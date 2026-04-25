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
    assert case["activeContextId"] == "main"
    assert case["contexts"][0]["id"] == "main"
    assert (tmp_path / ".casefile" / "contexts.json").is_file()


def test_casefile_register_context_then_switch(tmp_path: Path):
    bridge.dispatch({"command": "casefile:open", "root": str(tmp_path)})
    sibling = tmp_path / "second"
    sibling.mkdir()
    register_response = bridge.dispatch(
        {
            "command": "casefile:registerContext",
            "casefileRoot": str(tmp_path),
            "context": {"name": "Second", "kind": "doc", "root": "second"},
        }
    )
    assert register_response["ok"] is True
    ids = {context["id"] for context in register_response["casefile"]["contexts"]}
    assert ids == {"main", "second"}

    switch_response = bridge.dispatch(
        {
            "command": "casefile:switchContext",
            "casefileRoot": str(tmp_path),
            "contextId": "second",
        }
    )
    assert switch_response["casefile"]["activeContextId"] == "second"


def test_casefile_register_context_requires_context_object(tmp_path: Path):
    bridge.dispatch({"command": "casefile:open", "root": str(tmp_path)})
    with pytest.raises(ValueError):
        bridge.dispatch({"command": "casefile:registerContext", "casefileRoot": str(tmp_path)})


