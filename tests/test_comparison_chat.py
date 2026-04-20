"""M3.5c — comparison chat backend coverage.

These tests exercise the multi-lane comparison-chat surface area:

* ``CasefileService.resolve_comparison_scope`` produces the union read view
  with no lane-local write root.
* ``casefile:openComparison`` is order-independent and round-trips persisted
  history.
* ``casefile:sendComparisonChat`` builds a *write-disabled* tool registry and
  appends to the comparison-specific log path.
* The findings store accepts the synthetic ``laneIds`` (M3 already supports
  multi-lane findings; we just confirm the wiring).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from assistant_app import electron_bridge as bridge
from assistant_app.casefile import (
    CasefileService,
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
    overlay_prefixes = {overlay.prefix for overlay in scope.read_overlays}
    # Each lane gets a virtual `_lanes/<id>` mount.
    assert "_lanes/a" in overlay_prefixes
    assert "_lanes/b" in overlay_prefixes
    # Comparison sessions never write to a real lane: the bridge maps writes
    # at the casefile root, but the registry built for them refuses writes.
    assert scope.write_root == casefile_root.resolve()
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
    prefixes = {o.prefix for o in scope.read_overlays}
    assert "_lanes/a" in prefixes
    assert "_lanes/b" in prefixes
    assert "_lanes/a/_attachments/notes" in prefixes
    # Shared parent appears once (set semantics in the resolver).
    assert "_ancestors/p" in prefixes


# ---------------------------------------------------------------------------
# write tools are physically absent in comparison sessions
# ---------------------------------------------------------------------------


def test_comparison_registry_omits_write_tools(tmp_path: Path) -> None:
    casefile_root = _bootstrap(tmp_path)
    service = CasefileService(casefile_root)
    scope = service.resolve_comparison_scope(["a", "b"])
    registry = build_default_tool_registry(
        scope.write_root,
        casefile_root=casefile_root,
        read_overlays=scope.overlay_map(),
        enable_writes=False,
    )
    names = set(registry.list_commands())
    assert "read_file" in names
    assert "list_dir" in names
    # The registry must not even mention the write tools — defence in depth
    # against a future bug that grants `workspace_write` permission.
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
            enable_writes: bool = True,
            **_kw: Any,
        ) -> None:
            captured["enable_writes"] = enable_writes
            captured["workspace_root"] = workspace_root
            captured["read_overlays"] = dict(read_overlays or {})
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
    # The chat service must have been built without write capability and
    # send_user_message must have been called with allow_write_tools=False.
    assert captured["enable_writes"] is False
    assert captured["allow_write_tools"] is False
    # The session reads from both lanes (and any cascade).
    assert "_lanes/a" in captured["read_overlays"]
    assert "_lanes/b" in captured["read_overlays"]

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


def test_findings_created_via_comparison_lane_ids_round_trip(tmp_path: Path) -> None:
    """Findings authored from a comparison session keep both lane ids."""
    casefile_root = _bootstrap(tmp_path)
    create = bridge.dispatch(
        {
            "command": "casefile:createFinding",
            "casefileRoot": str(casefile_root),
            "finding": {
                "title": "Diverged behaviour",
                "body": "a and b disagree on shared.txt",
                "severity": "medium",
                "laneIds": ["a", "b"],
            },
        }
    )
    finding_id = create["finding"]["id"]
    listed_a = bridge.dispatch(
        {
            "command": "casefile:listFindings",
            "casefileRoot": str(casefile_root),
            "laneId": "a",
        }
    )
    listed_b = bridge.dispatch(
        {
            "command": "casefile:listFindings",
            "casefileRoot": str(casefile_root),
            "laneId": "b",
        }
    )
    assert finding_id in {f["id"] for f in listed_a["findings"]}
    assert finding_id in {f["id"] for f in listed_b["findings"]}


def test_resolve_comparison_scope_directly(tmp_path: Path) -> None:
    """Smoke-test the underlying ``resolve_comparison_scope`` helper."""
    casefile_root = _bootstrap(tmp_path)
    service = CasefileService(casefile_root)
    snapshot = service.snapshot()
    scope = resolve_comparison_scope(snapshot, ["a", "b"])
    assert scope.lane_id == "_compare__a__b"
    assert scope.write_root == casefile_root.resolve()
