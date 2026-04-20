import json
from typing import Any

from assistant_app.models import ChatMessage, ChatRequest
from assistant_app.providers.base import ProviderMetadata
from assistant_app.providers.http_chat import HttpChatProvider


class OpenAIProvider(HttpChatProvider):
    metadata = ProviderMetadata(name="openai", env_var_name="OPENAI_API_KEY")
    endpoint = "https://api.openai.com/v1/chat/completions"

    def build_headers(self, api_key: str) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

    def build_payload(self, request: ChatRequest) -> dict[str, object]:
        payload: dict[str, object] = {
            "model": request.model,
            "messages": self._serialize_messages(request),
        }
        if request.tools:
            payload["tools"] = [
                {
                    "type": "function",
                    "function": {
                        "name": str(tool.get("name", "")),
                        "description": str(tool.get("description", "")),
                        "parameters": tool.get("input_schema", {"type": "object"}),
                    },
                }
                for tool in request.tools
            ]
            payload["tool_choice"] = "auto"
        return payload

    def _serialize_message(self, message: ChatMessage) -> dict[str, object]:
        if message.role == "assistant" and message.tool_calls:
            tool_calls: list[dict[str, object]] = []
            for tool_call in message.tool_calls:
                tool_calls.append(
                    {
                        "id": str(tool_call.get("id", "")),
                        "type": "function",
                        "function": {
                            "name": str(tool_call.get("name", "")),
                            "arguments": json.dumps(tool_call.get("input", {})),
                        },
                    }
                )
            return {"role": "assistant", "content": message.content, "tool_calls": tool_calls}

        if message.role == "tool":
            return {
                "role": "tool",
                "tool_call_id": message.tool_call_id or "",
                "content": message.content or "",
            }

        return super()._serialize_message(message)

    def parse_response(self, response: dict[str, Any]) -> ChatMessage:
        choices = response.get("choices")
        if not isinstance(choices, list) or not choices:
            raise ValueError("missing choices")
        first = choices[0]
        if not isinstance(first, dict):
            raise ValueError("choice has invalid shape")
        message = first.get("message")
        if not isinstance(message, dict):
            raise ValueError("choice missing message")
        content = message.get("content")
        if not (isinstance(content, str) or content is None):
            raise ValueError("message has invalid content")

        tool_calls_raw = message.get("tool_calls")
        tool_calls: list[dict[str, object]] | None = None
        if tool_calls_raw is not None:
            if not isinstance(tool_calls_raw, list):
                raise ValueError("message tool_calls must be a list")
            normalized: list[dict[str, object]] = []
            for item in tool_calls_raw:
                if not isinstance(item, dict):
                    continue
                function_block = item.get("function")
                if isinstance(function_block, dict):
                    name = function_block.get("name")
                    raw_arguments = function_block.get("arguments")
                    parsed_arguments, parse_error = self._normalize_tool_arguments(
                        raw_arguments
                    )
                    call_entry: dict[str, object] = {
                        "id": str(item.get("id", "")),
                        "name": str(name or ""),
                        "input": parsed_arguments,
                    }
                    if parse_error is not None:
                        call_entry["parse_error"] = parse_error
                    normalized.append(call_entry)
                    continue
                normalized.append(item)
            tool_calls = normalized or None

        if content is None and not tool_calls:
            raise ValueError("message missing text content and tool calls")

        return ChatMessage(role="assistant", content=content, tool_calls=tool_calls)
