"""M4.5 — assistant charter (product-owned system prompt).

Covers:

* `load_charter()` returns the bundled charter body and caches it.
* `build_charter_system_content()` carries the marker prefix used by
  the bridge for idempotency.
* Oversized / missing / empty charter files raise `CharterError`.
* `chat:send` prepends the charter at index 0 — even with no casefile.
* When auto-context and a user prompt draft are also active, the on-the-
  wire system-message order is `[charter, context, prompt]`.
* Resumed turns (history already contains the charter) do not stack a
  duplicate.
* `casefile:sendComparisonChat` prepends the charter at the head of the
  comparison history exactly once.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from assistant_app import electron_bridge as bridge
from assistant_app import prompts as charter_module
from assistant_app.prompts import (
    CHARTER_MARKER,
    CharterError,
    MAX_CHARTER_BYTES,
    build_charter_system_content,
    load_charter,
)


# ---------------------------------------------------------------------------
# loader
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _reset_charter_cache():
    """Clear the `lru_cache` around `load_charter` between tests.

    Tests that swap `_CHARTER_PATH` need a fresh read; tests that don't
    still benefit from isolation so a charter-file edit during the
    suite is not silently masked by a cached value.
    """
    load_charter.cache_clear()
    yield
    load_charter.cache_clear()


def test_load_charter_returns_bundled_body():
    body = load_charter()
    assert body
    assert "DeskAssist" in body
    # Sanity: the bundled charter sits well under the hard cap.
    assert len(body.encode("utf-8")) < MAX_CHARTER_BYTES


def test_load_charter_is_cached():
    first = load_charter()
    second = load_charter()
    assert first is second


def test_build_charter_system_content_carries_marker():
    content = build_charter_system_content()
    assert content.startswith(CHARTER_MARKER)
    # The body must follow the marker, separated by a blank line.
    assert load_charter() in content


def test_load_charter_rejects_missing_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setattr(charter_module, "_CHARTER_PATH", tmp_path / "nope.md")
    load_charter.cache_clear()
    with pytest.raises(CharterError):
        load_charter()


def test_load_charter_rejects_empty_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    empty = tmp_path / "charter.md"
    empty.write_text("   \n", encoding="utf-8")
    monkeypatch.setattr(charter_module, "_CHARTER_PATH", empty)
    load_charter.cache_clear()
    with pytest.raises(CharterError):
        load_charter()


def test_load_charter_rejects_oversized_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    fat = tmp_path / "charter.md"
    fat.write_text("x" * (MAX_CHARTER_BYTES + 1), encoding="utf-8")
    monkeypatch.setattr(charter_module, "_CHARTER_PATH", fat)
    load_charter.cache_clear()
    with pytest.raises(CharterError):
        load_charter()


# ---------------------------------------------------------------------------
# bridge: charter on chat:send
# ---------------------------------------------------------------------------


def _make_stub_chat_service(captured: dict[str, Any]) -> type:
    """Stub that records the system messages handed to `replace_history`."""

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

    return StubChatService


def test_chat_send_injects_charter_with_no_casefile(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """Charter applies even to a plain workspace chat (no casefile open)."""
    captured: dict[str, Any] = {}
    monkeypatch.setattr(bridge, "ChatService", _make_stub_chat_service(captured))
    bridge.dispatch(
        {
            "command": "chat:send",
            "workspaceRoot": str(tmp_path),
            "provider": "openai",
            "userMessage": "hello",
            "messages": [],
        }
    )
    systems = captured["system_prompts"][0]
    assert len(systems) == 1
    assert systems[0].startswith(CHARTER_MARKER)


def test_chat_send_layers_charter_context_and_prompt_in_order(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """With all three layers active the order is [charter, context, prompt]."""
    from assistant_app.casefile import PromptsStore

    casefile_root = tmp_path / "case"
    casefile_root.mkdir()
    # An auto-included context file under the casefile root triggers the
    # M3.5a context block on chat:send.
    (casefile_root / "_context").mkdir()
    (casefile_root / "_context" / "rubric.md").write_text(
        "Always be analytical.", encoding="utf-8"
    )
    bridge.dispatch({"command": "casefile:open", "root": str(casefile_root)})
    # Tell the casefile context manifest to auto-include the rubric so the
    # M3.5a context-injection layer fires on chat:send.
    bridge.dispatch(
        {
            "command": "casefile:saveContext",
            "casefileRoot": str(casefile_root),
            "context": {"files": ["_context/rubric.md"]},
        }
    )
    lane_a = tmp_path / "lane_a"
    lane_a.mkdir()
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
    PromptsStore(casefile_root).create(name="Reviewer", body="You are a reviewer.")

    captured: dict[str, Any] = {}
    monkeypatch.setattr(bridge, "ChatService", _make_stub_chat_service(captured))
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
    systems = captured["system_prompts"][0]
    assert len(systems) >= 3, systems
    assert systems[0].startswith(CHARTER_MARKER)
    assert systems[1].startswith(bridge._CONTEXT_MARKER)
    assert systems[2].startswith(bridge._PROMPT_MARKER)


def test_chat_send_does_not_duplicate_charter_on_resume(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """Replaying a history that already contains the charter is idempotent."""
    captured: dict[str, Any] = {}
    monkeypatch.setattr(bridge, "ChatService", _make_stub_chat_service(captured))

    existing_charter = build_charter_system_content()
    bridge.dispatch(
        {
            "command": "chat:send",
            "workspaceRoot": str(tmp_path),
            "provider": "openai",
            "userMessage": "again",
            "messages": [
                {"role": "system", "content": existing_charter},
                {"role": "user", "content": "earlier"},
                {"role": "assistant", "content": "ok"},
            ],
        }
    )
    systems = captured["system_prompts"][0]
    charter_count = sum(1 for s in systems if s.startswith(CHARTER_MARKER))
    assert charter_count == 1


# ---------------------------------------------------------------------------
# bridge: charter on casefile:sendComparisonChat
# ---------------------------------------------------------------------------


def test_send_comparison_chat_injects_charter_at_head(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
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

    captured: dict[str, Any] = {}
    monkeypatch.setattr(bridge, "ChatService", _make_stub_chat_service(captured))
    bridge.dispatch(
        {
            "command": "casefile:sendComparisonChat",
            "casefileRoot": str(casefile_root),
            "laneIds": ["a", "b"],
            "provider": "openai",
            "userMessage": "compare them",
            "messages": [],
        }
    )
    systems = captured["system_prompts"][0]
    assert systems, "comparison chat must produce at least one system message"
    assert systems[0].startswith(CHARTER_MARKER)


def test_send_comparison_chat_does_not_duplicate_charter(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
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

    captured: dict[str, Any] = {}
    monkeypatch.setattr(bridge, "ChatService", _make_stub_chat_service(captured))
    bridge.dispatch(
        {
            "command": "casefile:sendComparisonChat",
            "casefileRoot": str(casefile_root),
            "laneIds": ["a", "b"],
            "provider": "openai",
            "userMessage": "again",
            "messages": [
                {"role": "system", "content": build_charter_system_content()},
                {"role": "user", "content": "earlier"},
                {"role": "assistant", "content": "ok"},
            ],
        }
    )
    systems = captured["system_prompts"][0]
    charter_count = sum(1 for s in systems if s.startswith(CHARTER_MARKER))
    assert charter_count == 1
