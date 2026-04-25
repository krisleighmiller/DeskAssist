from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from assistant_app import electron_bridge as bridge
from assistant_app.casefile import CasefileService, ContextManifest


def test_dispatch_default_command_is_chat_send(monkeypatch: pytest.MonkeyPatch):
    captured: dict[str, Any] = {}

    def fake_chat_send(req: dict[str, Any]) -> dict[str, Any]:
        captured.update(req)
        return {"ok": True, "message": {"role": "assistant", "content": "ok"}}

    monkeypatch.setitem(bridge._HANDLERS, "chat:send", fake_chat_send)
    response = bridge.dispatch({"userMessage": "hi"})
    assert response["ok"] is True
    assert captured["userMessage"] == "hi"


def test_dispatch_unknown_command_raises():
    with pytest.raises(ValueError):
        bridge.dispatch({"command": "unknown:thing"})


def test_casefile_open_creates_metadata_and_returns_snapshot(tmp_path: Path):
    response = bridge.dispatch({"command": "casefile:open", "root": str(tmp_path)})
    assert response["ok"] is True
    case = response["casefile"]
    assert case["root"] == str(tmp_path.resolve())
    assert case["activeLaneId"] == "main"
    assert case["lanes"][0]["id"] == "main"
    assert (tmp_path / ".casefile" / "lanes.json").is_file()


def test_casefile_register_lane_then_switch(tmp_path: Path):
    bridge.dispatch({"command": "casefile:open", "root": str(tmp_path)})
    sibling = tmp_path / "second"
    sibling.mkdir()
    register_response = bridge.dispatch(
        {
            "command": "casefile:registerLane",
            "casefileRoot": str(tmp_path),
            "lane": {"name": "Second", "kind": "doc", "root": "second"},
        }
    )
    assert register_response["ok"] is True
    ids = {lane["id"] for lane in register_response["casefile"]["lanes"]}
    assert ids == {"main", "second"}

    switch_response = bridge.dispatch(
        {
            "command": "casefile:switchLane",
            "casefileRoot": str(tmp_path),
            "laneId": "second",
        }
    )
    assert switch_response["casefile"]["activeLaneId"] == "second"


def test_casefile_register_lane_requires_lane_object(tmp_path: Path):
    bridge.dispatch({"command": "casefile:open", "root": str(tmp_path)})
    with pytest.raises(ValueError):
        bridge.dispatch({"command": "casefile:registerLane", "casefileRoot": str(tmp_path)})


