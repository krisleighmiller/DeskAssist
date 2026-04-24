from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from assistant_app import electron_bridge as bridge


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


def test_notes_save_and_get_round_trip(tmp_path: Path):
    casefile_root = _bootstrap_casefile_with_lanes(tmp_path)
    bridge.dispatch(
        {
            "command": "casefile:saveNote",
            "casefileRoot": str(casefile_root),
            "laneId": "a",
            "content": "# notes",
        }
    )
    response = bridge.dispatch(
        {
            "command": "casefile:getNote",
            "casefileRoot": str(casefile_root),
            "laneId": "a",
        }
    )
    assert response["content"] == "# notes"


def test_compare_lanes_returns_added_removed_changed(tmp_path: Path):
    casefile_root = _bootstrap_casefile_with_lanes(tmp_path)
    lane_a = tmp_path / "lane_a"
    lane_b = tmp_path / "lane_b"
    (lane_a / "shared.txt").write_text("alpha", encoding="utf-8")
    (lane_b / "shared.txt").write_text("beta", encoding="utf-8")
    (lane_a / "only_a.txt").write_text("x", encoding="utf-8")
    (lane_b / "only_b.txt").write_text("y", encoding="utf-8")
    response = bridge.dispatch(
        {
            "command": "casefile:compareLanes",
            "casefileRoot": str(casefile_root),
            "leftLaneId": "a",
            "rightLaneId": "b",
        }
    )
    comp = response["comparison"]
    assert comp["leftLaneId"] == "a"
    assert comp["rightLaneId"] == "b"
    assert comp["added"] == ["only_b.txt"]
    assert comp["removed"] == ["only_a.txt"]
    assert [c["path"] for c in comp["changed"]] == ["shared.txt"]


def test_compare_lanes_rejects_same_id(tmp_path: Path):
    casefile_root = _bootstrap_casefile_with_lanes(tmp_path)
    with pytest.raises(ValueError):
        bridge.dispatch(
            {
                "command": "casefile:compareLanes",
                "casefileRoot": str(casefile_root),
                "leftLaneId": "a",
                "rightLaneId": "a",
            }
        )


