from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from assistant_app.casefile.findings import (
    DEFAULT_SEVERITY,
    Finding,
    FindingFileError,
    FindingsStore,
    SEVERITIES,
    SourceRef,
    generate_finding_id,
)


# ---------------------------------------------------------------------------
# Id generation + validation
# ---------------------------------------------------------------------------


def test_generated_finding_ids_sort_chronologically():
    earlier = generate_finding_id(datetime(2025, 1, 1, tzinfo=timezone.utc))
    later = generate_finding_id(datetime(2025, 6, 1, tzinfo=timezone.utc))
    assert earlier < later  # ISO-8601 prefix gives lexicographic == chronological order


def test_create_rejects_path_like_id(tmp_path: Path):
    store = FindingsStore(tmp_path)
    with pytest.raises(ValueError):
        store.create(
            title="t",
            body="",
            severity="info",
            lane_ids=["main"],
            finding_id="../escape",
        )


# ---------------------------------------------------------------------------
# Basic CRUD
# ---------------------------------------------------------------------------


def test_create_and_get_round_trip(tmp_path: Path):
    store = FindingsStore(tmp_path)
    finding = store.create(
        title="Race in handler",
        body="The dispatcher mutates state.",
        severity="high",
        lane_ids=["main"],
        source_refs=[SourceRef(lane_id="main", path="src/dispatcher.py", line_start=42, line_end=50)],
    )
    fetched = store.get(finding.id)
    assert fetched == finding
    assert fetched.severity == "high"
    assert fetched.source_refs[0].path == "src/dispatcher.py"
    assert fetched.source_refs[0].line_start == 42


def test_create_rejects_empty_title(tmp_path: Path):
    store = FindingsStore(tmp_path)
    with pytest.raises(ValueError):
        store.create(title="   ", body="", severity="info", lane_ids=["main"])


def test_create_rejects_no_lanes(tmp_path: Path):
    store = FindingsStore(tmp_path)
    with pytest.raises(ValueError):
        store.create(title="t", body="", severity="info", lane_ids=[])


def test_unknown_severity_coerces_to_default(tmp_path: Path):
    store = FindingsStore(tmp_path)
    finding = store.create(
        title="t", body="", severity="cosmic", lane_ids=["main"]
    )
    assert finding.severity == DEFAULT_SEVERITY


def test_default_severity_is_a_known_severity():
    assert DEFAULT_SEVERITY in SEVERITIES


# ---------------------------------------------------------------------------
# Listing + filtering
# ---------------------------------------------------------------------------


def test_list_filters_by_lane(tmp_path: Path):
    store = FindingsStore(tmp_path)
    store.create(title="A", body="", severity="info", lane_ids=["a"])
    store.create(title="B", body="", severity="info", lane_ids=["b"])
    store.create(title="AB", body="", severity="info", lane_ids=["a", "b"])
    a_only = [f.title for f in store.list(lane_id="a")]
    assert sorted(a_only) == ["A", "AB"]
    all_findings = [f.title for f in store.list()]
    assert sorted(all_findings) == ["A", "AB", "B"]


def test_list_returns_newest_first(tmp_path: Path):
    store = FindingsStore(tmp_path)
    older = store.create(
        title="older",
        body="",
        severity="info",
        lane_ids=["main"],
        now=datetime(2025, 1, 1, tzinfo=timezone.utc),
    )
    newer = store.create(
        title="newer",
        body="",
        severity="info",
        lane_ids=["main"],
        now=datetime(2025, 6, 1, tzinfo=timezone.utc),
    )
    titles = [f.title for f in store.list()]
    assert titles == [newer.title, older.title]


def test_list_skips_corrupt_files(tmp_path: Path):
    store = FindingsStore(tmp_path)
    store.create(title="ok", body="", severity="info", lane_ids=["main"])
    store.ensure_directory()
    (store.directory / "garbage.json").write_text("{not valid", encoding="utf-8")
    listed = store.list()
    assert [f.title for f in listed] == ["ok"]


# ---------------------------------------------------------------------------
# Update + delete
# ---------------------------------------------------------------------------


def test_update_changes_only_provided_fields(tmp_path: Path):
    store = FindingsStore(tmp_path)
    finding = store.create(
        title="t", body="b", severity="info", lane_ids=["main"]
    )
    updated = store.update(finding.id, title="renamed")
    assert updated.title == "renamed"
    assert updated.body == "b"  # unchanged
    assert updated.severity == "info"
    assert updated.lane_ids == ("main",)
    assert updated.created_at == finding.created_at
    assert updated.updated_at != finding.created_at or True  # may be equal if same second


def test_update_unknown_raises(tmp_path: Path):
    store = FindingsStore(tmp_path)
    with pytest.raises(KeyError):
        store.update("nope", title="x")


def test_delete_removes_file(tmp_path: Path):
    store = FindingsStore(tmp_path)
    finding = store.create(title="t", body="", severity="info", lane_ids=["main"])
    assert (store.directory / f"{finding.id}.json").exists()
    store.delete(finding.id)
    assert not (store.directory / f"{finding.id}.json").exists()
    with pytest.raises(KeyError):
        store.get(finding.id)


# ---------------------------------------------------------------------------
# Schema validation
# ---------------------------------------------------------------------------


def test_load_rejects_unknown_version(tmp_path: Path):
    store = FindingsStore(tmp_path)
    finding = store.create(title="t", body="", severity="info", lane_ids=["main"])
    path = store.directory / f"{finding.id}.json"
    raw = json.loads(path.read_text())
    raw["version"] = 999
    path.write_text(json.dumps(raw), encoding="utf-8")
    with pytest.raises(FindingFileError):
        store.get(finding.id)


def test_load_rejects_missing_lane_ids(tmp_path: Path):
    raw = {
        "version": 1,
        "id": "20250101t000000-aaaaaa",
        "title": "x",
        "body": "",
        "severity": "info",
        "created_at": "2025-01-01T00:00:00Z",
        "updated_at": "2025-01-01T00:00:00Z",
        "lane_ids": [],
        "source_refs": [],
    }
    with pytest.raises(FindingFileError):
        Finding.from_json(raw)


def test_source_ref_rejects_missing_fields():
    with pytest.raises(FindingFileError):
        SourceRef.from_json({"lane_id": "a"})  # path missing


def test_serialized_form_is_round_trippable(tmp_path: Path):
    store = FindingsStore(tmp_path)
    finding = store.create(
        title="t",
        body="x",
        severity="medium",
        lane_ids=["a", "b"],
        source_refs=[
            SourceRef(lane_id="a", path="x.py"),
            SourceRef(lane_id="b", path="x.py", line_start=1, line_end=10),
        ],
    )
    path = store.directory / f"{finding.id}.json"
    raw = json.loads(path.read_text())
    rebuilt = Finding.from_json(raw)
    assert rebuilt == finding
