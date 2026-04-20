from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

from assistant_app.casefile import (
    CasefileService,
    FindingsStore,
    NotesStore,
    compare_lanes,
    export_review,
)
from assistant_app.casefile.service import parse_source_refs, serialize_finding
from assistant_app.chat_service import ChatService
from assistant_app.filesystem import WorkspaceFilesystem
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
    # When a casefile is in play, register the read-only findings tools so the
    # model can cite findings without being able to modify them.
    casefile_root_raw = request.get("casefileRoot")
    casefile_root = (
        Path(casefile_root_raw)
        if isinstance(casefile_root_raw, str) and casefile_root_raw.strip()
        else None
    )

    service = ChatService(
        default_provider_name=provider,
        workspace_root=workspace_root,
        casefile_root=casefile_root,
    )
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
    lane_id_raw = request.get("laneId")
    if (
        casefile_root is not None
        and isinstance(lane_id_raw, str)
        and lane_id_raw.strip()
    ):
        try:
            cs = CasefileService(casefile_root)
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
# M3 handlers: findings / notes / compare / export / lane-scoped read
# ---------------------------------------------------------------------------


def _require_casefile_root(request: dict[str, Any]) -> Path:
    root = request.get("casefileRoot")
    if not isinstance(root, str) or not root.strip():
        raise ValueError("casefileRoot is required")
    return Path(root)


def handle_casefile_list_findings(request: dict[str, Any]) -> dict[str, Any]:
    root = _require_casefile_root(request)
    raw_lane = request.get("laneId")
    lane_id = raw_lane if isinstance(raw_lane, str) and raw_lane.strip() else None
    findings = FindingsStore(root).list(lane_id=lane_id)
    return {"ok": True, "findings": [serialize_finding(f) for f in findings]}


def handle_casefile_get_finding(request: dict[str, Any]) -> dict[str, Any]:
    root = _require_casefile_root(request)
    finding_id = request.get("findingId")
    if not isinstance(finding_id, str) or not finding_id.strip():
        raise ValueError("findingId is required")
    finding = FindingsStore(root).get(finding_id)
    return {"ok": True, "finding": serialize_finding(finding)}


def _finding_input(request: dict[str, Any]) -> dict[str, Any]:
    raw = request.get("finding")
    if not isinstance(raw, dict):
        raise ValueError("finding object is required")
    return raw


def handle_casefile_create_finding(request: dict[str, Any]) -> dict[str, Any]:
    root = _require_casefile_root(request)
    raw = _finding_input(request)
    title = raw.get("title")
    if not isinstance(title, str) or not title.strip():
        raise ValueError("finding.title is required")
    body = raw.get("body") if isinstance(raw.get("body"), str) else ""
    severity = raw.get("severity") if isinstance(raw.get("severity"), str) else "info"
    raw_lanes = raw.get("laneIds") if "laneIds" in raw else raw.get("lane_ids")
    if not isinstance(raw_lanes, list) or not raw_lanes:
        raise ValueError("finding.laneIds must be a non-empty array")
    lane_ids = [str(item) for item in raw_lanes]
    source_refs = parse_source_refs(raw.get("sourceRefs") if "sourceRefs" in raw else raw.get("source_refs"))
    finding = FindingsStore(root).create(
        title=title,
        body=body,
        severity=severity,
        lane_ids=lane_ids,
        source_refs=source_refs,
    )
    return {"ok": True, "finding": serialize_finding(finding)}


def handle_casefile_update_finding(request: dict[str, Any]) -> dict[str, Any]:
    root = _require_casefile_root(request)
    finding_id = request.get("findingId")
    if not isinstance(finding_id, str) or not finding_id.strip():
        raise ValueError("findingId is required")
    raw = _finding_input(request)
    update_kwargs: dict[str, Any] = {}
    if "title" in raw and isinstance(raw["title"], str):
        update_kwargs["title"] = raw["title"]
    if "body" in raw and isinstance(raw["body"], str):
        update_kwargs["body"] = raw["body"]
    if "severity" in raw and isinstance(raw["severity"], str):
        update_kwargs["severity"] = raw["severity"]
    if "laneIds" in raw or "lane_ids" in raw:
        raw_lanes = raw.get("laneIds") if "laneIds" in raw else raw.get("lane_ids")
        if isinstance(raw_lanes, list):
            update_kwargs["lane_ids"] = [str(item) for item in raw_lanes]
    if "sourceRefs" in raw or "source_refs" in raw:
        update_kwargs["source_refs"] = parse_source_refs(
            raw.get("sourceRefs") if "sourceRefs" in raw else raw.get("source_refs")
        )
    finding = FindingsStore(root).update(finding_id, **update_kwargs)
    return {"ok": True, "finding": serialize_finding(finding)}


