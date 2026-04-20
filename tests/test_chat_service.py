import pytest
from pathlib import Path

from assistant_app.chat_service import ChatService
from assistant_app.models import ChatMessage, ChatRequest
from assistant_app.providers.base import BaseProvider, ProviderMetadata
from assistant_app.providers import AnthropicProvider, DeepSeekProvider, OpenAIProvider
from assistant_app.tools import ToolRegistry


def test_chat_service_lists_default_providers():
    service = ChatService()
    assert service.list_providers() == ["anthropic", "deepseek", "openai"]


def test_chat_service_switch_provider_and_send():
    openai = OpenAIProvider(api_key="test-key")
    anthropic = AnthropicProvider(api_key="test-key")
    deepseek = DeepSeekProvider(api_key="test-key")
    openai._post_json = lambda **_: {"choices": [{"message": {"content": "openai ok"}}]}  # type: ignore[method-assign]
    anthropic._post_json = lambda **_: {"content": [{"type": "text", "text": "anthropic ok"}]}  # type: ignore[method-assign]
    deepseek._post_json = lambda **_: {"choices": [{"message": {"content": "deepseek ok"}}]}  # type: ignore[method-assign]
    service = ChatService(
        default_provider_name="openai",
        providers=[openai, anthropic, deepseek],
    )
    service.set_active_provider("anthropic")
    response = service.send_user_message("ping", model="claude-stub")
    assert service.active_provider_name == "anthropic"
    assert response.content == "anthropic ok"


def test_chat_service_rejects_unknown_provider():
    service = ChatService()
    with pytest.raises(ValueError):
        service.set_active_provider("unknown-provider")


def test_chat_service_exposes_tool_commands():
    service = ChatService()
    commands = service.list_tool_commands()
    assert commands == ["append_file", "delete_file", "delete_path", "list_dir", "read_file", "save_file"]


def test_chat_service_can_list_disabled_tool_commands():
    service = ChatService()
    commands = service.list_tool_commands(include_disabled=True)
    assert commands == [
        "append_file",
        "delete_file",
        "delete_path",
        "list_dir",
        "read_file",
        "save_file",
    ]


def test_chat_service_exposes_tool_specs():
    service = ChatService()
    specs = service.list_tool_specs()
    spec_names = [spec.name for spec in specs]
    assert spec_names == ["append_file", "delete_file", "delete_path", "list_dir", "read_file", "save_file"]
    read_spec = [spec for spec in specs if spec.name == "read_file"][0]
    assert read_spec.permission == "workspace_read"
    assert read_spec.required_params == frozenset({"path"})


class CaptureProvider(BaseProvider):
    metadata = ProviderMetadata(name="capture", env_var_name="CAPTURE_KEY")

    def __init__(self) -> None:
        super().__init__(api_key="dummy")
        self.last_request: ChatRequest | None = None

    def send(self, request: ChatRequest) -> ChatMessage:
        self.last_request = request
        return ChatMessage(role="assistant", content="ok")


def test_chat_service_uses_provider_default_model_when_missing():
    provider = CaptureProvider()
    service = ChatService(
        default_provider_name="capture",
        providers=[provider],
        model_defaults={"capture": "capture-model"},
    )
    service.send_user_message("ping")
    assert provider.last_request is not None
    assert provider.last_request.model == "capture-model"


class FailingProvider(BaseProvider):
    metadata = ProviderMetadata(name="failing", env_var_name="FAILING_KEY")

    def __init__(self) -> None:
        super().__init__(api_key="dummy")

    def send(self, request: ChatRequest) -> ChatMessage:
        raise RuntimeError("provider failed")


def test_chat_service_does_not_mutate_history_when_provider_fails():
    service = ChatService(
        default_provider_name="failing",
        providers=[FailingProvider()],
        model_defaults={"failing": "failing-model"},
    )
    with pytest.raises(RuntimeError):
        service.send_user_message("will fail")
    assert service.history == []


def test_chat_service_rejects_duplicate_provider_names():
    first = CaptureProvider()
    second = CaptureProvider()
    with pytest.raises(ValueError):
        ChatService(default_provider_name="capture", providers=[first, second])


class ToolLoopProvider(BaseProvider):
    metadata = ProviderMetadata(name="toolloop", env_var_name="TOOLLOOP_KEY")

    def __init__(self) -> None:
        super().__init__(api_key="dummy")
        self.request_count = 0
        self.saw_tools_schema = False

    def send(self, request: ChatRequest) -> ChatMessage:
        self.request_count += 1
        self.saw_tools_schema = bool(request.tools)
        has_tool_result = any(message.role == "tool" for message in request.messages)
        if not has_tool_result:
            return ChatMessage(
                role="assistant",
                content=None,
                tool_calls=[
                    {
                        "id": "tool_call_1",
                        "name": "read_file",
                        "input": {"path": "README.md"},
                    }
                ],
            )
        return ChatMessage(role="assistant", content="tool loop complete")


def test_chat_service_executes_tool_calls_and_continues_turn():
    provider = ToolLoopProvider()
    registry = ToolRegistry(workspace_root=Path.cwd(), enabled_commands={"read_file"})
    registry.register(
        "read_file",
        lambda params: {"echoPath": params["path"]},
        input_schema={"path": str},
        required_params={"path"},
        permission="workspace_read",
    )
    service = ChatService(
        default_provider_name="toolloop",
        providers=[provider],
        tool_registry=registry,
        model_defaults={"toolloop": "toolloop-model"},
    )
    response = service.send_user_message("read README")
    assert response.content == "tool loop complete"
    assert provider.request_count == 2
    assert provider.saw_tools_schema
    assert [message.role for message in service.history] == ["user", "assistant", "tool", "assistant"]


def test_chat_service_requires_write_approval_for_write_tools():
    registry = ToolRegistry(workspace_root=Path.cwd(), enabled_commands={"save_file"})
    registry.register(
        "save_file",
        lambda params: {"echoPath": params["path"]},
        input_schema={"path": str, "content": str},
        required_params={"path", "content"},
        permission="workspace_write",
    )

    class WriteCallProvider(BaseProvider):
        metadata = ProviderMetadata(name="writecall", env_var_name="WRITECALL_KEY")

        def __init__(self) -> None:
            super().__init__(api_key="dummy")
            self.request_count = 0
            self.saw_tool_message = False

        def send(self, request: ChatRequest) -> ChatMessage:
            self.request_count += 1
            tool_messages = [m for m in request.messages if m.role == "tool"]
            if not tool_messages:
                return ChatMessage(
                    role="assistant",
                    content=None,
                    tool_calls=[
                        {
                            "id": "tool_call_write_1",
                            "name": "save_file",
                            "input": {"path": "a.txt", "content": "hello"},
                        }
                    ],
                )
            self.saw_tool_message = True
            return ChatMessage(role="assistant", content="done")

    write_provider = WriteCallProvider()
    service = ChatService(
        default_provider_name="writecall",
        providers=[write_provider],
        tool_registry=registry,
        model_defaults={"writecall": "write-model"},
    )
    pending_response = service.send_user_message("write it", allow_write_tools=False)
    assert pending_response.tool_calls is not None
    assert pending_response.tool_calls[0]["name"] == "save_file"
    assert write_provider.saw_tool_message is False

    resumed_response = service.resume_pending_tool_calls(allow_write_tools=True)
    assert resumed_response.content == "done"
    assert write_provider.saw_tool_message is True
