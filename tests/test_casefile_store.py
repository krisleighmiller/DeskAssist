from __future__ import annotations

import json
from pathlib import Path

import pytest

from assistant_app.casefile import CasefileService, LANE_KINDS, Lane
from assistant_app.casefile.store import CasefileStore, LanesFileError, normalize_lane_id


# ---------------------------------------------------------------------------
# Lane id normalization
# ---------------------------------------------------------------------------


def test_normalize_lane_id_lowercases_and_replaces_invalid_chars():
    assert normalize_lane_id("Main Repo") == "main-repo"
    assert normalize_lane_id("attempt #2") == "attempt-2"
    assert normalize_lane_id("CamelCase") == "camelcase"


def test_normalize_lane_id_rejects_empty_and_reserved():
    with pytest.raises(ValueError):
        normalize_lane_id("   ")
    with pytest.raises(ValueError):
        normalize_lane_id("..")
    with pytest.raises(ValueError):
        normalize_lane_id("casefile")


# ---------------------------------------------------------------------------
# Initialization + default lane
# ---------------------------------------------------------------------------


def test_open_creates_metadata_dir_and_default_lane(tmp_path: Path):
    store = CasefileStore(tmp_path)
    store.ensure_initialized()
    assert (tmp_path / ".casefile").is_dir()
    assert (tmp_path / ".casefile" / "lanes.json").is_file()
    snapshot = store.load_snapshot()
    assert snapshot.active_lane_id == "main"
    assert len(snapshot.lanes) == 1
    main = snapshot.lanes[0]
    assert main.id == "main"
    assert main.kind == "repo"
    assert main.root == tmp_path.resolve()


def test_load_snapshot_auto_initializes_when_missing(tmp_path: Path):
    store = CasefileStore(tmp_path)
    snapshot = store.load_snapshot()  # no explicit ensure_initialized()
    assert (tmp_path / ".casefile" / "lanes.json").exists()
    assert snapshot.active_lane_id == "main"


# ---------------------------------------------------------------------------
# Lane registration
# ---------------------------------------------------------------------------


def test_register_lane_stores_relative_root_when_inside_casefile(tmp_path: Path):
    sibling = tmp_path / "attempt_a"
    sibling.mkdir()
    store = CasefileStore(tmp_path)
    store.ensure_initialized()
    snapshot = store.register_lane(name="Attempt A", kind="repo", root=sibling)
    assert {lane.id for lane in snapshot.lanes} == {"main", "attempt-a"}
    raw = json.loads((tmp_path / ".casefile" / "lanes.json").read_text())
    serialized_attempt = next(lane for lane in raw["lanes"] if lane["id"] == "attempt-a")
    # Stored as a relative path so casefiles are portable when moved as a unit.
    assert serialized_attempt["root"] == "attempt_a"


def test_register_lane_stores_absolute_root_when_outside_casefile(tmp_path: Path):
    casefile_root = tmp_path / "case"
    casefile_root.mkdir()
    sibling = tmp_path / "outside_lane"
    sibling.mkdir()
    store = CasefileStore(casefile_root)
    store.ensure_initialized()
    store.register_lane(name="Outside", kind="repo", root=sibling)
    raw = json.loads((casefile_root / ".casefile" / "lanes.json").read_text())
    outside = next(lane for lane in raw["lanes"] if lane["id"] == "outside")
    assert Path(outside["root"]) == sibling.resolve()


def test_register_lane_disambiguates_colliding_ids(tmp_path: Path):
    a = tmp_path / "a"
    a.mkdir()
    b = tmp_path / "b"
    b.mkdir()
    store = CasefileStore(tmp_path)
    store.ensure_initialized()
    store.register_lane(name="repo", kind="repo", root=a)
    snapshot = store.register_lane(name="repo", kind="repo", root=b)
    ids = [lane.id for lane in snapshot.lanes]
    assert "repo" in ids
    assert "repo-2" in ids


def test_register_lane_rejects_missing_root(tmp_path: Path):
    store = CasefileStore(tmp_path)
    store.ensure_initialized()
    with pytest.raises(FileNotFoundError):
        store.register_lane(name="ghost", kind="repo", root=tmp_path / "nope")


def test_register_lane_rejects_file_root(tmp_path: Path):
    store = CasefileStore(tmp_path)
    store.ensure_initialized()
    file_path = tmp_path / "file.txt"
    file_path.write_text("hi", encoding="utf-8")
    with pytest.raises(NotADirectoryError):
        store.register_lane(name="file lane", kind="repo", root=file_path)


# ---------------------------------------------------------------------------
# Active lane management
# ---------------------------------------------------------------------------


