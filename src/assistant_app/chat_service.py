from pathlib import Path
from typing import Mapping
import json

from assistant_app.casefile.models import ScopedDirectory
from assistant_app.models import ChatMessage, ChatRequest
from assistant_app.providers import (
    AnthropicProvider,
    BaseProvider,
    DeepSeekProvider,
    OpenAIProvider,
)
from assistant_app.tools import ToolRegistry, ToolSpec, build_default_tool_registry


# Cap on assistant↔tool round-trips per user turn. Real agentic turns regularly
# need more than a handful of tool calls (e.g. list_dir → read_file ×N → answer),
# so the limit is set high enough to allow normal exploration but low enough to
# stop a runaway loop from billing out the user's API key. Bumped from 8 after
# DeepSeek hit the cap on routine multi-file reads.
MAX_TOOL_TURNS = 32

# SECURITY (M9): hard cap on the total serialised size (in bytes) of
# the conversation history we are willing to send to a provider. A
# malicious lane chat log that somebody has written to directly (or a
# renderer compromise that inflates the history array) can otherwise
# cost the user arbitrary money on the next `send_user_message`.
# 4 MB is large enough for several hundred normal turns (including
# embedded tool-call results) but small enough that a single request
# cannot burn through more than ~$1 on the most expensive model.
MAX_HISTORY_BYTES = 4 * 1024 * 1024