def test_chat_send_resolves_workspace_root_from_active_lane(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """`chat:send` with `casefileRoot` but no `laneId` must use the active lane."""
    casefile_root = tmp_path / "case"
    casefile_root.mkdir()
    lane_a = tmp_path / "lane_a"
    lane_a.mkdir()

    bridge.dispatch({"command": "casefile:open", "root": str(casefile_root)})
    bridge.dispatch(
        {
            "command": "casefile:registerLane",
            "casefileRoot": str(casefile_root),
            "lane": {"name": "A", "kind": "repo", "root": str(lane_a), "id": "a"},
        }
    )
    bridge.dispatch(
        {
            "command": "casefile:switchLane",
            "casefileRoot": str(casefile_root),
            "laneId": "a",
        }
    )

    captured_roots: list[Path] = []

    class StubChatService:
        def __init__(
            self,
            *,
            default_provider_name: str,
            workspace_root: Path,
            **_kw: Any,
        ) -> None:
            captured_roots.append(workspace_root)
            self._history: list[Any] = []

        def replace_history(self, _messages: list[Any]) -> None:
            pass

        @property
        def history(self) -> list[Any]:
            return list(self._history)

        def send_user_message(self, _text: str, **_kw: Any) -> Any:
            from assistant_app.models import ChatMessage

            response = ChatMessage(role="assistant", content="ok")
            self._history.append(response)
            return response

        def pending_write_tool_calls(self, _msg: Any) -> list[Any]:
            return []

    monkeypatch.setattr(bridge, "ChatService", StubChatService)

    response = bridge.dispatch(
        {
            "command": "chat:send",
            "casefileRoot": str(casefile_root),
            "provider": "openai",
            "userMessage": "hello",
            "messages": [],
        }
    )
    assert response["ok"] is True
    assert captured_roots == [lane_a.resolve()]


# ---------------------------------------------------------------------------
# M3 dispatch coverage
# ---------------------------------------------------------------------------


def _bootstrap_casefile_with_lanes(tmp_path: Path) -> Path:
    casefile_root = tmp_path / "case"
    casefile_root.mkdir()
    lane_a = tmp_path / "lane_a"
    lane_a.mkdir()
    lane_b = tmp_path / "lane_b"
    lane_b.mkdir()
    bridge.dispatch({"command": "casefile:open", "root": str(casefile_root)})
    bridge.dispatch(
        {
            "command": "casefile:registerLane",
            "casefileRoot": str(casefile_root),
            "lane": {"name": "A", "kind": "repo", "root": str(lane_a), "id": "a"},
        }
    )
    bridge.dispatch(
        {
            "command": "casefile:registerLane",
            "casefileRoot": str(casefile_root),
            "lane": {"name": "B", "kind": "repo", "root": str(lane_b), "id": "b"},
        }
    )
    return casefile_root


def test_chat_save_output_writes_markdown_under_destination(tmp_path: Path):
    """`chat:saveOutput` writes the message body to ``<destinationDir>/<filename>``.

    The destination is an absolute directory the user picks (typically a lane
    attachment, but the bridge does not require it to be inside any lane).
    """
    casefile_root = _bootstrap_casefile_with_lanes(tmp_path)
    destination = tmp_path / "lane_a" / "ash_notes"
    destination.mkdir()
    response = bridge.dispatch(
        {
            "command": "chat:saveOutput",
            "casefileRoot": str(casefile_root),
            "destinationDir": str(destination),
            "filename": "review-2026.md",
            "body": "# Heading\n\nbody text\n",
        }
    )
    written = Path(response["path"])
    assert written == destination / "review-2026.md"
    assert written.read_text(encoding="utf-8") == "# Heading\n\nbody text\n"


def test_chat_save_output_rejects_path_separator_in_filename(tmp_path: Path):
    casefile_root = _bootstrap_casefile_with_lanes(tmp_path)
    destination = tmp_path / "lane_a"
    with pytest.raises(ValueError):
        bridge.dispatch(
            {
                "command": "chat:saveOutput",
                "casefileRoot": str(casefile_root),
                "destinationDir": str(destination),
                "filename": "../escape.md",
                "body": "x",
            }
        )


def test_chat_save_output_rejects_missing_destination(tmp_path: Path):
    casefile_root = _bootstrap_casefile_with_lanes(tmp_path)
    with pytest.raises(FileNotFoundError):
        bridge.dispatch(
            {
                "command": "chat:saveOutput",
                "casefileRoot": str(casefile_root),
                "destinationDir": str(tmp_path / "does_not_exist"),
                "filename": "x.md",
                "body": "x",
            }
        )


def test_chat_save_output_refuses_to_overwrite(tmp_path: Path):
    casefile_root = _bootstrap_casefile_with_lanes(tmp_path)
    destination = tmp_path / "lane_a"
    (destination / "existing.md").write_text("old", encoding="utf-8")
    with pytest.raises(FileExistsError):
        bridge.dispatch(
            {
                "command": "chat:saveOutput",
                "casefileRoot": str(casefile_root),
                "destinationDir": str(destination),
                "filename": "existing.md",
                "body": "new",
            }
        )


def test_chat_send_persists_history_delta_to_lane_log(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    casefile_root = tmp_path / "case"
    casefile_root.mkdir()
    bridge.dispatch({"command": "casefile:open", "root": str(casefile_root)})

    class StubChatService:
        def __init__(self, **_kw: Any) -> None:
            self._history: list[Any] = []

        def replace_history(self, _messages: list[Any]) -> None:
            pass

        @property
        def history(self) -> list[Any]:
            return list(self._history)

        def send_user_message(self, text: str, **_kw: Any) -> Any:
            from assistant_app.models import ChatMessage

            user = ChatMessage(role="user", content=text)
            assistant = ChatMessage(role="assistant", content="echo")
            self._history.extend([user, assistant])
            return assistant

        def pending_write_tool_calls(self, _msg: Any) -> list[Any]:
            return []

    monkeypatch.setattr(bridge, "ChatService", StubChatService)

    bridge.dispatch(
        {
            "command": "chat:send",
            "casefileRoot": str(casefile_root),
            "laneId": "main",
            "provider": "openai",
            "userMessage": "hi",
            "messages": [],
        }
    )
    list_response = bridge.dispatch(
        {
            "command": "casefile:listChat",
            "casefileRoot": str(casefile_root),
            "laneId": "main",
        }
    )
    persisted = list_response["messages"]
    assert [m["role"] for m in persisted] == ["user", "assistant"]
    assert persisted[0]["content"] == "hi"
    assert persisted[1]["content"] == "echo"


def test_chat_send_requires_valid_approval_token_for_write_resume(
    monkeypatch: pytest.MonkeyPatch,
):
    class StubChatService:
        def __init__(self, **_kw: Any) -> None:
            self._history: list[Any] = []

        def replace_history(self, messages: list[Any]) -> None:
            self._history = list(messages)

        @property
        def history(self) -> list[Any]:
            return list(self._history)

        def resume_pending_tool_calls(self, **_kw: Any) -> Any:
            raise AssertionError("resume should not execute without a valid token")

        def pending_write_tool_calls(self, msg: Any) -> list[dict[str, object]]:
            calls = getattr(msg, "tool_calls", None) or []
            return [call for call in calls if call.get("name") == "save_file"]

    monkeypatch.setattr(bridge, "ChatService", StubChatService)

    with pytest.raises(PermissionError, match="pendingApprovalToken"):
        bridge.dispatch(
            {
                "command": "chat:send",
                "messages": [
                    {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": "call_1",
                                "name": "save_file",
                                "input": {"path": "x.md", "content": "x"},
                            }
                        ],
                    }
                ],
                "allowWriteTools": True,
                "resumePendingToolCalls": True,
                "approvalSecret": "test-secret",
            }
        )


