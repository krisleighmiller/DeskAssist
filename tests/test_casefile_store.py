from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from uuid import UUID

from assistant_app.casefile import CasefileService, CONTEXT_KINDS, Context
from assistant_app.casefile import store as store_module
from assistant_app.casefile.store import CasefileStore, ContextsFileError, normalize_context_id


# ---------------------------------------------------------------------------
# Context id normalization
# ---------------------------------------------------------------------------


def test_normalize_context_id_lowercases_and_replaces_invalid_chars():
    assert normalize_context_id("Main Repo") == "main-repo"
    assert normalize_context_id("attempt #2") == "attempt-2"
    assert normalize_context_id("CamelCase") == "camelcase"


def test_normalize_context_id_rejects_empty_and_reserved():
    with pytest.raises(ValueError):
        normalize_context_id("   ")
    with pytest.raises(ValueError):
        normalize_context_id("..")
    with pytest.raises(ValueError):
        normalize_context_id("casefile")


# ---------------------------------------------------------------------------
# Initialization + default context
# ---------------------------------------------------------------------------


def test_open_creates_metadata_dir_and_default_context(tmp_path: Path):
    store = CasefileStore(tmp_path)
    store.ensure_initialized()
    assert (tmp_path / ".casefile").is_dir()
    assert (tmp_path / ".casefile" / "contexts.json").is_file()
    snapshot = store.load_snapshot()
    assert snapshot.active_context_id == "main"
    assert len(snapshot.contexts) == 1
    main = snapshot.contexts[0]
    assert main.id == "main"
    assert main.kind == "repo"
    assert main.root == tmp_path.resolve()


def test_load_snapshot_auto_initializes_when_missing(tmp_path: Path):
    store = CasefileStore(tmp_path)
    snapshot = store.load_snapshot()  # no explicit ensure_initialized()
    assert (tmp_path / ".casefile" / "contexts.json").exists()
    assert snapshot.active_context_id == "main"


def test_malformed_writable_metadata_fails_closed(tmp_path: Path):
    meta = tmp_path / ".casefile"
    meta.mkdir()
    (meta / "contexts.json").write_text(
        json.dumps(
            {
                "version": 2,
                "contexts": [
                    {
                        "id": "main",
                        "name": "Main",
                        "kind": "repo",
                        "root": ".",
                        "writable": "false",
                    }
                ],
                "active_context_id": "main",
            }
        ),
        encoding="utf-8",
    )

    snapshot = CasefileStore(tmp_path).load_snapshot()

    assert snapshot.contexts[0].writable is False


# ---------------------------------------------------------------------------
# Context registration
# ---------------------------------------------------------------------------


def test_register_context_stores_relative_root_when_inside_casefile(tmp_path: Path):
    sibling = tmp_path / "attempt_a"
    sibling.mkdir()
    store = CasefileStore(tmp_path)
    store.ensure_initialized()
    snapshot = store.register_context(name="Attempt A", kind="repo", root=sibling)
    assert {context.id for context in snapshot.contexts} == {"main", "attempt-a"}
    raw = json.loads((tmp_path / ".casefile" / "contexts.json").read_text())
    serialized_attempt = next(context for context in raw["contexts"] if context["id"] == "attempt-a")
    # Stored as a relative path so casefiles are portable when moved as a unit.
    assert serialized_attempt["root"] == "attempt_a"


def test_register_context_stores_absolute_root_when_outside_casefile(tmp_path: Path):
    casefile_root = tmp_path / "case"
    casefile_root.mkdir()
    sibling = tmp_path / "outside_context"
    sibling.mkdir()
    store = CasefileStore(casefile_root)
    store.ensure_initialized()
    store.register_context(name="Outside", kind="repo", root=sibling)
    raw = json.loads((casefile_root / ".casefile" / "contexts.json").read_text())
    outside = next(context for context in raw["contexts"] if context["id"] == "outside")
    assert Path(outside["root"]) == sibling.resolve()


def test_register_context_disambiguates_colliding_ids(tmp_path: Path):
    a = tmp_path / "a"
    a.mkdir()
    b = tmp_path / "b"
    b.mkdir()
    store = CasefileStore(tmp_path)
    store.ensure_initialized()
    store.register_context(name="repo", kind="repo", root=a)
    snapshot = store.register_context(name="repo", kind="repo", root=b)
    ids = [context.id for context in snapshot.contexts]
    assert "repo" in ids
    assert "repo-2" in ids