class ChatService:
    def __init__(
        self,
        default_provider_name: str = "openai",
        providers: list[BaseProvider] | None = None,
        workspace_root: Path | None = None,
        tool_registry: ToolRegistry | None = None,
        model_defaults: dict[str, str] | None = None,
        casefile_root: Path | None = None,
        read_overlays: Mapping[str, Path] | None = None,
        scoped_directories: tuple[ScopedDirectory, ...] | None = None,
        enable_writes: bool = True,
    ) -> None:
        provided = providers or [
            OpenAIProvider(),
            AnthropicProvider(),
            DeepSeekProvider(),
        ]
        provider_names = [provider.metadata.name for provider in provided]
        duplicates = sorted({name for name in provider_names if provider_names.count(name) > 1})
        if duplicates:
            joined = ", ".join(duplicates)
            raise ValueError(f"Duplicate provider name(s): {joined}")
        self._providers: dict[str, BaseProvider] = {
            provider.metadata.name: provider for provider in provided
        }
        if default_provider_name not in self._providers:
            raise ValueError(f"Unknown provider '{default_provider_name}'")
        self._active_provider_name = default_provider_name
        self._history: list[ChatMessage] = []
        resolved_workspace_root = (
            workspace_root if workspace_root is not None else Path.cwd()
        ).resolve()
        resolved_casefile_root = casefile_root.resolve() if casefile_root is not None else None
        self._tool_registry = tool_registry or build_default_tool_registry(
            resolved_workspace_root,
            casefile_root=resolved_casefile_root,
            read_overlays=read_overlays,
            scoped_directories=scoped_directories,
            enable_writes=enable_writes,
        )
        self._default_models = {
            "openai": "gpt-4o-mini",
            "anthropic": "claude-haiku-4-5",
            "deepseek": "deepseek-chat",
        }
        if model_defaults:
            self._default_models.update(model_defaults)
        self._write_commands = {
            spec.name
            for spec in self._tool_registry.get_command_specs(enabled_only=False)
            if spec.permission == "workspace_write"
        }

    @property
    def active_provider_name(self) -> str:
        return self._active_provider_name

    @property
    def history(self) -> list[ChatMessage]:
        return list(self._history)

    def replace_history(self, messages: list[ChatMessage]) -> None:
        # SECURITY (M9): enforce the byte budget before the history is
        # accepted. Measuring the JSON serialisation of each message
        # is a reasonable proxy for the eventual token count (within a
        # factor of 3–4×) and catches both bloated tool results and
        # replay attacks where a corrupted log contains enormous
        # assistant turns.
        total_bytes = 0
        for msg in messages:
            total_bytes += len((msg.content or "").encode("utf-8"))
            if msg.tool_calls:
                total_bytes += len(
                    json.dumps(msg.tool_calls, ensure_ascii=False).encode("utf-8")
                )
            if total_bytes > MAX_HISTORY_BYTES:
                raise ValueError(
                    f"Conversation history exceeds the {MAX_HISTORY_BYTES:,} byte "
                    f"safety limit ({total_bytes:,} bytes). Trim older messages or "
                    "start a new chat."
                )
        self._history = list(messages)

    def list_providers(self) -> list[str]:
        return sorted(self._providers.keys())

    def set_active_provider(self, provider_name: str) -> None:
        if provider_name not in self._providers:
            raise ValueError(f"Unknown provider '{provider_name}'")
        self._active_provider_name = provider_name

    def _resolve_model_name(self, model: str | None) -> str:
        if model and model.strip():
            return model.strip()
        provider_name = self._active_provider_name
        if provider_name not in self._default_models:
            raise ValueError(f"No default model configured for provider '{provider_name}'")
        return self._default_models[provider_name]

    def send_user_message(
        self,
        text: str,
        model: str | None = None,
        *,
        allow_write_tools: bool = False,
    ) -> ChatMessage:
        user_message = ChatMessage(role="user", content=text)
        request_messages = self._history + [user_message]
        return self._run_turn(
            request_messages=request_messages,
            model=model,
            allow_write_tools=allow_write_tools,
        )

    def resume_pending_tool_calls(
        self,
        model: str | None = None,
        *,
        allow_write_tools: bool = False,
    ) -> ChatMessage:
        if not self._history:
            raise ValueError("No history to resume")
        latest = self._history[-1]
        if latest.role != "assistant" or not latest.tool_calls:
            raise ValueError("No pending assistant tool calls to resume")
        request_messages = list(self._history)
        for _ in range(MAX_TOOL_TURNS):
            latest = request_messages[-1]
            if latest.role == "assistant" and latest.tool_calls:
                if self._tool_calls_require_write(latest.tool_calls) and not allow_write_tools:
                    self._history = request_messages
                    return latest
                tool_messages = self._execute_tool_calls(
                    latest.tool_calls,
                    allow_write_tools=allow_write_tools,
                )
                request_messages.extend(tool_messages)
            request = ChatRequest(
                messages=request_messages,
                model=self._resolve_model_name(model),
                tools=self._build_tool_definitions(),
            )
            response = self._providers[self._active_provider_name].send(request)
            request_messages.append(response)
            if not response.tool_calls:
                self._history = request_messages
                return response
            if self._tool_calls_require_write(response.tool_calls) and not allow_write_tools:
                self._history = request_messages
                return response
        raise RuntimeError(
            f"Tool loop exceeded maximum turns ({MAX_TOOL_TURNS}). "
            "The model kept requesting tool calls without producing a final answer."
        )

    def list_tool_commands(self, include_disabled: bool = False) -> list[str]:
        """Return tool commands for UI/planner discovery.

        By default this only returns commands executable by external callers.
        Set include_disabled=True for admin/debug surfaces.
        """
        return self._tool_registry.list_commands(enabled_only=not include_disabled)

    def list_tool_specs(self, include_disabled: bool = False) -> list[ToolSpec]:
        return self._tool_registry.get_command_specs(enabled_only=not include_disabled)

    def execute_tool_command(
        self, cmd: str, params: dict[str, object], *, capability: object | None = None
    ) -> dict[str, object]:
        return self._tool_registry.execute({"cmd": cmd, "params": params}, capability=capability)

    def _execute_tool_calls(
        self,
        tool_calls: list[dict[str, object]],
        *,
        allow_write_tools: bool,
    ) -> list[ChatMessage]:
        # Pre-flight write authorization. We refuse to execute *any* call in
        # the batch if a write call is present without approval, so that we
        # never partially execute a batch and leave history in an
        # inconsistent state mid-iteration. Callers are expected to gate on
        # `_tool_calls_require_write` first; this is defence in depth.
        if not allow_write_tools:
            for call in tool_calls:
                command_name = str(call.get("name") or "")
                if command_name in self._write_commands:
                    raise RuntimeError(
                        "Write tool execution attempted without approval"
                    )

        messages: list[ChatMessage] = []
        for call in tool_calls:
            call_id = str(call.get("id") or "")
            command_name = str(call.get("name") or "")
            raw_input = call.get("input")
            params = raw_input if isinstance(raw_input, dict) else {}
            # Surface argument parse failures (flagged by providers via a
            # top-level "parse_error" field) as a structured tool-error
            # response so the model can see the problem and self-correct,
            # rather than executing the tool with an empty params dict.
            parse_error = call.get("parse_error")
            if parse_error:
                result: dict[str, object] = {"error": str(parse_error)}
                messages.append(
                    ChatMessage(
                        role="tool",
                        content=json.dumps(result),
                        tool_call_id=call_id,
                    )
                )
                continue
            result = self.execute_tool_command(command_name, params)
            messages.append(
                ChatMessage(
                    role="tool",
                    content=json.dumps(result),
                    tool_call_id=call_id,
                )
            )
        return messages

    def pending_write_tool_calls(self, message: ChatMessage) -> list[dict[str, object]]:
        if not message.tool_calls:
            return []
        return [call for call in message.tool_calls if str(call.get("name") or "") in self._write_commands]

    def _build_tool_definitions(self) -> list[dict[str, object]]:
        definitions: list[dict[str, object]] = []
        for spec in self.list_tool_specs():
            properties: dict[str, object] = {}
            for param_name, param_type in spec.input_schema.items():
                properties[param_name] = {"type": self._json_type_for_python(param_type)}
            description = spec.description or f"Execute tool command {spec.name}."
            definitions.append(
                {
                    "name": spec.name,
                    "description": description,
                    "input_schema": {
                        "type": "object",
                        "properties": properties,
                        "required": sorted(spec.required_params),
                    },
                }
            )
        return definitions

    def _json_type_for_python(self, value_type: type) -> str:
        # `bool` must be checked before `int` because `bool` is a subclass of `int`.
        if value_type is bool:
            return "boolean"
        if value_type is str:
            return "string"
        if value_type in {int, float}:
            return "number"
        if value_type is list:
            return "array"
        if value_type is dict:
            return "object"
        raise TypeError(
            f"Cannot map Python type {value_type!r} to a JSON schema type. "
            "Add an explicit mapping in _json_type_for_python."
        )

    def _tool_calls_require_write(self, tool_calls: list[dict[str, object]]) -> bool:
        for call in tool_calls:
            if str(call.get("name") or "") in self._write_commands:
                return True
        return False

    def _run_turn(
        self,
        *,
        request_messages: list[ChatMessage],
        model: str | None,
        allow_write_tools: bool,
    ) -> ChatMessage:
        tools = self._build_tool_definitions()
        for _ in range(MAX_TOOL_TURNS):
            request = ChatRequest(
                messages=request_messages,
                model=self._resolve_model_name(model),
                tools=tools,
            )
            response = self._providers[self._active_provider_name].send(request)
            request_messages.append(response)
            if not response.tool_calls:
                self._history = request_messages
                return response
            if self._tool_calls_require_write(response.tool_calls) and not allow_write_tools:
                self._history = request_messages
                return response
            tool_messages = self._execute_tool_calls(
                response.tool_calls,
                allow_write_tools=allow_write_tools,
            )
            request_messages.extend(tool_messages)
        raise RuntimeError(
            f"Tool loop exceeded maximum turns ({MAX_TOOL_TURNS}). "
            "The model kept requesting tool calls without producing a final answer."
        )
