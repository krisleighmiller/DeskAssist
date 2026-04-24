"""M3.5c — comparison chat backend coverage.

These tests exercise the multi-lane comparison-chat surface area:

* ``CasefileService.resolve_comparison_scope`` produces the union scoped view
  with lane-local writable/read-only access preserved.
* ``casefile:openComparison`` is order-independent and round-trips persisted
  history.
* ``casefile:sendComparisonChat`` uses the normal scoped tool path and
  appends to the comparison-specific log path.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any
from uuid import UUID

import pytest

from assistant_app import electron_bridge as bridge
from assistant_app.casefile import (
    CasefileService,
    LaneAttachment,
    comparison_id_for_lanes,
    resolve_comparison_scope,
)
from assistant_app.tools import build_default_tool_registry


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _bootstrap(tmp_path: Path) -> Path:
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


# ---------------------------------------------------------------------------
# scope + id stability
# ---------------------------------------------------------------------------


def test_comparison_id_is_order_independent(tmp_path: Path) -> None:
    _bootstrap(tmp_path)
    assert comparison_id_for_lanes(["a", "b"]) == comparison_id_for_lanes(["b", "a"])
    assert comparison_id_for_lanes(["a", "b"]) == "_compare__a__b"


def test_comparison_id_requires_two_distinct_ids() -> None:
    with pytest.raises(ValueError):
        comparison_id_for_lanes(["a"])
    with pytest.raises(ValueError):
        comparison_id_for_lanes(["a", "a"])


def test_resolve_comparison_scope_unions_overlays(tmp_path: Path) -> None:
    casefile_root = _bootstrap(tmp_path)
    service = CasefileService(casefile_root)
    scope = service.resolve_comparison_scope(["a", "b"])
    overlay_map = scope.overlay_map()
    # Each selected lane keeps its own access mode (writable by default).
    labels = [d.label for d in scope.directories]
    assert "a" in labels
    assert "b" in labels
    assert all(d.writable for d in scope.directories)
    # No read-only overlays are needed when every compared directory is writable.
    assert overlay_map == {}
    assert scope.write_root == (tmp_path / "lane_a").resolve()
    assert scope.lane_id == "_compare__a__b"


def test_resolve_comparison_scope_includes_ancestors_and_attachments(
    tmp_path: Path,
) -> None:
    casefile_root = tmp_path / "case"
    casefile_root.mkdir()
    parent_dir = tmp_path / "parent"
    parent_dir.mkdir()
    notes_dir = tmp_path / "notes"
    notes_dir.mkdir()
    child_a = tmp_path / "child_a"
    child_a.mkdir()
    child_b = tmp_path / "child_b"
    child_b.mkdir()
    bridge.dispatch({"command": "casefile:open", "root": str(casefile_root)})
    bridge.dispatch(
        {
            "command": "casefile:registerLane",
            "casefileRoot": str(casefile_root),
            "lane": {"name": "P", "kind": "other", "root": str(parent_dir), "id": "p"},
        }
    )
    bridge.dispatch(
        {
            "command": "casefile:registerLane",
            "casefileRoot": str(casefile_root),
            "lane": {
                "name": "A",
                "kind": "repo",
                "root": str(child_a),
                "id": "a",
                "parentId": "p",
                "attachments": [{"name": "notes", "root": str(notes_dir)}],
            },
        }
    )
    bridge.dispatch(
        {
            "command": "casefile:registerLane",
            "casefileRoot": str(casefile_root),
            "lane": {
                "name": "B",
                "kind": "repo",
                "root": str(child_b),
                "id": "b",
                "parentId": "p",
            },
        }
    )
    service = CasefileService(casefile_root)
    scope = service.resolve_comparison_scope(["a", "b"])
    labels = {d.label for d in scope.directories}
    write_labels = {d.label for d in scope.directories if d.writable}
    read_labels = {d.label for d in scope.directories if not d.writable}
    # Both selected lanes and their direct attachments keep live access modes.
    assert "a" in labels
    assert "b" in labels
    assert {"a", "b", "notes"} <= write_labels
    # Shared parent is inherited context only, so it stays read-only.
    assert "p" in read_labels
    # All paths are unique (no directory appears twice).
    paths = [d.path for d in scope.directories]
    assert len(paths) == len(set(paths))


# ---------------------------------------------------------------------------
# write-tool availability follows scoped writability
# ---------------------------------------------------------------------------


def test_comparison_registry_includes_write_tools_when_any_scope_writable(tmp_path: Path) -> None:
    casefile_root = _bootstrap(tmp_path)
    service = CasefileService(casefile_root)
    scope = service.resolve_comparison_scope(["a", "b"])
    registry = build_default_tool_registry(
        scope.write_root,
        casefile_root=casefile_root,
        read_overlays=scope.overlay_map(),
        scoped_directories=scope.directories,
        enable_writes=any(d.writable for d in scope.directories),
    )
    names = set(registry.list_commands())
    assert "read_file" in names
    assert "list_dir" in names
    for command in ("save_file", "append_file", "delete_file", "delete_path"):
        assert command in names


def test_comparison_registry_omits_write_tools_when_every_scope_is_read_only(
    tmp_path: Path,
) -> None:
    casefile_root = _bootstrap(tmp_path)
    bridge.dispatch(
        {
            "command": "casefile:updateLane",
            "casefileRoot": str(casefile_root),
            "laneId": "a",
            "writable": False,
        }
    )
    bridge.dispatch(
        {
            "command": "casefile:updateLane",
            "casefileRoot": str(casefile_root),
            "laneId": "b",
            "writable": False,
        }
    )
    service = CasefileService(casefile_root)
    scope = service.resolve_comparison_scope(["a", "b"])
    registry = build_default_tool_registry(
        scope.write_root,
        casefile_root=casefile_root,
        read_overlays=scope.overlay_map(),
        scoped_directories=scope.directories,
        enable_writes=any(d.writable for d in scope.directories),
    )
    names = set(registry.list_commands())
    assert "read_file" in names
    assert "list_dir" in names
    for forbidden in ("save_file", "append_file", "delete_file", "delete_path"):
        assert forbidden not in names


# ---------------------------------------------------------------------------
# bridge: openComparison + sendComparisonChat
# ---------------------------------------------------------------------------


def test_open_comparison_returns_canonical_session(tmp_path: Path) -> None:
    casefile_root = _bootstrap(tmp_path)
    forward = bridge.dispatch(
        {
            "command": "casefile:openComparison",
            "casefileRoot": str(casefile_root),
            "laneIds": ["b", "a"],
        }
    )
    reverse = bridge.dispatch(
        {
            "command": "casefile:openComparison",
            "casefileRoot": str(casefile_root),
            "laneIds": ["a", "b"],
        }
    )
    assert forward["comparison"]["id"] == "_compare__a__b"
    UUID(forward["comparison"]["sessionId"])
    assert forward["comparison"]["sessionId"] == reverse["comparison"]["sessionId"]
    assert forward["comparison"]["id"] == reverse["comparison"]["id"]
    assert forward["comparison"]["laneIds"] == ["a", "b"]
    assert [lane["id"] for lane in forward["comparison"]["lanes"]] == ["a", "b"]
    assert forward["comparison"]["messages"] == []


def test_open_comparison_rejects_single_lane(tmp_path: Path) -> None:
    casefile_root = _bootstrap(tmp_path)
    with pytest.raises(ValueError):
        bridge.dispatch(
            {
                "command": "casefile:openComparison",
                "casefileRoot": str(casefile_root),
                "laneIds": ["a"],
            }
        )


def test_send_comparison_chat_persists_to_synthetic_log(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    casefile_root = _bootstrap(tmp_path)
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
            enable_writes: bool = True,
            **_kw: Any,
        ) -> None:
            captured["enable_writes"] = enable_writes
            captured["workspace_root"] = workspace_root
            captured["read_overlays"] = dict(read_overlays or {})
            captured["scoped_labels"] = [
                getattr(entry, "label", None) for entry in (scoped_directories or ())
            ]
            self._injected: list[Any] = []
            self._history: list[Any] = []

        def replace_history(self, messages: list[Any]) -> None:
            self._injected = list(messages)

        @property
        def history(self) -> list[Any]:
            return list(self._injected) + list(self._history)

        def send_user_message(self, text: str, **kw: Any) -> Any:
            from assistant_app.models import ChatMessage

            captured["allow_write_tools"] = kw.get("allow_write_tools")
            user = ChatMessage(role="user", content=text)
            assistant = ChatMessage(role="assistant", content="diff: a vs b")
            self._history.extend([user, assistant])
            return assistant

        def pending_write_tool_calls(self, _msg: Any) -> list[Any]:
            return []

    monkeypatch.setattr(bridge, "ChatService", StubChatService)
    response = bridge.dispatch(
        {
            "command": "casefile:sendComparisonChat",
            "casefileRoot": str(casefile_root),
            "laneIds": ["b", "a"],
            "provider": "openai",
            "userMessage": "compare them",
            "messages": [],
        }
    )
    assert response["ok"] is True
    assert response["comparison"]["id"] == "_compare__a__b"
    assert [m["role"] for m in response["messages"]] == ["user", "assistant"]
    # The chat service follows scoped writability and still starts with
    # unapproved write tools disabled for the turn.
    assert captured["enable_writes"] is True
    assert captured["allow_write_tools"] is False
    assert captured["scoped_labels"][:2] == ["a", "b"]

    # Re-opening the comparison must surface the persisted history.
    reopen = bridge.dispatch(
        {
            "command": "casefile:openComparison",
            "casefileRoot": str(casefile_root),
            "laneIds": ["a", "b"],
        }
    )
    persisted = reopen["comparison"]["messages"]
    assert [m["role"] for m in persisted] == ["user", "assistant"]
    assert persisted[0]["content"] == "compare them"
    # Log lives at the synthetic comparison path, not under either lane id.
    log_path = casefile_root / ".casefile" / "chats" / "_compare__a__b.jsonl"
    assert log_path.is_file()


def test_send_comparison_chat_requires_user_message(
    tmp_path: Path,
) -> None:
    casefile_root = _bootstrap(tmp_path)
    with pytest.raises(ValueError):
        bridge.dispatch(
            {
                "command": "casefile:sendComparisonChat",
                "casefileRoot": str(casefile_root),
                "laneIds": ["a", "b"],
                "provider": "openai",
                "messages": [],
            }
        )


def test_update_comparison_attachments_persists_across_reopen(tmp_path: Path) -> None:
    casefile_root = _bootstrap(tmp_path)
    compare_notes = tmp_path / "compare_notes"
    compare_notes.mkdir()

    updated = bridge.dispatch(
        {
            "command": "casefile:updateComparisonAttachments",
            "casefileRoot": str(casefile_root),
            "laneIds": ["b", "a"],
            "attachments": [{"name": "shared", "root": str(compare_notes), "mode": "write"}],
        }
    )
    assert updated["comparison"]["attachments"] == [
        {"name": "shared", "root": str(compare_notes.resolve()), "mode": "write"}
    ]

    reopened = bridge.dispatch(
        {
            "command": "casefile:openComparison",
            "casefileRoot": str(casefile_root),
            "laneIds": ["a", "b"],
        }
    )
    assert reopened["comparison"]["attachments"] == [
        {"name": "shared", "root": str(compare_notes.resolve()), "mode": "write"}
    ]
    assert (casefile_root / ".casefile" / "comparisons.json").is_file()


def test_resolve_comparison_scope_includes_comparison_level_attachments(
    tmp_path: Path,
) -> None:
    casefile_root = _bootstrap(tmp_path)
    service = CasefileService(casefile_root)
    shared_dir = tmp_path / "shared"
    shared_dir.mkdir()
    service.update_comparison_attachments(
        ["a", "b"],
        [LaneAttachment(name="shared", root=shared_dir, mode="read")],
    )

    scope = service.resolve_comparison_scope(["a", "b"])
    labels = {d.label for d in scope.directories}
    read_labels = {d.label for d in scope.directories if not d.writable}
    assert "shared" in labels
    assert "shared" in read_labels


def test_send_comparison_chat_surfaces_pending_write_approvals(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    casefile_root = _bootstrap(tmp_path)

    class StubChatService:
        def __init__(self, **_kw: Any) -> None:
            self._injected: list[Any] = []
            self._history: list[Any] = []

        def replace_history(self, messages: list[Any]) -> None:
            self._injected = list(messages)

        @property
        def history(self) -> list[Any]:
            return list(self._injected) + list(self._history)

        def send_user_message(self, text: str, **_kw: Any) -> Any:
            from assistant_app.models import ChatMessage

            user = ChatMessage(role="user", content=text)
            assistant = ChatMessage(role="assistant", content="need approval")
            self._history.extend([user, assistant])
            return assistant

        def pending_write_tool_calls(self, _msg: Any) -> list[Any]:
            return [
                {
                    "id": "call_1",
                    "name": "save_file",
                    "input": {"path": "_scope/a/out.md", "content": "hello"},
                }
            ]

    monkeypatch.setattr(bridge, "ChatService", StubChatService)
    response = bridge.dispatch(
        {
            "command": "casefile:sendComparisonChat",
            "casefileRoot": str(casefile_root),
            "laneIds": ["a", "b"],
            "provider": "openai",
            "userMessage": "save it",
            "messages": [],
        }
    )
    assert response["pendingApprovals"] == [
        {
            "id": "call_1",
            "name": "save_file",
            "input": {"path": "_scope/a/out.md", "content": "hello"},
        }
    ]


def test_resolve_comparison_scope_directly(tmp_path: Path) -> None:
    """Smoke-test the underlying ``resolve_comparison_scope`` helper."""
    casefile_root = _bootstrap(tmp_path)
    service = CasefileService(casefile_root)
    snapshot = service.snapshot()
    scope = resolve_comparison_scope(snapshot, ["a", "b"])
    assert scope.lane_id == "_compare__a__b"
    assert scope.write_root == (tmp_path / "lane_a").resolve()