def test_chat_send_mints_and_accepts_write_approval_token(
    monkeypatch: pytest.MonkeyPatch,
):
    state: dict[str, bool] = {"resumed": False}

    class StubChatService:
        def __init__(self, **_kw: Any) -> None:
            self._history: list[Any] = []

        def replace_history(self, messages: list[Any]) -> None:
            self._history = list(messages)

        @property
        def history(self) -> list[Any]:
            return list(self._history)

        def send_user_message(self, text: str, **_kw: Any) -> Any:
            from assistant_app.models import ChatMessage

            user = ChatMessage(role="user", content=text)
            assistant = ChatMessage(
                role="assistant",
                content=None,
                tool_calls=[
                    {
                        "id": "call_1",
                        "name": "save_file",
                        "input": {"path": "x.md", "content": "x"},
                    }
                ],
            )
            self._history.extend([user, assistant])
            return assistant

        def resume_pending_tool_calls(self, **_kw: Any) -> Any:
            from assistant_app.models import ChatMessage

            state["resumed"] = True
            assistant = ChatMessage(role="assistant", content="done")
            self._history.append(assistant)
            return assistant

        def pending_write_tool_calls(self, msg: Any) -> list[dict[str, object]]:
            calls = getattr(msg, "tool_calls", None) or []
            return [call for call in calls if call.get("name") == "save_file"]

    monkeypatch.setattr(bridge, "ChatService", StubChatService)
    secret = "test-secret"
    first = bridge.dispatch(
        {
            "command": "chat:send",
            "userMessage": "please save",
            "messages": [],
            "approvalSecret": secret,
        }
    )

    token = first["pendingApprovalToken"]
    bridge.dispatch(
        {
            "command": "chat:send",
            "messages": first["messages"],
            "allowWriteTools": True,
            "resumePendingToolCalls": True,
            "approvalSecret": secret,
            "pendingApprovalToken": token,
        }
    )

    assert state["resumed"] is True


