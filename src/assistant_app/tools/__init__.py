from pathlib import Path
from typing import Mapping

from assistant_app.tools.file_tools import (
    make_append_file_tool,
    make_delete_file_tool,
    make_delete_path_tool,
    make_list_dir_tool,
    make_read_file_tool,
    make_save_file_tool,
)
from assistant_app.tools.findings_tools import (
    make_findings_list_tool,
    make_findings_read_tool,
)
from assistant_app.tools.registry import ToolRegistry, ToolSpec
from assistant_app.tools.system_tools import make_sys_exec_tool


def build_default_tool_registry(
    workspace_root: Path,
    *,
    casefile_root: Path | None = None,
    read_overlays: Mapping[str, Path] | None = None,
    register_system_exec: bool = False,
    enable_writes: bool = True,
) -> ToolRegistry:
    """Build the standard tool registry rooted at `workspace_root`.

    `casefile_root` is optional. When provided, casefile-aware read-only
    tools (`findings_list`, `findings_read`) are registered and enabled so
    the chat model can cite findings that exist in the casefile. The tools
    only ever read; they cannot create or delete findings.

    `read_overlays` (M3.5) layers additional read-only roots on top of the
    write root, addressed by virtual path prefix. Writes still go only to
    `workspace_root`. The overlays are propagated to the file tools so
    `read_file("_ancestors/foo/bar.md")` resolves into the right ancestor
    without exposing absolute paths to the model.

    `register_system_exec` controls whether the ``sys_exec`` tool is
    registered at all.  It defaults to ``False`` so the registry never
    exposes it to the model unless explicitly opted in.  No currently
    shipped bridge handler sets this flag; the tool exists for future
    trusted-automation use cases only.

    `enable_writes` (M3.5c) controls whether the write-permission tools
    (``save_file``, ``append_file``, ``delete_file``, ``delete_path``) are
    registered at all.  Comparison-chat sessions set this to ``False`` so a
    multi-lane chat physically cannot mutate either side's files even if a
    bug elsewhere granted ``workspace_write`` permission.

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
    if casefile_root is not None:
        enabled |= {"findings_list", "findings_read"}
    registry = ToolRegistry(
        workspace_root=workspace_root,
        enabled_commands=enabled,
    )
    registry.register(
        "list_dir",
        make_list_dir_tool(workspace_root, read_overlays=read_overlays),
        input_schema={"path": str},
        required_params=set(),
        permission="workspace_read",
    )
    registry.register(
        "read_file",
        make_read_file_tool(workspace_root, read_overlays=read_overlays),
        input_schema={"path": str, "max_chars": int},
        required_params={"path"},
        permission="workspace_read",
    )
    if enable_writes:
        registry.register(
            "save_file",
            make_save_file_tool(workspace_root, read_overlays=read_overlays),
            input_schema={"path": str, "content": str, "overwrite": bool},
            required_params={"path", "content"},
            permission="workspace_write",
        )
        registry.register(
            "append_file",
            make_append_file_tool(workspace_root, read_overlays=read_overlays),
            input_schema={"path": str, "content": str},
            required_params={"path", "content"},
            permission="workspace_write",
        )
        registry.register(
            "delete_file",
            make_delete_file_tool(workspace_root, read_overlays=read_overlays),
            input_schema={"path": str},
            required_params={"path"},
            permission="workspace_write",
        )
        registry.register(
            "delete_path",
            make_delete_path_tool(workspace_root, read_overlays=read_overlays),
            input_schema={"path": str, "recursive": bool},
            required_params={"path"},
            permission="workspace_write",
        )
    if casefile_root is not None:
        registry.register(
            "findings_list",
            make_findings_list_tool(casefile_root),
            input_schema={"lane_id": str},
            required_params=set(),
            permission="workspace_read",
        )
        registry.register(
            "findings_read",
            make_findings_read_tool(casefile_root),
            input_schema={"id": str},
            required_params={"id"},
            permission="workspace_read",
        )
    if register_system_exec:
        registry.register(
            "sys_exec",
            make_sys_exec_tool(workspace_root),
            input_schema={"command": str, "confirm": bool, "timeout_seconds": int, "max_output_chars": int},
            required_params={"command", "confirm"},
            permission="system_exec",
            internal_enabled=True,
        )
    return registry


__all__ = ["ToolRegistry", "ToolSpec", "build_default_tool_registry"]
