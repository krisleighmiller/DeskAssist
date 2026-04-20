"""LLM-facing wrapper around :mod:`assistant_app.system_exec`.

This module exposes the ``sys_exec`` tool to the model. All the heavy
lifting (command validation, sandboxed Popen, bounded IO/timeout) lives in
``assistant_app.system_exec`` and is shared with the user-driven Run
launcher (``assistant_app.casefile.runs``). Keep this file thin so the
shared helpers remain the single audited code path.
"""

from __future__ import annotations

from pathlib import Path

from assistant_app.system_exec import (
    ALLOWED_EXECUTABLES,
    run_safe,
    validate_command,
)

__all__ = ["ALLOWED_EXECUTABLES", "make_sys_exec_tool"]


def make_sys_exec_tool(workspace_root: Path):
    def sys_exec(params: dict[str, object]) -> dict[str, object]:
        raw_command = params.get("command")
        # `validate_command` raises ValueError if the string is empty/whitespace.
        if not isinstance(raw_command, str):
            raise ValueError("command is required")

        # The confirm gate is the LLM-facing safety net; it doesn't apply to
        # user-initiated runs (those are explicit by definition).
        confirmed = params.get("confirm", False)
        if confirmed is not True:
            raise PermissionError("sys_exec requires confirm=true")

        command = validate_command(raw_command)
        timeout_seconds = int(params.get("timeout_seconds", 30))
        max_output_chars = int(params.get("max_output_chars", 8000))

        return run_safe(
            command,
            cwd=workspace_root,
            timeout_seconds=timeout_seconds,
            max_output_chars=max_output_chars,
        )

    return sys_exec
