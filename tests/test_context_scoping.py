from __future__ import annotations

from pathlib import Path

import pytest

from assistant_app.casefile import CasefileService
from assistant_app.filesystem import WorkspaceFilesystem


def _setup_two_scope(tmp_path: Path) -> tuple[Path, Path, Path]:
    """Create a casefile with two sibling contexts, each containing one file."""
    casefile_root = tmp_path / "case"
    casefile_root.mkdir()
    context_a = tmp_path / "context_a"
    context_a.mkdir()
    context_b = tmp_path / "context_b"
    context_b.mkdir()
    (context_a / "secret_a.txt").write_text("from A", encoding="utf-8")
    (context_b / "secret_b.txt").write_text("from B", encoding="utf-8")

    service = CasefileService(casefile_root)
    service.open()
    service.register_context(name="context a", kind="repo", root=context_a, context_id="a")
    service.register_context(name="context b", kind="repo", root=context_b, context_id="b")
    return casefile_root, context_a, context_b


def test_context_scoped_filesystem_can_read_its_own_files(tmp_path: Path):
    _, context_a, _ = _setup_two_scope(tmp_path)
    fs = WorkspaceFilesystem(context_a)
    content, truncated, _ = fs.read_text_bounded("secret_a.txt", 1024)
    assert content == "from A"
    assert truncated is False


def test_context_scoped_filesystem_cannot_read_sibling_context_via_relative(tmp_path: Path):
    _, context_a, _ = _setup_two_scope(tmp_path)
    fs = WorkspaceFilesystem(context_a)
    # Walking up out of context_a into context_b is exactly what scoping must block.
    with pytest.raises(PermissionError):
        fs.resolve_relative("../context_b/secret_b.txt")


def test_context_scoped_filesystem_cannot_read_sibling_context_via_absolute(tmp_path: Path):
    _, context_a, context_b = _setup_two_scope(tmp_path)
    fs = WorkspaceFilesystem(context_a)
    # Absolute paths into the sibling context are also rejected.
    with pytest.raises(PermissionError):
        fs.resolve_relative(str(context_b / "secret_b.txt"))


def test_context_scoped_filesystem_cannot_write_into_sibling_context(tmp_path: Path):
    _, context_a, _ = _setup_two_scope(tmp_path)
    fs = WorkspaceFilesystem(context_a)
    with pytest.raises(PermissionError):
        fs.save_text("../context_b/poisoned.txt", "nope", overwrite=True)
