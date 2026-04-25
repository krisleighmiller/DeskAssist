"""Migration tests for lanes.json v1 -> v2 (M3.5a).

The contract:
  - A lanes.json written by M2/M3 (version 1, no parent_id, no attachments)
    must load without intervention.
  - Loading alone does not rewrite the file (read-only when nothing changed).
  - The first mutation (register_lane / set_active_lane / etc.) rewrites the
    file as version 2 with the new fields populated to safe defaults.
  - A v2 file round-trips cleanly through register/load.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from assistant_app.casefile import CasefileStore, LaneAttachment
from assistant_app.casefile.store import LanesFileError


def _write_v1_lanes(casefile_root: Path, lanes: list[dict], active: str) -> Path:
    meta = casefile_root / ".casefile"
    meta.mkdir(parents=True, exist_ok=True)
    payload = {"version": 1, "lanes": lanes, "active_lane_id": active}
    target = meta / "lanes.json"
    target.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return target


def test_v1_file_loads_with_default_parent_and_attachments(tmp_path: Path):
    (tmp_path / "ash").mkdir()
    (tmp_path / "elm").mkdir()
    _write_v1_lanes(
        tmp_path,
        [
            {"id": "main", "name": "Main", "kind": "repo", "root": "."},
            {"id": "ash", "name": "Ash", "kind": "repo", "root": "ash"},
            {"id": "elm", "name": "Elm", "kind": "repo", "root": "elm"},
        ],
        "ash",
    )
    store = CasefileStore(tmp_path)
    snapshot = store.load_snapshot()
    assert {lane.id for lane in snapshot.lanes} == {"main", "ash", "elm"}
    for lane in snapshot.lanes:
        assert lane.parent_id is None
        assert lane.attachments == ()
    assert snapshot.active_lane_id == "ash"


def test_v1_load_does_not_rewrite_file(tmp_path: Path):
    target = _write_v1_lanes(
        tmp_path,
        [{"id": "main", "name": "Main", "kind": "repo", "root": "."}],
        "main",
    )
    raw_before = target.read_bytes()
    store = CasefileStore(tmp_path)
    store.load_snapshot()
    assert target.read_bytes() == raw_before


def test_first_mutation_rewrites_as_v2(tmp_path: Path):
    (tmp_path / "child").mkdir()
    target = _write_v1_lanes(
        tmp_path,
        [{"id": "main", "name": "Main", "kind": "repo", "root": "."}],
        "main",
    )
    store = CasefileStore(tmp_path)
    store.register_lane(name="Child", kind="repo", root=tmp_path / "child")
    raw_after = json.loads(target.read_text(encoding="utf-8"))
    assert raw_after["version"] == 2
    for entry in raw_after["lanes"]:
        assert "parent_id" in entry
        assert "attachments" in entry
        assert entry["attachments"] == []


def test_unknown_future_version_is_rejected(tmp_path: Path):
    _write_v1_lanes(tmp_path, [{"id": "main", "name": "Main", "kind": "repo", "root": "."}], "main")
    target = tmp_path / ".casefile" / "lanes.json"
    payload = json.loads(target.read_text(encoding="utf-8"))
    payload["version"] = 99
    target.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(LanesFileError):
        CasefileStore(tmp_path).load_snapshot()


def test_v2_round_trip_with_parent_and_attachments(tmp_path: Path):
    (tmp_path / "task9").mkdir()
    (tmp_path / "task9" / "ash").mkdir()
    (tmp_path / "task9" / "ash_notes").mkdir()
    store = CasefileStore(tmp_path)
    store.register_lane(name="Task 9", kind="other", root=tmp_path / "task9")
    snap = store.register_lane(
        name="Ash",
        kind="repo",
        root=tmp_path / "task9" / "ash",
        parent_id="task-9",
        attachments=[LaneAttachment(name="notes", root=tmp_path / "task9" / "ash_notes")],
    )
    ash = snap.lane_by_id("ash")
    assert ash.parent_id == "task-9"
    assert len(ash.attachments) == 1
    assert ash.attachments[0].name == "notes"
    assert ash.attachments[0].root == (tmp_path / "task9" / "ash_notes").resolve()
    # Reload from disk
    store2 = CasefileStore(tmp_path)
    snap2 = store2.load_snapshot()
    ash2 = snap2.lane_by_id("ash")
    assert ash2.parent_id == "task-9"
    assert ash2.attachments == ash.attachments


def test_dangling_parent_id_is_silently_dropped(tmp_path: Path):
    """If a parent is deleted out-of-band, child loads as a root, not crash."""
    (tmp_path / "child").mkdir()
    meta = tmp_path / ".casefile"
    meta.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": 2,
        "lanes": [
            {
                "id": "child",
                "name": "Child",
                "kind": "repo",
                "root": "child",
                "parent_id": "ghost",
                "attachments": [],
            }
        ],
        "active_lane_id": "child",
    }
    (meta / "lanes.json").write_text(json.dumps(payload), encoding="utf-8")
    snapshot = CasefileStore(tmp_path).load_snapshot()
    assert snapshot.lane_by_id("child").parent_id is None


def test_register_with_unknown_parent_raises(tmp_path: Path):
    (tmp_path / "child").mkdir()
    store = CasefileStore(tmp_path)
    store.ensure_initialized()
    with pytest.raises(KeyError):
        store.register_lane(
            name="Child",
            kind="repo",
            root=tmp_path / "child",
            parent_id="not-a-real-lane",
        )


def test_set_lane_parent_rejects_cycle(tmp_path: Path):
    (tmp_path / "a").mkdir()
    (tmp_path / "b").mkdir()
    store = CasefileStore(tmp_path)
    store.ensure_initialized()
    store.register_lane(name="A", kind="repo", root=tmp_path / "a")
    store.register_lane(name="B", kind="repo", root=tmp_path / "b", parent_id="a")
    # Trying to make 'a' a child of 'b' would form a 1-cycle through 'b -> a'.
    with pytest.raises(ValueError):
        store.set_lane_parent("a", "b")


def test_remove_lane_reparents_children(tmp_path: Path):
    (tmp_path / "p").mkdir()
    (tmp_path / "c").mkdir()
    store = CasefileStore(tmp_path)
    store.ensure_initialized()
    store.register_lane(name="Parent", kind="repo", root=tmp_path / "p")
    store.register_lane(name="Child", kind="repo", root=tmp_path / "c", parent_id="parent")
    snap = store.remove_lane("parent")
    child = snap.lane_by_id("child")
    # Parent had no parent itself, so child should be re-parented to None.
    assert child.parent_id is None
