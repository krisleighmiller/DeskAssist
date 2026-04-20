from __future__ import annotations

from pathlib import Path

from assistant_app.filesystem import WorkspaceFilesystem


def make_list_dir_tool(workspace_root: Path):
    fs = WorkspaceFilesystem(workspace_root)

    def list_dir(params: dict[str, object]) -> dict[str, object]:
        raw_path = str(params.get("path", "."))
        target, entries = fs.list_dir(raw_path)
        return {
            "path": str(target),
            "entries": entries,
        }

    return list_dir


def make_read_file_tool(workspace_root: Path):
    fs = WorkspaceFilesystem(workspace_root)

    def read_file(params: dict[str, object]) -> dict[str, object]:
        raw_path = str(params.get("path", ""))
        if not raw_path:
            raise ValueError("path is required")
        max_chars = int(params.get("max_chars", 5000))
        content, truncated, target = fs.read_text_bounded(raw_path, max_chars)
        return {
            "path": str(target),
            "content": content,
            "truncated": truncated,
        }

    return read_file


def make_save_file_tool(workspace_root: Path):
    fs = WorkspaceFilesystem(workspace_root)

    def save_file(params: dict[str, object]) -> dict[str, object]:
        raw_path = str(params["path"])
        content = str(params["content"])
        overwrite = bool(params.get("overwrite", False))
        target, bytes_written = fs.save_text(raw_path, content, overwrite=overwrite)
        return {
            "path": str(target),
            "bytes_written": bytes_written,
        }

    return save_file


def make_append_file_tool(workspace_root: Path):
    fs = WorkspaceFilesystem(workspace_root)

    def append_file(params: dict[str, object]) -> dict[str, object]:
        raw_path = str(params["path"])
        content = str(params["content"])
        target, bytes_appended = fs.append_text(raw_path, content)
        return {
            "path": str(target),
            "bytes_appended": bytes_appended,
        }

    return append_file


def make_delete_file_tool(workspace_root: Path):
    fs = WorkspaceFilesystem(workspace_root)

    def delete_file(params: dict[str, object]) -> dict[str, object]:
        raw_path = str(params["path"])
        target = fs.delete_file(raw_path)
        return {
            "path": str(target),
            "deleted": True,
        }

    return delete_file


def make_delete_path_tool(workspace_root: Path):
    fs = WorkspaceFilesystem(workspace_root)

    def delete_path(params: dict[str, object]) -> dict[str, object]:
        raw_path = str(params["path"])
        recursive = bool(params.get("recursive", False))
        target, deleted_type = fs.delete_path(raw_path, recursive=recursive)
        return {
            "path": str(target),
            "deleted": True,
            "deleted_type": deleted_type,
        }

    return delete_path
