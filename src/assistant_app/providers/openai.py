from assistant_app.providers.base import ProviderMetadata
from assistant_app.providers.http_chat import OpenAICompatibleMixin


class OpenAIProvider(OpenAICompatibleMixin):
    metadata = ProviderMetadata(name="openai", env_var_name="OPENAI_API_KEY")
    endpoint = "https://api.openai.com/v1/chat/completions"

    def build_headers(self, api_key: str) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
