from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Any

from assistant_app.casefile import (
    CasefileService,
    ContextManifest,
    DEFAULT_RUN_MAX_OUTPUT_CHARS,
    DEFAULT_RUN_TIMEOUT_SECONDS,
    FindingsStore,
    InboxItem,
    InboxSource,
    InboxStore,
    NotesStore,
    PromptsStore,
    ResolvedContextFile,
    RunRecord,
    RunsStore,
    RunSummary,
    ScopeContext,
    compare_lanes,
    export_review,
)
from assistant_app.casefile.service import (
    parse_attachments,
    parse_source_refs,
    serialize_context_manifest,
    serialize_finding,
    serialize_scope,
)
from assistant_app.casefile.prompts import PromptDraft, PromptSummary
from assistant_app.chat_service import ChatService
from assistant_app.filesystem import WorkspaceFilesystem
from assistant_app.models import ChatMessage
from assistant_app.prompts import CHARTER_MARKER, build_charter_system_content
from assistant_app.system_exec import ALLOWED_EXECUTABLES


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


_CONTEXT_MARKER = "You are operating inside a DeskAssist casefile scope."
_PROMPT_MARKER = "[DeskAssist prompt: "


def _history_has_prompt_marker(history: list[ChatMessage], prompt_id: str) -> bool:
    """True if the given prompt is already injected as a system message.

    The marker carries the prompt id so resuming a turn with the *same*
    prompt selection is idempotent, but switching prompts mid-conversation
    correctly appends a new system message rather than de-duping silently.
    """
    needle = f"{_PROMPT_MARKER}{prompt_id}]"
    for msg in history:
        if msg.role == "system" and isinstance(msg.content, str) and msg.content.startswith(needle):
            return True
    return False


def _build_prompt_system_message(prompt: PromptDraft) -> str:
    """Wrap a stored prompt body in a tagged system message.

    The tag (`[DeskAssist prompt: <id>]`) is the marker used by
    `_history_has_prompt_marker` to keep injection idempotent on retries.
    """
    return f"{_PROMPT_MARKER}{prompt.id}] {prompt.name}\n\n{prompt.body}"


def _history_has_context_marker(history: list[ChatMessage]) -> bool:
    """True if the auto-injected casefile-context system message is present.

    Auto-include is recomputed on every chat:send (cheaper than tracking
    state in the renderer), so we need a stable marker to avoid stacking
    duplicates when a turn is resumed. Scans the *full* history (mirroring
    `_history_has_prompt_marker`) so a context message reordered behind
    another system message is still detected.
    """
    for msg in history:
        if (
            msg.role == "system"
            and isinstance(msg.content, str)
            and msg.content.startswith(_CONTEXT_MARKER)
        ):
            return True
    return False


def _history_has_charter_marker(history: list[ChatMessage]) -> bool:
    """True if the product-owned assistant charter is already in history.

    Mirrors `_history_has_context_marker` / `_history_has_prompt_marker`
    so a resumed turn does not stack duplicate charters at the head of
    the conversation.
    """
    for msg in history:
        if (
            msg.role == "system"
            and isinstance(msg.content, str)
            and msg.content.startswith(CHARTER_MARKER)
        ):
            return True
    return False


def _prepend_assistant_charter(history: list[ChatMessage]) -> None:
    """Prepend the assistant charter at index 0 unless already present.

    Layer 1 of the system-prompt stack (M4.5). Casefile auto-context
    (M3.5a) and user-selected prompt drafts (M4.1) insert *after* this
    layer using `_history_has_charter_marker` to compute their offsets,
    so the on-the-wire ordering is always:

        [charter, context?, prompt?, ...conversation...]

    Each layer narrows the previous one; the charter is the only layer
    the user cannot override.
    """
    if _history_has_charter_marker(history):
        return
    history.insert(
        0, ChatMessage(role="system", content=build_charter_system_content())
    )


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

# Printable ASCII only; anything else is suspicious and should not reach a
# provider HTTP header.  255 chars is generous enough for any real key format.
_PRINTABLE_ASCII_RE = re.compile(r"^[\x20-\x7E]+$")
_MAX_API_KEY_LEN = 255


def _validate_api_key(provider_name: str, value: str) -> None:
    """Raise ``ValueError`` if *value* is not safe to forward as an API key.

    Checks: non-empty, printable ASCII only, reasonable length.  Known
    provider prefixes (sk-, sk-ant-, etc.) are *not* enforced here because
    new providers may use different formats; the HTTP client will surface an
    authentication error if the key is wrong.
    """
    if not isinstance(value, str) or not value:
        raise ValueError(
            f"API key for {provider_name!r} failed format validation "
            "(must be printable ASCII, max 255 characters)"
        )
    if len(value) > _MAX_API_KEY_LEN:
        raise ValueError(
            f"API key for {provider_name!r} failed format validation "
            "(must be printable ASCII, max 255 characters)"
        )
    if not _PRINTABLE_ASCII_RE.match(value):
        raise ValueError(
            f"API key for {provider_name!r} failed format validation "
            "(must be printable ASCII, max 255 characters)"
        )


def _apply_api_keys(api_keys: object) -> None:
    keys: dict[str, object] = api_keys if isinstance(api_keys, dict) else {}
    for provider_name, env_var in _KEY_ENV_MAP.items():
        value = keys.get(provider_name)
        if isinstance(value, str) and value.strip():
            stripped = value.strip()
            _validate_api_key(provider_name, stripped)
            os.environ[env_var] = stripped
        else:
            os.environ.pop(env_var, None)


# ---------------------------------------------------------------------------
# Command handlers
# ---------------------------------------------------------------------------


