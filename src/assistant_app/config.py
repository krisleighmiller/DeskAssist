from dataclasses import dataclass
from pathlib import Path


@dataclass(slots=True, frozen=True)
class AppConfig:
    workspace_root: Path
    default_provider: str = "openai"

    @classmethod
    def from_workspace(cls, workspace_root: str | Path) -> "AppConfig":
        return cls(workspace_root=Path(workspace_root).resolve())
