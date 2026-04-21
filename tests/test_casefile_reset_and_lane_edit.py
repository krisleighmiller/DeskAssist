"""M4.6 — casefile reset (hard + soft) and lane CRUD (edit + remove).

Covers:

* `CasefileStore.update_lane` round-trips name / kind / root, validates
  the new root exists, and rejects empty name strings.
* `CasefileStore.remove_lane` (already existed in M2/M3.5) preserves
  per-lane on-disk data; the M4.6 service wrapper does too.
* `CasefileStore.hard_reset` deletes `.casefile/` outright; subsequent
  `load_snapshot` re-initializes a fresh casefile.
* `CasefileStore.soft_reset` wipes per-task scratch (chats / findings /
  notes / runs / exports), conditionally wipes prompts, preserves
  context.json + inbox.json, and re-creates the default `main` lane.
* Both resets are idempotent.
* `CasefileService.find_root_conflict` detects overlap and respects
  `exclude_lane_id`.
* Bridge dispatch: `casefile:updateLane` round-trips and emits
  `rootConflict` when the new root collides with another lane.
* Bridge dispatch: `casefile:removeLane`, `casefile:hardReset`,
  `casefile:softReset` (`keepPrompts` toggle).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from assistant_app import electron_bridge as bridge
from assistant_app.casefile import CasefileService
from assistant_app.casefile.store import CasefileStore


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _bootstrap(tmp_path: Path) -> tuple[Path, Path, Path]:
    """Open a casefile with two lanes pointing at distinct directories."""
    casefile_root = tmp_path / "case"
    casefile_root.mkdir()
    lane_a = tmp_path / "lane_a"
    lane_a.mkdir()
    lane_b = tmp_path / "lane_b"
    lane_b.mkdir()
    bridge.dispatch({"command": "casefile:open", "root": str(casefile_root)})
    bridge.dispatch(
        {
            "command": "casefile:registerLane",
            "casefileRoot": str(casefile_root),
            "lane": {"name": "A", "kind": "repo", "root": str(lane_a), "id": "a"},
        }
    )
    bridge.dispatch(
        {
            "command": "casefile:registerLane",
            "casefileRoot": str(casefile_root),
            "lane": {"name": "B", "kind": "repo", "root": str(lane_b), "id": "b"},
        }
    )
    return casefile_root, lane_a, lane_b


# ---------------------------------------------------------------------------
# update_lane
# ---------------------------------------------------------------------------


def test_update_lane_changes_name(tmp_path: Path) -> None:
    casefile_root, _, _ = _bootstrap(tmp_path)
    store = CasefileStore(casefile_root)
    snapshot = store.update_lane("a", name="Renamed")
    lane = snapshot.lane_by_id("a")
    assert lane.name == "Renamed"


def test_update_lane_changes_kind(tmp_path: Path) -> None:
    casefile_root, _, _ = _bootstrap(tmp_path)
    store = CasefileStore(casefile_root)
    snapshot = store.update_lane("a", kind="doc")
    assert snapshot.lane_by_id("a").kind == "doc"


def test_update_lane_changes_root(tmp_path: Path) -> None:
    casefile_root, _, lane_b = _bootstrap(tmp_path)
    new_root = tmp_path / "fresh"
    new_root.mkdir()
    store = CasefileStore(casefile_root)
    snapshot = store.update_lane("a", root=new_root)
    assert snapshot.lane_by_id("a").root == new_root.resolve()


def test_update_lane_preserves_omitted_fields(tmp_path: Path) -> None:
    casefile_root, lane_a, _ = _bootstrap(tmp_path)
    store = CasefileStore(casefile_root)
    before = store.load_snapshot().lane_by_id("a")
    snapshot = store.update_lane("a", name="Renamed Only")
    after = snapshot.lane_by_id("a")
    assert after.name == "Renamed Only"
    assert after.kind == before.kind
    assert after.root == before.root
    assert after.parent_id == before.parent_id
    assert after.attachments == before.attachments


def test_update_lane_rejects_empty_name(tmp_path: Path) -> None:
    casefile_root, _, _ = _bootstrap(tmp_path)
    store = CasefileStore(casefile_root)
    with pytest.raises(ValueError):
        store.update_lane("a", name="   ")


def test_update_lane_rejects_missing_root(tmp_path: Path) -> None:
    casefile_root, _, _ = _bootstrap(tmp_path)
    store = CasefileStore(casefile_root)
    with pytest.raises(FileNotFoundError):
        store.update_lane("a", root=tmp_path / "does_not_exist")


def test_update_lane_unknown_id_raises(tmp_path: Path) -> None:
    casefile_root, _, _ = _bootstrap(tmp_path)
    store = CasefileStore(casefile_root)
    with pytest.raises(KeyError):
        store.update_lane("nope", name="x")


# ---------------------------------------------------------------------------
# remove_lane: per-lane on-disk data is preserved (hidden but recoverable)
# ---------------------------------------------------------------------------


def test_remove_lane_keeps_chat_log_on_disk(tmp_path: Path) -> None:
    casefile_root, _, _ = _bootstrap(tmp_path)
    store = CasefileStore(casefile_root)
    # Plant a chat log so removal has something to (not) delete.
    store.append_chat_messages("a", [{"role": "user", "content": "hi"}])
    chat_path = store.chat_log_path("a")
    assert chat_path.exists()
    service = CasefileService(casefile_root)
    snapshot = service.remove_lane("a")
    assert "a" not in {lane.id for lane in snapshot.lanes}
    # The lane is gone from lanes.json but its chat log remains on disk
    # so re-registering id=`a` later can resurrect it.
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


def test_hard_reset_then_load_returns_default_main_lane(tmp_path: Path) -> None:
    casefile_root, _, _ = _bootstrap(tmp_path)
    service = CasefileService(casefile_root)
    snapshot = service.hard_reset()
    assert [lane.id for lane in snapshot.lanes] == ["main"]
    assert snapshot.active_lane_id == "main"


def test_hard_reset_is_idempotent(tmp_path: Path) -> None:
    casefile_root, _, _ = _bootstrap(tmp_path)
    service = CasefileService(casefile_root)
    service.hard_reset()
    # Second call on an already-empty casefile must not raise.
    snapshot = service.hard_reset()
    assert [lane.id for lane in snapshot.lanes] == ["main"]


# ---------------------------------------------------------------------------
# soft_reset
# ---------------------------------------------------------------------------


def test_soft_reset_wipes_per_task_scratch(tmp_path: Path) -> None:
    casefile_root, _, _ = _bootstrap(tmp_path)
    meta = casefile_root / ".casefile"
    # Plant artifacts in every directory soft-reset is supposed to wipe.
    for sub in ("chats", "findings", "notes", "runs", "exports", "prompts"):
        (meta / sub).mkdir(parents=True, exist_ok=True)
        (meta / sub / "leftover.txt").write_text("x", encoding="utf-8")
    service = CasefileService(casefile_root)
    service.soft_reset(keep_prompts=False)
    for sub in ("chats", "findings", "notes", "runs", "exports", "prompts"):
        assert not (meta / sub / "leftover.txt").exists(), sub


def test_soft_reset_keep_prompts_preserves_prompts_dir(tmp_path: Path) -> None:
    casefile_root, _, _ = _bootstrap(tmp_path)
    meta = casefile_root / ".casefile"
    (meta / "prompts").mkdir(parents=True, exist_ok=True)
    (meta / "prompts" / "rubric.md").write_text("rubric body", encoding="utf-8")
    (meta / "chats").mkdir(parents=True, exist_ok=True)
    (meta / "chats" / "scratch.jsonl").write_text("{}\n", encoding="utf-8")
    service = CasefileService(casefile_root)
    service.soft_reset(keep_prompts=True)
    assert (meta / "prompts" / "rubric.md").exists()
    assert not (meta / "chats" / "scratch.jsonl").exists()


def test_soft_reset_preserves_context_and_inbox(tmp_path: Path) -> None:
    casefile_root, _, _ = _bootstrap(tmp_path)
    meta = casefile_root / ".casefile"
    (meta / "context.json").write_text(
        '{"version": 1, "files": ["doc.md"]}', encoding="utf-8"
    )
    (meta / "inbox.json").write_text('{"version": 1, "sources": []}', encoding="utf-8")
    service = CasefileService(casefile_root)
    service.soft_reset(keep_prompts=True)
    assert (meta / "context.json").exists()
    assert (meta / "inbox.json").exists()


def test_soft_reset_recreates_default_main_lane(tmp_path: Path) -> None:
    casefile_root, _, _ = _bootstrap(tmp_path)
    service = CasefileService(casefile_root)
    snapshot = service.soft_reset(keep_prompts=True)
    assert [lane.id for lane in snapshot.lanes] == ["main"]
    assert snapshot.active_lane_id == "main"


def test_soft_reset_is_idempotent(tmp_path: Path) -> None:
    casefile_root, _, _ = _bootstrap(tmp_path)
    service = CasefileService(casefile_root)
    service.soft_reset(keep_prompts=False)
    snapshot = service.soft_reset(keep_prompts=False)
    assert [lane.id for lane in snapshot.lanes] == ["main"]


# ---------------------------------------------------------------------------
# find_root_conflict
# ---------------------------------------------------------------------------


def test_find_root_conflict_detects_overlap(tmp_path: Path) -> None:
    casefile_root, lane_a, _ = _bootstrap(tmp_path)
    service = CasefileService(casefile_root)
    assert service.find_root_conflict(lane_a) == "a"


def test_find_root_conflict_excludes_self(tmp_path: Path) -> None:
    casefile_root, lane_a, _ = _bootstrap(tmp_path)
    service = CasefileService(casefile_root)
    assert service.find_root_conflict(lane_a, exclude_lane_id="a") is None


def test_find_root_conflict_returns_none_when_unique(tmp_path: Path) -> None:
    casefile_root, _, _ = _bootstrap(tmp_path)
    fresh = tmp_path / "elsewhere"
    fresh.mkdir()
    service = CasefileService(casefile_root)
    assert service.find_root_conflict(fresh) is None


# ---------------------------------------------------------------------------
# bridge dispatch
# ---------------------------------------------------------------------------


def test_dispatch_update_lane_round_trips(tmp_path: Path) -> None:
    casefile_root, _, _ = _bootstrap(tmp_path)
    response = bridge.dispatch(
        {
            "command": "casefile:updateLane",
            "casefileRoot": str(casefile_root),
            "laneId": "a",
            "name": "Renamed",
            "kind": "doc",
        }
    )
    assert response["ok"] is True
    lane = next(l for l in response["casefile"]["lanes"] if l["id"] == "a")
    assert lane["name"] == "Renamed"
    assert lane["kind"] == "doc"
    assert "rootConflict" not in response


def test_dispatch_update_lane_emits_root_conflict(tmp_path: Path) -> None:
    """Editing lane `a` to point at lane `b`'s root surfaces a warning."""
    casefile_root, _, lane_b = _bootstrap(tmp_path)
    response = bridge.dispatch(
        {
            "command": "casefile:updateLane",
            "casefileRoot": str(casefile_root),
            "laneId": "a",
            "root": str(lane_b),
        }
    )
    assert response["ok"] is True
    # The update still went through (warning, not block).
    lane = next(l for l in response["casefile"]["lanes"] if l["id"] == "a")
    assert lane["root"] == str(lane_b.resolve())
    assert response["rootConflict"] == {"conflictingLaneId": "b"}


