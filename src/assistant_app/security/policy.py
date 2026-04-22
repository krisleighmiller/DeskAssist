from __future__ import annotations

import logging
from typing import Any, Callable

logger = logging.getLogger(__name__)


class _InternalCapability:
    """Process-local capability token for trusted internal calls.

    SECURITY NOTE: ``INTERNAL_CAPABILITY`` is intentionally a module-level
    singleton rather than a secret token — the safety property is *not*
    "attackers cannot obtain it" (any Python code imported into the bridge
    process can do ``from assistant_app.security.policy import
    INTERNAL_CAPABILITY``).  The property is instead "every path that
    reaches an internal-only command is *explicit* and *auditable*":

    * ``authorize()`` logs every use via ``audit()``.
    * There are currently *no* internal-only commands and *zero* bridge
      handlers that invoke ``execute_tool_command`` with
      ``INTERNAL_CAPABILITY``.  The only safety guarantee is structural:
      no current code path threads the capability from an untrusted IPC
      message to ``execute_tool_command``.

    If you add a handler that calls ``execute_tool_command(...,
    capability=INTERNAL_CAPABILITY)``, you are bypassing the external-caller
    guard.  That may be intentional for trusted automation, but you must:
      1. Add an ``audit()`` entry with a distinct origin label.
      2. Ensure the call site is reachable only from trusted code (not from
         the raw JSON dispatch loop in ``electron_bridge.__main__``).
      3. Update this docstring to list the new authorized caller.
    """

    __slots__ = ("_secret",)
    _instantiated = False

    def __init__(self) -> None:
        if _InternalCapability._instantiated:
            raise RuntimeError("_InternalCapability is a singleton")
        _InternalCapability._instantiated = True
        self._secret = object()

    def __reduce__(self) -> tuple[str]:
        raise TypeError("InternalCapability cannot be serialized")

    def __repr__(self) -> str:
        return "<InternalCapability>"


INTERNAL_CAPABILITY = _InternalCapability()

_TRUSTED_KEYS = frozenset({"cmd", "params"})


def sanitize_command(command: dict[str, Any]) -> dict[str, Any]:
    """Strip untrusted keys from externally sourced tool command payloads."""
    raw_params = command.get("params", {})
    if not isinstance(raw_params, dict):
        raw_params = {}
    cleaned = {
        "cmd": str(command.get("cmd", "")),
        "params": raw_params,
    }
    # Future-proof against accidental key additions.
    return {key: value for key, value in cleaned.items() if key in _TRUSTED_KEYS}


def authorize(
    cmd_id: str,
    *,
    capability: object | None = None,
    has_cmd_fn: Callable[[str], bool] | None = None,
    has_internal_cmd_fn: Callable[[str], bool] | None = None,
    allowed_cmds: frozenset[str] | None = None,
) -> tuple[bool, str]:
    """Decide whether a command is authorized to execute."""
    origin = "internal" if capability is INTERNAL_CAPABILITY else "external"

    if allowed_cmds is not None and cmd_id not in allowed_cmds:
        audit(cmd_id, origin, "denied", "not in registry allowlist")
        return False, f"Command {cmd_id!r} not in registry allowlist"

    if capability is INTERNAL_CAPABILITY:
        if has_internal_cmd_fn is not None and has_internal_cmd_fn(cmd_id):
            audit(cmd_id, origin, "allowed", "internal capability")
            return True, "internal capability"
        if has_cmd_fn is not None and has_cmd_fn(cmd_id):
            audit(cmd_id, origin, "allowed", "enabled")
            return True, "enabled"
        audit(cmd_id, origin, "denied", "command not enabled for internal execution")
        return False, f"Command {cmd_id!r} not enabled for internal execution"

    if has_cmd_fn is not None and not has_cmd_fn(cmd_id):
        audit(cmd_id, origin, "denied", "command not enabled")
        return False, f"Command {cmd_id!r} not enabled"

    audit(cmd_id, origin, "allowed", "enabled")
    return True, "enabled"


def audit(cmd_id: str, origin: str, decision: str, reason: str) -> None:
    logger.info(
        "COMMAND_AUDIT: cmd=%r origin=%s decision=%s reason=%s",
        cmd_id,
        origin,
        decision,
        reason,
    )
