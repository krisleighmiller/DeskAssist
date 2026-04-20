from assistant_app.models import ChatMessage, ChatRequest
from assistant_app.providers import (
    AnthropicProvider,
    DeepSeekProvider,
    HttpChatProvider,
    OpenAIProvider,
)
from assistant_app.providers.base import ProviderMetadata


class DummyContractProvider(HttpChatProvider):
    metadata = ProviderMetadata(name="dummy", env_var_name="DUMMY_KEY")
    endpoint = "https://example.com/v1/chat"

    def build_headers(self, api_key: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {api_key}"}

    def build_payload(self, request: ChatRequest) -> dict[str, object]:
        return {"model": request.model, "messages": self._serialize_messages(request)}

    def parse_response(self, response: dict[str, object]) -> ChatMessage:
        value = response.get("text")
        if not isinstance(value, str):
            raise ValueError("missing text")
        return ChatMessage(role="assistant", content=value)


def _request() -> ChatRequest:
    return ChatRequest(messages=[ChatMessage(role="user", content="hello")], model="test-model")


def test_all_http_providers_use_shared_contract():
    assert issubclass(OpenAIProvider, HttpChatProvider)
    assert issubclass(AnthropicProvider, HttpChatProvider)
    assert issubclass(DeepSeekProvider, HttpChatProvider)


def test_http_chat_provider_send_path_success():
    provider = DummyContractProvider(api_key="test-key")
    provider._post_json = lambda **_: {"text": "contract ok"}  # type: ignore[method-assign]
    response = provider.send(_request())
    assert response.role == "assistant"
    assert response.content == "contract ok"


def test_http_chat_provider_normalizes_parse_errors():
    provider = DummyContractProvider(api_key="test-key")
    provider._post_json = lambda **_: {"wrong": "shape"}  # type: ignore[method-assign]
    try:
        provider.send(_request())
    except RuntimeError as exc:
        assert "dummy response parse failed" in str(exc)
    else:
        raise AssertionError("Expected RuntimeError for parse failure")