# ---------------------------------------------------------------------------
# M3.5a dispatch coverage: hierarchical lanes, context manifest, scope cascade
# ---------------------------------------------------------------------------


def test_register_lane_with_parent_and_attachment(tmp_path: Path):
    casefile_root = tmp_path / "case"
    casefile_root.mkdir()
    parent_dir = tmp_path / "parent"
    parent_dir.mkdir()
    child_dir = tmp_path / "child"
    child_dir.mkdir()
    notes_dir = tmp_path / "child_notes"
    notes_dir.mkdir()
    bridge.dispatch({"command": "casefile:open", "root": str(casefile_root)})
    bridge.dispatch(
        {
            "command": "casefile:registerLane",
            "casefileRoot": str(casefile_root),
            "lane": {"name": "Parent", "kind": "other", "root": str(parent_dir), "id": "parent"},
        }
    )
    response = bridge.dispatch(
        {
            "command": "casefile:registerLane",
            "casefileRoot": str(casefile_root),
            "lane": {
                "name": "Child",
                "kind": "repo",
                "root": str(child_dir),
                "id": "child",
                "parentId": "parent",
                "attachments": [{"name": "notes", "root": str(notes_dir)}],
            },
        }
    )
    child = next(lane for lane in response["casefile"]["lanes"] if lane["id"] == "child")
    assert child["parentId"] == "parent"
    assert child["attachments"] == [
        {"name": "notes", "root": str(notes_dir.resolve()), "mode": "write"}
    ]


def test_resolve_scope_returns_overlays_and_context(tmp_path: Path):
    casefile_root = tmp_path / "case"
    casefile_root.mkdir()
    (casefile_root / "rubric.md").write_text("be a good boxer", encoding="utf-8")
    parent_dir = tmp_path / "parent"
    parent_dir.mkdir()
    child_dir = tmp_path / "child"
    child_dir.mkdir()
    notes_dir = tmp_path / "child_notes"
    notes_dir.mkdir()
    bridge.dispatch({"command": "casefile:open", "root": str(casefile_root)})
    bridge.dispatch(
        {
            "command": "casefile:registerLane",
            "casefileRoot": str(casefile_root),
            "lane": {"name": "Parent", "kind": "other", "root": str(parent_dir), "id": "parent"},
        }
    )
    bridge.dispatch(
        {
            "command": "casefile:registerLane",
            "casefileRoot": str(casefile_root),
            "lane": {
                "name": "Child",
                "kind": "repo",
                "root": str(child_dir),
                "id": "child",
                "parentId": "parent",
                "attachments": [{"name": "notes", "root": str(notes_dir)}],
            },
        }
    )
    CasefileService(casefile_root).save_context_manifest(
        ContextManifest(files=("rubric.md",), auto_include_max_bytes=4096)
    )
    response = bridge.dispatch(
        {
            "command": "casefile:resolveScope",
            "casefileRoot": str(casefile_root),
            "laneId": "child",
        }
    )
    scope = response["scope"]
    assert scope["writeRoot"] == str(child_dir.resolve())
    # New flat model: directories list with labels and writable flags.
    directories = scope["directories"]
    labels = [d["label"] for d in directories]
    write_labels = [d["label"] for d in directories if d["writable"]]
    read_labels = [d["label"] for d in directories if not d["writable"]]
    assert write_labels == ["child", "notes"]
    assert "parent" not in labels
    assert read_labels == []
    assert [entry["path"] for entry in scope["contextFiles"]] == ["rubric.md"]


