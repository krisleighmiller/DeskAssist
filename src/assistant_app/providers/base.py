from abc import ABC, abstractmethod
from dataclasses import dataclass
import json
import time
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
        *,
        max_retries: int = 3,
    ) -> dict[str, object]:
        body = json.dumps(payload).encode("utf-8")
        delay = 1.0
        last_retryable_exc: HTTPError | None = None
        for attempt in range(max_retries + 1):
            if attempt > 0:
                time.sleep(delay)
                delay = min(delay * 2, 60.0)
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
                # Retry on rate-limit (429) and transient server errors (503).
                if exc.code in (429, 503) and attempt < max_retries:
                    retry_after = exc.headers.get("Retry-After")
                    if retry_after:
                        try:
                            delay = max(float(retry_after), 0.5)
                        except ValueError:
                            pass
                    last_retryable_exc = exc
                    continue
                error_body = exc.read().decode("utf-8", errors="replace")
                raise RuntimeError(
                    f"{self.metadata.name} API request failed ({exc.code}): {error_body}"
                ) from exc
            except URLError as exc:
                raise RuntimeError(f"{self.metadata.name} API connection failed: {exc}") from exc
        # All retries exhausted for a retryable status code.
        if last_retryable_exc is None:
            raise RuntimeError(
                f"{self.metadata.name} API request failed after {max_retries} retries "
                "(internal error: no exception was recorded)"
            )
        error_body = last_retryable_exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(
            f"{self.metadata.name} API request failed after {max_retries} retries "
            f"({last_retryable_exc.code}): {error_body}"
        ) from last_retryable_exc

    @abstractmethod
    def send(self, request: ChatRequest) -> ChatMessage:
        raise NotImplementedError

    @staticmethod
    def _normalize_tool_arguments(
        raw_arguments: object,
    ) -> tuple[dict[str, object], str | None]:
        """Parse a provider's raw tool-call arguments into ``(args, error)``.

        Returns a ``(parsed_dict, None)`` pair on success, or
        ``({}, error_message)`` when the arguments cannot be parsed.  The
        error message is stored as a *top-level* field in the normalised call
        dict (``parse_error``), not buried inside ``input``, so callers can
        distinguish a genuine model argument from an internal parse failure
        without scanning inside the ``input`` dict.
        """
        if not isinstance(raw_arguments, str):
            return {}, None
        try:
            loaded = json.loads(raw_arguments)
        except Exception as exc:
            return {}, f"tool arguments JSON parse failed: {exc}"
        if not isinstance(loaded, dict):
            return {}, f"tool arguments is not a JSON object: {raw_arguments!r}"
        return loaded, None
