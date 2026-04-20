from unittest.mock import patch

from assistant_app.models import ChatMessage, ChatRequest
from assistant_app.providers import AnthropicProvider, DeepSeekProvider, OpenAIProvider
from assistant_app.providers.base import BaseProvider, ProviderMetadata


def _sample_request() -> ChatRequest:
    return ChatRequest(messages=[ChatMessage(role="user", content="hello")], model="test-model")


def test_openai_provider_response_parsing():
    provider = OpenAIProvider(api_key="test-key")
    provider._post_json = lambda **_: {  # type: ignore[method-assign]
        "choices": [{"message": {"content": "openai ok"}}]
    }
    response = provider.send(_sample_request())
    assert response.role == "assistant"
    assert response.content == "openai ok"


def test_openai_provider_accepts_tool_call_only_response():
    provider = OpenAIProvider(api_key="test-key")
    provider._post_json = lambda **_: {  # type: ignore[method-assign]
        "choices": [
            {
                "message": {
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "call_123",
                            "name": "read_file",
                            "input": {"path": "README.md"},
                        }
                    ],
                }
            }
        ]
    }
    response = provider.send(_sample_request())
    assert response.content is None
    assert response.tool_calls is not None
    assert response.tool_calls[0]["id"] == "call_123"


def test_openai_provider_normalizes_function_tool_calls():
    provider = OpenAIProvider(api_key="test-key")
    provider._post_json = lambda **_: {  # type: ignore[method-assign]
        "choices": [
            {
                "message": {
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "call_abc",
                            "type": "function",
                            "function": {
                                "name": "read_file",
                                "arguments": "{\"path\":\"README.md\"}",
                            },
                        }
                    ],
                }
            }
        ]
    }
    response = provider.send(_sample_request())
    assert response.tool_calls is not None
    assert response.tool_calls[0] == {
        "id": "call_abc",
        "name": "read_file",
        "input": {"path": "README.md"},
    }


def test_openai_provider_serializes_internal_tool_calls_for_followup():
    provider = OpenAIProvider(api_key="test-key")
    request = ChatRequest(
        messages=[
            ChatMessage(role="user", content="read file"),
            ChatMessage(
                role="assistant",
                content=None,
                tool_calls=[{"id": "call_1", "name": "read_file", "input": {"path": "README.md"}}],
            ),
            ChatMessage(role="tool", content='{"ok":true}', tool_call_id="call_1"),
        ],
        model="test-model",
    )
    payload = provider.build_payload(request)
    messages = payload["messages"]
    assert isinstance(messages, list)
    assistant_message = messages[1]
    assert assistant_message["tool_calls"][0]["type"] == "function"
    assert assistant_message["tool_calls"][0]["function"]["name"] == "read_file"
    tool_message = messages[2]
    assert tool_message["role"] == "tool"
    assert tool_message["tool_call_id"] == "call_1"


def test_anthropic_provider_response_parsing():
    provider = AnthropicProvider(api_key="test-key")
    provider._post_json = lambda **_: {  # type: ignore[method-assign]
        "content": [{"type": "text", "text": "anthropic ok"}]
    }
    response = provider.send(_sample_request())
    assert response.role == "assistant"
    assert response.content == "anthropic ok"


def test_anthropic_provider_normalizes_system_and_unknown_roles():
    provider = AnthropicProvider(api_key="test-key")
    captured_payload: dict[str, object] = {}

    def fake_post_json(**kwargs):  # type: ignore[no-untyped-def]
        nonlocal captured_payload
        captured_payload = kwargs["payload"]
        return {"content": [{"type": "text", "text": "ok"}]}

    provider._post_json = fake_post_json  # type: ignore[method-assign]
    request = ChatRequest(
        messages=[
            ChatMessage(role="system", content="You are helpful."),
            ChatMessage(role="tool", content="Tool output blob"),
            ChatMessage(role="user", content="hello"),
        ],
        model="claude-test",
    )
    provider.send(request)
    assert captured_payload["system"] == "You are helpful."
    assert captured_payload["messages"] == [
        {
            "role": "user",
            "content": [
                {"type": "tool_result", "tool_use_id": "", "content": "Tool output blob"}
            ],
        },
        {"role": "user", "content": [{"type": "text", "text": "hello"}]},
    ]


