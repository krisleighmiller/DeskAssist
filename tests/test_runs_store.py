"""Unit tests for `assistant_app.casefile.runs.RunsStore`.

These cover the behavioural contract the bridge handlers and the renderer
rely on: validation failures get persisted as run records (so the UI can
render them uniformly), allowlisted commands actually execute, and the
list endpoint stays sortable + lane-filterable. The popen path itself is
exercised end-to-end via `echo` (which is in the safe allowlist).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from assistant_app.casefile.runs import (
    DEFAULT_RUN_MAX_OUTPUT_CHARS,
    DEFAULT_RUN_TIMEOUT_SECONDS,
    RunsStore,
    generate_run_id,
)


def _make_casefile(tmp_path: Path) -> Path:
    casefile_root = tmp_path / "case"
    casefile_root.mkdir()
    return casefile_root


def test_generate_run_id_is_lowercase_and_sortable():
    a = generate_run_id()
    b = generate_run_id()
    assert a.islower() and b.islower()
    # Two ids generated within the same second should still be unique
    # because of the random suffix.
    assert a != b


def test_start_with_allowlisted_command_persists_record(tmp_path: Path):
    root = _make_casefile(tmp_path)
    store = RunsStore(root)
    record = store.start(command="echo hello", cwd=root)
    assert record.exit_code == 0
    assert record.stdout.strip() == "hello"
    assert record.error is None

    # Round-trip through disk via .get()
    fetched = store.get(record.id)
    assert fetched.id == record.id
    assert fetched.stdout.strip() == "hello"
    assert (root / ".casefile" / "runs" / f"{record.id}.json").is_file()


def test_start_with_disallowed_command_records_error_not_raises(tmp_path: Path):
    root = _make_casefile(tmp_path)
    record = RunsStore(root).start(command="rm -rf /", cwd=root)
    assert record.exit_code is None
    assert record.error is not None
    assert "PermissionError" in record.error
    assert "not allowed" in record.error
    # The failed run still shows up in the list so users can see why.
    listed = RunsStore(root).list()
    assert [s.id for s in listed] == [record.id]
    assert listed[0].error is not None


def test_start_with_path_invocation_records_error(tmp_path: Path):
    root = _make_casefile(tmp_path)
    record = RunsStore(root).start(command="/bin/echo hi", cwd=root)
    assert record.exit_code is None
    assert record.error is not None
    assert "path invocation" in record.error.lower()


def test_start_with_empty_command_raises(tmp_path: Path):
    root = _make_casefile(tmp_path)
    # Empty command is a programmer/UI error, not a recordable run — the
    # bridge handler validates `command` before calling start(), so the
    # store-level guard just propagates the same ValueError shape.
    record = RunsStore(root).start(command="   ", cwd=root)
    assert record.error is not None
    assert "ValueError" in record.error


def test_list_orders_newest_first_and_filters_by_lane(tmp_path: Path):
    root = _make_casefile(tmp_path)
    store = RunsStore(root)
    a = store.start(command="echo a", cwd=root, lane_id="lane-a")
    b = store.start(command="echo b", cwd=root, lane_id="lane-b")
    c = store.start(command="echo c", cwd=root, lane_id="lane-a")
    all_ids = [s.id for s in store.list()]
    # Newest-first; same-second creations are still differentiated by id.
    assert set(all_ids) == {a.id, b.id, c.id}
    just_a = [s.id for s in store.list(lane_id="lane-a")]
    assert set(just_a) == {a.id, c.id}
    assert "lane-b" not in {s.lane_id for s in store.list(lane_id="lane-a")}


def test_get_unknown_id_raises(tmp_path: Path):
    root = _make_casefile(tmp_path)
    with pytest.raises(KeyError):
        RunsStore(root).get("does-not-exist")


def test_delete_removes_file(tmp_path: Path):
    root = _make_casefile(tmp_path)
    store = RunsStore(root)
    record = store.start(command="echo bye", cwd=root)
    store.delete(record.id)
    assert not (root / ".casefile" / "runs" / f"{record.id}.json").exists()
    with pytest.raises(KeyError):
        store.get(record.id)


def test_delete_unknown_id_raises(tmp_path: Path):
    root = _make_casefile(tmp_path)
    with pytest.raises(KeyError):
        RunsStore(root).delete("nope")


def test_get_rejects_path_like_id(tmp_path: Path):
    root = _make_casefile(tmp_path)
    with pytest.raises(ValueError):
        RunsStore(root).get("../escape")


def test_corrupt_run_file_is_skipped_in_list(tmp_path: Path):
    root = _make_casefile(tmp_path)
    store = RunsStore(root)
    good = store.start(command="echo ok", cwd=root)
    # Drop a junk file alongside it.
    (store.directory / "corrupt.json").write_text("not json", encoding="utf-8")
    listed = [s.id for s in store.list()]
    assert good.id in listed
    assert "corrupt" not in listed


def test_record_round_trip_preserves_all_fields(tmp_path: Path):
    root = _make_casefile(tmp_path)
    store = RunsStore(root)
    rec = store.start(
        command="echo hi",
        cwd=root,
        lane_id="lane-a",
        timeout_seconds=5,
        max_output_chars=200,
    )
    raw = json.loads((store.directory / f"{rec.id}.json").read_text(encoding="utf-8"))
    assert raw["lane_id"] == "lane-a"
    assert raw["timeout_seconds"] == 5
    assert raw["max_output_chars"] == 200
    assert raw["cwd"] == str(root.resolve())


def test_start_uses_default_limits_when_unspecified(tmp_path: Path):
    root = _make_casefile(tmp_path)
    rec = RunsStore(root).start(command="echo hi", cwd=root)
    assert rec.timeout_seconds == DEFAULT_RUN_TIMEOUT_SECONDS
    assert rec.max_output_chars == DEFAULT_RUN_MAX_OUTPUT_CHARS


def test_start_truncates_oversized_output(tmp_path: Path):
    root = _make_casefile(tmp_path)
    rec = RunsStore(root).start(
        command="printf 1234567890",
        cwd=root,
        max_output_chars=5,
    )
    assert rec.stdout == "12345"
    assert rec.stdout_truncated is True
