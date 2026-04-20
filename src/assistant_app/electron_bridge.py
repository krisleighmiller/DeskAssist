from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

from assistant_app.casefile import CasefileService
from assistant_app.chat_service import ChatService
from assistant_app.models import ChatMessage


# ---------------------------------------------------------------------------
# Message <-> dict conversions
# ---------------------------------------------------------------------------


def _parse_messages(raw_messages: list[dict[str, Any]]) -> list[ChatMessage]:
    parsed: list[ChatMessage] = []
    for item in raw_messages:
        role = str(item.get("role", "user"))
        content = item.get("content")
        if content is not None and not isinstance(content, str):
            content = str(content)
        tool_calls = item.get("tool_calls")
        if tool_calls is not None and not isinstance(tool_calls, list):
            tool_calls = None
        tool_call_id_raw = item.get("tool_call_id")
        tool_call_id = str(tool_call_id_raw) if isinstance(tool_call_id_raw, str) else None
        parsed.append(
            ChatMessage(
                role=role,
                content=content,
                tool_calls=tool_calls,
                tool_call_id=tool_call_id,
            )
        )
    return parsed


def _serialize_message(message: ChatMessage) -> dict[str, Any]:
    return {
        "role": message.role,
        "content": message.content,
        "tool_calls": message.tool_calls,
        "tool_call_id": message.tool_call_id,
    }


# ---------------------------------------------------------------------------
# Provider key environment plumbing
# ---------------------------------------------------------------------------


_KEY_ENV_MAP: dict[str, str] = {
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY",
}


def _apply_api_keys(api_keys: object) -> None:
    keys: dict[str, object] = api_keys if isinstance(api_keys, dict) else {}
    for provider_name, env_var in _KEY_ENV_MAP.items():
        value = keys.get(provider_name)
        if isinstance(value, str) and value.strip():
            os.environ[env_var] = value.strip()
        else:
            os.environ.pop(env_var, None)


# ---------------------------------------------------------------------------
# Command handlers
# ---------------------------------------------------------------------------


def _resolve_lane_root(request: dict[str, Any]) -> Path:
    """Resolve the workspace root for a chat turn.

    The renderer is expected to pass `casefileRoot` + optional `laneId`. If a
    casefile is provided we look the lane up via CasefileService so that
    file-tools are scoped to the lane root, not the bare casefile root. The
    `workspaceRoot` field is kept as a back-compat fallback so any caller that
    has not migrated yet (or any test) still works.
    """
    casefile_root_raw = request.get("casefileRoot")
    if isinstance(casefile_root_raw, str) and casefile_root_raw.strip():
        service = CasefileService(Path(casefile_root_raw))
        lane_id_raw = request.get("laneId")
        lane_id = lane_id_raw.strip() if isinstance(lane_id_raw, str) and lane_id_raw.strip() else None
        lane = service.resolve_lane(lane_id)
        return lane.root
    workspace_root_raw = request.get("workspaceRoot")
    if isinstance(workspace_root_raw, str) and workspace_root_raw.strip():
        return Path(workspace_root_raw).resolve()
    return Path.cwd().resolve()


def handle_chat_send(request: dict[str, Any]) -> dict[str, Any]:
    provider = str(request.get("provider") or "openai")
    model = request.get("model")
    user_message = request.get("userMessage")
    allow_write_tools = bool(request.get("allowWriteTools", False))
    resume_pending = bool(request.get("resumePendingToolCalls", False))
    if not resume_pending and (not isinstance(user_message, str) or not user_message.strip()):
        raise ValueError("userMessage is required")

    _apply_api_keys(request.get("apiKeys"))

    history_raw = request.get("messages") or []
    if not isinstance(history_raw, list):
        raise ValueError("messages must be an array")

    workspace_root = _resolve_lane_root(request)

    service = ChatService(default_provider_name=provider, workspace_root=workspace_root)
    service.replace_history(_parse_messages(history_raw))
    history_before_count = len(service.history)
    if resume_pending:
        response = service.resume_pending_tool_calls(
            model=model if isinstance(model, str) else None,
            allow_write_tools=allow_write_tools,
        )
    else:
        response = service.send_user_message(
            user_message,
            model=model if isinstance(model, str) else None,
            allow_write_tools=allow_write_tools,
        )
    history_delta = service.history[history_before_count:]
    pending_write_approvals = service.pending_write_tool_calls(response)
    serialized_delta = [_serialize_message(message) for message in history_delta]

    # Persist the turn under the casefile lane (if one was provided). Best-effort:
    # a persistence failure should not poison the response that the renderer
    # already received from the model. We surface it as an error field.
    persistence_error: str | None = None
    casefile_root_raw = request.get("casefileRoot")
    lane_id_raw = request.get("laneId")
    if (
        isinstance(casefile_root_raw, str)
        and casefile_root_raw.strip()
        and isinstance(lane_id_raw, str)
        and lane_id_raw.strip()
    ):
        try:
            cs = CasefileService(Path(casefile_root_raw))
            cs.append_chat(lane_id_raw, serialized_delta)
        except Exception as exc:  # noqa: BLE001
            persistence_error = f"chat persistence failed: {type(exc).__name__}: {exc}"

    payload: dict[str, Any] = {
        "ok": True,
        "message": _serialize_message(response),
        "messages": serialized_delta,
        "pendingApprovals": pending_write_approvals,
    }
    if persistence_error:
        payload["persistenceError"] = persistence_error
    return payload