def test_lane_read_file_is_lane_scoped(tmp_path: Path):
    casefile_root = _bootstrap_casefile_with_lanes(tmp_path)
    lane_a = tmp_path / "lane_a"
    (lane_a / "secret.txt").write_text("hello A", encoding="utf-8")
    response = bridge.dispatch(
        {
            "command": "lane:readFile",
            "casefileRoot": str(casefile_root),
            "laneId": "a",
            "path": "secret.txt",
        }
    )
    assert response["content"] == "hello A"
    # Reading lane B's files via lane A's id must be blocked.
    with pytest.raises(PermissionError):
        bridge.dispatch(
            {
                "command": "lane:readFile",
                "casefileRoot": str(casefile_root),
                "laneId": "a",
                "path": "../lane_b/anything.txt",
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


def test_save_and_get_context_manifest(tmp_path: Path):
    casefile_root = tmp_path / "case"
    casefile_root.mkdir()
    (casefile_root / "rubric.md").write_text("rubric body", encoding="utf-8")
    bridge.dispatch({"command": "casefile:open", "root": str(casefile_root)})
    saved = bridge.dispatch(
        {
            "command": "casefile:saveContext",
            "casefileRoot": str(casefile_root),
            "context": {"files": ["rubric.md"], "autoIncludeMaxBytes": 4096},
        }
    )
    assert saved["context"]["files"] == ["rubric.md"]
    assert saved["context"]["autoIncludeMaxBytes"] == 4096
    assert [r["path"] for r in saved["context"]["resolved"]] == ["rubric.md"]
    fetched = bridge.dispatch(
        {"command": "casefile:getContext", "casefileRoot": str(casefile_root)}
    )
    assert fetched["context"]["files"] == ["rubric.md"]


def test_save_context_rejects_unbounded_auto_include(tmp_path: Path):
    casefile_root = tmp_path / "case"
    casefile_root.mkdir()
    bridge.dispatch({"command": "casefile:open", "root": str(casefile_root)})

    with pytest.raises(ValueError, match="autoIncludeMaxBytes"):
        bridge.dispatch(
            {
                "command": "casefile:saveContext",
                "casefileRoot": str(casefile_root),
                "context": {"files": [], "autoIncludeMaxBytes": 999_999_999},
            }
        )


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
    bridge.dispatch(
        {
            "command": "casefile:saveContext",
            "casefileRoot": str(casefile_root),
            "context": {"files": ["rubric.md"], "autoIncludeMaxBytes": 4096},
        }
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
    bridge.dispatch(
        {
            "command": "casefile:saveContext",
            "casefileRoot": str(casefile_root),
            "context": {"files": ["rubric.md"], "autoIncludeMaxBytes": 4096},
        }
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


def test_set_lane_parent_command(tmp_path: Path):
    casefile_root = tmp_path / "case"
    casefile_root.mkdir()
    (tmp_path / "a").mkdir()
    (tmp_path / "b").mkdir()
    bridge.dispatch({"command": "casefile:open", "root": str(casefile_root)})
    bridge.dispatch(
        {
            "command": "casefile:registerLane",
            "casefileRoot": str(casefile_root),
            "lane": {"name": "A", "kind": "repo", "root": str(tmp_path / "a"), "id": "a"},
        }
    )
    bridge.dispatch(
        {
            "command": "casefile:registerLane",
            "casefileRoot": str(casefile_root),
            "lane": {"name": "B", "kind": "repo", "root": str(tmp_path / "b"), "id": "b"},
        }
    )
    response = bridge.dispatch(
        {
            "command": "casefile:setLaneParent",
            "casefileRoot": str(casefile_root),
            "laneId": "b",
            "parentId": "a",
        }
    )
    b = next(lane for lane in response["casefile"]["lanes"] if lane["id"] == "b")
    assert b["parentId"] == "a"


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


# ---------------------------------------------------------------------------
# M4.1: prompt drafts dispatch + chat:send systemPromptId injection
# ---------------------------------------------------------------------------


def test_prompt_create_list_get_save_delete_round_trip(tmp_path: Path):
    casefile_root = tmp_path / "case"
    casefile_root.mkdir()
    bridge.dispatch({"command": "casefile:open", "root": str(casefile_root)})

    create = bridge.dispatch(
        {
            "command": "casefile:createPrompt",
            "casefileRoot": str(casefile_root),
            "prompt": {"name": "Code Review", "body": "Be careful."},
        }
    )
    prompt_id = create["prompt"]["id"]
    assert prompt_id == "code-review"
    assert create["prompt"]["name"] == "Code Review"

    listed = bridge.dispatch(
        {"command": "casefile:listPrompts", "casefileRoot": str(casefile_root)}
    )
    assert [p["id"] for p in listed["prompts"]] == [prompt_id]
    assert listed["prompts"][0]["sizeBytes"] > 0

    fetched = bridge.dispatch(
        {
            "command": "casefile:getPrompt",
            "casefileRoot": str(casefile_root),
            "promptId": prompt_id,
        }
    )
    assert fetched["prompt"]["body"] == "Be careful."

    saved = bridge.dispatch(
        {
            "command": "casefile:savePrompt",
            "casefileRoot": str(casefile_root),
            "promptId": prompt_id,
            "prompt": {"body": "Be very careful.", "name": "Code Review v2"},
        }
    )
    assert saved["prompt"]["body"] == "Be very careful."
    assert saved["prompt"]["name"] == "Code Review v2"

    bridge.dispatch(
        {
            "command": "casefile:deletePrompt",
            "casefileRoot": str(casefile_root),
            "promptId": prompt_id,
        }
    )
    listed_after = bridge.dispatch(
        {"command": "casefile:listPrompts", "casefileRoot": str(casefile_root)}
    )
    assert listed_after["prompts"] == []


def test_create_prompt_requires_name(tmp_path: Path):
    casefile_root = tmp_path / "case"
    casefile_root.mkdir()
    bridge.dispatch({"command": "casefile:open", "root": str(casefile_root)})
    with pytest.raises(ValueError):
        bridge.dispatch(
            {
                "command": "casefile:createPrompt",
                "casefileRoot": str(casefile_root),
                "prompt": {"body": "x"},
            }
        )


def test_get_prompt_requires_prompt_id(tmp_path: Path):
    casefile_root = tmp_path / "case"
    casefile_root.mkdir()
    bridge.dispatch({"command": "casefile:open", "root": str(casefile_root)})
    with pytest.raises(ValueError):
        bridge.dispatch(
            {"command": "casefile:getPrompt", "casefileRoot": str(casefile_root)}
        )


def test_chat_send_injects_selected_system_prompt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """A `systemPromptId` on chat:send injects the prompt body as a system
    message *after* the auto-context block (so casefile-wide instructions
    still apply) and is idempotent across resumed turns."""
    from assistant_app.casefile import PromptsStore

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
    PromptsStore(casefile_root).create(
        name="Reviewer", body="You are a reviewer."
    )

    captured: dict[str, Any] = {}

    class StubChatService:
        def __init__(self, **_kw: Any) -> None:
            self._injected: list[Any] = []
            self._history: list[Any] = []

        def replace_history(self, messages: list[Any]) -> None:
            self._injected = list(messages)
            captured.setdefault("system_prompts", []).append(
                [m.content for m in messages if getattr(m, "role", None) == "system"]
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

    # First turn: selecting the prompt injects it.
    bridge.dispatch(
        {
            "command": "chat:send",
            "casefileRoot": str(casefile_root),
            "laneId": "a",
            "provider": "openai",
            "userMessage": "hello",
            "messages": [],
            "systemPromptId": "reviewer",
        }
    )
    first_systems = captured["system_prompts"][0]
    assert any("[DeskAssist prompt: reviewer]" in s for s in first_systems)
    assert any("You are a reviewer." in s for s in first_systems)

    # Second turn: replaying the same history (which now contains the marker)
    # must not stack a duplicate prompt message.
    history_with_prompt = [
        {
            "role": "system",
            "content": "[DeskAssist prompt: reviewer] Reviewer\n\nYou are a reviewer.",
        },
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": "ok"},
    ]
    bridge.dispatch(
        {
            "command": "chat:send",
            "casefileRoot": str(casefile_root),
            "laneId": "a",
            "provider": "openai",
            "userMessage": "again",
            "messages": history_with_prompt,
            "systemPromptId": "reviewer",
        }
    )
    second_systems = captured["system_prompts"][1]
    prompt_count = sum(1 for s in second_systems if "[DeskAssist prompt: reviewer]" in s)
    assert prompt_count == 1


def test_chat_send_unknown_prompt_id_raises(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
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

    class StubChatService:
        def __init__(self, **_kw: Any) -> None:
            self._history: list[Any] = []

        def replace_history(self, _messages: list[Any]) -> None:
            pass

        @property
        def history(self) -> list[Any]:
            return list(self._history)

        def send_user_message(self, _text: str, **_kw: Any) -> Any:
            from assistant_app.models import ChatMessage

            return ChatMessage(role="assistant", content="ok")

        def pending_write_tool_calls(self, _msg: Any) -> list[Any]:
            return []

    monkeypatch.setattr(bridge, "ChatService", StubChatService)

    with pytest.raises(ValueError):
        bridge.dispatch(
            {
                "command": "chat:send",
                "casefileRoot": str(casefile_root),
                "laneId": "a",
                "provider": "openai",
                "userMessage": "hi",
                "messages": [],
                "systemPromptId": "does-not-exist",
            }
        )


def test_inbox_source_lifecycle(tmp_path: Path):
    casefile_root = tmp_path / "case"
    casefile_root.mkdir()
    inbox_dir = tmp_path / "external"
    inbox_dir.mkdir()
    (inbox_dir / "note.md").write_text("hello", encoding="utf-8")

    bridge.dispatch({"command": "casefile:open", "root": str(casefile_root)})

    added = bridge.dispatch(
        {
            "command": "casefile:addInboxSource",
            "casefileRoot": str(casefile_root),
            "name": "External",
            "root": str(inbox_dir),
        }
    )
    assert added["ok"] is True
    source_id = added["source"]["id"]
    assert source_id == "external"

    listed = bridge.dispatch(
        {
            "command": "casefile:listInboxSources",
            "casefileRoot": str(casefile_root),
        }
    )
    assert [s["id"] for s in listed["sources"]] == [source_id]

    items = bridge.dispatch(
        {
            "command": "casefile:listInboxItems",
            "casefileRoot": str(casefile_root),
            "sourceId": source_id,
        }
    )
    assert [it["path"] for it in items["items"]] == ["note.md"]

    read = bridge.dispatch(
        {
            "command": "casefile:readInboxItem",
            "casefileRoot": str(casefile_root),
            "sourceId": source_id,
            "path": "note.md",
        }
    )
    assert read["content"] == "hello"
    assert read["truncated"] is False

    bridge.dispatch(
        {
            "command": "casefile:updateInboxSource",
            "casefileRoot": str(casefile_root),
            "sourceId": source_id,
            "name": "Renamed",
        }
    )
    after_update = bridge.dispatch(
        {
            "command": "casefile:listInboxSources",
            "casefileRoot": str(casefile_root),
        }
    )
    assert after_update["sources"][0]["name"] == "Renamed"

    bridge.dispatch(
        {
            "command": "casefile:removeInboxSource",
            "casefileRoot": str(casefile_root),
            "sourceId": source_id,
        }
    )
    final = bridge.dispatch(
        {
            "command": "casefile:listInboxSources",
            "casefileRoot": str(casefile_root),
        }
    )
    assert final["sources"] == []


def test_inbox_add_source_validates_inputs(tmp_path: Path):
    casefile_root = tmp_path / "case"
    casefile_root.mkdir()
    bridge.dispatch({"command": "casefile:open", "root": str(casefile_root)})
    with pytest.raises(ValueError):
        bridge.dispatch(
            {
                "command": "casefile:addInboxSource",
                "casefileRoot": str(casefile_root),
                "name": "",
                "root": str(tmp_path),
            }
        )
    with pytest.raises(ValueError):
        bridge.dispatch(
            {
                "command": "casefile:addInboxSource",
                "casefileRoot": str(casefile_root),
                "name": "X",
                "root": str(tmp_path / "missing"),
            }
        )
