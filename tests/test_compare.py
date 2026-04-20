from __future__ import annotations

import os
from pathlib import Path

import pytest

from assistant_app.casefile.compare import compare_lanes
from assistant_app.casefile.models import Lane


def _lane(lane_id: str, root: Path) -> Lane:
    return Lane(id=lane_id, name=lane_id, kind="repo", root=root.resolve())


def test_compare_empty_lanes(tmp_path: Path):
    a = tmp_path / "a"
    b = tmp_path / "b"
    a.mkdir()
    b.mkdir()
    result = compare_lanes(_lane("a", a), _lane("b", b))
    assert result.added == ()
    assert result.removed == ()
    assert result.changed == ()


def test_compare_detects_added_removed_and_changed(tmp_path: Path):
    a = tmp_path / "a"
    b = tmp_path / "b"
    a.mkdir()
    b.mkdir()
    (a / "shared.txt").write_text("alpha", encoding="utf-8")
    (a / "only_in_a.txt").write_text("x", encoding="utf-8")
    (b / "shared.txt").write_text("beta", encoding="utf-8")
    (b / "only_in_b.txt").write_text("y", encoding="utf-8")
    (a / "identical.txt").write_text("same", encoding="utf-8")
    (b / "identical.txt").write_text("same", encoding="utf-8")

    result = compare_lanes(_lane("a", a), _lane("b", b))
    assert result.added == ("only_in_b.txt",)
    assert result.removed == ("only_in_a.txt",)
    assert tuple(c.path for c in result.changed) == ("shared.txt",)
    # Identical files must not appear anywhere.
    all_paths = set(result.added) | set(result.removed) | {c.path for c in result.changed}
    assert "identical.txt" not in all_paths


def test_compare_walks_subdirectories(tmp_path: Path):
    a = tmp_path / "a"
    b = tmp_path / "b"
    (a / "sub").mkdir(parents=True)
    (b / "sub").mkdir(parents=True)
    (a / "sub" / "f.txt").write_text("1", encoding="utf-8")
    (b / "sub" / "f.txt").write_text("2", encoding="utf-8")
    result = compare_lanes(_lane("a", a), _lane("b", b))
    assert tuple(c.path for c in result.changed) == ("sub/f.txt",)


def test_compare_skips_casefile_metadata(tmp_path: Path):
    a = tmp_path / "a"
    b = tmp_path / "b"
    (a / ".casefile").mkdir(parents=True)
    (b / ".casefile").mkdir(parents=True)
    (a / ".casefile" / "lanes.json").write_text("{}", encoding="utf-8")
    (b / ".casefile" / "lanes.json").write_text("[]", encoding="utf-8")
    result = compare_lanes(_lane("a", a), _lane("b", b))
    assert result.added == ()
    assert result.removed == ()
    assert result.changed == ()


def test_compare_respects_skip_dir_names_override(tmp_path: Path):
    a = tmp_path / "a"
    b = tmp_path / "b"
    (a / "build").mkdir(parents=True)
    (b / "build").mkdir(parents=True)
    (a / "build" / "out.bin").write_text("1", encoding="utf-8")
    (b / "build" / "out.bin").write_text("2", encoding="utf-8")
    # Override default skip list to *only* skip "build" — confirms override is applied.
    result = compare_lanes(_lane("a", a), _lane("b", b), skip_dir_names=["build"])
    assert result.changed == ()


@pytest.mark.skipif(os.name == "nt", reason="Symlink behavior differs on Windows")
def test_compare_skips_symlinks(tmp_path: Path):
    a = tmp_path / "a"
    b = tmp_path / "b"
    a.mkdir()
    b.mkdir()
    (a / "real.txt").write_text("hi", encoding="utf-8")
    (a / "link.txt").symlink_to(a / "real.txt")
    (b / "real.txt").write_text("hi", encoding="utf-8")
    # Symlink in `a` must not appear as a removed entry just because `b` lacks it.
    result = compare_lanes(_lane("a", a), _lane("b", b))
    assert "link.txt" not in result.added
    assert "link.txt" not in result.removed