def test_register_context_rejects_missing_root(tmp_path: Path):
    store = CasefileStore(tmp_path)
    store.ensure_initialized()
    with pytest.raises(FileNotFoundError):
        store.register_context(name="ghost", kind="repo", root=tmp_path / "nope")


def test_register_context_rejects_file_root(tmp_path: Path):
    store = CasefileStore(tmp_path)
    store.ensure_initialized()
    file_path = tmp_path / "file.txt"
    file_path.write_text("hi", encoding="utf-8")
    with pytest.raises(NotADirectoryError):
        store.register_context(name="file context", kind="repo", root=file_path)


# ---------------------------------------------------------------------------
# Active context management
# ---------------------------------------------------------------------------


def test_set_active_context_persists_across_loads(tmp_path: Path):
    a = tmp_path / "a"
    a.mkdir()
    store = CasefileStore(tmp_path)
    store.ensure_initialized()
    store.register_context(name="A", kind="repo", root=a)
    store.set_active_context("a")
    reopened = CasefileStore(tmp_path).load_snapshot()
    assert reopened.active_context_id == "a"
    assert reopened.active_context is not None
    assert reopened.active_context.id == "a"


def test_set_active_context_unknown_raises(tmp_path: Path):
    store = CasefileStore(tmp_path)
    store.ensure_initialized()
    with pytest.raises(KeyError):
        store.set_active_context("nope")


def test_remove_context_picks_new_active(tmp_path: Path):
    a = tmp_path / "a"
    a.mkdir()
    store = CasefileStore(tmp_path)
    store.ensure_initialized()
    store.register_context(name="A", kind="repo", root=a)
    store.set_active_context("a")
    snapshot = store.remove_context("a")
    assert snapshot.active_context_id == "main"


# ---------------------------------------------------------------------------
# Malformed contexts.json
# ---------------------------------------------------------------------------


def test_load_snapshot_rejects_unknown_version(tmp_path: Path):
    store = CasefileStore(tmp_path)
    store.ensure_initialized()
    store.casefile.contexts_file.write_text(
        json.dumps({"version": 999, "contexts": [], "active_context_id": None}),
        encoding="utf-8",
    )
    with pytest.raises(ContextsFileError):
        store.load_snapshot()


def test_load_snapshot_rejects_duplicate_ids(tmp_path: Path):
    store = CasefileStore(tmp_path)
    store.ensure_initialized()
    store.casefile.contexts_file.write_text(
        json.dumps(
            {
                "version": 1,
                "contexts": [
                    {"id": "main", "name": "Main", "kind": "repo", "root": "."},
                    {"id": "main", "name": "Other", "kind": "repo", "root": "."},
                ],
                "active_context_id": "main",
            }
        ),
        encoding="utf-8",
    )
    with pytest.raises(ContextsFileError):
        store.load_snapshot()


def test_unknown_kind_coerces_to_other(tmp_path: Path):
    store = CasefileStore(tmp_path)
    store.ensure_initialized()
    store.casefile.contexts_file.write_text(
        json.dumps(
            {
                "version": 1,
                "contexts": [
                    {"id": "main", "name": "Main", "kind": "future-kind", "root": "."},
                ],
                "active_context_id": "main",
            }
        ),
        encoding="utf-8",
    )
    snapshot = store.load_snapshot()
    assert snapshot.contexts[0].kind == "other"


def test_default_context_kind_is_a_known_kind():
    # Guard against accidentally renaming a context kind without updating the set.
    from assistant_app.casefile import DEFAULT_CONTEXT_KIND

    assert DEFAULT_CONTEXT_KIND in CONTEXT_KINDS


# ---------------------------------------------------------------------------
# Chat persistence
# ---------------------------------------------------------------------------


def test_chat_log_round_trip(tmp_path: Path):
    store = CasefileStore(tmp_path)
    store.ensure_initialized()
    session_id = store.load_snapshot().context_by_id("main").session_id
    messages = [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "hello"},
    ]
    store.append_chat_messages("main", messages)
    store.append_chat_messages("main", [{"role": "user", "content": "again"}])
    read, skipped = store.read_chat_messages("main")
    assert skipped == 0
    assert [m["role"] for m in read] == ["user", "assistant", "user"]
    assert read[-1]["content"] == "again"
    assert (tmp_path / ".casefile" / "chats" / f"{session_id}.jsonl").is_file()
    assert not store.chat_log_path("main").exists()