def _resolve_chat_context(
    request: dict[str, Any],
) -> tuple[Path, Path | None, ScopeContext | None]:
    """Resolve write root + casefile root + (optional) full ScopeContext.

    Returns a triple `(write_root, casefile_root, scope)`.
    - When a `casefileRoot` + `laneId` is provided, `scope` is the full
      cascade (ancestors + attachments + casefile context files) and
      `write_root` is the lane's own directory.
    - When only `casefileRoot` is provided, the casefile's active lane is
      used, with the same cascade semantics.
    - When neither is provided, falls back to `workspaceRoot` or cwd. This
      is the back-compat path for any caller that has not migrated to
      casefiles (notably the bare `python -m assistant_app.electron_bridge`
      smoke test).
    """
    casefile_root_raw = request.get("casefileRoot")
    if isinstance(casefile_root_raw, str) and casefile_root_raw.strip():
        casefile_root = Path(casefile_root_raw).resolve()
        service = CasefileService(casefile_root)
        lane_id_raw = request.get("laneId")
        lane_id = (
            lane_id_raw.strip()
            if isinstance(lane_id_raw, str) and lane_id_raw.strip()
            else None
        )
        lane = service.resolve_lane(lane_id)
        scope = service.resolve_scope(lane.id)
        return scope.write_root, casefile_root, scope
    workspace_root_raw = request.get("workspaceRoot")
    if isinstance(workspace_root_raw, str) and workspace_root_raw.strip():
        return Path(workspace_root_raw).resolve(), None, None
    return Path.cwd().resolve(), None, None


def _build_context_system_prompt(scope: ScopeContext) -> str | None:
    """Format the auto-injected casefile-context system message.

    Returns None when there is nothing to inject (no overlays and no
    auto-include candidates), so callers can skip prepending an empty
    message to the chat history.
    """
    candidates = scope.auto_include_candidates()
    overlays = scope.read_overlays
    if not candidates and not overlays:
        return None
    parts: list[str] = ["You are operating inside a DeskAssist casefile scope."]
    if overlays:
        parts.append(
            "You have read-only access to the following overlay roots in addition to "
            "your write root. Reference them via the listed virtual prefix:"
        )
        for overlay in overlays:
            parts.append(f"  - {overlay.prefix}/  ({overlay.label})")
    if candidates:
        parts.append(
            "Casefile-wide context files (auto-included verbatim below; treat as "
            "authoritative shared instructions):"
        )
        for entry in candidates:
            try:
                content = entry.absolute_path.read_text(encoding="utf-8")
            except OSError:
                continue
            parts.append(f"\n--- BEGIN _context/{entry.relative_path} ---\n{content}\n--- END _context/{entry.relative_path} ---")
    return "\n".join(parts)


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

    workspace_root, casefile_root, scope = _resolve_chat_context(request)
    # When a scope is active we layer ancestor + attachment + casefile-context
    # roots into the tool registry as read-only overlays. The write root stays
    # the lane's own directory, so the M2 isolation guarantee (writes can't
    # cross sibling lanes) is preserved.
    read_overlays = scope.overlay_map() if scope is not None else None

    service = ChatService(
        default_provider_name=provider,
        workspace_root=workspace_root,
        casefile_root=casefile_root,
        read_overlays=read_overlays,
    )
    parsed_history = _parse_messages(history_raw)

    # M4.5: product-owned charter. Always layer 1, regardless of whether a
    # casefile is open — it frames the assistant's identity for plain
    # workspace chats too, not just casefile-scoped ones.
    _prepend_assistant_charter(parsed_history)

    if scope is not None:
        context_prompt = _build_context_system_prompt(scope)
        # Only inject when (a) there's actually context to inject and (b) the
        # caller hasn't already placed one (idempotent for resumed turns).
        # Offset by 1 when the charter is at index 0 so the on-the-wire order
        # is always `[charter, context, prompt, ...]`.
        if context_prompt and not _history_has_context_marker(parsed_history):
            ctx_idx = 1 if _history_has_charter_marker(parsed_history) else 0
            parsed_history.insert(
                ctx_idx, ChatMessage(role="system", content=context_prompt)
            )

    # M4.1: optional user-selected prompt draft. Loaded after the auto-context
    # block so casefile-wide instructions are still in effect; the user's
    # prompt augments them rather than replacing them. We tag the injected
    # message with the prompt id so a resumed turn does not stack duplicates,
    # but switching prompts mid-conversation does correctly append a new one.
    raw_prompt_id = request.get("systemPromptId")
    if (
        casefile_root is not None
        and isinstance(raw_prompt_id, str)
        and raw_prompt_id.strip()
    ):
        try:
            prompt = PromptsStore(casefile_root).get(raw_prompt_id.strip())
        except (KeyError, ValueError) as exc:
            raise ValueError(f"systemPromptId {raw_prompt_id!r}: {exc}") from exc
        if not _history_has_prompt_marker(parsed_history, prompt.id):
            # Insert after charter (M4.5) and context (M3.5a) so the layered
            # order is preserved even when only some layers are present.
            insert_at = (
                (1 if _history_has_charter_marker(parsed_history) else 0)
                + (1 if _history_has_context_marker(parsed_history) else 0)
            )
            parsed_history.insert(
                insert_at,
                ChatMessage(role="system", content=_build_prompt_system_message(prompt)),
            )

    service.replace_history(parsed_history)
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
    resolved = Path(root).resolve()
    _validate_path_depth(resolved, "root")
    service = CasefileService(resolved)
    snapshot = service.open()
    return {"ok": True, "casefile": service.serialize(snapshot)}


def handle_casefile_register_lane(request: dict[str, Any]) -> dict[str, Any]:
    casefile_root_path = _require_casefile_root(request)
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
    raw_lane_path = Path(lane_root_raw.strip())
    resolved_lane_root = (
        raw_lane_path.resolve()
        if raw_lane_path.is_absolute()
        else (casefile_root_path / raw_lane_path).resolve()
    )
    _validate_path_depth(resolved_lane_root, "lane.root")
    lane_id_raw = lane_raw.get("id")
    lane_id = lane_id_raw if isinstance(lane_id_raw, str) and lane_id_raw.strip() else None
    parent_id_raw = lane_raw.get("parentId") if "parentId" in lane_raw else lane_raw.get("parent_id")
    parent_id = (
        parent_id_raw.strip()
        if isinstance(parent_id_raw, str) and parent_id_raw.strip()
        else None
    )
    attachments = parse_attachments(lane_raw.get("attachments"))
    service = CasefileService(casefile_root_path)
    snapshot = service.register_lane(
        name=name,
        kind=kind,
        root=resolved_lane_root,
        lane_id=lane_id,
        parent_id=parent_id,
        attachments=attachments,
    )
    return {"ok": True, "casefile": service.serialize(snapshot)}