def test_chat_send_layers_overlays_into_chat_service(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """`chat:send` must hand the scope's overlay_map into ChatService."""
    casefile_root = tmp_path / "case"
    casefile_root.mkdir()
    (casefile_root / "rubric.md").write_text("rubric body content", encoding="utf-8")
    parent_dir = tmp_path / "parent"
    parent_dir.mkdir()
    child_dir = tmp_path / "child"
    child_dir.mkdir()
    notes_dir = tmp_path / "child_notes"
    notes_dir.mkdir()

    bridge.dispatch({"command": "casefile:open", "root": str(casefile_root)})
    bridge.dispatch(
        {
            "command": "casefile:registerLane",
            "casefileRoot": str(casefile_root),
            "lane": {"name": "Parent", "kind": "other", "root": str(parent_dir), "id": "parent"},
        }
    )
    bridge.dispatch(
        {
            "command": "casefile:registerLane",
            "casefileRoot": str(casefile_root),
            "lane": {
                "name": "Child",
                "kind": "repo",
                "root": str(child_dir),
                "id": "child",
                "parentId": "parent",
                "attachments": [{"name": "notes", "root": str(notes_dir)}],
            },
        }
    )
    CasefileService(casefile_root).save_context_manifest(
        ContextManifest(files=("rubric.md",), auto_include_max_bytes=4096)
    )

    captured: dict[str, Any] = {}

    class StubChatService:
        def __init__(
            self,
            *,
            default_provider_name: str,
            workspace_root: Path,
            casefile_root: Path | None = None,
            read_overlays: dict[str, Path] | None = None,
            scoped_directories: tuple[Any, ...] | None = None,
            **_kw: Any,
        ) -> None:
            captured["workspace_root"] = workspace_root
            captured["casefile_root"] = casefile_root
            captured["read_overlays"] = (
                {prefix: Path(root) for prefix, root in read_overlays.items()}
                if read_overlays
                else None
            )
            captured["scoped_labels"] = [
                getattr(entry, "label", None) for entry in (scoped_directories or ())
            ]
            self._history: list[Any] = []
            self._injected: list[Any] = []

        def replace_history(self, messages: list[Any]) -> None:
            self._injected = list(messages)
            captured.setdefault("system_prompts", []).extend(
                m.content for m in messages if getattr(m, "role", None) == "system"
            )

        @property
        def history(self) -> list[Any]:
            return list(self._injected) + list(self._history)

        def send_user_message(self, _text: str, **_kw: Any) -> Any:
            from assistant_app.models import ChatMessage

            response = ChatMessage(role="assistant", content="ok")
            self._history.append(response)
            return response

        def pending_write_tool_calls(self, _msg: Any) -> list[Any]:
            return []

    monkeypatch.setattr(bridge, "ChatService", StubChatService)

    bridge.dispatch(
        {
            "command": "chat:send",
            "casefileRoot": str(casefile_root),
            "laneId": "child",
            "provider": "openai",
            "userMessage": "hi",
            "messages": [],
        }
    )
    assert captured["workspace_root"] == child_dir.resolve()
    assert captured["casefile_root"] == casefile_root
    overlays = captured["read_overlays"]
    assert overlays is not None
    # New flat model: active scope directories are passed separately and all
    # writable entries remain addressable through `_scope/<label>/`.
    assert captured["scoped_labels"] == ["child", "notes"]
    assert "_context" in overlays
    # Auto-include: the rubric should appear in a system prompt.
    system_prompts = captured.get("system_prompts", [])
    assert any("rubric body" in str(p) for p in system_prompts)


def test_update_lane_attachments_command(tmp_path: Path):
    casefile_root = tmp_path / "case"
    casefile_root.mkdir()
    lane_dir = tmp_path / "a"
    lane_dir.mkdir()
    notes_dir = tmp_path / "notes"
    notes_dir.mkdir()
    bridge.dispatch({"command": "casefile:open", "root": str(casefile_root)})
    bridge.dispatch(
        {
            "command": "casefile:registerLane",
            "casefileRoot": str(casefile_root),
            "lane": {"name": "A", "kind": "repo", "root": str(lane_dir), "id": "a"},
        }
    )
    response = bridge.dispatch(
        {
            "command": "casefile:updateLaneAttachments",
            "casefileRoot": str(casefile_root),
            "laneId": "a",
            "attachments": [{"name": "notes", "root": str(notes_dir)}],
        }
    )
    lane_a = next(lane for lane in response["casefile"]["lanes"] if lane["id"] == "a")
    assert lane_a["attachments"][0]["name"] == "notes"
    assert lane_a["attachments"][0]["root"] == str(notes_dir.resolve())


