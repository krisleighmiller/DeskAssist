"""Tests for `WorkspaceFilesystem` scoped multi-root routing."""

from __future__ import annotations

from pathlib import Path

import pytest

from assistant_app.casefile.models import ScopedDirectory
from assistant_app.filesystem import WorkspaceFilesystem


def _make(tmp_path: Path) -> tuple[Path, Path, Path]:
    write = tmp_path / "write"
    overlay_a = tmp_path / "overlay_a"
    overlay_b = tmp_path / "overlay_b"
    write.mkdir()
    overlay_a.mkdir()
    overlay_b.mkdir()
    (write / "own.md").write_text("own", encoding="utf-8")
    (overlay_a / "rubric.md").write_text("rubric body", encoding="utf-8")
    (overlay_b / "log.md").write_text("log body", encoding="utf-8")
    return write, overlay_a, overlay_b


def test_read_falls_back_to_write_root_without_overlays(tmp_path: Path):
    write, _, _ = _make(tmp_path)
    fs = WorkspaceFilesystem(write)
    content, _, _ = fs.read_text_bounded("own.md", 100)
    assert content == "own"


def test_overlay_read_routes_to_correct_root(tmp_path: Path):
    write, overlay_a, overlay_b = _make(tmp_path)
    fs = WorkspaceFilesystem(
        write,
        read_overlays={
            "_ancestors/family": overlay_a,
            "_attachments/notes": overlay_b,
        },
    )
    content_a, _, target_a = fs.read_text_bounded("_ancestors/family/rubric.md", 100)
    content_b, _, target_b = fs.read_text_bounded("_attachments/notes/log.md", 100)
    assert content_a == "rubric body"
    assert target_a == (overlay_a / "rubric.md").resolve()
    assert content_b == "log body"
    assert target_b == (overlay_b / "log.md").resolve()


def test_longer_overlay_prefix_takes_precedence(tmp_path: Path):
    """Nested overlay (e.g. ancestor-attachment) must win over its parent prefix."""
    write, overlay_a, overlay_b = _make(tmp_path)
    fs = WorkspaceFilesystem(
        write,
        read_overlays={
            "_ancestors/family": overlay_a,
            "_ancestors/family/_attachments/log": overlay_b,
        },
    )
    content, _, target = fs.read_text_bounded(
        "_ancestors/family/_attachments/log/log.md", 100
    )
    assert content == "log body"
    assert target == (overlay_b / "log.md").resolve()


def test_traversal_inside_overlay_is_blocked(tmp_path: Path):
    write, overlay_a, _ = _make(tmp_path)
    (tmp_path / "outside.md").write_text("nope", encoding="utf-8")
    fs = WorkspaceFilesystem(write, read_overlays={"_ancestors/family": overlay_a})
    with pytest.raises(PermissionError):
        fs.read_text_bounded("_ancestors/family/../outside.md", 100)


def test_writes_to_overlay_paths_are_rejected(tmp_path: Path):
    write, overlay_a, _ = _make(tmp_path)
    fs = WorkspaceFilesystem(write, read_overlays={"_ancestors/family": overlay_a})
    with pytest.raises(PermissionError):
        fs.save_text("_ancestors/family/new.md", "x", overwrite=True)
    with pytest.raises(PermissionError):
        fs.append_text("_ancestors/family/rubric.md", "x")
    with pytest.raises(PermissionError):
        fs.delete_file("_ancestors/family/rubric.md")
    with pytest.raises(PermissionError):
        fs.delete_path("_ancestors/family", recursive=True)


def test_writes_to_write_root_still_work(tmp_path: Path):
    write, overlay_a, _ = _make(tmp_path)
    fs = WorkspaceFilesystem(write, read_overlays={"_ancestors/family": overlay_a})
    target, _ = fs.save_text("new.md", "hello", overwrite=False)
    assert target == (write / "new.md").resolve()
    assert (write / "new.md").read_text(encoding="utf-8") == "hello"


