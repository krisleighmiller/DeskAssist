from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from assistant_app.casefile.models import Casefile

# Bumped when the sidecar JSON schema changes. The body file (`<id>.md`) has
# no version because it is just markdown.
PROMPT_META_VERSION = 1

# Hard ceiling for prompt body size. A system prompt that approaches this
# is almost certainly a mistake (the model's context window will be eaten
# before the chat starts). 256 KiB is generous for any real rubric.
MAX_PROMPT_BODY_BYTES: int = 256 * 1024

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")


class PromptFileError(ValueError):
    """Raised when a prompt's sidecar JSON is malformed in a way the loader cannot recover from."""


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def normalize_prompt_id(raw: str) -> str:
    """Normalize a free-form id to the on-disk shape (lowercase, `[a-z0-9_-]`).

    Mirrors `normalize_lane_id` so prompt ids are equally safe as filenames
    and IPC tokens. Reserved/empty ids are rejected outright.
    """
    if "/" in raw or "\\" in raw or "\x00" in raw or ".." in raw:
        raise ValueError(f"Invalid prompt id (contains path-like characters): {raw!r}")
    candidate = raw.strip().lower()
    candidate = re.sub(r"[^a-z0-9_-]+", "-", candidate).strip("-")
    if not candidate:
        raise ValueError("Prompt id is empty after normalization")
    if not _ID_RE.match(candidate):
        raise ValueError(f"Invalid prompt id after normalization: {candidate!r}")
    if candidate in {".", "..", "casefile"}:
        raise ValueError(f"Reserved prompt id: {candidate!r}")
    return candidate


def slug_from_name(name: str) -> str:
    """Default id derived from a display name."""
    return normalize_prompt_id(name or "prompt")


