from __future__ import annotations

from pathlib import Path

from assistant_app.casefile.models import Casefile
from assistant_app.casefile.store import normalize_lane_id

# 10 MB is generous for an analyst scratch-pad; anything larger is almost
# certainly unintentional (e.g. an LLM writing unbounded output).
MAX_NOTE_BYTES: int = 10 * 1024 * 1024


class NotesStore:
    """Per-lane notes persisted under `.casefile/notes/<lane_id>.md`.

    Notes are intentionally a flat per-lane markdown file rather than a
    structured document — they are scratch space for the analyst, not a
    typed artifact like a Finding. The Casefile owns them so they are not
    lost across machines/sessions and so the export pipeline can include
    them.
    """

    def __init__(self, casefile_root: Path) -> None:
        self.casefile = Casefile(root=Path(casefile_root).resolve())

    @property
    def directory(self) -> Path:
        return self.casefile.metadata_dir / "notes"

    def _path_for(self, lane_id: str) -> Path:
        # Defense-in-depth: re-normalize lane_id even though callers should
        # only ever pass already-validated ids from the lanes store.
        safe = normalize_lane_id(lane_id)
        return self.directory / f"{safe}.md"

    def read(self, lane_id: str) -> str:
        path = self._path_for(lane_id)
        if not path.exists():
            return ""
        return path.read_text(encoding="utf-8")

    def write(self, lane_id: str, content: str) -> Path:
        path = self._path_for(lane_id)
        encoded = content.encode("utf-8")
        if len(encoded) > MAX_NOTE_BYTES:
            raise ValueError(
                f"Note content size ({len(encoded):,} bytes) exceeds the maximum "
                f"allowed size ({MAX_NOTE_BYTES:,} bytes)"
            )
        path.parent.mkdir(parents=True, exist_ok=True)
        # Atomic write so a crash mid-save can't truncate the user's notes.
        tmp = path.with_suffix(".md.tmp")
        tmp.write_text(content, encoding="utf-8")
        tmp.replace(path)
        return path