def test_dispatch_update_lane_rejects_blank_root_string(tmp_path: Path) -> None:
    casefile_root, _, _ = _bootstrap(tmp_path)
    with pytest.raises(ValueError):
        bridge.dispatch(
            {
                "command": "casefile:updateLane",
                "casefileRoot": str(casefile_root),
                "laneId": "a",
                "root": "   ",
            }
        )


def test_dispatch_remove_lane(tmp_path: Path) -> None:
    casefile_root, _, _ = _bootstrap(tmp_path)
    response = bridge.dispatch(
        {
            "command": "casefile:removeLane",
            "casefileRoot": str(casefile_root),
            "laneId": "b",
        }
    )
    assert response["ok"] is True
    assert "b" not in {l["id"] for l in response["casefile"]["lanes"]}


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
    assert [l["id"] for l in response["casefile"]["lanes"]] == ["main"]
    # Chat log for the wiped `a` lane no longer exists either.
    assert not (casefile_root / ".casefile" / "chats" / "a.jsonl").exists()


def test_dispatch_soft_reset_keep_prompts_default_true(tmp_path: Path) -> None:
    casefile_root, _, _ = _bootstrap(tmp_path)
    meta = casefile_root / ".casefile"
    (meta / "prompts").mkdir(parents=True, exist_ok=True)
    (meta / "prompts" / "k.md").write_text("k", encoding="utf-8")
    response = bridge.dispatch(
        {"command": "casefile:softReset", "casefileRoot": str(casefile_root)}
    )
    assert response["ok"] is True
    assert (meta / "prompts" / "k.md").exists()


def test_dispatch_soft_reset_keep_prompts_false_wipes_prompts(tmp_path: Path) -> None:
    casefile_root, _, _ = _bootstrap(tmp_path)
    meta = casefile_root / ".casefile"
    (meta / "prompts").mkdir(parents=True, exist_ok=True)
    (meta / "prompts" / "k.md").write_text("k", encoding="utf-8")
    response = bridge.dispatch(
        {
            "command": "casefile:softReset",
            "casefileRoot": str(casefile_root),
            "keepPrompts": False,
        }
    )
    assert response["ok"] is True
    assert not (meta / "prompts" / "k.md").exists()


def test_dispatch_soft_reset_rejects_non_bool_keep_prompts(tmp_path: Path) -> None:
    casefile_root, _, _ = _bootstrap(tmp_path)
    with pytest.raises(ValueError):
        bridge.dispatch(
            {
                "command": "casefile:softReset",
                "casefileRoot": str(casefile_root),
                "keepPrompts": "yes",
            }
        )
