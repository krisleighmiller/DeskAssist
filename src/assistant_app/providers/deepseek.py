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
