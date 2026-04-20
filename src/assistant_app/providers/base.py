from abc import ABC, abstractmethod
from dataclasses import dataclass
import json
from os import getenv
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from assistant_app.models import ChatMessage, ChatRequest


@dataclass(slots=True, frozen=True)
class ProviderMetadata:
    name: str
    env_var_name: str


class BaseProvider(ABC):
    metadata: ProviderMetadata

    def __init__(self, api_key: str | None = None, timeout_seconds: float = 30.0) -> None:
        self._api_key = api_key
        self._timeout_seconds = timeout_seconds

    @property
    def api_key(self) -> str | None:
        return self._api_key or getenv(self.metadata.env_var_name)

    @property
    def is_configured(self) -> bool:
        return bool(self.api_key)

    def require_api_key(self) -> str:
        key = self.api_key
        if not key:
            raise RuntimeError(
                f"{self.metadata.name} provider is missing API key "
                f"({self.metadata.env_var_name})"
            )
        return key

    def _serialize_messages(self, request: ChatRequest) -> list[dict[str, object]]:
        serialized: list[dict[str, object]] = []
        for message in request.messages:
            serialized.append(self._serialize_message(message))
        return serialized

    def _serialize_message(self, message: ChatMessage) -> dict[str, object]:
        item: dict[str, object] = {
            "role": message.role,
            "content": message.content,
        }
        if message.tool_calls:
            item["tool_calls"] = message.tool_calls
        if message.tool_call_id:
            item["tool_call_id"] = message.tool_call_id
        return item

    def _post_json(
        self,
        url: str,
        headers: dict[str, str],
        payload: dict[str, object],
    ) -> dict[str, object]:
        body = json.dumps(payload).encode("utf-8")
        request = Request(url=url, data=body, headers=headers, method="POST")
        try:
            with urlopen(request, timeout=self._timeout_seconds) as response:
                raw_body = response.read().decode("utf-8")
                try:
                    parsed = json.loads(raw_body)
                except json.JSONDecodeError as exc:
                    raise RuntimeError(
                        f"{self.metadata.name} API returned malformed JSON: {exc.msg}"
                    ) from exc
                if not isinstance(parsed, dict):
                    raise RuntimeError(f"{self.metadata.name} API returned non-object JSON")
                return parsed
        except HTTPError as exc:
            error_body = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(
                f"{self.metadata.name} API request failed ({exc.code}): {error_body}"
            ) from exc
        except URLError as exc:
            raise RuntimeError(f"{self.metadata.name} API connection failed: {exc}") from exc

    @abstractmethod
    def send(self, request: ChatRequest) -> ChatMessage:
        raise NotImplementedError
