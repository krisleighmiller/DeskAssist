from pathlib import Path

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
) -> ToolRegistry:
    """Build the standard tool registry rooted at `workspace_root`.

    `casefile_root` is optional. When provided, casefile-aware read-only
    tools (`findings_list`, `findings_read`) are registered and enabled so
    the chat model can cite findings that exist in the casefile. The tools
    only ever read; they cannot create or delete findings.
    """
    enabled = {"append_file", "delete_file", "delete_path", "list_dir", "read_file", "save_file"}
    if casefile_root is not None:
        enabled |= {"findings_list", "findings_read"}
    registry = ToolRegistry(
        workspace_root=workspace_root,
        enabled_commands=enabled,
    )
    registry.register(
        "list_dir",
        make_list_dir_tool(workspace_root),
        input_schema={"path": str},
        required_params=set(),
        permission="workspace_read",
    )
    registry.register(
        "read_file",
        make_read_file_tool(workspace_root),
        input_schema={"path": str, "max_chars": int},
        required_params={"path"},
        permission="workspace_read",
    )
    registry.register(
        "save_file",
        make_save_file_tool(workspace_root),
        input_schema={"path": str, "content": str, "overwrite": bool},
        required_params={"path", "content"},
        permission="workspace_write",
    )
    registry.register(
        "append_file",
        make_append_file_tool(workspace_root),
        input_schema={"path": str, "content": str},
        required_params={"path", "content"},
        permission="workspace_write",
    )
    registry.register(
        "delete_file",
        make_delete_file_tool(workspace_root),
        input_schema={"path": str},
        required_params={"path"},
        permission="workspace_write",
    )
    registry.register(
        "delete_path",
        make_delete_path_tool(workspace_root),
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