def handle_casefile_update_lane_attachments(request: dict[str, Any]) -> dict[str, Any]:
    root = request.get("casefileRoot")
    if not isinstance(root, str) or not root.strip():
        raise ValueError("casefileRoot is required")
    lane_id = request.get("laneId")
    if not isinstance(lane_id, str) or not lane_id.strip():
        raise ValueError("laneId is required")
    attachments = parse_attachments(request.get("attachments"))
    service = CasefileService(Path(root))
    snapshot = service.update_lane_attachments(lane_id, attachments)
    return {"ok": True, "casefile": service.serialize(snapshot)}


def handle_casefile_update_lane(request: dict[str, Any]) -> dict[str, Any]:
    """M4.6: edit a lane's name / kind / root.

    Each of ``name``, ``kind``, ``root`` is independently optional.
    Omitting a field (or passing ``null``) leaves the existing value
    unchanged. Parent and attachments are handled by their own
    dedicated commands (``casefile:setLaneParent`` /
    ``casefile:updateLaneAttachments``); the lane id is immutable.

    When the resulting lane root matches another lane's root, a
    non-blocking warning is surfaced via ``rootConflict`` so the
    renderer can highlight the overlap without aborting the edit.
    """
    casefile_root_path = _require_casefile_root(request)
    lane_id = request.get("laneId")
    if not isinstance(lane_id, str) or not lane_id.strip():
        raise ValueError("laneId is required")
    name_raw = request.get("name")
    kind_raw = request.get("kind")
    root_raw = request.get("root")
    name: str | None
    if name_raw is None:
        name = None
    elif isinstance(name_raw, str):
        name = name_raw
    else:
        raise ValueError("name must be a string or null")
    kind: str | None
    if kind_raw is None:
        kind = None
    elif isinstance(kind_raw, str):
        kind = kind_raw
    else:
        raise ValueError("kind must be a string or null")
    new_root: Path | None
    if root_raw is None:
        new_root = None
    elif isinstance(root_raw, str) and root_raw.strip():
        raw_path = Path(root_raw.strip())
        new_root = (
            raw_path.resolve()
            if raw_path.is_absolute()
            else (casefile_root_path / raw_path).resolve()
        )
        _validate_path_depth(new_root, "root")
    else:
        raise ValueError("root must be a non-empty string or null")
    service = CasefileService(casefile_root_path)
    snapshot = service.update_lane(
        lane_id.strip(), name=name, kind=kind, root=new_root,
    )
    payload: dict[str, Any] = {
        "ok": True,
        "casefile": service.serialize(snapshot),
    }
    # Only check for conflict when the root was touched. Editing only
    # name/kind cannot create or remove a conflict.
    if new_root is not None:
        conflict = service.find_root_conflict(
            new_root, exclude_lane_id=lane_id.strip()
        )
        if conflict:
            payload["rootConflict"] = {"conflictingLaneId": conflict}
    return payload


def handle_casefile_remove_lane(request: dict[str, Any]) -> dict[str, Any]:
    """M4.6: remove a lane from the casefile.

    On-disk per-lane data files (``chats/<id>.jsonl``,
    ``notes/<id>.md``, findings tagged with this lane) are intentionally
    preserved so re-registering a lane with the same id resurrects the
    prior history. The renderer is responsible for surfacing a
    confirmation dialog before invoking this.
    """
    casefile_root_path = _require_casefile_root(request)
    lane_id = request.get("laneId")
    if not isinstance(lane_id, str) or not lane_id.strip():
        raise ValueError("laneId is required")
    service = CasefileService(casefile_root_path)
    snapshot = service.remove_lane(lane_id.strip())
    return {"ok": True, "casefile": service.serialize(snapshot)}


def handle_casefile_hard_reset(request: dict[str, Any]) -> dict[str, Any]:
    """M4.6: nuke ``.casefile/`` and re-initialize it.

    The returned snapshot is the freshly initialized casefile (default
    ``main`` lane, no chats, no findings, no prompts, etc.). The
    renderer must gate this behind a confirmation dialog; the bridge
    does not.
    """
    casefile_root_path = _require_casefile_root(request)
    service = CasefileService(casefile_root_path)
    snapshot = service.hard_reset()
    return {"ok": True, "casefile": service.serialize(snapshot)}


def handle_casefile_soft_reset(request: dict[str, Any]) -> dict[str, Any]:
    """M4.6: clear per-task scratch (lanes, chats, findings, notes,
    runs, exports). Optionally also clear prompts via ``keepPrompts``.

    Preserves ``context.json`` and ``inbox.json`` regardless. Also
    re-creates the default ``main`` lane so the casefile is immediately
    usable for a new task.
    """
    casefile_root_path = _require_casefile_root(request)
    keep_prompts_raw = request.get("keepPrompts", True)
    if not isinstance(keep_prompts_raw, bool):
        raise ValueError("keepPrompts must be a boolean")
    service = CasefileService(casefile_root_path)
    snapshot = service.soft_reset(keep_prompts=keep_prompts_raw)
    return {"ok": True, "casefile": service.serialize(snapshot)}