def test_set_active_lane_persists_across_loads(tmp_path: Path):
    a = tmp_path / "a"
    a.mkdir()
    store = CasefileStore(tmp_path)
    store.ensure_initialized()
    store.register_lane(name="A", kind="repo", root=a)
    store.set_active_lane("a")
    reopened = CasefileStore(tmp_path).load_snapshot()
    assert reopened.active_lane_id == "a"
    assert reopened.active_lane is not None
    assert reopened.active_lane.id == "a"


def test_set_active_lane_unknown_raises(tmp_path: Path):
    store = CasefileStore(tmp_path)
    store.ensure_initialized()
    with pytest.raises(KeyError):
        store.set_active_lane("nope")


def test_remove_lane_picks_new_active(tmp_path: Path):
    a = tmp_path / "a"
    a.mkdir()
    store = CasefileStore(tmp_path)
    store.ensure_initialized()
    store.register_lane(name="A", kind="repo", root=a)
    store.set_active_lane("a")
    snapshot = store.remove_lane("a")
    assert snapshot.active_lane_id == "main"


# ---------------------------------------------------------------------------
# Malformed lanes.json
# ---------------------------------------------------------------------------


def test_load_snapshot_rejects_unknown_version(tmp_path: Path):
    store = CasefileStore(tmp_path)
    store.ensure_initialized()
    store.casefile.lanes_file.write_text(
        json.dumps({"version": 999, "lanes": [], "active_lane_id": None}),
        encoding="utf-8",
    )
    with pytest.raises(LanesFileError):
        store.load_snapshot()


def test_load_snapshot_rejects_duplicate_ids(tmp_path: Path):
    store = CasefileStore(tmp_path)
    store.ensure_initialized()
    store.casefile.lanes_file.write_text(
        json.dumps(
            {
                "version": 1,
                "lanes": [
                    {"id": "main", "name": "Main", "kind": "repo", "root": "."},
                    {"id": "main", "name": "Other", "kind": "repo", "root": "."},
                ],
                "active_lane_id": "main",
            }
        ),
        encoding="utf-8",
    )
    with pytest.raises(LanesFileError):
        store.load_snapshot()


def test_unknown_kind_coerces_to_other(tmp_path: Path):
    store = CasefileStore(tmp_path)
    store.ensure_initialized()
    store.casefile.lanes_file.write_text(
        json.dumps(
            {
                "version": 1,
                "lanes": [
                    {"id": "main", "name": "Main", "kind": "future-kind", "root": "."},
                ],
                "active_lane_id": "main",
            }
        ),
        encoding="utf-8",
    )
    snapshot = store.load_snapshot()
    assert snapshot.lanes[0].kind == "other"


def test_default_lane_kind_is_a_known_kind():
    # Guard against accidentally renaming a lane kind without updating the set.
    from assistant_app.casefile import DEFAULT_LANE_KIND

    assert DEFAULT_LANE_KIND in LANE_KINDS


# ---------------------------------------------------------------------------
# Chat persistence
# ---------------------------------------------------------------------------


def test_chat_log_round_trip(tmp_path: Path):
    store = CasefileStore(tmp_path)
    store.ensure_initialized()
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
    # Even if a malicious caller bypasses register_lane and asks for a chat
    # log with a path-traversal id, normalize_lane_id should reject it.
    with pytest.raises(ValueError):
        store.chat_log_path("../escape")


# ---------------------------------------------------------------------------
# CasefileService surface
# ---------------------------------------------------------------------------


def test_service_resolve_lane_defaults_to_active(tmp_path: Path):
    service = CasefileService(tmp_path)
    service.open()
    lane = service.resolve_lane(None)
    assert lane.id == "main"


def test_service_resolve_lane_unknown_raises(tmp_path: Path):
    service = CasefileService(tmp_path)
    service.open()
    with pytest.raises(KeyError):
        service.resolve_lane("ghost")


def test_service_serialize_returns_ipc_friendly_payload(tmp_path: Path):
    service = CasefileService(tmp_path)
    snapshot = service.open()
    payload = service.serialize(snapshot)
    assert payload["root"] == str(tmp_path.resolve())
    assert payload["activeLaneId"] == "main"
    assert isinstance(payload["lanes"], list)
    assert payload["lanes"][0]["id"] == "main"
    # Lane root in IPC is always absolute string.
    assert Path(payload["lanes"][0]["root"]).is_absolute()


def test_lane_dataclass_is_frozen(tmp_path: Path):
    lane = Lane(id="x", name="X", kind="repo", root=tmp_path)
    with pytest.raises(Exception):
        lane.id = "y"  # type: ignore[misc]