def test_chat_send_resolves_workspace_root_from_active_context(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """`chat:send` with `casefileRoot` but no `contextId` must use the active context."""
    casefile_root = tmp_path / "case"
    casefile_root.mkdir()
    context_a = tmp_path / "context_a"
    context_a.mkdir()

    bridge.dispatch({"command": "casefile:open", "root": str(casefile_root)})
    bridge.dispatch(
        {
            "command": "casefile:registerContext",
            "casefileRoot": str(casefile_root),
            "context": {"name": "A", "kind": "repo", "root": str(context_a), "id": "a"},
        }
    )
    bridge.dispatch(
        {
            "command": "casefile:switchContext",
            "casefileRoot": str(casefile_root),
            "contextId": "a",
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
    assert captured_roots == [context_a.resolve()]


# ---------------------------------------------------------------------------
# M3 dispatch coverage
# ---------------------------------------------------------------------------


def _bootstrap_casefile_with_scope(tmp_path: Path) -> Path:
    casefile_root = tmp_path / "case"
    casefile_root.mkdir()
    context_a = tmp_path / "context_a"
    context_a.mkdir()
    context_b = tmp_path / "context_b"
    context_b.mkdir()
    bridge.dispatch({"command": "casefile:open", "root": str(casefile_root)})
    bridge.dispatch(
        {
            "command": "casefile:registerContext",
            "casefileRoot": str(casefile_root),
            "context": {"name": "A", "kind": "repo", "root": str(context_a), "id": "a"},
        }
    )
    bridge.dispatch(
        {
            "command": "casefile:registerContext",
            "casefileRoot": str(casefile_root),
            "context": {"name": "B", "kind": "repo", "root": str(context_b), "id": "b"},
        }
    )
    return casefile_root


def test_chat_save_output_writes_markdown_under_destination(tmp_path: Path):
    """`chat:saveOutput` writes the message body to ``<destinationDir>/<filename>``.

    The destination is an absolute directory the user picks (typically a context
    attachment, but the bridge does not require it to be inside any context).
    """
    casefile_root = _bootstrap_casefile_with_scope(tmp_path)
    destination = tmp_path / "context_a" / "ash_reference"
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
    casefile_root = _bootstrap_casefile_with_scope(tmp_path)
    destination = tmp_path / "context_a"
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
    casefile_root = _bootstrap_casefile_with_scope(tmp_path)
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
    casefile_root = _bootstrap_casefile_with_scope(tmp_path)
    destination = tmp_path / "context_a"
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


def test_chat_send_persists_history_delta_to_context_log(
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
            "contextId": "main",
            "provider": "openai",
            "userMessage": "hi",
            "messages": [],
        }
    )
    list_response = bridge.dispatch(
        {
            "command": "casefile:listChat",
            "casefileRoot": str(casefile_root),
            "contextId": "main",
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
# M3.5a dispatch coverage: hierarchical contexts, context manifest, scope cascade
# ---------------------------------------------------------------------------


def test_register_context_with_parent_and_attachment(tmp_path: Path):
    casefile_root = tmp_path / "case"
    casefile_root.mkdir()
    parent_dir = tmp_path / "parent"
    parent_dir.mkdir()
    child_dir = tmp_path / "child"
    child_dir.mkdir()
    reference_dir = tmp_path / "child_reference"
    reference_dir.mkdir()
    bridge.dispatch({"command": "casefile:open", "root": str(casefile_root)})
    bridge.dispatch(
        {
            "command": "casefile:registerContext",
            "casefileRoot": str(casefile_root),
            "context": {"name": "Parent", "kind": "other", "root": str(parent_dir), "id": "parent"},
        }
    )
    response = bridge.dispatch(
        {
            "command": "casefile:registerContext",
            "casefileRoot": str(casefile_root),
            "context": {
                "name": "Child",
                "kind": "repo",
                "root": str(child_dir),
                "id": "child",
                "parentId": "parent",
                "attachments": [{"name": "reference", "root": str(reference_dir)}],
            },
        }
    )
    child = next(context for context in response["casefile"]["contexts"] if context["id"] == "child")
    assert child["parentId"] == "parent"
    assert child["attachments"] == [
        {"name": "reference", "root": str(reference_dir.resolve()), "mode": "write"}
    ]


def test_resolve_scope_returns_overlays_and_context(tmp_path: Path):
    casefile_root = tmp_path / "case"
    casefile_root.mkdir()
    (casefile_root / "rubric.md").write_text("be a good boxer", encoding="utf-8")
    parent_dir = tmp_path / "parent"
    parent_dir.mkdir()
    child_dir = tmp_path / "child"
    child_dir.mkdir()
    reference_dir = tmp_path / "child_reference"
    reference_dir.mkdir()
    bridge.dispatch({"command": "casefile:open", "root": str(casefile_root)})
    bridge.dispatch(
        {
            "command": "casefile:registerContext",
            "casefileRoot": str(casefile_root),
            "context": {"name": "Parent", "kind": "other", "root": str(parent_dir), "id": "parent"},
        }
    )
    bridge.dispatch(
        {
            "command": "casefile:registerContext",
            "casefileRoot": str(casefile_root),
            "context": {
                "name": "Child",
                "kind": "repo",
                "root": str(child_dir),
                "id": "child",
                "parentId": "parent",
                "attachments": [{"name": "reference", "root": str(reference_dir)}],
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
            "contextId": "child",
        }
    )
    scope = response["scope"]
    # SECURITY (M7): `writeRoot` and `casefileRoot` are intentionally
    # omitted from the serialised scope to reduce path leakage.
    assert "writeRoot" not in scope
    assert "casefileRoot" not in scope
    # New flat model: directories list with labels and writable flags.
    directories = scope["directories"]
    labels = [d["label"] for d in directories]
    write_labels = [d["label"] for d in directories if d["writable"]]
    read_labels = [d["label"] for d in directories if not d["writable"]]
    assert write_labels == ["child", "reference"]
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
    reference_dir = tmp_path / "child_reference"
    reference_dir.mkdir()

    bridge.dispatch({"command": "casefile:open", "root": str(casefile_root)})
    bridge.dispatch(
        {
            "command": "casefile:registerContext",
            "casefileRoot": str(casefile_root),
            "context": {"name": "Parent", "kind": "other", "root": str(parent_dir), "id": "parent"},
        }
    )
    bridge.dispatch(
        {
            "command": "casefile:registerContext",
            "casefileRoot": str(casefile_root),
            "context": {
                "name": "Child",
                "kind": "repo",
                "root": str(child_dir),
                "id": "child",
                "parentId": "parent",
                "attachments": [{"name": "reference", "root": str(reference_dir)}],
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
            "contextId": "child",
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
    assert captured["scoped_labels"] == ["child", "reference"]
    assert "_context" in overlays
    # Auto-include: the rubric should appear in a system prompt.
    system_prompts = captured.get("system_prompts", [])
    assert any("rubric body" in str(p) for p in system_prompts)


def test_update_context_attachments_command(tmp_path: Path):
    casefile_root = tmp_path / "case"
    casefile_root.mkdir()
    context_dir = tmp_path / "a"
    context_dir.mkdir()
    reference_dir = tmp_path / "reference"
    reference_dir.mkdir()
    bridge.dispatch({"command": "casefile:open", "root": str(casefile_root)})
    bridge.dispatch(
        {
            "command": "casefile:registerContext",
            "casefileRoot": str(casefile_root),
            "context": {"name": "A", "kind": "repo", "root": str(context_dir), "id": "a"},
        }
    )
    response = bridge.dispatch(
        {
            "command": "casefile:updateContextAttachments",
            "casefileRoot": str(casefile_root),
            "contextId": "a",
            "attachments": [{"name": "reference", "root": str(reference_dir)}],
        }
    )
    context_a = next(context for context in response["casefile"]["contexts"] if context["id"] == "a")
    assert context_a["attachments"][0]["name"] == "reference"
    assert context_a["attachments"][0]["root"] == str(reference_dir.resolve())


# ---------------------------------------------------------------------------
# Security regression: H6 — sensitive directories rejected as roots
# ---------------------------------------------------------------------------


def test_register_context_rejects_attachment_pointing_at_sensitive_path(tmp_path: Path):
    """SECURITY (H6): an attachment root inside a denylisted system dir
    must be rejected at registration time, not at first use.
    """
    casefile_root = tmp_path / "case"
    casefile_root.mkdir()
    context_dir = tmp_path / "context"
    context_dir.mkdir()
    bridge.dispatch({"command": "casefile:open", "root": str(casefile_root)})
    with pytest.raises(ValueError, match="sensitive"):
        bridge.dispatch(
            {
                "command": "casefile:registerContext",
                "casefileRoot": str(casefile_root),
                "context": {
                    "name": "Bad",
                    "kind": "repo",
                    "root": str(context_dir),
                    "id": "bad",
                    "attachments": [{"name": "leak", "root": "/etc/ssl/private"}],
                },
            }
        )


def test_update_context_attachments_rejects_sensitive_root(tmp_path: Path):
    """SECURITY (H6): the same denylist applies to attachment edits, not
    just initial registration. Otherwise a renderer compromise can
    sidestep the gate by registering with a benign root then mutating.
    """
    casefile_root = tmp_path / "case"
    casefile_root.mkdir()
    context_dir = tmp_path / "context"
    context_dir.mkdir()
    bridge.dispatch({"command": "casefile:open", "root": str(casefile_root)})
    bridge.dispatch(
        {
            "command": "casefile:registerContext",
            "casefileRoot": str(casefile_root),
            "context": {
                "name": "L",
                "kind": "repo",
                "root": str(context_dir),
                "id": "l",
            },
        }
    )
    # `/proc/self/root` resolves to `/` so it trips the depth check
    # first; either rejection (depth or sensitive-prefix) is a valid
    # security outcome — the assertion is that we refuse the path.
    with pytest.raises(ValueError, match=r"(sensitive|too shallow)"):
        bridge.dispatch(
            {
                "command": "casefile:updateContextAttachments",
                "casefileRoot": str(casefile_root),
                "contextId": "l",
                "attachments": [{"name": "leak", "root": "/proc/self/root"}],
            }
        )
    # Direct `/etc` test for explicit sensitive-prefix coverage.
    with pytest.raises(ValueError, match="sensitive"):
        bridge.dispatch(
            {
                "command": "casefile:updateContextAttachments",
                "casefileRoot": str(casefile_root),
                "contextId": "l",
                "attachments": [{"name": "leak", "root": "/etc/ssh"}],
            }
        )


# ---------------------------------------------------------------------------
# Security regression: H10 — API keys scoped to a single chat call
# ---------------------------------------------------------------------------


def test_chat_send_pops_api_key_env_after_call(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """SECURITY (H10): provider API keys delivered via the request
    payload must NOT linger in `os.environ` after the chat handler
    returns. Otherwise a follow-up handler in the same Python
    interpreter (or a child process spawned by an unrelated tool)
    would inherit them.
    """
    import os as _os

    casefile_root = tmp_path / "case"
    casefile_root.mkdir()
    context = tmp_path / "context"
    context.mkdir()
    bridge.dispatch({"command": "casefile:open", "root": str(casefile_root)})
    bridge.dispatch(
        {
            "command": "casefile:registerContext",
            "casefileRoot": str(casefile_root),
            "context": {"name": "L", "kind": "repo", "root": str(context), "id": "l"},
        }
    )
    bridge.dispatch(
        {
            "command": "casefile:switchContext",
            "casefileRoot": str(casefile_root),
            "contextId": "l",
        }
    )

    # Make sure the env starts clean so the assertion below is meaningful.
    _os.environ.pop("OPENAI_API_KEY", None)

    class StubChatService:
        def __init__(self, **_kw: Any) -> None:
            self._history: list[Any] = []
            # Capture env-state mid-call: this is the only point at
            # which keys are *legitimately* visible.
            assert _os.environ.get("OPENAI_API_KEY") == "sk-test-1234567890abcdef"

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

    bridge.dispatch(
        {
            "command": "chat:send",
            "casefileRoot": str(casefile_root),
            "provider": "openai",
            "userMessage": "hello",
            "messages": [],
            "apiKeys": {"openai": "sk-test-1234567890abcdef"},
        }
    )
    # POST-condition: env scrubbed.
    assert "OPENAI_API_KEY" not in _os.environ
    assert "ANTHROPIC_API_KEY" not in _os.environ
    assert "DEEPSEEK_API_KEY" not in _os.environ


def test_chat_send_pops_api_key_env_even_when_handler_raises(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """SECURITY (H10): the env scrub MUST run even if the chat handler
    raises. Otherwise a tool-error mid-turn leaks the key into the
    process env until the bridge exits (or, worse, until a follow-up
    handler reads it).
    """
    import os as _os

    casefile_root = tmp_path / "case"
    casefile_root.mkdir()
    context = tmp_path / "context"
    context.mkdir()
    bridge.dispatch({"command": "casefile:open", "root": str(casefile_root)})
    bridge.dispatch(
        {
            "command": "casefile:registerContext",
            "casefileRoot": str(casefile_root),
            "context": {"name": "L", "kind": "repo", "root": str(context), "id": "l"},
        }
    )
    bridge.dispatch(
        {
            "command": "casefile:switchContext",
            "casefileRoot": str(casefile_root),
            "contextId": "l",
        }
    )
    _os.environ.pop("ANTHROPIC_API_KEY", None)

    class ExplodingChatService:
        def __init__(self, **_kw: Any) -> None:
            raise RuntimeError("boom")

    monkeypatch.setattr(bridge, "ChatService", ExplodingChatService)

    with pytest.raises(RuntimeError, match="boom"):
        bridge.dispatch(
            {
                "command": "chat:send",
                "casefileRoot": str(casefile_root),
                "provider": "anthropic",
                "userMessage": "hi",
                "messages": [],
                "apiKeys": {"anthropic": "sk-ant-1234567890abcdef"},
            }
        )
    assert "ANTHROPIC_API_KEY" not in _os.environ