def handle_casefile_set_lane_parent(request: dict[str, Any]) -> dict[str, Any]:
    root = request.get("casefileRoot")
    if not isinstance(root, str) or not root.strip():
        raise ValueError("casefileRoot is required")
    lane_id = request.get("laneId")
    if not isinstance(lane_id, str) or not lane_id.strip():
        raise ValueError("laneId is required")
    raw_parent = request.get("parentId")
    parent_id: str | None
    if raw_parent is None:
        parent_id = None
    elif isinstance(raw_parent, str):
        parent_id = raw_parent.strip() or None
    else:
        raise ValueError("parentId must be a string or null")
    service = CasefileService(Path(root))
    snapshot = service.set_lane_parent(lane_id, parent_id)
    return {"ok": True, "casefile": service.serialize(snapshot)}


def handle_casefile_get_context(request: dict[str, Any]) -> dict[str, Any]:
    root = _require_casefile_root(request)
    service = CasefileService(root)
    manifest = service.load_context_manifest()
    files = service.context_store().resolve_files(manifest)
    return {"ok": True, "context": serialize_context_manifest(manifest, files)}


def handle_casefile_save_context(request: dict[str, Any]) -> dict[str, Any]:
    root = _require_casefile_root(request)
    raw = request.get("context")
    if not isinstance(raw, dict):
        raise ValueError("context object is required")
    raw_files = raw.get("files", [])
    if not isinstance(raw_files, list):
        raise ValueError("context.files must be an array")
    files: list[str] = []
    for entry in raw_files:
        if isinstance(entry, str) and entry.strip():
            files.append(entry.strip())
    raw_max = raw.get("autoIncludeMaxBytes") if "autoIncludeMaxBytes" in raw else raw.get("auto_include_max_bytes")
    manifest_kwargs: dict[str, Any] = {"files": tuple(files)}
    if isinstance(raw_max, int) and not isinstance(raw_max, bool) and raw_max >= 0:
        manifest_kwargs["auto_include_max_bytes"] = raw_max
    service = CasefileService(root)
    saved = service.save_context_manifest(ContextManifest(**manifest_kwargs))
    files_resolved = service.context_store().resolve_files(saved)
    return {"ok": True, "context": serialize_context_manifest(saved, files_resolved)}


def handle_casefile_resolve_scope(request: dict[str, Any]) -> dict[str, Any]:
    root = _require_casefile_root(request)
    lane_id = request.get("laneId")
    if not isinstance(lane_id, str) or not lane_id.strip():
        raise ValueError("laneId is required")
    service = CasefileService(root)
    scope = service.resolve_scope(lane_id)
    return {"ok": True, "scope": serialize_scope(scope)}


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
    messages, skipped = service.read_chat(lane_id)
    result: dict[str, Any] = {"ok": True, "messages": messages}
    if skipped:
        result["skippedCorruptLines"] = skipped
    return result


# ---------------------------------------------------------------------------
# M3 handlers: findings / notes / compare / export / lane-scoped read
# ---------------------------------------------------------------------------


def _require_casefile_root(request: dict[str, Any]) -> Path:
    root = request.get("casefileRoot")
    if not isinstance(root, str) or not root.strip():
        raise ValueError("casefileRoot is required")
    resolved = Path(root).resolve()
    _validate_path_depth(resolved, "casefileRoot")
    return resolved


def _validate_path_depth(p: Path, field: str) -> None:
    """Reject obviously dangerous root paths.

    Two independent checks:

    1. **Depth** — at least 3 components (e.g. ``/home/user/x``).  This
       prevents ``/``, ``/etc``, and other single-level paths from being used
       as casefile or lane roots.

    2. **Sensitive-directory denylist** — rejects paths that are equal to or
       nested inside known sensitive system directories and user credential
       stores.  This is a best-effort defence; the real authorisation boundary
       is the OS file-permission check at write time, but failing early with a
       clear message is better than a cryptic permission error.
    """
    if len(p.parts) < 3:
        raise ValueError(
            f"{field} path is too shallow to be a safe root: {p!r} "
            "(must have at least two directory levels below the filesystem root)"
        )
    for prefix in _SENSITIVE_PATH_PREFIXES:
        try:
            is_inside = (p == prefix) or p.is_relative_to(prefix)
        except (TypeError, ValueError):
            # is_relative_to can raise on unusual paths; treat as not inside.
            continue
        if is_inside:
            raise ValueError(
                f"{field} path is inside a sensitive system directory "
                f"({prefix}): {p!r}"
            )


def _build_sensitive_prefixes() -> tuple[Path, ...]:
    """Compute the sensitive-path denylist once at module load time.

    NOTE: This list covers POSIX/Linux paths only.  Windows is not a current
    deployment target; these paths are no-ops on Windows and no Windows-specific
    paths (e.g. %SystemRoot%, %USERPROFILE%\\.ssh) are included.  If Windows
    support is added, gate by ``os.name == "nt"`` and extend accordingly.
    """
    prefixes: list[Path] = [
        Path("/etc"),
        Path("/var"),
        Path("/usr"),
        Path("/bin"),
        Path("/sbin"),
        Path("/lib"),
        Path("/lib64"),
        Path("/boot"),
        Path("/proc"),
        Path("/sys"),
        Path("/dev"),
        Path("/root"),
    ]
    try:
        home = Path.home()
        prefixes.extend([home / ".ssh", home / ".gnupg", home / ".aws"])
    except RuntimeError:
        pass
    return tuple(prefixes)


_SENSITIVE_PATH_PREFIXES: tuple[Path, ...] = _build_sensitive_prefixes()


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
    # Optional per-call overrides for the safety caps.  The defaults in
    # compare.compare_lanes are tuned for "monorepo-sized" lanes (250k
    # files / 2 GB combined); callers that know they need more can pass
    # explicit values, but we still validate they are positive ints to
    # avoid accidental "unbounded" comparisons.
    kwargs: dict[str, Any] = {}
    for key, src in (
        ("max_files_per_lane", "maxFilesPerLane"),
        ("max_bytes_per_file", "maxBytesPerFile"),
        ("max_total_bytes", "maxTotalBytes"),
    ):
        raw = request.get(src)
        if raw is None:
            continue
        if not isinstance(raw, int) or isinstance(raw, bool) or raw <= 0:
            raise ValueError(f"{src} must be a positive integer")
        kwargs[key] = raw
    comparison = compare_lanes(left, right, **kwargs)
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


