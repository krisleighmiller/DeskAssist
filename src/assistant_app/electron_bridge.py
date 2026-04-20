from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

from assistant_app.chat_service import ChatService
from assistant_app.models import ChatMessage


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


def main() -> None:
    raw_input = sys.stdin.read()
    request = json.loads(raw_input or "{}")

    workspace_root = Path(str(request.get("workspaceRoot") or ".")).resolve()
    provider = str(request.get("provider") or "openai")
    model = request.get("model")
    user_message = request.get("userMessage")
    allow_write_tools = bool(request.get("allowWriteTools", False))
    resume_pending = bool(request.get("resumePendingToolCalls", False))
    api_keys = request.get("apiKeys") if isinstance(request.get("apiKeys"), dict) else {}
    if not resume_pending and (not isinstance(user_message, str) or not user_message.strip()):
        raise ValueError("userMessage is required")

    key_map = {
        "openai": "OPENAI_API_KEY",
        "anthropic": "ANTHROPIC_API_KEY",
        "deepseek": "DEEPSEEK_API_KEY",
    }
    for provider_name, env_var in key_map.items():
        value = api_keys.get(provider_name)
        if isinstance(value, str) and value.strip():
            os.environ[env_var] = value.strip()
        else:
            os.environ.pop(env_var, None)

    history_raw = request.get("messages") or []
    if not isinstance(history_raw, list):
        raise ValueError("messages must be an array")

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
    history_after = service.history
    history_delta = history_after[history_before_count:]
    pending_write_approvals = service.pending_write_tool_calls(response)

    print(
        json.dumps(
            {
                "ok": True,
                "message": {
                    "role": response.role,
                    "content": response.content,
                    "tool_calls": response.tool_calls,
                    "tool_call_id": response.tool_call_id,
                },
                "messages": [_serialize_message(message) for message in history_delta],
                "pendingApprovals": pending_write_approvals,
            }
        )
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(exc)}), file=sys.stderr)
        raise SystemExit(1)