def test_deepseek_provider_response_parsing():
    provider = DeepSeekProvider(api_key="test-key")
    provider._post_json = lambda **_: {  # type: ignore[method-assign]
        "choices": [{"message": {"content": "deepseek ok"}}]
    }
    response = provider.send(_sample_request())
    assert response.role == "assistant"
    assert response.content == "deepseek ok"


def test_deepseek_provider_accepts_tool_call_only_response():
    provider = DeepSeekProvider(api_key="test-key")
    provider._post_json = lambda **_: {  # type: ignore[method-assign]
        "choices": [
            {
                "message": {
                    "content": None,
                    "tool_calls": [
                        {"id": "call_42", "name": "list_dir", "input": {"path": "."}}
                    ],
                }
            }
        ]
    }
    response = provider.send(_sample_request())
    assert response.content is None
    assert response.tool_calls is not None
    assert response.tool_calls[0]["name"] == "list_dir"


def test_deepseek_provider_normalizes_function_tool_calls():
    provider = DeepSeekProvider(api_key="test-key")
    provider._post_json = lambda **_: {  # type: ignore[method-assign]
        "choices": [
            {
                "message": {
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "call_ds",
                            "type": "function",
                            "function": {
                                "name": "list_dir",
                                "arguments": "{\"path\":\".\"}",
                            },
                        }
                    ],
                }
            }
        ]
    }
    response = provider.send(_sample_request())
    assert response.tool_calls is not None
    assert response.tool_calls[0] == {"id": "call_ds", "name": "list_dir", "input": {"path": "."}}


def test_deepseek_provider_serializes_internal_tool_calls_for_followup():
    provider = DeepSeekProvider(api_key="test-key")
    request = ChatRequest(
        messages=[
            ChatMessage(role="user", content="list folder"),
            ChatMessage(
                role="assistant",
                content=None,
                tool_calls=[{"id": "call_2", "name": "list_dir", "input": {"path": "."}}],
            ),
            ChatMessage(role="tool", content='{"ok":true}', tool_call_id="call_2"),
        ],
        model="deepseek-chat",
    )
    payload = provider.build_payload(request)
    messages = payload["messages"]
    assert isinstance(messages, list)
    assistant_message = messages[1]
    assert assistant_message["tool_calls"][0]["type"] == "function"
    assert assistant_message["tool_calls"][0]["function"]["name"] == "list_dir"
    tool_message = messages[2]
    assert tool_message["role"] == "tool"
    assert tool_message["tool_call_id"] == "call_2"


def test_anthropic_provider_accepts_tool_use_only_response():
    provider = AnthropicProvider(api_key="test-key")
    provider._post_json = lambda **_: {  # type: ignore[method-assign]
        "content": [
            {
                "type": "tool_use",
                "id": "toolu_1",
                "name": "read_file",
                "input": {"path": "README.md"},
            }
        ]
    }
    response = provider.send(_sample_request())
    assert response.content is None
    assert response.tool_calls is not None
    assert response.tool_calls[0]["id"] == "toolu_1"


def test_provider_requires_api_key():
    provider = OpenAIProvider(api_key=None)
    try:
        provider.send(_sample_request())
    except RuntimeError as exc:
        assert "OPENAI_API_KEY" in str(exc)
    else:
        raise AssertionError("Expected RuntimeError for missing API key")


class BaseProviderProbe(BaseProvider):
    metadata = ProviderMetadata(name="probe", env_var_name="PROBE_KEY")

    def send(self, request: ChatRequest) -> ChatMessage:
        return ChatMessage(role="assistant", content="unused")


class DummyHTTPResponse:
    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self) -> bytes:
        return b"not valid json"


def test_provider_normalizes_malformed_json_errors():
    provider = BaseProviderProbe(api_key="test-key")
    with patch("assistant_app.providers.base.urlopen", return_value=DummyHTTPResponse()):
        try:
            provider._post_json(
                url="https://example.com",
                headers={"Content-Type": "application/json"},
                payload={"hello": "world"},
            )
        except RuntimeError as exc:
            assert "malformed JSON" in str(exc)
        else:
            raise AssertionError("Expected RuntimeError for malformed JSON")