def handle_casefile_read_overlay_file(request: dict[str, Any]) -> dict[str, Any]:
    """Read a file from one of the active scope's read overlays.

    Used by the renderer's "Show ancestor files" file-tree view. The path
    must use a virtual prefix (e.g. `_ancestors/<lane>/foo.md`,
    `_attachments/notes/log.txt`, `_context/Rubric.md`); the scope's
    overlay map handles the rewrite to a real disk path. Reads are
    bounded just like `lane:readFile`.
    """
    root = _require_casefile_root(request)
    lane_id = request.get("laneId")
    file_path = request.get("path")
    if not isinstance(lane_id, str) or not lane_id.strip():
        raise ValueError("laneId is required")
    if not isinstance(file_path, str) or not file_path.strip():
        raise ValueError("path is required")
    max_chars_raw = request.get("maxChars")
    max_chars = (
        int(max_chars_raw)
        if isinstance(max_chars_raw, int) and max_chars_raw > 0
        else 200_000
    )
    service = CasefileService(root)
    scope = service.resolve_scope(lane_id)
    fs = WorkspaceFilesystem(scope.write_root, read_overlays=scope.overlay_map())
    content, truncated, target = fs.read_text_bounded(file_path, max_chars)
    return {"ok": True, "path": str(target), "content": content, "truncated": truncated}


# ---------------------------------------------------------------------------
# M4.1: prompt drafts
# ---------------------------------------------------------------------------


def _serialize_prompt_summary(summary: PromptSummary) -> dict[str, Any]:
    return {
        "id": summary.id,
        "name": summary.name,
        "createdAt": summary.created_at,
        "updatedAt": summary.updated_at,
        "sizeBytes": summary.size_bytes,
    }


def _serialize_prompt(draft: PromptDraft) -> dict[str, Any]:
    return {
        "id": draft.id,
        "name": draft.name,
        "body": draft.body,
        "createdAt": draft.created_at,
        "updatedAt": draft.updated_at,
    }


def handle_casefile_list_prompts(request: dict[str, Any]) -> dict[str, Any]:
    root = _require_casefile_root(request)
    summaries = PromptsStore(root).list()
    return {"ok": True, "prompts": [_serialize_prompt_summary(s) for s in summaries]}


def handle_casefile_get_prompt(request: dict[str, Any]) -> dict[str, Any]:
    root = _require_casefile_root(request)
    prompt_id = request.get("promptId")
    if not isinstance(prompt_id, str) or not prompt_id.strip():
        raise ValueError("promptId is required")
    draft = PromptsStore(root).get(prompt_id.strip())
    return {"ok": True, "prompt": _serialize_prompt(draft)}


def _prompt_input(request: dict[str, Any]) -> dict[str, Any]:
    raw = request.get("prompt")
    if not isinstance(raw, dict):
        raise ValueError("prompt object is required")
    return raw


def handle_casefile_create_prompt(request: dict[str, Any]) -> dict[str, Any]:
    """Create a new prompt draft. The id is derived from the name unless one
    is explicitly supplied; an existing-id collision is resolved by suffixing
    `-2`, `-3`, ... so the renderer never has to handle a 409-shaped error.
    """
    root = _require_casefile_root(request)
    raw = _prompt_input(request)
    name = raw.get("name")
    if not isinstance(name, str) or not name.strip():
        raise ValueError("prompt.name is required")
    body = raw.get("body") if isinstance(raw.get("body"), str) else ""
    raw_id = raw.get("id")
    prompt_id = raw_id.strip() if isinstance(raw_id, str) and raw_id.strip() else None
    draft = PromptsStore(root).create(name=name, body=body, prompt_id=prompt_id)
    return {"ok": True, "prompt": _serialize_prompt(draft)}


def handle_casefile_save_prompt(request: dict[str, Any]) -> dict[str, Any]:
    """Update an existing prompt's name or body. Either field is optional;
    omitting both is a no-op (still returns the current draft so the
    renderer can refresh its view without a separate `get`)."""
    root = _require_casefile_root(request)
    prompt_id = request.get("promptId")
    if not isinstance(prompt_id, str) or not prompt_id.strip():
        raise ValueError("promptId is required")
    raw = _prompt_input(request)
    update_kwargs: dict[str, Any] = {}
    if "name" in raw and isinstance(raw["name"], str):
        update_kwargs["name"] = raw["name"]
    if "body" in raw and isinstance(raw["body"], str):
        update_kwargs["body"] = raw["body"]
    draft = PromptsStore(root).save(prompt_id.strip(), **update_kwargs)
    return {"ok": True, "prompt": _serialize_prompt(draft)}


def handle_casefile_delete_prompt(request: dict[str, Any]) -> dict[str, Any]:
    root = _require_casefile_root(request)
    prompt_id = request.get("promptId")
    if not isinstance(prompt_id, str) or not prompt_id.strip():
        raise ValueError("promptId is required")
    PromptsStore(root).delete(prompt_id.strip())
    return {"ok": True}


# ---------------------------------------------------------------------------
# M4.2: runs handlers
# ---------------------------------------------------------------------------


def _serialize_run_summary(summary: RunSummary) -> dict[str, Any]:
    return {
        "id": summary.id,
        "command": summary.command,
        "laneId": summary.lane_id,
        "startedAt": summary.started_at,
        "exitCode": summary.exit_code,
        "error": summary.error,
    }


def _serialize_run(record: RunRecord) -> dict[str, Any]:
    return {
        "id": record.id,
        "command": record.command,
        "laneId": record.lane_id,
        "cwd": record.cwd,
        "startedAt": record.started_at,
        "finishedAt": record.finished_at,
        "exitCode": record.exit_code,
        "stdout": record.stdout,
        "stderr": record.stderr,
        "stdoutTruncated": record.stdout_truncated,
        "stderrTruncated": record.stderr_truncated,
        "timeoutSeconds": record.timeout_seconds,
        "maxOutputChars": record.max_output_chars,
        "error": record.error,
    }


