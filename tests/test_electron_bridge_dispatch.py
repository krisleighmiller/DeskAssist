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


def test_findings_create_list_update_delete_round_trip(tmp_path: Path):
    casefile_root = _bootstrap_casefile_with_lanes(tmp_path)
    create = bridge.dispatch(
        {
            "command": "casefile:createFinding",
            "casefileRoot": str(casefile_root),
            "finding": {
                "title": "Race in dispatcher",
                "body": "details",
                "severity": "high",
                "laneIds": ["a"],
                "sourceRefs": [{"laneId": "a", "path": "x.py", "lineStart": 1, "lineEnd": 2}],
            },
        }
    )
    finding_id = create["finding"]["id"]
    listed = bridge.dispatch(
        {
            "command": "casefile:listFindings",
            "casefileRoot": str(casefile_root),
            "laneId": "a",
        }
    )
    assert [f["id"] for f in listed["findings"]] == [finding_id]
    updated = bridge.dispatch(
        {
            "command": "casefile:updateFinding",
            "casefileRoot": str(casefile_root),
            "findingId": finding_id,
            "finding": {"title": "Renamed"},
        }
    )
    assert updated["finding"]["title"] == "Renamed"
    bridge.dispatch(
        {
            "command": "casefile:deleteFinding",
            "casefileRoot": str(casefile_root),
            "findingId": finding_id,
        }
    )
    listed_after = bridge.dispatch(
        {
            "command": "casefile:listFindings",
            "casefileRoot": str(casefile_root),
        }
    )
    assert listed_after["findings"] == []


def test_create_finding_requires_lane_ids(tmp_path: Path):
    casefile_root = _bootstrap_casefile_with_lanes(tmp_path)
    with pytest.raises(ValueError):
        bridge.dispatch(
            {
                "command": "casefile:createFinding",
                "casefileRoot": str(casefile_root),
                "finding": {"title": "t", "body": "", "severity": "info", "laneIds": []},
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


def test_export_findings_writes_markdown_and_returns_it(tmp_path: Path):
    casefile_root = _bootstrap_casefile_with_lanes(tmp_path)
    bridge.dispatch(
        {
            "command": "casefile:saveNote",
            "casefileRoot": str(casefile_root),
            "laneId": "a",
            "content": "Lane A notes.",
        }
    )
    bridge.dispatch(
        {
            "command": "casefile:createFinding",
            "casefileRoot": str(casefile_root),
            "finding": {
                "title": "Critical bug",
                "body": "details",
                "severity": "critical",
                "laneIds": ["a"],
            },
        }
    )
    response = bridge.dispatch(
        {
            "command": "casefile:exportFindings",
            "casefileRoot": str(casefile_root),
            "laneIds": ["a"],
        }
    )
    assert "Critical bug" in response["markdown"]
    assert "Lane A notes." in response["markdown"]
    output = Path(response["path"])
    assert output.exists()
    assert output.parent == casefile_root / ".casefile" / "exports"


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