def test_traversal_into_write_root_still_blocked(tmp_path: Path):
    write, overlay_a, _ = _make(tmp_path)
    fs = WorkspaceFilesystem(write, read_overlays={"_ancestors/family": overlay_a})
    with pytest.raises(PermissionError):
        fs.resolve_relative("../escape")


def test_list_dir_of_write_root_advertises_overlay_prefixes(tmp_path: Path):
    write, overlay_a, overlay_b = _make(tmp_path)
    fs = WorkspaceFilesystem(
        write,
        read_overlays={
            "_ancestors/family": overlay_a,
            "_attachments/notes": overlay_b,
        },
    )
    _, entries = fs.list_dir(".")
    overlay_entries = [e for e in entries if e["type"] == "overlay"]
    overlay_names = {e["name"] for e in overlay_entries}
    assert overlay_names == {"_ancestors", "_attachments"}


def test_list_dir_inside_overlay_returns_overlay_contents(tmp_path: Path):
    write, overlay_a, _ = _make(tmp_path)
    fs = WorkspaceFilesystem(write, read_overlays={"_ancestors/family": overlay_a})
    target, entries = fs.list_dir("_ancestors/family")
    assert target == overlay_a.resolve()
    assert {e["name"] for e in entries} == {"rubric.md"}


def test_scoped_directories_allow_writes_only_on_writable_mounts(tmp_path: Path):
    write, overlay_a, overlay_b = _make(tmp_path)
    fs = WorkspaceFilesystem(
        write,
        scoped_directories=(
            ScopedDirectory(path=write, label="main", writable=True),
            ScopedDirectory(path=overlay_a, label="notes", writable=True),
            ScopedDirectory(path=overlay_b, label="logs", writable=False),
        ),
    )

    target, _ = fs.save_text("_scope/notes/new.md", "hello", overwrite=False)
    assert target == (overlay_a / "new.md").resolve()
    assert (overlay_a / "new.md").read_text(encoding="utf-8") == "hello"

    with pytest.raises(PermissionError):
        fs.save_text("_scope/logs/new.md", "nope", overwrite=False)


def test_scoped_directories_block_bare_writes_when_primary_root_is_not_writable(tmp_path: Path):
    casefile_root = tmp_path / "case"
    ref_root = tmp_path / "reference"
    casefile_root.mkdir()
    ref_root.mkdir()
    fs = WorkspaceFilesystem(
        casefile_root,
        scoped_directories=(ScopedDirectory(path=ref_root, label="reference", writable=False),),
    )

    with pytest.raises(PermissionError):
        fs.save_text("escape.md", "blocked", overwrite=False)


def test_scoped_directories_block_bare_reads_when_no_mount_matches_root(tmp_path: Path):
    casefile_root = tmp_path / "case"
    ref_root = tmp_path / "reference"
    casefile_root.mkdir()
    ref_root.mkdir()
    (casefile_root / "secret.md").write_text("not in scope", encoding="utf-8")
    (ref_root / "public.md").write_text("in scope", encoding="utf-8")
    fs = WorkspaceFilesystem(
        casefile_root,
        scoped_directories=(ScopedDirectory(path=ref_root, label="reference", writable=False),),
    )

    with pytest.raises(PermissionError):
        fs.read_text_bounded("secret.md", 100)
    content, _, target = fs.read_text_bounded("_scope/reference/public.md", 100)
    assert content == "in scope"
    assert target == (ref_root / "public.md").resolve()


def test_read_only_scoped_root_lists_only_virtual_mounts(tmp_path: Path):
    casefile_root = tmp_path / "case"
    ref_root = tmp_path / "reference"
    casefile_root.mkdir()
    ref_root.mkdir()
    (casefile_root / "secret.md").write_text("not in scope", encoding="utf-8")
    fs = WorkspaceFilesystem(
        casefile_root,
        scoped_directories=(ScopedDirectory(path=ref_root, label="reference", writable=False),),
    )

    target, entries = fs.list_dir(".")
    assert target == casefile_root.resolve()
    assert entries == [{"name": "_scope", "type": "overlay"}]