def handle_casefile_list_runs(request: dict[str, Any]) -> dict[str, Any]:
    root = _require_casefile_root(request)
    raw_lane = request.get("laneId")
    lane_id = raw_lane.strip() if isinstance(raw_lane, str) and raw_lane.strip() else None
    summaries = RunsStore(root).list(lane_id=lane_id)
    return {"ok": True, "runs": [_serialize_run_summary(s) for s in summaries]}


def handle_casefile_get_run(request: dict[str, Any]) -> dict[str, Any]:
    root = _require_casefile_root(request)
    run_id = request.get("runId")
    if not isinstance(run_id, str) or not run_id.strip():
        raise ValueError("runId is required")
    record = RunsStore(root).get(run_id.strip())
    return {"ok": True, "run": _serialize_run(record)}


def handle_casefile_delete_run(request: dict[str, Any]) -> dict[str, Any]:
    root = _require_casefile_root(request)
    run_id = request.get("runId")
    if not isinstance(run_id, str) or not run_id.strip():
        raise ValueError("runId is required")
    RunsStore(root).delete(run_id.strip())
    return {"ok": True}


def handle_runs_get_allowed_executables(_request: dict[str, Any]) -> dict[str, Any]:
    """Return the safe-allowlist for the renderer's Runs tab.

    The frontend used to maintain its own copy of this list; routing the
    canonical set through the bridge means a backend allowlist change can
    never silently desync from the UI hint.
    """
    return {"ok": True, "executables": sorted(ALLOWED_EXECUTABLES)}


def handle_casefile_run_command(request: dict[str, Any]) -> dict[str, Any]:
    """Execute one safe-allowlisted command and persist the result.

    The cwd resolves to the lane root when ``laneId`` is supplied, otherwise
    the casefile root itself — same as how findings/notes scope. We never
    fall back to an arbitrary directory: the lane root is the only path
    surface the user has explicitly registered as workspace-writable.

    Validation/permission/timeout failures are recorded *into* the run
    record (with ``exit_code: null`` and a populated ``error`` field) rather
    than raised, so the renderer can render the failed run alongside
    successful ones from the list endpoint without two error paths.
    """
    root = _require_casefile_root(request)
    # The dispatch envelope already uses "command" for the bridge command
    # name (e.g. "casefile:runCommand"), so the shell command lives under
    # a separate "commandLine" field. Renaming once here keeps the public
    # IPC surface unambiguous.
    command_line = request.get("commandLine")
    if not isinstance(command_line, str) or not command_line.strip():
        raise ValueError("commandLine is required")
    raw_lane = request.get("laneId")
    lane_id = raw_lane.strip() if isinstance(raw_lane, str) and raw_lane.strip() else None
    if lane_id is not None:
        snapshot = CasefileService(root).snapshot()
        # `lane_by_id` raises KeyError on miss; translate into a ValueError
        # with a descriptive message so the bridge `error` field is human-
        # readable (otherwise `str(KeyError('x'))` becomes the unhelpful
        # quoted string `"'x'"`). Mirrors the pattern in findings/prompts.
        try:
            lane = snapshot.lane_by_id(lane_id)
        except KeyError as exc:
            raise ValueError(f"Unknown laneId: {lane_id!r}") from exc
        cwd = lane.root
    else:
        cwd = root

    # Range-check at the bridge level so out-of-range inputs surface as
    # plain validation errors rather than being baked into a persisted
    # run record (which is what would happen if we let `run_safe` raise
    # downstream from `RunsStore.start`).
    timeout_raw = request.get("timeoutSeconds")
    if timeout_raw is None:
        timeout_seconds = DEFAULT_RUN_TIMEOUT_SECONDS
    elif isinstance(timeout_raw, int) and not isinstance(timeout_raw, bool):
        if timeout_raw < 1 or timeout_raw > 120:
            raise ValueError("timeoutSeconds must be between 1 and 120")
        timeout_seconds = timeout_raw
    else:
        raise ValueError("timeoutSeconds must be an integer")

    max_chars_raw = request.get("maxOutputChars")
    if max_chars_raw is None:
        max_output_chars = DEFAULT_RUN_MAX_OUTPUT_CHARS
    elif isinstance(max_chars_raw, int) and not isinstance(max_chars_raw, bool):
        if max_chars_raw < 1 or max_chars_raw > 200_000:
            raise ValueError("maxOutputChars must be between 1 and 200000")
        max_output_chars = max_chars_raw
    else:
        raise ValueError("maxOutputChars must be an integer")

    record = RunsStore(root).start(
        command=command_line,
        cwd=cwd,
        lane_id=lane_id,
        timeout_seconds=timeout_seconds,
        max_output_chars=max_output_chars,
    )
    return {"ok": True, "run": _serialize_run(record)}


# ---------------------------------------------------------------------------
# M4.3: inbox handlers
# ---------------------------------------------------------------------------


def _serialize_inbox_source(source: InboxSource) -> dict[str, Any]:
    return {"id": source.id, "name": source.name, "root": source.root}


def _serialize_inbox_item(item: InboxItem) -> dict[str, Any]:
    return {
        "sourceId": item.source_id,
        "path": item.path,
        "sizeBytes": item.size_bytes,
    }


def handle_casefile_list_inbox_sources(request: dict[str, Any]) -> dict[str, Any]:
    root = _require_casefile_root(request)
    sources = InboxStore(root).list_sources()
    return {"ok": True, "sources": [_serialize_inbox_source(s) for s in sources]}


