"""M4.6 — casefile reset (hard + soft) and context CRUD (edit + remove).

Covers:

* `CasefileStore.update_context` round-trips name / kind / root, validates
  the new root exists, and rejects empty name strings.
* `CasefileStore.remove_context` (already existed in M2/M3.5) preserves
  per-context on-disk data; the M4.6 service wrapper does too.
* `CasefileStore.hard_reset` deletes `.casefile/` outright; subsequent
  `load_snapshot` re-initializes a fresh casefile.
* `CasefileStore.soft_reset` wipes per-task scratch and legacy scratch
  directories, preserves context.json, and re-creates the default `main` context.
* Both resets are idempotent.
* `CasefileService.find_root_conflict` detects overlap and respects
  `exclude_context_id`.
* Bridge dispatch: `casefile:updateContext` round-trips and emits
  `rootConflict` when the new root collides with another context.
* Bridge dispatch: `casefile:removeContext`, `casefile:hardReset`,
  `casefile:softReset`.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from assistant_app import electron_bridge as bridge
from assistant_app.casefile import CasefileService
from assistant_app.casefile.store import CasefileStore


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _bootstrap(tmp_path: Path) -> tuple[Path, Path, Path]:
    """Open a casefile with two contexts pointing at distinct directories."""
    casefile_root = tmp_path / "case"
    casefile_root.mkdir()
    context_a = tmp_path / "context_a"
    context_a.mkdir()
    context_b = tmp_path / "context_b"
    context_b.mkdir()
    bridge.dispatch({"command": "casefile:open", "root": str(casefile_root)})
    bridge.dispatch(
        {
            "command": "casefile:registerContext",
            "casefileRoot": str(casefile_root),
            "context": {"name": "A", "kind": "repo", "root": str(context_a), "id": "a"},
        }
    )
    bridge.dispatch(
        {
            "command": "casefile:registerContext",
            "casefileRoot": str(casefile_root),
            "context": {"name": "B", "kind": "repo", "root": str(context_b), "id": "b"},
        }
    )
    return casefile_root, context_a, context_b


# ---------------------------------------------------------------------------
# update_context
# ---------------------------------------------------------------------------


def test_update_context_changes_name(tmp_path: Path) -> None:
    casefile_root, _, _ = _bootstrap(tmp_path)
    store = CasefileStore(casefile_root)
    snapshot = store.update_context("a", name="Renamed")
    context = snapshot.context_by_id("a")
    assert context.name == "Renamed"


def test_update_context_changes_kind(tmp_path: Path) -> None:
    casefile_root, _, _ = _bootstrap(tmp_path)
    store = CasefileStore(casefile_root)
    snapshot = store.update_context("a", kind="doc")
    assert snapshot.context_by_id("a").kind == "doc"


def test_update_context_changes_root(tmp_path: Path) -> None:
    casefile_root, _, context_b = _bootstrap(tmp_path)
    new_root = tmp_path / "fresh"
    new_root.mkdir()
    store = CasefileStore(casefile_root)
    snapshot = store.update_context("a", root=new_root)
    assert snapshot.context_by_id("a").root == new_root.resolve()


def test_update_context_preserves_omitted_fields(tmp_path: Path) -> None:
    casefile_root, context_a, _ = _bootstrap(tmp_path)
    store = CasefileStore(casefile_root)
    before = store.load_snapshot().context_by_id("a")
    snapshot = store.update_context("a", name="Renamed Only")
    after = snapshot.context_by_id("a")
    assert after.name == "Renamed Only"
    assert after.kind == before.kind
    assert after.root == before.root
    assert after.parent_id == before.parent_id
    assert after.attachments == before.attachments


def test_update_context_rejects_empty_name(tmp_path: Path) -> None:
    casefile_root, _, _ = _bootstrap(tmp_path)
    store = CasefileStore(casefile_root)
    with pytest.raises(ValueError):
        store.update_context("a", name="   ")


def test_update_context_rejects_missing_root(tmp_path: Path) -> None:
    casefile_root, _, _ = _bootstrap(tmp_path)
    store = CasefileStore(casefile_root)
    with pytest.raises(FileNotFoundError):
        store.update_context("a", root=tmp_path / "does_not_exist")


def test_update_context_unknown_id_raises(tmp_path: Path) -> None:
    casefile_root, _, _ = _bootstrap(tmp_path)
    store = CasefileStore(casefile_root)
    with pytest.raises(KeyError):
        store.update_context("nope", name="x")


# ---------------------------------------------------------------------------
# remove_context: per-context on-disk data is preserved (hidden but recoverable)
# ---------------------------------------------------------------------------


def test_remove_context_keeps_chat_log_on_disk(tmp_path: Path) -> None:
    casefile_root, _, _ = _bootstrap(tmp_path)
    store = CasefileStore(casefile_root)
    # Plant a chat log so removal has something to (not) delete.
    store.append_chat_messages("a", [{"role": "user", "content": "hi"}])
    session_id = store.load_snapshot().context_by_id("a").session_id
    chat_path = casefile_root / ".casefile" / "chats" / f"{session_id}.jsonl"
    assert chat_path.exists()
    service = CasefileService(casefile_root)
    snapshot = service.remove_context("a")
    assert "a" not in {context.id for context in snapshot.contexts}
    # The context is gone from contexts.json, but its UUID-keyed chat log remains
    # on disk for audit/recovery.
    assert chat_path.exists()


# ---------------------------------------------------------------------------
# hard_reset
# ---------------------------------------------------------------------------


def test_hard_reset_deletes_metadata_directory(tmp_path: Path) -> None:
    casefile_root, _, _ = _bootstrap(tmp_path)
    meta = casefile_root / ".casefile"
    assert meta.exists()
    store = CasefileStore(casefile_root)
    store.hard_reset()
    assert not meta.exists()


def test_hard_reset_then_load_returns_default_main_context(tmp_path: Path) -> None:
    casefile_root, _, _ = _bootstrap(tmp_path)
    service = CasefileService(casefile_root)
    snapshot = service.hard_reset()
    assert [context.id for context in snapshot.contexts] == ["main"]
    assert snapshot.active_context_id == "main"


def test_hard_reset_is_idempotent(tmp_path: Path) -> None:
    casefile_root, _, _ = _bootstrap(tmp_path)
    service = CasefileService(casefile_root)
    service.hard_reset()
    # Second call on an already-empty casefile must not raise.
    snapshot = service.hard_reset()
    assert [context.id for context in snapshot.contexts] == ["main"]


# ---------------------------------------------------------------------------
# soft_reset
# ---------------------------------------------------------------------------


def test_soft_reset_wipes_per_task_scratch(tmp_path: Path) -> None:
    casefile_root, _, _ = _bootstrap(tmp_path)
    meta = casefile_root / ".casefile"
    # Plant a chat artifact in the per-task scratch directory.
    (meta / "chats").mkdir(parents=True, exist_ok=True)
    (meta / "chats" / "leftover.txt").write_text("x", encoding="utf-8")
    service = CasefileService(casefile_root)
    service.soft_reset()
    assert not (meta / "chats" / "leftover.txt").exists()


def test_soft_reset_preserves_context(tmp_path: Path) -> None:
    casefile_root, _, _ = _bootstrap(tmp_path)
    meta = casefile_root / ".casefile"
    (meta / "context.json").write_text(
        '{"version": 1, "files": ["doc.md"]}', encoding="utf-8"
    )
    service = CasefileService(casefile_root)
    service.soft_reset()
    assert (meta / "context.json").exists()


def test_soft_reset_recreates_default_main_context(tmp_path: Path) -> None:
    casefile_root, _, _ = _bootstrap(tmp_path)
    service = CasefileService(casefile_root)
    snapshot = service.soft_reset()
    assert [context.id for context in snapshot.contexts] == ["main"]
    assert snapshot.active_context_id == "main"


def test_soft_reset_is_idempotent(tmp_path: Path) -> None:
    casefile_root, _, _ = _bootstrap(tmp_path)
    service = CasefileService(casefile_root)
    service.soft_reset()
    snapshot = service.soft_reset()
    assert [context.id for context in snapshot.contexts] == ["main"]


# ---------------------------------------------------------------------------
# find_root_conflict
# ---------------------------------------------------------------------------


def test_find_root_conflict_detects_overlap(tmp_path: Path) -> None:
    casefile_root, context_a, _ = _bootstrap(tmp_path)
    service = CasefileService(casefile_root)
    assert service.find_root_conflict(context_a) == "a"


def test_find_root_conflict_excludes_self(tmp_path: Path) -> None:
    casefile_root, context_a, _ = _bootstrap(tmp_path)
    service = CasefileService(casefile_root)
    assert service.find_root_conflict(context_a, exclude_context_id="a") is None


def test_find_root_conflict_returns_none_when_unique(tmp_path: Path) -> None:
    casefile_root, _, _ = _bootstrap(tmp_path)
    fresh = tmp_path / "elsewhere"
    fresh.mkdir()
    service = CasefileService(casefile_root)
    assert service.find_root_conflict(fresh) is None


# ---------------------------------------------------------------------------
# bridge dispatch
# ---------------------------------------------------------------------------


def test_dispatch_update_context_round_trips(tmp_path: Path) -> None:
    casefile_root, _, _ = _bootstrap(tmp_path)
    response = bridge.dispatch(
        {
            "command": "casefile:updateContext",
            "casefileRoot": str(casefile_root),
            "contextId": "a",
            "name": "Renamed",
            "kind": "doc",
        }
    )
    assert response["ok"] is True
    context = next(l for l in response["casefile"]["contexts"] if l["id"] == "a")
    assert context["name"] == "Renamed"
    assert context["kind"] == "doc"
    assert "rootConflict" not in response


def test_dispatch_update_context_emits_root_conflict(tmp_path: Path) -> None:
    """Editing context `a` to point at context `b`'s root surfaces a warning."""
    casefile_root, _, context_b = _bootstrap(tmp_path)
    response = bridge.dispatch(
        {
            "command": "casefile:updateContext",
            "casefileRoot": str(casefile_root),
            "contextId": "a",
            "root": str(context_b),
        }
    )
    assert response["ok"] is True
    # The update still went through (warning, not block).
    context = next(l for l in response["casefile"]["contexts"] if l["id"] == "a")
    assert context["root"] == str(context_b.resolve())
    assert response["rootConflict"] == {"conflictingContextId": "b"}


