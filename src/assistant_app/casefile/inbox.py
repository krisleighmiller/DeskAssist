"""Configured local-directory inboxes attached to a casefile.

An "inbox" is a directory the user has registered as an external source of
context (notes, transcripts, references) that are *not* part of any lane's
filesystem. The store persists the configuration in
``.casefile/inbox.json`` and offers bounded helpers for listing items and
reading their contents.

Inbox content is intentionally *not* mounted as a lane: lanes are
write-scoped and carry their own chat history, while inbox sources are
read-only references that several lanes (or comparison chats, or
findings) might point at without owning. To link an inbox item to a
finding, the renderer composes a virtual path of the form
``_inbox/<source_id>/<relative-path>`` and uses it as the
``source_ref.path`` on a finding owned by a real lane — no schema change
is required.
"""

from __future__ import annotations

import json
import re
import secrets
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

from assistant_app.casefile.models import Casefile

INBOX_FILE_VERSION = 1
INBOX_FILENAME = "inbox.json"

# File suffixes treated as inbox items. Anything else (binaries, images,
# arbitrary office docs) is filtered out at list time so the renderer
# doesn't have to defensively guard against opening them.
INBOX_TEXT_SUFFIXES = frozenset(
    {".md", ".markdown", ".txt", ".rst", ".log", ".csv", ".tsv", ".json"}
)

# Walking is depth-bounded so a wildly deep source can't hang the UI.
MAX_INBOX_LIST_DEPTH = 4
DEFAULT_INBOX_READ_MAX_CHARS = 200_000


class InboxFileError(ValueError):
    """Raised when the inbox configuration file is malformed."""


_ID_SAFE_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")


def normalize_source_id(raw: str) -> str:
    """Collapse a user-supplied id to the safe-character set.

    Path-like substrings are rejected outright (mirroring what we do for
    lane / prompt / run ids); other characters are replaced with hyphens
    so the user gets a usable id without having to guess our regex.
    """
    if not isinstance(raw, str):
        raise ValueError("inbox source id must be a string")
    if "/" in raw or "\\" in raw or ".." in raw or "\x00" in raw:
        raise ValueError(f"Invalid inbox source id (path-like): {raw!r}")
    cleaned = re.sub(r"[^a-z0-9_-]+", "-", raw.lower()).strip("-")
    if not cleaned:
        raise ValueError("inbox source id is empty after normalization")
    if not _ID_SAFE_RE.match(cleaned):
        raise ValueError(f"Invalid inbox source id: {raw!r}")
    return cleaned


def slug_from_name(name: str) -> str:
    """Generate an inbox source id from a free-form name.

    Falls back to ``inbox`` (the same way prompts fall back to
    ``prompt``) when the name has no usable characters; the caller is
    expected to handle id-collision suffixing itself.
    """
    cleaned = re.sub(r"[^a-z0-9_-]+", "-", name.lower()).strip("-")
    return cleaned or "inbox"


@dataclass(slots=True, frozen=True)
class InboxSource:
    """A single configured inbox directory."""

    id: str
    name: str
    root: str  # absolute path string; resolved at registration time

    def to_json(self) -> dict[str, Any]:
        return {"id": self.id, "name": self.name, "root": self.root}

    @classmethod
    def from_json(cls, raw: object) -> "InboxSource":
        if not isinstance(raw, dict):
            raise InboxFileError(
                f"inbox source must be an object, got {type(raw).__name__}"
            )
        try:
            return cls(
                id=normalize_source_id(str(raw["id"])),
                name=str(raw.get("name") or raw["id"]),
                root=str(raw["root"]),
            )
        except KeyError as exc:
            raise InboxFileError(
                f"inbox source missing required field: {exc.args[0]!r}"
            ) from exc


@dataclass(slots=True, frozen=True)
class InboxItem:
    """A single text item discovered under an inbox source."""

    source_id: str
    path: str  # forward-slash, source-relative
    size_bytes: int

    def to_json(self) -> dict[str, Any]:
        return {
            "sourceId": self.source_id,
            "path": self.path,
            "sizeBytes": self.size_bytes,
        }


