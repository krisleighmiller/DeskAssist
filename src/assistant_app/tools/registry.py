from __future__ import annotations

from dataclasses import dataclass
import logging
from pathlib import Path
from typing import Any, Callable

from assistant_app.security.policy import authorize, sanitize_command

ToolHandler = Callable[[dict[str, Any]], dict[str, Any]]
logger = logging.getLogger(__name__)


@dataclass(slots=True, frozen=True)
class ToolSpec:
    name: str
    input_schema: dict[str, type]
    required_params: frozenset[str]
    permission: str
    internal_enabled: bool
    description: str = ""


class ToolRegistry:
    def __init__(
        self,
        workspace_root: Path,
        enabled_commands: set[str] | None = None,
        granted_permissions: set[str] | None = None,
    ) -> None:
        self.workspace_root = workspace_root.resolve()
        self._handlers: dict[str, ToolHandler] = {}
        self._specs: dict[str, ToolSpec] = {}
        self._enabled_commands = enabled_commands or set()
        self._internal_commands: set[str] = set()
        self._granted_permissions = granted_permissions or {"workspace_read", "workspace_write"}

    def register(
        self,
        command_name: str,
        handler: ToolHandler,
        *,
        input_schema: dict[str, type] | None = None,
        required_params: set[str] | None = None,
        permission: str = "workspace_read",
        internal_enabled: bool = False,
        description: str = "",
    ) -> None:
        if command_name in self._handlers:
            raise ValueError(f"Tool command '{command_name}' is already registered")
        self._handlers[command_name] = handler
        spec = ToolSpec(
            name=command_name,
            input_schema=input_schema or {},
            required_params=frozenset(required_params or set()),
            permission=permission,
            internal_enabled=internal_enabled,
            description=description,
        )
        self._specs[command_name] = spec
        if internal_enabled:
            self._internal_commands.add(command_name)

    def list_commands(self, enabled_only: bool = True) -> list[str]:
        commands = sorted(self._handlers.keys())
        if enabled_only:
            return [cmd for cmd in commands if self.is_enabled(cmd)]
        return commands

    def is_enabled(self, command_name: str) -> bool:
        return command_name in self._enabled_commands

    def enable(self, command_name: str) -> None:
        self._enabled_commands.add(command_name)

    def disable(self, command_name: str) -> None:
        self._enabled_commands.discard(command_name)

    def grant_permission(self, permission: str) -> None:
        self._granted_permissions.add(permission)

    def revoke_permission(self, permission: str) -> None:
        self._granted_permissions.discard(permission)

    def has_permission(self, permission: str) -> bool:
        return permission in self._granted_permissions

    def get_command_specs(self, enabled_only: bool = True) -> list[ToolSpec]:
        names = self.list_commands(enabled_only=enabled_only)
        return [self._specs[name] for name in names if name in self._specs]

    def execute(self, command: dict[str, Any], *, capability: object | None = None) -> dict[str, Any]:
        sanitized = sanitize_command(command)
        cmd_id = sanitized["cmd"]
        spec = self._specs.get(cmd_id)

        # Authorization runs before parameter validation so that an
        # unauthorized caller cannot probe the tool's parameter shape by
        # observing which inputs are accepted vs rejected.
        allowed, reason = authorize(
            cmd_id,
            capability=capability,
            has_cmd_fn=self.is_enabled,
            has_internal_cmd_fn=self.is_internal_enabled,
            allowed_cmds=frozenset(self._handlers.keys()),
        )
        if not allowed:
            self._audit(cmd_id, "denied", reason)
            return {
                "ok": False,
                "cmd": cmd_id,
                "summary": f"Tool {cmd_id} denied: {reason}",
                "error": {
                    "type": "PermissionError",
                    "message": reason,
                },
            }

        if spec is not None and not self.has_permission(spec.permission):
            reason = f"Missing permission: {spec.permission}"
            self._audit(cmd_id, "denied", reason)
            return {
                "ok": False,
                "cmd": cmd_id,
                "summary": f"Tool {cmd_id} denied: {reason}",
                "error": {
                    "type": "PermissionError",
                    "message": reason,
                },
            }

        if spec is not None:
            try:
                sanitized["params"] = self._validate_params(spec, sanitized["params"])
            except Exception as exc:
                self._audit(cmd_id, "failed", f"{type(exc).__name__}: {exc}")
                return {
                    "ok": False,
                    "cmd": cmd_id,
                    "summary": f"Tool {cmd_id} failed validation.",
                    "error": {
                        "type": type(exc).__name__,
                        "message": str(exc),
                    },
                }

        handler = self._handlers[cmd_id]
        try:
            result = handler(sanitized["params"])
            self._audit(cmd_id, "succeeded", "handler returned successfully")
            return {
                "ok": True,
                "cmd": cmd_id,
                "summary": f"Tool {cmd_id} executed successfully.",
                "result": result,
            }
        except Exception as exc:
            self._audit(cmd_id, "failed", f"{type(exc).__name__}: {exc}")
            return {
                "ok": False,
                "cmd": cmd_id,
                "summary": f"Tool {cmd_id} failed: {type(exc).__name__}",
                "error": {
                    "type": type(exc).__name__,
                    "message": str(exc),
                },
            }

    def _audit(self, cmd_id: str, decision: str, reason: str) -> None:
        logger.info("TOOL_AUDIT: cmd=%r decision=%s reason=%s", cmd_id, decision, reason)

    def is_internal_enabled(self, command_name: str) -> bool:
        return command_name in self._internal_commands

    def _validate_params(self, spec: ToolSpec, params: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(params, dict):
            raise TypeError("params must be an object")

        unknown = sorted(set(params.keys()) - set(spec.input_schema.keys()))
        if unknown:
            raise ValueError(f"Unknown parameter(s): {', '.join(unknown)}")

        missing = sorted(param for param in spec.required_params if param not in params)
        if missing:
            raise ValueError(f"Missing required parameter(s): {', '.join(missing)}")

        for name, value in params.items():
            expected_type = spec.input_schema[name]
            if expected_type is bool:
                if type(value) is not bool:
                    raise TypeError(f"Parameter '{name}' must be bool")
                continue
            if not isinstance(value, expected_type):
                raise TypeError(f"Parameter '{name}' must be {expected_type.__name__}")
            # `bool` is a subclass of `int` in Python, so `isinstance(True, int)`
            # is True. Reject booleans for all non-bool numeric types so the
            # JSON-typed tool surface treats booleans and numbers as distinct.
            if expected_type is not bool and isinstance(value, bool):
                raise TypeError(f"Parameter '{name}' must be {expected_type.__name__}, not bool")
        return params
