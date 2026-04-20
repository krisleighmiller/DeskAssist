from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest

from assistant_app.casefile import CasefileService
from assistant_app.casefile.export import export_review, render_review_markdown
from assistant_app.casefile.findings import FindingsStore, SourceRef
from assistant_app.casefile.notes import NotesStore


def _casefile_with_two_lanes(tmp_path: Path):
    lane_a = tmp_path / "lane_a"
    lane_a.mkdir()
    lane_b = tmp_path / "lane_b"
    lane_b.mkdir()
    service = CasefileService(tmp_path / "case")
    (tmp_path / "case").mkdir()
    service.open()
    service.register_lane(name="A", kind="repo", root=lane_a, lane_id="a")
    service.register_lane(name="B", kind="repo", root=lane_b, lane_id="b")
    return service.snapshot()


def test_render_review_includes_header_lanes_findings_and_notes(tmp_path: Path):
    snapshot = _casefile_with_two_lanes(tmp_path)
    casefile_root = snapshot.casefile.root
    findings_store = FindingsStore(casefile_root)
    notes_store = NotesStore(casefile_root)
    notes_store.write("a", "Lane A notes go here.")
    finding = findings_store.create(
        title="Race in dispatcher",
        body="Concurrent calls mutate state.",
        severity="high",
        lane_ids=["a", "b"],
        source_refs=[SourceRef(lane_id="a", path="src/x.py", line_start=10, line_end=20)],
    )
    md = render_review_markdown(
        casefile=snapshot.casefile,
        lanes=snapshot.lanes,
        selected_lane_ids=["a", "b"],
        findings=[finding],
        notes_by_lane={"a": notes_store.read("a"), "b": ""},
        generated_at=datetime(2025, 7, 4, 12, 30, tzinfo=timezone.utc),
    )
    assert md.startswith("# Casefile Review:")
    assert "2025-07-04 12:30 UTC" in md
    # Lanes referenced.
    assert "A (`a`)" in md
    assert "B (`b`)" in md
    # Notes section includes A's note but not B's empty one.
    assert "Lane A notes go here." in md
    # Findings section.
    assert "Race in dispatcher" in md
    assert "Severity: **high**" in md
    assert "src/x.py:L10-L20" in md


def test_render_review_handles_empty_findings_and_notes(tmp_path: Path):
    snapshot = _casefile_with_two_lanes(tmp_path)
    md = render_review_markdown(
        casefile=snapshot.casefile,
        lanes=snapshot.lanes,
        selected_lane_ids=["a"],
        findings=[],
        notes_by_lane={"a": ""},
        generated_at=datetime(2025, 1, 1, tzinfo=timezone.utc),
    )
    assert "_No notes recorded for the selected lanes._" in md
    assert "_No findings recorded for the selected lanes._" in md


def test_export_review_writes_file_under_exports_dir(tmp_path: Path):
    snapshot = _casefile_with_two_lanes(tmp_path)
    casefile_root = snapshot.casefile.root
    notes_store = NotesStore(casefile_root)
    notes_store.write("a", "lane A note")
    findings_store = FindingsStore(casefile_root)
    findings_store.create(
        title="Finding 1",
        body="body",
        severity="medium",
        lane_ids=["a"],
    )
    output_path, markdown = export_review(
        casefile_root=casefile_root,
        lanes=snapshot.lanes,
        selected_lane_ids=["a"],
        generated_at=datetime(2025, 5, 1, 9, 15, tzinfo=timezone.utc),
    )
    assert output_path.exists()
    assert output_path.parent == casefile_root / ".casefile" / "exports"
    assert output_path.read_text(encoding="utf-8") == markdown
    assert "Finding 1" in markdown
    assert "lane A note" in markdown


def test_export_review_filters_findings_by_selected_lanes(tmp_path: Path):
    snapshot = _casefile_with_two_lanes(tmp_path)
    casefile_root = snapshot.casefile.root
    findings_store = FindingsStore(casefile_root)
    findings_store.create(title="A only", body="", severity="info", lane_ids=["a"])
    findings_store.create(title="B only", body="", severity="info", lane_ids=["b"])
    findings_store.create(title="A and B", body="", severity="info", lane_ids=["a", "b"])

    _, markdown = export_review(
        casefile_root=casefile_root,
        lanes=snapshot.lanes,
        selected_lane_ids=["a"],
    )
    assert "A only" in markdown
    assert "A and B" in markdown
    assert "B only" not in markdown


def test_export_review_requires_at_least_one_lane(tmp_path: Path):
    snapshot = _casefile_with_two_lanes(tmp_path)
    with pytest.raises(ValueError):
        export_review(
            casefile_root=snapshot.casefile.root,
            lanes=snapshot.lanes,
            selected_lane_ids=[],
        )
