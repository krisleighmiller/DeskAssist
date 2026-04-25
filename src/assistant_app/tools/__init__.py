from pathlib import Path
from typing import Mapping

from assistant_app.casefile.models import ScopedDirectory
from assistant_app.tools.file_tools import (
    make_append_file_tool,
    make_delete_file_tool,
    make_delete_path_tool,
    make_list_dir_tool,
    make_read_file_tool,
    make_save_file_tool,
)
from assistant_app.tools.registry import ToolRegistry, ToolSpec


def build_default_tool_registry(
    workspace_root: Path,
    *,
    casefile_root: Path | None = None,
    read_overlays: Mapping[str, Path] | None = None,
    scoped_directories: tuple[ScopedDirectory, ...] | None = None,
    enable_writes: bool = True,
) -> ToolRegistry:
    """Build the standard tool registry rooted at `workspace_root`.

    `casefile_root` is currently accepted for API compatibility with
    bridge call sites that still pass it; no casefile-aware tools are
    registered today (the previous read-only ``findings_list`` /
    ``findings_read`` tools were removed along with the findings store).

    `scoped_directories` is the current scope source of truth: each directory
    is mounted under `_scope/<label>/...` with its own writable flag. Legacy
    `read_overlays` are still accepted for compatibility and for non-scope
    overlays such as `_context/...`.

    `enable_writes` controls whether the write-permission tools
    (``save_file``, ``append_file``, ``delete_file``, ``delete_path``) are
    registered at all. Scoped sessions with no writable directories set this
    to ``False`` so the model cannot mutate read-only material even if a bug
    elsewhere granted ``workspace_write`` permission.

    AUDIT INVARIANT: no bridge handler in ``electron_bridge`` passes
    ``capability=INTERNAL_CAPABILITY`` to ``execute_tool_command``.  If
    you add one, follow the checklist in
    ``assistant_app.security.policy._InternalCapability`` (add an
    ``audit()`` entry, restrict the call site to trusted code, and
    update the docstring).  A structural test in
    ``tests/test_tools.py::test_no_bridge_handler_uses_internal_capability``
    asserts this invariant — update it if you intentionally break it.
    """
    enabled: set[str] = {"list_dir", "read_file"}
    if enable_writes:
        enabled |= {"append_file", "delete_file", "delete_path", "save_file"}
    # `casefile_root` is accepted for call-site compatibility but is not
    # used to register any tools at present (the findings/runs tools that
    # previously consumed it were removed). Suppress the unused-variable
    # warning explicitly rather than silently ignoring the parameter.
    _ = casefile_root
    registry = ToolRegistry(
        workspace_root=workspace_root,
        enabled_commands=enabled,
    )
    registry.register(
        "list_dir",
        make_list_dir_tool(
            workspace_root,
            read_overlays=read_overlays,
            scoped_directories=scoped_directories,
        ),
        input_schema={"path": str},
        required_params=set(),
        permission="workspace_read",
        description="List directory entries under the current workspace.",
    )
    registry.register(
        "read_file",
        make_read_file_tool(
            workspace_root,
            read_overlays=read_overlays,
            scoped_directories=scoped_directories,
        ),
        input_schema={"path": str, "max_bytes": int, "max_chars": int},
        required_params={"path"},
        permission="workspace_read",
        description="Read text content from a workspace file.",
    )
    if enable_writes:
        registry.register(
            "save_file",
            make_save_file_tool(
                workspace_root,
                read_overlays=read_overlays,
                scoped_directories=scoped_directories,
            ),
            input_schema={"path": str, "content": str, "overwrite": bool},
            required_params={"path", "content"},
            permission="workspace_write",
            description="Write full file contents. Requires user write approval.",
        )
        registry.register(
            "append_file",
            make_append_file_tool(
                workspace_root,
                read_overlays=read_overlays,
                scoped_directories=scoped_directories,
            ),
            input_schema={"path": str, "content": str},
            required_params={"path", "content"},
            permission="workspace_write",
            description="Append text to a workspace file. Requires user write approval.",
        )
        registry.register(
            "delete_file",
            make_delete_file_tool(
                workspace_root,
                read_overlays=read_overlays,
                scoped_directories=scoped_directories,
            ),
            input_schema={"path": str},
            required_params={"path"},
            permission="workspace_write",
            description="Delete a single workspace file. Requires user write approval.",
        )
        registry.register(
            "delete_path",
            make_delete_path_tool(
                workspace_root,
                read_overlays=read_overlays,
                scoped_directories=scoped_directories,
            ),
            input_schema={"path": str, "recursive": bool},
            required_params={"path"},
            permission="workspace_write",
            description=(
                "Delete a workspace file or directory. Set recursive=true for directories. "
                "Requires user write approval."
            ),
        )
    return registry


__all__ = ["ToolRegistry", "ToolSpec", "build_default_tool_registry"]