def handle_casefile_add_inbox_source(request: dict[str, Any]) -> dict[str, Any]:
    root = _require_casefile_root(request)
    name = request.get("name")
    src_root = request.get("root")
    raw_id = request.get("sourceId")
    if not isinstance(name, str) or not name.strip():
        raise ValueError("name is required")
    if not isinstance(src_root, str) or not src_root.strip():
        raise ValueError("root is required")
    source_id = raw_id.strip() if isinstance(raw_id, str) and raw_id.strip() else None
    source = InboxStore(root).add_source(
        name=name, root=src_root, source_id=source_id
    )
    return {"ok": True, "source": _serialize_inbox_source(source)}


def handle_casefile_update_inbox_source(request: dict[str, Any]) -> dict[str, Any]:
    root = _require_casefile_root(request)
    source_id = request.get("sourceId")
    if not isinstance(source_id, str) or not source_id.strip():
        raise ValueError("sourceId is required")
    name = request.get("name")
    src_root = request.get("root")
    update_kwargs: dict[str, Any] = {}
    if isinstance(name, str):
        update_kwargs["name"] = name
    if isinstance(src_root, str):
        update_kwargs["root"] = src_root
    if not update_kwargs:
        raise ValueError("nothing to update: provide name and/or root")
    source = InboxStore(root).update_source(source_id.strip(), **update_kwargs)
    return {"ok": True, "source": _serialize_inbox_source(source)}


def handle_casefile_remove_inbox_source(request: dict[str, Any]) -> dict[str, Any]:
    root = _require_casefile_root(request)
    source_id = request.get("sourceId")
    if not isinstance(source_id, str) or not source_id.strip():
        raise ValueError("sourceId is required")
    InboxStore(root).remove_source(source_id.strip())
    return {"ok": True}


def handle_casefile_list_inbox_items(request: dict[str, Any]) -> dict[str, Any]:
    root = _require_casefile_root(request)
    source_id = request.get("sourceId")
    if not isinstance(source_id, str) or not source_id.strip():
        raise ValueError("sourceId is required")
    raw_depth = request.get("maxDepth")
    max_depth = int(raw_depth) if isinstance(raw_depth, int) and raw_depth > 0 else None
    items = InboxStore(root).list_items(source_id.strip(), max_depth=max_depth)
    return {"ok": True, "items": [_serialize_inbox_item(it) for it in items]}


def handle_casefile_read_inbox_item(request: dict[str, Any]) -> dict[str, Any]:
    root = _require_casefile_root(request)
    source_id = request.get("sourceId")
    relative = request.get("path")
    if not isinstance(source_id, str) or not source_id.strip():
        raise ValueError("sourceId is required")
    if not isinstance(relative, str) or not relative.strip():
        raise ValueError("path is required")
    raw_max = request.get("maxChars")
    if isinstance(raw_max, int) and raw_max > 0:
        content, truncated, abs_path = InboxStore(root).read_item(
            source_id.strip(), relative, max_chars=raw_max
        )
    else:
        content, truncated, abs_path = InboxStore(root).read_item(
            source_id.strip(), relative
        )
    return {
        "ok": True,
        "content": content,
        "truncated": truncated,
        "absolutePath": abs_path,
    }


# ---------------------------------------------------------------------------
# M3.5c: comparison chat handlers
# ---------------------------------------------------------------------------


def _parse_lane_ids(request: dict[str, Any]) -> list[str]:
    raw = request.get("laneIds")
    if not isinstance(raw, list) or len(raw) < 2:
        raise ValueError("laneIds must be an array of at least two lane ids")
    ids: list[str] = []
    for item in raw:
        if not isinstance(item, str) or not item.strip():
            raise ValueError("each laneIds entry must be a non-empty string")
        ids.append(item.strip())
    if len(set(ids)) < 2:
        raise ValueError("laneIds must contain at least two distinct ids")
    return ids


def _serialize_comparison_summary(
    service: CasefileService, lane_ids: list[str]
) -> dict[str, Any]:
    """Build the IPC-shaped session metadata for a comparison chat.

    Lane summaries are emitted in the *same sorted order* used to build the
    synthetic id and the log filename, so the renderer banner stays stable
    across selection orderings.
    """
    snapshot = service.snapshot()
    sorted_ids = sorted(set(lane_ids))
    lanes = [snapshot.lane_by_id(lid) for lid in sorted_ids]
    return {
        "id": service.comparison_id(sorted_ids),
        "laneIds": sorted_ids,
        "lanes": [
            {"id": lane.id, "name": lane.name, "root": str(lane.root)}
            for lane in lanes
        ],
    }


def handle_casefile_open_comparison(request: dict[str, Any]) -> dict[str, Any]:
    """Open (or re-open) a comparison chat session over ``laneIds``.

    Returns the synthetic session id, the lane summaries (in the canonical
    sorted order), and any persisted history loaded from the comparison
    chat log.  Idempotent: re-opening the same set of lanes yields the
    same id and surfaces the existing history.
    """
    root = _require_casefile_root(request)
    lane_ids = _parse_lane_ids(request)
    service = CasefileService(root)
    # Validate the lanes exist and the cascade resolves cleanly.  If a lane
    # in the set was deleted out-of-band, this raises before we report a
    # "loaded" session that is already broken.
    service.resolve_comparison_scope(lane_ids)
    summary = _serialize_comparison_summary(service, lane_ids)
    messages, skipped = service.read_comparison_chat(lane_ids)
    payload: dict[str, Any] = {
        "ok": True,
        "comparison": {**summary, "messages": messages},
    }
    if skipped:
        payload["comparison"]["skippedCorruptLines"] = skipped
    return payload


