from pathlib import Path

from assistant_app.chat_service import ChatService
from assistant_app.config import AppConfig


def main() -> None:
    config = AppConfig.from_workspace(Path.cwd())
    chat_service = ChatService(
        default_provider_name=config.default_provider,
        workspace_root=config.workspace_root,
    )
    providers = ", ".join(chat_service.list_providers())
    print(f"deskassist bootstrap OK ({providers})")


if __name__ == "__main__":
    main()