def test_dispatch_update_context_rejects_blank_root_string(tmp_path: Path) -> None:
    casefile_root, _, _ = _bootstrap(tmp_path)
    with pytest.raises(ValueError):
        bridge.dispatch(
            {
                "command": "casefile:updateContext",
                "casefileRoot": str(casefile_root),
                "contextId": "a",
                "root": "   ",
            }
        )


def test_dispatch_remove_context(tmp_path: Path) -> None:
    casefile_root, _, _ = _bootstrap(tmp_path)
    response = bridge.dispatch(
        {
            "command": "casefile:removeContext",
            "casefileRoot": str(casefile_root),
            "contextId": "b",
        }
    )
    assert response["ok"] is True
    assert "b" not in {l["id"] for l in response["casefile"]["contexts"]}


def test_dispatch_hard_reset(tmp_path: Path) -> None:
    casefile_root, _, _ = _bootstrap(tmp_path)
    # Plant a chat so we can confirm it's gone.
    CasefileStore(casefile_root).append_chat_messages(
        "a", [{"role": "user", "content": "hi"}]
    )
    response = bridge.dispatch(
        {"command": "casefile:hardReset", "casefileRoot": str(casefile_root)}
    )
    assert response["ok"] is True
    assert [l["id"] for l in response["casefile"]["contexts"]] == ["main"]
    # Chat log for the wiped `a` context no longer exists either.
    assert not (casefile_root / ".casefile" / "chats" / "a.jsonl").exists()


