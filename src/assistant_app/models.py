from dataclasses import dataclass


@dataclass(slots=True, frozen=True)
class ChatMessage:
    role: str
    content: str | None
    tool_calls: list[dict[str, object]] | None = None
    tool_call_id: str | None = None


@dataclass(slots=True, frozen=True)
class ChatRequest:
    messages: list[ChatMessage]
    model: str
    tools: list[dict[str, object]] | None = None
