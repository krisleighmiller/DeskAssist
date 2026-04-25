"""HttpChatProvider shared base for providers that use the OpenAI
message/tool-call wire format (OpenAI and DeepSeek).

The ``OpenAICompatibleMixin`` extracts the duplicated ``_serialize_message``
and ``parse_response`` implementations that were previously copied verbatim
between the two providers.
"""
from __future__ import annotations

import json
from abc import abstractmethod
from typing import Any

from assistant_app.models import ChatMessage, ChatRequest
from assistant_app.providers.base import BaseProvider


class HttpChatProvider(BaseProvider):
    endpoint: str

    def send(self, request: ChatRequest) -> ChatMessage:
        api_key = self.require_api_key()
        response = self._post_json(
            url=self.endpoint,
            headers=self.build_headers(api_key),
            payload=self.build_payload(request),
        )
        try:
            message = self.parse_response(response)
        except Exception as exc:
            raise RuntimeError(f"{self.metadata.name} response parse failed: {exc}") from exc
        if message.content is None and not message.tool_calls:
            raise RuntimeError(f"{self.metadata.name} response parse failed: empty assistant payload")
        return message

    @abstractmethod
    def build_headers(self, api_key: str) -> dict[str, str]:
        raise NotImplementedError

    @abstractmethod
    def build_payload(self, request: ChatRequest) -> dict[str, object]:
        raise NotImplementedError

    @abstractmethod
    def parse_response(self, response: dict[str, Any]) -> ChatMessage:
        raise NotImplementedError


class OpenAICompatibleMixin(HttpChatProvider):
    """Shared wire-format logic for OpenAI-compatible APIs (OpenAI, DeepSeek).

    Both providers use the same chat/completions message shape and tool-call
    representation. This mixin provides ``_serialize_message`` and
    ``parse_response`` once so neither subclass carries a verbatim copy.
    """

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

    def build_payload(self, request: ChatRequest) -> dict[str, object]:
        """Default OpenAI-compatible payload builder.

        Both ``OpenAIProvider`` and ``DeepSeekProvider`` use this exact wire
        shape (chat/completions with ``tools`` + ``tool_choice``).  Subclasses
        can override if a vendor diverges, but should prefer extending this
        method to keep the message/tool serialisation identical.
        """
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
                # Tool-call items without a `function` block do not match the
                # downstream {id, name, input} contract. Normalise them into
                # an explicit parse-error entry so the model can self-correct
                # rather than silently passing through a malformed shape.
                normalized.append(
                    {
                        "id": str(item.get("id", "")),
                        "name": str(item.get("name") or ""),
                        "input": {},
                        "parse_error": "tool call missing 'function' block",
                    }
                )
            tool_calls = normalized or None

        if content is None and not tool_calls:
            raise ValueError("message missing text content and tool calls")

        return ChatMessage(role="assistant", content=content, tool_calls=tool_calls)

