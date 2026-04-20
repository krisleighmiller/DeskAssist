from __future__ import annotations

from pathlib import Path

import pytest

from assistant_app.casefile import CasefileService
from assistant_app.filesystem import WorkspaceFilesystem


def _setup_two_lanes(tmp_path: Path) -> tuple[Path, Path, Path]:
    """Create a casefile with two sibling lanes, each containing one file."""
    casefile_root = tmp_path / "case"
    casefile_root.mkdir()
    lane_a = tmp_path / "lane_a"
    lane_a.mkdir()
    lane_b = tmp_path / "lane_b"
    lane_b.mkdir()
    (lane_a / "secret_a.txt").write_text("from A", encoding="utf-8")
    (lane_b / "secret_b.txt").write_text("from B", encoding="utf-8")

    service = CasefileService(casefile_root)
    service.open()
    service.register_lane(name="lane a", kind="repo", root=lane_a, lane_id="a")
    service.register_lane(name="lane b", kind="repo", root=lane_b, lane_id="b")
    return casefile_root, lane_a, lane_b


def test_lane_scoped_filesystem_can_read_its_own_files(tmp_path: Path):
    _, lane_a, _ = _setup_two_lanes(tmp_path)
    fs = WorkspaceFilesystem(lane_a)
    content, truncated, _ = fs.read_text_bounded("secret_a.txt", 1024)
    assert content == "from A"
    assert truncated is False


def test_lane_scoped_filesystem_cannot_read_sibling_lane_via_relative(tmp_path: Path):
    _, lane_a, _ = _setup_two_lanes(tmp_path)
    fs = WorkspaceFilesystem(lane_a)
    # Walking up out of lane_a into lane_b is exactly what scoping must block.
    with pytest.raises(PermissionError):
        fs.resolve_relative("../lane_b/secret_b.txt")


def test_lane_scoped_filesystem_cannot_read_sibling_lane_via_absolute(tmp_path: Path):
    _, lane_a, lane_b = _setup_two_lanes(tmp_path)
    fs = WorkspaceFilesystem(lane_a)
    # Absolute paths into the sibling lane are also rejected.
    with pytest.raises(PermissionError):
        fs.resolve_relative(str(lane_b / "secret_b.txt"))


def test_lane_scoped_filesystem_cannot_write_into_sibling_lane(tmp_path: Path):
    _, lane_a, _ = _setup_two_lanes(tmp_path)
    fs = WorkspaceFilesystem(lane_a)
    with pytest.raises(PermissionError):
        fs.save_text("../lane_b/poisoned.txt", "nope", overwrite=True)
