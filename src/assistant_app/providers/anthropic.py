from typing import Any

from assistant_app.models import ChatMessage, ChatRequest
from assistant_app.providers.base import ProviderMetadata
from assistant_app.providers.http_chat import HttpChatProvider


class AnthropicProvider(HttpChatProvider):
    metadata = ProviderMetadata(name="anthropic", env_var_name="ANTHROPIC_API_KEY")
    endpoint = "https://api.anthropic.com/v1/messages"
    # Per-class default.  Override at the class level for a custom subclass, or
    # pass `max_tokens=N` to the constructor for a one-off instance.
    default_max_tokens: int = 8192

    def __init__(
        self,
        api_key: str | None = None,
        timeout_seconds: float = 30.0,
        max_tokens: int | None = None,
    ) -> None:
        super().__init__(api_key=api_key, timeout_seconds=timeout_seconds)
        if max_tokens is not None:
            self._max_tokens = max_tokens
        else:
            self._max_tokens = self.default_max_tokens

    def _build_anthropic_payload(self, request: ChatRequest) -> dict[str, object]:
        system_parts: list[str] = []
        messages: list[dict[str, object]] = []
        for message in request.messages:
            role = message.role
            content = message.content or ""
            if role == "system":
                system_parts.append(content)
                continue
            if role == "tool":
                messages.append(
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "tool_result",
                                "tool_use_id": message.tool_call_id or "",
                                "content": content or "{}",
                            }
                        ],
                    }
                )
                continue
            if role not in {"user", "assistant"}:
                # Preserve semantic intent while normalizing to Anthropic roles.
                role = "user"
                content = f"[{message.role}] {content}"
            anthropic_content: list[dict[str, object]] = []
            if content:
                anthropic_content.append({"type": "text", "text": content})
            if message.tool_calls:
                for tool_call in message.tool_calls:
                    anthropic_content.append(
                        {
                            "type": "tool_use",
                            "id": str(tool_call.get("id", "")),
                            "name": str(tool_call.get("name", "")),
                            "input": tool_call.get("input", {}),
                        }
                    )
            if not anthropic_content:
                anthropic_content.append({"type": "text", "text": "<empty>"})
            messages.append({"role": role, "content": anthropic_content})

        if not messages:
            messages.append({"role": "user", "content": "<no user message>"})

        payload: dict[str, object] = {
            "model": request.model,
            "max_tokens": self._max_tokens,
            "messages": messages,
        }
        if system_parts:
            payload["system"] = "\n\n".join(system_parts)
        if request.tools:
            payload["tools"] = request.tools
        return payload

    def build_headers(self, api_key: str) -> dict[str, str]:
        return {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        }

    def build_payload(self, request: ChatRequest) -> dict[str, object]:
        return self._build_anthropic_payload(request)

    def parse_response(self, response: dict[str, Any]) -> ChatMessage:
        content_blocks = response.get("content")
        if not isinstance(content_blocks, list) or not content_blocks:
            raise ValueError("missing content blocks")
        text_parts: list[str] = []
        tool_calls: list[dict[str, object]] = []
        for block in content_blocks:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text":
                text = block.get("text")
                if isinstance(text, str) and text:
                    text_parts.append(text)
            if block.get("type") == "tool_use":
                tool_calls.append(
                    {
                        "id": str(block.get("id", "")),
                        "name": str(block.get("name", "")),
                        "input": block.get("input", {}),
                    }
                )
        content = "\n".join(text_parts) if text_parts else None
        if content is None and not tool_calls:
            raise ValueError("missing text and tool_use blocks")
        return ChatMessage(role="assistant", content=content, tool_calls=tool_calls or None)