def handle_casefile_open(request: dict[str, Any]) -> dict[str, Any]:
    root = request.get("root") or request.get("casefileRoot")
    if not isinstance(root, str) or not root.strip():
        raise ValueError("root is required")
    service = CasefileService(Path(root))
    snapshot = service.open()
    return {"ok": True, "casefile": service.serialize(snapshot)}


def handle_casefile_register_lane(request: dict[str, Any]) -> dict[str, Any]:
    root = request.get("casefileRoot")
    if not isinstance(root, str) or not root.strip():
        raise ValueError("casefileRoot is required")
    lane_raw = request.get("lane")
    if not isinstance(lane_raw, dict):
        raise ValueError("lane object is required")
    name = lane_raw.get("name")
    if not isinstance(name, str) or not name.strip():
        raise ValueError("lane.name is required")
    kind = lane_raw.get("kind") if isinstance(lane_raw.get("kind"), str) else "other"
    lane_root_raw = lane_raw.get("root")
    if not isinstance(lane_root_raw, str) or not lane_root_raw.strip():
        raise ValueError("lane.root is required")
    lane_id_raw = lane_raw.get("id")
    lane_id = lane_id_raw if isinstance(lane_id_raw, str) and lane_id_raw.strip() else None
    service = CasefileService(Path(root))
    snapshot = service.register_lane(
        name=name, kind=kind, root=Path(lane_root_raw), lane_id=lane_id
    )
    return {"ok": True, "casefile": service.serialize(snapshot)}


def handle_casefile_switch_lane(request: dict[str, Any]) -> dict[str, Any]:
    root = request.get("casefileRoot")
    lane_id = request.get("laneId")
    if not isinstance(root, str) or not root.strip():
        raise ValueError("casefileRoot is required")
    if not isinstance(lane_id, str) or not lane_id.strip():
        raise ValueError("laneId is required")
    service = CasefileService(Path(root))
    snapshot = service.set_active_lane(lane_id)
    return {"ok": True, "casefile": service.serialize(snapshot)}


def handle_casefile_list_chat(request: dict[str, Any]) -> dict[str, Any]:
    root = request.get("casefileRoot")
    lane_id = request.get("laneId")
    if not isinstance(root, str) or not root.strip():
        raise ValueError("casefileRoot is required")
    if not isinstance(lane_id, str) or not lane_id.strip():
        raise ValueError("laneId is required")
    service = CasefileService(Path(root))
    messages = service.read_chat(lane_id)
    return {"ok": True, "messages": messages}


# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------


_HANDLERS = {
    "chat:send": handle_chat_send,
    "casefile:open": handle_casefile_open,
    "casefile:registerLane": handle_casefile_register_lane,
    "casefile:switchLane": handle_casefile_switch_lane,
    "casefile:listChat": handle_casefile_list_chat,
}


def dispatch(request: dict[str, Any]) -> dict[str, Any]:
    """Route a parsed request dict to the matching command handler.

    The default command is `chat:send` so any caller from before the casefile
    migration (which simply posted a chat payload) keeps working.
    """
    command = request.get("command")
    if not isinstance(command, str) or not command:
        command = "chat:send"
    handler = _HANDLERS.get(command)
    if handler is None:
        raise ValueError(f"Unknown bridge command: {command!r}")
    return handler(request)


def main() -> None:
    raw_input = sys.stdin.read()
    request = json.loads(raw_input or "{}")
    response = dispatch(request)
    print(json.dumps(response))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(exc)}), file=sys.stderr)
        raise SystemExit(1)