class InboxStore:
    """File-backed configuration + read helpers for inbox sources.

    We keep the configuration in one JSON file (rather than one file per
    source like prompts/runs/findings) because it's a small, frequently
    re-read list and atomic rewrites are cheap. Items themselves live on
    disk under the user's chosen directories; we never copy them into the
    casefile.
    """

    def __init__(self, casefile_root: Path) -> None:
        self.casefile = Casefile(root=Path(casefile_root).resolve())

    # ----- paths -----

    @property
    def config_path(self) -> Path:
        return self.casefile.metadata_dir / INBOX_FILENAME

    def ensure_metadata_dir(self) -> None:
        self.casefile.metadata_dir.mkdir(parents=True, exist_ok=True)

    # ----- source CRUD -----

    def list_sources(self) -> list[InboxSource]:
        if not self.config_path.exists():
            return []
        try:
            raw = json.loads(self.config_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise InboxFileError(f"failed to read inbox.json: {exc}") from exc
        if not isinstance(raw, dict):
            raise InboxFileError("inbox.json root must be an object")
        sources_raw = raw.get("sources", [])
        if not isinstance(sources_raw, list):
            raise InboxFileError("inbox.json `sources` must be an array")
        out: list[InboxSource] = []
        for entry in sources_raw:
            try:
                out.append(InboxSource.from_json(entry))
            except InboxFileError:
                # A single malformed entry should not blank the list.
                continue
        return out

    def get_source(self, source_id: str) -> InboxSource:
        safe = normalize_source_id(source_id)
        for src in self.list_sources():
            if src.id == safe:
                return src
        raise KeyError(f"Unknown inbox source: {source_id}")

    def add_source(
        self, *, name: str, root: str, source_id: str | None = None
    ) -> InboxSource:
        cleaned_name = (name or "").strip()
        if not cleaned_name:
            raise ValueError("inbox source name is required")
        root_resolved = Path(root).expanduser().resolve()
        if not root_resolved.is_dir():
            raise ValueError(f"inbox root is not a directory: {root_resolved}")

        sources = self.list_sources()
        used_ids = {s.id for s in sources}

        if source_id is not None and source_id.strip():
            new_id = normalize_source_id(source_id)
            if new_id in used_ids:
                raise ValueError(f"inbox source id already in use: {new_id!r}")
        else:
            base = slug_from_name(cleaned_name)
            new_id = base
            counter = 2
            while new_id in used_ids:
                new_id = f"{base}-{counter}"
                counter += 1

        new_source = InboxSource(id=new_id, name=cleaned_name, root=str(root_resolved))
        self._write_sources([*sources, new_source])
        return new_source

    def update_source(
        self,
        source_id: str,
        *,
        name: str | None = None,
        root: str | None = None,
    ) -> InboxSource:
        safe = normalize_source_id(source_id)
        sources = self.list_sources()
        for idx, src in enumerate(sources):
            if src.id != safe:
                continue
            updated = src
            if name is not None:
                cleaned = name.strip()
                if not cleaned:
                    raise ValueError("inbox source name cannot be empty")
                updated = replace(updated, name=cleaned)
            if root is not None:
                root_resolved = Path(root).expanduser().resolve()
                if not root_resolved.is_dir():
                    raise ValueError(
                        f"inbox root is not a directory: {root_resolved}"
                    )
                updated = replace(updated, root=str(root_resolved))
            sources[idx] = updated
            self._write_sources(sources)
            return updated
        raise KeyError(f"Unknown inbox source: {source_id}")

    def remove_source(self, source_id: str) -> None:
        safe = normalize_source_id(source_id)
        sources = self.list_sources()
        filtered = [s for s in sources if s.id != safe]
        if len(filtered) == len(sources):
            raise KeyError(f"Unknown inbox source: {source_id}")
        self._write_sources(filtered)

    # ----- items -----

    def list_items(self, source_id: str, *, max_depth: int | None = None) -> list[InboxItem]:
        source = self.get_source(source_id)
        depth_cap = MAX_INBOX_LIST_DEPTH if max_depth is None else max(1, min(max_depth, MAX_INBOX_LIST_DEPTH))
        root = Path(source.root)
        if not root.is_dir():
            # The directory was deleted out from under us; surface as an
            # empty list rather than crashing the inbox tab.
            return []
        items: list[InboxItem] = []
        self._walk(root, root, depth=0, depth_cap=depth_cap, source_id=source.id, out=items)
        # Stable, predictable order regardless of filesystem iteration order.
        items.sort(key=lambda it: it.path)
        return items

    def read_item(
        self,
        source_id: str,
        relative_path: str,
        *,
        max_chars: int = DEFAULT_INBOX_READ_MAX_CHARS,
    ) -> tuple[str, bool, str]:
        """Return ``(content, truncated, absolute_path)`` for an inbox item.

        ``relative_path`` is the source-relative path returned by
        :meth:`list_items`. We resolve it against the source root and
        verify the result still lives inside that root before reading
        (defends against path-escape attempts via ``..``).
        """
        if max_chars < 1 or max_chars > 2_000_000:
            raise ValueError("max_chars must be between 1 and 2_000_000")
        if not isinstance(relative_path, str) or not relative_path.strip():
            raise ValueError("relative_path is required")
        source = self.get_source(source_id)
        source_root = Path(source.root).resolve()
        target = (source_root / relative_path).resolve()
        if target != source_root and source_root not in target.parents:
            raise ValueError(
                f"inbox item path escapes source root: {relative_path!r}"
            )
        if not target.is_file():
            raise FileNotFoundError(f"inbox item not found: {relative_path}")
        if target.suffix.lower() not in INBOX_TEXT_SUFFIXES:
            raise ValueError(
                f"inbox item is not a text type: {target.suffix or '(no suffix)'}"
            )
        # Bounded read: read enough bytes to hit the cap then trim.
        with target.open("r", encoding="utf-8", errors="replace") as fh:
            content = fh.read(max_chars + 1)
        truncated = len(content) > max_chars
        return content[:max_chars], truncated, str(target)

    # ----- internals -----

    def _walk(
        self,
        root: Path,
        directory: Path,
        *,
        depth: int,
        depth_cap: int,
        source_id: str,
        out: list[InboxItem],
    ) -> None:
        if depth >= depth_cap:
            return
        try:
            entries = sorted(directory.iterdir(), key=lambda p: p.name.lower())
        except OSError:
            return
        for entry in entries:
            # Hidden + casefile metadata directories are skipped: they're
            # noise from the user's perspective and would break the
            # virtual-path assumption when nested inside a casefile root.
            if entry.name.startswith(".") or entry.name == ".casefile":
                continue
            if entry.is_dir():
                self._walk(
                    root,
                    entry,
                    depth=depth + 1,
                    depth_cap=depth_cap,
                    source_id=source_id,
                    out=out,
                )
                continue
            if not entry.is_file():
                continue
            if entry.suffix.lower() not in INBOX_TEXT_SUFFIXES:
                continue
            try:
                size = entry.stat().st_size
            except OSError:
                continue
            rel = entry.relative_to(root).as_posix()
            out.append(InboxItem(source_id=source_id, path=rel, size_bytes=size))

    def _write_sources(self, sources: list[InboxSource]) -> None:
        self.ensure_metadata_dir()
        payload = {
            "version": INBOX_FILE_VERSION,
            "sources": [s.to_json() for s in sources],
        }
        tmp = self.config_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        tmp.replace(self.config_path)


def random_source_id() -> str:
    """Random fallback id when the user provides nothing.

    Currently unused (slug_from_name handles the empty case), but exposed
    for tests / future callers that want a guaranteed-unique id without
    going through the collision-suffix loop.
    """
    return f"inbox-{secrets.token_hex(4)}"


__all__ = [
    "DEFAULT_INBOX_READ_MAX_CHARS",
    "INBOX_FILE_VERSION",
    "INBOX_FILENAME",
    "INBOX_TEXT_SUFFIXES",
    "InboxFileError",
    "InboxItem",
    "InboxSource",
    "InboxStore",
    "MAX_INBOX_LIST_DEPTH",
    "normalize_source_id",
    "random_source_id",
    "slug_from_name",
]