@dataclass(slots=True, frozen=True)
class PromptDraft:
    """One named prompt draft persisted under `.casefile/prompts/`.

    `id` is the slug used as the filename stem and as the IPC token. `name`
    is presentational and may differ from `id`. `body` is full markdown,
    treated as-is when it is selected as a chat system prompt.
    """

    id: str
    name: str
    body: str
    created_at: str
    updated_at: str

    def to_meta_json(self) -> dict[str, Any]:
        return {
            "version": PROMPT_META_VERSION,
            "id": self.id,
            "name": self.name,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


@dataclass(slots=True, frozen=True)
class PromptSummary:
    """A listing-friendly view of a prompt — no body, just metadata."""

    id: str
    name: str
    created_at: str
    updated_at: str
    size_bytes: int


class PromptsStore:
    """Filesystem-backed CRUD for `.casefile/prompts/`.

    Each prompt is a `<id>.md` body file + a `<id>.json` sidecar carrying
    the display name and timestamps. Splitting body and metadata keeps the
    body editable in Monaco as plain markdown (no YAML frontmatter to
    confuse the renderer), and means renaming a prompt does not touch the
    body file.
    """

    def __init__(self, casefile_root: Path) -> None:
        self.casefile = Casefile(root=Path(casefile_root).resolve())

    @property
    def directory(self) -> Path:
        return self.casefile.metadata_dir / "prompts"

    def ensure_directory(self) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)

    def _body_path(self, prompt_id: str) -> Path:
        safe = normalize_prompt_id(prompt_id)
        return self.directory / f"{safe}.md"

    def _meta_path(self, prompt_id: str) -> Path:
        safe = normalize_prompt_id(prompt_id)
        return self.directory / f"{safe}.json"

    def list(self) -> list[PromptSummary]:
        if not self.directory.exists():
            return []
        out: list[PromptSummary] = []
        for entry in sorted(self.directory.iterdir(), key=lambda p: p.name):
            if entry.suffix != ".md" or not entry.is_file():
                continue
            stem = entry.stem
            try:
                meta = self._load_meta(stem)
            except PromptFileError:
                # Body without a parseable sidecar — surface the body but
                # synthesize defaults rather than hiding it.
                meta = self._fallback_meta(stem, entry)
            try:
                size = entry.stat().st_size
            except OSError:
                size = 0
            out.append(
                PromptSummary(
                    id=meta.id,
                    name=meta.name,
                    created_at=meta.created_at,
                    updated_at=meta.updated_at,
                    size_bytes=size,
                )
            )
        return out

    def get(self, prompt_id: str) -> PromptDraft:
        body_path = self._body_path(prompt_id)
        if not body_path.exists():
            raise KeyError(f"Unknown prompt id: {prompt_id}")
        try:
            body = body_path.read_text(encoding="utf-8")
        except OSError as exc:
            raise PromptFileError(f"Cannot read {body_path}: {exc}") from exc
        try:
            meta = self._load_meta(normalize_prompt_id(prompt_id))
        except PromptFileError:
            meta = self._fallback_meta(normalize_prompt_id(prompt_id), body_path)
        return PromptDraft(
            id=meta.id,
            name=meta.name,
            body=body,
            created_at=meta.created_at,
            updated_at=meta.updated_at,
        )

    def create(
        self,
        *,
        name: str,
        body: str,
        prompt_id: str | None = None,
        now: datetime | None = None,
    ) -> PromptDraft:
        cleaned_name = name.strip()
        if not cleaned_name:
            raise ValueError("Prompt name is required")
        self._validate_body(body)
        candidate = normalize_prompt_id(prompt_id) if prompt_id else slug_from_name(cleaned_name)
        existing = {p.id for p in self.list()}
        final_id = self._unique_id(candidate, existing)
        timestamp = self._format_now(now)
        prompt = PromptDraft(
            id=final_id,
            name=cleaned_name,
            body=body,
            created_at=timestamp,
            updated_at=timestamp,
        )
        self._write(prompt, expect_existing=False)
        return prompt

    def save(
        self,
        prompt_id: str,
        *,
        name: str | None = None,
        body: str | None = None,
        now: datetime | None = None,
    ) -> PromptDraft:
        """Update an existing prompt's name and/or body."""
        existing = self.get(prompt_id)
        new_name = existing.name if name is None else name.strip()
        if not new_name:
            raise ValueError("Prompt name is required")
        new_body = existing.body if body is None else body
        self._validate_body(new_body)
        timestamp = self._format_now(now)
        updated = PromptDraft(
            id=existing.id,
            name=new_name,
            body=new_body,
            created_at=existing.created_at,
            updated_at=timestamp,
        )
        self._write(updated, expect_existing=True)
        return updated

    def delete(self, prompt_id: str) -> None:
        body = self._body_path(prompt_id)
        meta = self._meta_path(prompt_id)
        if not body.exists():
            raise KeyError(f"Unknown prompt id: {prompt_id}")
        body.unlink()
        if meta.exists():
            meta.unlink()

    # ----- internals -----

    @staticmethod
    def _validate_body(body: str) -> None:
        if not isinstance(body, str):
            raise TypeError("Prompt body must be a string")
        encoded = body.encode("utf-8")
        if len(encoded) > MAX_PROMPT_BODY_BYTES:
            raise ValueError(
                f"Prompt body size ({len(encoded):,} bytes) exceeds the maximum "
                f"allowed size ({MAX_PROMPT_BODY_BYTES:,} bytes)"
            )

    @staticmethod
    def _format_now(now: datetime | None) -> str:
        if now is None:
            return _now_iso()
        return now.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    @staticmethod
    def _unique_id(candidate: str, existing: set[str]) -> str:
        if candidate not in existing:
            return candidate
        suffix = 2
        while True:
            attempt = f"{candidate}-{suffix}"
            if attempt not in existing:
                return attempt
            suffix += 1

    def _write(self, prompt: PromptDraft, *, expect_existing: bool) -> None:
        self.ensure_directory()
        body_path = self._body_path(prompt.id)
        meta_path = self._meta_path(prompt.id)
        if expect_existing and not body_path.exists():
            raise KeyError(f"Cannot update missing prompt: {prompt.id}")
        if not expect_existing and body_path.exists():
            raise FileExistsError(f"Prompt already exists: {prompt.id}")
        body_tmp = body_path.with_suffix(".md.tmp")
        meta_tmp = meta_path.with_suffix(".json.tmp")
        body_tmp.write_text(prompt.body, encoding="utf-8")
        meta_tmp.write_text(
            json.dumps(prompt.to_meta_json(), indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        body_tmp.replace(body_path)
        meta_tmp.replace(meta_path)

    def _load_meta(self, normalized_id: str) -> PromptDraft:
        meta_path = self.directory / f"{normalized_id}.json"
        if not meta_path.exists():
            raise PromptFileError(f"Missing sidecar: {meta_path}")
        try:
            text = meta_path.read_text(encoding="utf-8")
        except OSError as exc:
            raise PromptFileError(f"Cannot read {meta_path}: {exc}") from exc
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            raise PromptFileError(f"Malformed JSON in {meta_path}: {exc}") from exc
        if not isinstance(data, dict):
            raise PromptFileError(f"Sidecar {meta_path} must be a JSON object")
        version = data.get("version", 1)
        if not isinstance(version, int) or version > PROMPT_META_VERSION:
            raise PromptFileError(
                f"Unsupported prompt sidecar version: {version!r} "
                f"(this build understands <= {PROMPT_META_VERSION})"
            )
        raw_id = data.get("id")
        if not isinstance(raw_id, str) or not raw_id:
            raise PromptFileError(f"Sidecar {meta_path} missing 'id'")
        try:
            sidecar_id = normalize_prompt_id(raw_id)
        except ValueError as exc:
            raise PromptFileError(str(exc)) from exc
        if sidecar_id != normalized_id:
            # Filename is the source of truth; if the sidecar disagrees,
            # trust the filename so renaming on disk isn't silently undone.
            sidecar_id = normalized_id
        raw_name = data.get("name")
        name = raw_name.strip() if isinstance(raw_name, str) and raw_name.strip() else sidecar_id
        created_at = data.get("created_at")
        updated_at = data.get("updated_at")
        if not isinstance(created_at, str) or not created_at:
            created_at = _now_iso()
        if not isinstance(updated_at, str) or not updated_at:
            updated_at = created_at
        return PromptDraft(
            id=sidecar_id,
            name=name,
            body="",  # body is loaded separately in `get()`
            created_at=created_at,
            updated_at=updated_at,
        )

    def _fallback_meta(self, normalized_id: str, body_path: Path) -> PromptDraft:
        """Synthesize a meta record for a body file with no/broken sidecar."""
        try:
            mtime = datetime.fromtimestamp(body_path.stat().st_mtime, tz=timezone.utc)
            ts = mtime.strftime("%Y-%m-%dT%H:%M:%SZ")
        except OSError:
            ts = _now_iso()
        return PromptDraft(
            id=normalized_id,
            name=normalized_id.replace("-", " ").title() or normalized_id,
            body="",
            created_at=ts,
            updated_at=ts,
        )