def handle_casefile_delete_finding(request: dict[str, Any]) -> dict[str, Any]:
    root = _require_casefile_root(request)
    finding_id = request.get("findingId")
    if not isinstance(finding_id, str) or not finding_id.strip():
        raise ValueError("findingId is required")
    FindingsStore(root).delete(finding_id)
    return {"ok": True}


def handle_casefile_get_note(request: dict[str, Any]) -> dict[str, Any]:
    root = _require_casefile_root(request)
    lane_id = request.get("laneId")
    if not isinstance(lane_id, str) or not lane_id.strip():
        raise ValueError("laneId is required")
    content = NotesStore(root).read(lane_id)
    return {"ok": True, "content": content}


def handle_casefile_save_note(request: dict[str, Any]) -> dict[str, Any]:
    root = _require_casefile_root(request)
    lane_id = request.get("laneId")
    if not isinstance(lane_id, str) or not lane_id.strip():
        raise ValueError("laneId is required")
    content = request.get("content")
    if not isinstance(content, str):
        raise ValueError("content must be a string")
    path = NotesStore(root).write(lane_id, content)
    return {"ok": True, "path": str(path)}


def handle_casefile_compare_lanes(request: dict[str, Any]) -> dict[str, Any]:
    root = _require_casefile_root(request)
    left_id = request.get("leftLaneId")
    right_id = request.get("rightLaneId")
    if not isinstance(left_id, str) or not left_id.strip():
        raise ValueError("leftLaneId is required")
    if not isinstance(right_id, str) or not right_id.strip():
        raise ValueError("rightLaneId is required")
    if left_id == right_id:
        raise ValueError("leftLaneId and rightLaneId must differ")
    service = CasefileService(root)
    snapshot = service.snapshot()
    left = snapshot.lane_by_id(left_id)
    right = snapshot.lane_by_id(right_id)
    comparison = compare_lanes(left, right)
    return {"ok": True, "comparison": comparison.to_json()}


def handle_casefile_export(request: dict[str, Any]) -> dict[str, Any]:
    root = _require_casefile_root(request)
    raw_lanes = request.get("laneIds")
    if not isinstance(raw_lanes, list) or not raw_lanes:
        raise ValueError("laneIds must be a non-empty array")
    lane_ids = [str(item) for item in raw_lanes if isinstance(item, str)]
    service = CasefileService(root)
    snapshot = service.snapshot()
    output_path, markdown = export_review(
        casefile_root=root,
        lanes=snapshot.lanes,
        selected_lane_ids=lane_ids,
    )
    return {"ok": True, "path": str(output_path), "markdown": markdown}


def handle_lane_read_file(request: dict[str, Any]) -> dict[str, Any]:
    """Read a file from a specific lane (not necessarily the active one).

    Used by the diff editor to fetch both sides of a comparison without
    having to switch the active lane. Lane scoping is preserved by routing
    the read through `WorkspaceFilesystem(lane.root)`.
    """
    root = _require_casefile_root(request)
    lane_id = request.get("laneId")
    file_path = request.get("path")
    if not isinstance(lane_id, str) or not lane_id.strip():
        raise ValueError("laneId is required")
    if not isinstance(file_path, str) or not file_path.strip():
        raise ValueError("path is required")
    max_chars_raw = request.get("maxChars")
    max_chars = int(max_chars_raw) if isinstance(max_chars_raw, int) and max_chars_raw > 0 else 200_000
    snapshot = CasefileService(root).snapshot()
    lane = snapshot.lane_by_id(lane_id)
    fs = WorkspaceFilesystem(lane.root)
    content, truncated, target = fs.read_text_bounded(file_path, max_chars)
    return {"ok": True, "path": str(target), "content": content, "truncated": truncated}


# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------


_HANDLERS = {
    "chat:send": handle_chat_send,
    "casefile:open": handle_casefile_open,
    "casefile:registerLane": handle_casefile_register_lane,
    "casefile:switchLane": handle_casefile_switch_lane,
    "casefile:listChat": handle_casefile_list_chat,
    "casefile:listFindings": handle_casefile_list_findings,
    "casefile:getFinding": handle_casefile_get_finding,
    "casefile:createFinding": handle_casefile_create_finding,
    "casefile:updateFinding": handle_casefile_update_finding,
    "casefile:deleteFinding": handle_casefile_delete_finding,
    "casefile:getNote": handle_casefile_get_note,
    "casefile:saveNote": handle_casefile_save_note,
    "casefile:compareLanes": handle_casefile_compare_lanes,
    "casefile:exportFindings": handle_casefile_export,
    "lane:readFile": handle_lane_read_file,
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
