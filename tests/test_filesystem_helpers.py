from pathlib import Path

import pytest

from assistant_app.casefile.models import ScopedDirectory
from assistant_app.filesystem import WorkspaceFilesystem


def test_workspace_filesystem_resolve_relative_blocks_escape(tmp_path: Path):
    fs = WorkspaceFilesystem(tmp_path)
    with pytest.raises(PermissionError):
        fs.resolve_relative("../outside.txt")


def test_workspace_filesystem_read_text_bounded(tmp_path: Path):
    sample = tmp_path / "large.txt"
    sample.write_text("abcdef", encoding="utf-8")
    fs = WorkspaceFilesystem(tmp_path)
    content, truncated, path = fs.read_text_bounded("large.txt", 3)
    assert content == "abc"
    assert truncated is True
    assert path == sample


def test_workspace_filesystem_save_append_delete(tmp_path: Path):
    fs = WorkspaceFilesystem(tmp_path)
    target, written = fs.save_text("notes/todo.txt", "one\n", overwrite=False)
    assert target.exists()
    assert written == len("one\n".encode("utf-8"))

    target, appended = fs.append_text("notes/todo.txt", "two\n")
    assert target.read_text(encoding="utf-8") == "one\ntwo\n"
    assert appended == len("two\n".encode("utf-8"))

    deleted = fs.delete_file("notes/todo.txt")
    assert deleted == target
    assert not target.exists()


def test_workspace_filesystem_refuses_to_delete_workspace_root(tmp_path: Path):
    fs = WorkspaceFilesystem(tmp_path)
    with pytest.raises(PermissionError, match="scoped root"):
        fs.delete_path(".", recursive=True)


def test_workspace_filesystem_refuses_to_delete_writable_scoped_root(tmp_path: Path):
    primary = tmp_path / "primary"
    notes = tmp_path / "notes"
    primary.mkdir()
    notes.mkdir()
    fs = WorkspaceFilesystem(
        primary,
        scoped_directories=(
            ScopedDirectory(path=primary, label="primary", writable=True),
            ScopedDirectory(path=notes, label="notes", writable=True),
        ),
    )
    with pytest.raises(PermissionError, match="scoped root"):
        fs.delete_path("_scope/notes", recursive=True)
