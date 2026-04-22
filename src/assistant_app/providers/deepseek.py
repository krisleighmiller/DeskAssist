from assistant_app.models import ChatRequest
from assistant_app.providers.base import ProviderMetadata
from assistant_app.providers.http_chat import OpenAICompatibleMixin


class DeepSeekProvider(OpenAICompatibleMixin):
    metadata = ProviderMetadata(name="deepseek", env_var_name="DEEPSEEK_API_KEY")
    endpoint = "https://api.deepseek.com/chat/completions"

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