def test_chat_log_append_retries_short_os_writes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    store = CasefileStore(tmp_path)
    store.ensure_initialized()
    session_id = store.load_snapshot().context_by_id("main").session_id
    real_write = os.write
    write_calls = 0

    def short_write(fd: int, data: bytes | memoryview) -> int:
        nonlocal write_calls
        write_calls += 1
        chunk_size = max(1, len(data) // 3)
        return real_write(fd, bytes(data[:chunk_size]))

    monkeypatch.setattr(store_module.os, "write", short_write)

    message = {"role": "assistant", "content": "x" * 1024}
    store.append_chat_messages("main", [message])

    log = tmp_path / ".casefile" / "chats" / f"{session_id}.jsonl"
    assert [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()] == [message]
    assert write_calls > 2


def test_chat_log_uses_session_id_not_reused_context_id(tmp_path: Path):
    store = CasefileStore(tmp_path)
    store.ensure_initialized()
    first_session_id = store.load_snapshot().context_by_id("main").session_id
    store.append_chat_messages("main", [{"role": "user", "content": "old"}])

    store.remove_context("main")
    store.register_context(name="Main", kind="repo", root=tmp_path, context_id="main")
    second_session_id = store.load_snapshot().context_by_id("main").session_id

    assert second_session_id != first_session_id
    messages, skipped = store.read_chat_messages("main")
    assert skipped == 0
    assert messages == []


def test_chat_log_corruption_skips_bad_lines(tmp_path: Path):
    """A corrupt line in the chat log is skipped (with a warning) rather than
    aborting the entire read.  Policy: one bad write must not make the
    whole history unreadable."""
    store = CasefileStore(tmp_path)
    store.ensure_initialized()
    log = store.chat_log_path("main")
    log.parent.mkdir(parents=True, exist_ok=True)
    # Write one corrupt line followed by a valid one.
    log.write_text('not-json\n{"role":"user","content":"hi"}\n', encoding="utf-8")
    messages, skipped = store.read_chat_messages("main")
    assert skipped == 1
    assert messages == [{"role": "user", "content": "hi"}]


def test_chat_log_path_safe_against_traversal(tmp_path: Path):
    store = CasefileStore(tmp_path)
    store.ensure_initialized()
    # Even if a malicious caller bypasses register_context and asks for a chat
    # log with a path-traversal id, normalize_context_id should reject it.
    with pytest.raises(ValueError):
        store.chat_log_path("../escape")


# ---------------------------------------------------------------------------
# CasefileService surface
# ---------------------------------------------------------------------------


def test_service_resolve_context_defaults_to_active(tmp_path: Path):
    service = CasefileService(tmp_path)
    service.open()
    context = service.resolve_context(None)
    assert context.id == "main"


def test_service_resolve_context_unknown_raises(tmp_path: Path):
    service = CasefileService(tmp_path)
    service.open()
    with pytest.raises(KeyError):
        service.resolve_context("ghost")


def test_service_serialize_returns_ipc_friendly_payload(tmp_path: Path):
    service = CasefileService(tmp_path)
    snapshot = service.open()
    payload = service.serialize(snapshot)
    assert payload["root"] == str(tmp_path.resolve())
    assert payload["activeContextId"] == "main"
    assert isinstance(payload["contexts"], list)
    assert payload["contexts"][0]["id"] == "main"
    UUID(payload["contexts"][0]["sessionId"])
    # Context root in IPC is always absolute string.
    assert Path(payload["contexts"][0]["root"]).is_absolute()


def test_context_session_id_persists_across_reloads(tmp_path: Path):
    service = CasefileService(tmp_path)
    first = service.open()
    context_id = first.contexts[0].session_id
    UUID(context_id)

    second = CasefileService(tmp_path).open()
    assert second.contexts[0].session_id == context_id


def test_context_dataclass_is_frozen(tmp_path: Path):
    context = Context(id="x", name="X", kind="repo", root=tmp_path)
    with pytest.raises(Exception):
        context.id = "y"  # type: ignore[misc]
