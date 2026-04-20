from __future__ import annotations

from pathlib import Path
import shutil


class WorkspaceFilesystem:
    def __init__(self, workspace_root: Path) -> None:
        self.workspace_root = workspace_root.resolve()

    def resolve_relative(self, candidate: str) -> Path:
        path = (self.workspace_root / candidate).resolve()
        if not path.is_relative_to(self.workspace_root):
            raise PermissionError(f"Path escapes workspace: {candidate}")
        return path

    def read_text_bounded(self, candidate: str, max_chars: int) -> tuple[str, bool, Path]:
        if max_chars <= 0:
            raise ValueError("max_chars must be greater than 0")
        target = self.resolve_relative(candidate)
        if not target.exists():
            raise FileNotFoundError(f"File not found: {candidate}")
        if not target.is_file():
            raise IsADirectoryError(f"Not a file: {candidate}")
        with target.open("r", encoding="utf-8") as handle:
            sampled = handle.read(max_chars + 1)
        truncated = len(sampled) > max_chars
        return sampled[:max_chars], truncated, target

    def list_dir(self, candidate: str) -> tuple[Path, list[dict[str, str]]]:
        target = self.resolve_relative(candidate)
        if not target.exists():
            raise FileNotFoundError(f"Directory not found: {candidate}")
        if not target.is_dir():
            raise NotADirectoryError(f"Not a directory: {candidate}")
        entries: list[dict[str, str]] = []
        for item in sorted(target.iterdir(), key=lambda p: p.name.lower()):
            entries.append({"name": item.name, "type": "dir" if item.is_dir() else "file"})
        return target, entries

    def save_text(self, candidate: str, content: str, overwrite: bool) -> tuple[Path, int]:
        target = self.resolve_relative(candidate)
        if target.exists() and not overwrite:
            raise FileExistsError(f"File already exists: {candidate}")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        return target, len(content.encode("utf-8"))

    def append_text(self, candidate: str, content: str) -> tuple[Path, int]:
        target = self.resolve_relative(candidate)
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("a", encoding="utf-8") as handle:
            handle.write(content)
        return target, len(content.encode("utf-8"))

    def delete_file(self, candidate: str) -> Path:
        target = self.resolve_relative(candidate)
        if not target.exists():
            raise FileNotFoundError(f"File not found: {candidate}")
        if not target.is_file():
            raise IsADirectoryError(f"Not a file: {candidate}")
        target.unlink()
        return target

    def delete_path(self, candidate: str, recursive: bool) -> tuple[Path, str]:
        target = self.resolve_relative(candidate)
        if not target.exists():
            raise FileNotFoundError(f"Path not found: {candidate}")
        if target.is_file():
            target.unlink()
            return target, "file"
        if not recursive:
            raise IsADirectoryError(
                f"Path is a directory: {candidate}. Set recursive=true to delete directories."
            )
        shutil.rmtree(target)
        return target, "dir"
