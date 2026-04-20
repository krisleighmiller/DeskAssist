from __future__ import annotations

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
        except Exception as exc:  # noqa: BLE001
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