def handle_casefile_send_comparison_chat(request: dict[str, Any]) -> dict[str, Any]:
    """Run one chat turn against a comparison session.

    The session is read-only by construction: the registry is built with
    ``enable_writes=False`` so no save / append / delete tool exists for
    the model to call.  ``allowWriteTools`` and ``resumePendingToolCalls``
    are accepted for shape parity with ``chat:send`` but the former is
    forced to ``False`` here — there are no write tools to approve.
    """
    root = _require_casefile_root(request)
    lane_ids = _parse_lane_ids(request)
    provider = str(request.get("provider") or "openai")
    model = request.get("model")
    user_message = request.get("userMessage")
    resume_pending = bool(request.get("resumePendingToolCalls", False))
    if not resume_pending and (
        not isinstance(user_message, str) or not user_message.strip()
    ):
        raise ValueError("userMessage is required")

    _apply_api_keys(request.get("apiKeys"))

    history_raw = request.get("messages") or []
    if not isinstance(history_raw, list):
        raise ValueError("messages must be an array")

    service = CasefileService(root)
    scope = service.resolve_comparison_scope(lane_ids)

    chat = ChatService(
        default_provider_name=provider,
        workspace_root=scope.write_root,
        casefile_root=root,
        read_overlays=scope.overlay_map(),
        enable_writes=False,
    )
    parsed_history = _parse_messages(history_raw)
    # M4.5: charter applies to comparison sessions too. Comparison chats are
    # the most likely place for the model to drift into "let me plan this
    # diff review" if left to its own defaults, so the charter is at least
    # as important here as in single-lane chat.
    _prepend_assistant_charter(parsed_history)
    context_prompt = _build_context_system_prompt(scope)
    if context_prompt and not _history_has_context_marker(parsed_history):
        ctx_idx = 1 if _history_has_charter_marker(parsed_history) else 0
        parsed_history.insert(ctx_idx, ChatMessage(role="system", content=context_prompt))
    chat.replace_history(parsed_history)
    history_before_count = len(chat.history)
    if resume_pending:
        response = chat.resume_pending_tool_calls(
            model=model if isinstance(model, str) else None,
            allow_write_tools=False,
        )
    else:
        response = chat.send_user_message(
            user_message,
            model=model if isinstance(model, str) else None,
            allow_write_tools=False,
        )
    history_delta = chat.history[history_before_count:]
    serialized_delta = [_serialize_message(m) for m in history_delta]

    persistence_error: str | None = None
    try:
        service.append_comparison_chat(lane_ids, serialized_delta)
    except Exception as exc:  # noqa: BLE001
        persistence_error = (
            f"comparison chat persistence failed: {type(exc).__name__}: {exc}"
        )

    payload: dict[str, Any] = {
        "ok": True,
        "message": _serialize_message(response),
        "messages": serialized_delta,
        # Comparison sessions never produce write-tool approvals (no write
        # tools are registered) but we emit the empty list for shape parity
        # with chat:send so the renderer can reuse its rendering code.
        "pendingApprovals": [],
        "comparison": _serialize_comparison_summary(service, lane_ids),
    }
    if persistence_error:
        payload["persistenceError"] = persistence_error
    return payload


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
    "casefile:updateLane": handle_casefile_update_lane,
    "casefile:removeLane": handle_casefile_remove_lane,
    "casefile:updateLaneAttachments": handle_casefile_update_lane_attachments,
    "casefile:setLaneParent": handle_casefile_set_lane_parent,
    "casefile:hardReset": handle_casefile_hard_reset,
    "casefile:softReset": handle_casefile_soft_reset,
    "casefile:switchLane": handle_casefile_switch_lane,
    "casefile:getContext": handle_casefile_get_context,
    "casefile:saveContext": handle_casefile_save_context,
    "casefile:resolveScope": handle_casefile_resolve_scope,
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
    "casefile:readOverlayFile": handle_casefile_read_overlay_file,
    "casefile:openComparison": handle_casefile_open_comparison,
    "casefile:sendComparisonChat": handle_casefile_send_comparison_chat,
    "casefile:listPrompts": handle_casefile_list_prompts,
    "casefile:getPrompt": handle_casefile_get_prompt,
    "casefile:createPrompt": handle_casefile_create_prompt,
    "casefile:savePrompt": handle_casefile_save_prompt,
    "casefile:deletePrompt": handle_casefile_delete_prompt,
    "casefile:getAllowedExecutables": handle_runs_get_allowed_executables,
    "casefile:listRuns": handle_casefile_list_runs,
    "casefile:getRun": handle_casefile_get_run,
    "casefile:deleteRun": handle_casefile_delete_run,
    "casefile:runCommand": handle_casefile_run_command,
    "casefile:listInboxSources": handle_casefile_list_inbox_sources,
    "casefile:addInboxSource": handle_casefile_add_inbox_source,
    "casefile:updateInboxSource": handle_casefile_update_inbox_source,
    "casefile:removeInboxSource": handle_casefile_remove_inbox_source,
    "casefile:listInboxItems": handle_casefile_list_inbox_items,
    "casefile:readInboxItem": handle_casefile_read_inbox_item,
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


# Sentinel markers that frame the single JSON response line on stdout.
# Must match BRIDGE_RESPONSE_START / BRIDGE_RESPONSE_END in ui-electron/main.js.
_RESPONSE_START = "<<<BRIDGE_RESPONSE>>>"
_RESPONSE_END = "<<<END_RESPONSE>>>"


def main() -> None:
    try:
        raw_input = sys.stdin.read()
        request = json.loads(raw_input or "{}")
        response = dispatch(request)
    except Exception as exc:  # noqa: BLE001
        # All handler and parse exceptions are returned as structured errors on
        # stdout inside the sentinel frame.  This ensures the Electron main
        # process always receives a well-formed JSON object it can inspect
        # (response.ok === false) rather than an empty or partial stdout that
        # triggers a fallback parse error.  Raw stderr is no longer used for
        # IPC error signalling, but we print the traceback there so the main
        # process log ([bridge stderr]) retains the diagnostic without
        # exposing it to the renderer.
        import traceback
        traceback.print_exc(file=sys.stderr)
        response = {"ok": False, "error": str(exc)}
    # flush=True ensures the sentinel frame is flushed before the process exits.
    print(f"{_RESPONSE_START}{json.dumps(response)}{_RESPONSE_END}", flush=True)


if __name__ == "__main__":
    main()
