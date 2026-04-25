from __future__ import annotations

import fnmatch
import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

from assistant_app.casefile.models import Casefile

_logger = logging.getLogger(__name__)

# Bumped when the schema changes. Loader treats unknown future versions as
# fatal but tolerates missing fields in the current version.
CONTEXT_FILE_VERSION = 1

# Default ceiling for auto-injecting a context file into the chat system
# prompt. Files larger than this are still listed but only read on demand
# via tool calls. 32 KiB is roughly the size of a long checklist or rubric;
# anything larger is usually source code that shouldn't be auto-included.
DEFAULT_AUTO_INCLUDE_MAX_BYTES = 32 * 1024

# Hard ceilings for user-configured auto-include budgets. The per-file cap
# keeps one large file from being injected accidentally; the total cap prevents
# many individually-small files from ballooning a provider request.
MAX_AUTO_INCLUDE_MAX_BYTES = 256 * 1024
MAX_AUTO_INCLUDE_TOTAL_BYTES = 512 * 1024


class ContextManifestError(ValueError):
    """Raised when `.casefile/context.json` is malformed in a way the loader cannot recover."""


@dataclass(slots=True, frozen=True)
class ContextManifest:
    """Casefile-wide always-on read context.

    `files` are paths or glob patterns relative to the casefile root. Each
    entry can match zero or more on-disk files. Globs are evaluated lazily
    by `resolve_files`; nothing here touches disk at construction time.

    `auto_include_max_bytes` is the per-file budget for auto-inclusion in
    the chat system prompt. Files larger than this are still discoverable
    via tool calls, just not pre-loaded into context.
    """

    files: tuple[str, ...] = field(default_factory=tuple)
    auto_include_max_bytes: int = DEFAULT_AUTO_INCLUDE_MAX_BYTES

    def to_json(self) -> dict[str, Any]:
        return {
            "version": CONTEXT_FILE_VERSION,
            "files": list(self.files),
            "auto_include_max_bytes": self.auto_include_max_bytes,
        }

    @classmethod
    def from_json(cls, raw: object) -> "ContextManifest":
        if not isinstance(raw, dict):
            raise ContextManifestError("context.json must be a JSON object at the top level")
        version = raw.get("version", 1)
        if not isinstance(version, int) or version > CONTEXT_FILE_VERSION:
            raise ContextManifestError(
                f"Unsupported context.json version: {version!r} "
                f"(this build understands <= {CONTEXT_FILE_VERSION})"
            )
        raw_files = raw.get("files", [])
        if not isinstance(raw_files, list):
            raise ContextManifestError("context.json: 'files' must be an array")
        files: list[str] = []
        for entry in raw_files:
            if not isinstance(entry, str):
                continue
            cleaned = entry.strip().lstrip("/")
            if not cleaned or ".." in cleaned.split("/"):
                # Reject traversal explicitly. Patterns relative to the
                # casefile root only — no escaping outward.
                continue
            files.append(cleaned)
        raw_max = raw.get("auto_include_max_bytes", DEFAULT_AUTO_INCLUDE_MAX_BYTES)
        if isinstance(raw_max, bool) or not isinstance(raw_max, int) or raw_max < 0:
            raw_max = DEFAULT_AUTO_INCLUDE_MAX_BYTES
        raw_max = min(raw_max, MAX_AUTO_INCLUDE_MAX_BYTES)
        return cls(files=tuple(files), auto_include_max_bytes=raw_max)


@dataclass(slots=True, frozen=True)
class ResolvedContextFile:
    """A concrete file matched by the manifest, plus its size in bytes."""

    relative_path: str  # POSIX, relative to casefile root
    absolute_path: Path
    size_bytes: int


class ContextManifestStore:
    """Filesystem-backed CRUD for `.casefile/context.json`.

    The file is optional. A missing file means "no auto-included context"
    rather than an error, so existing casefiles work without a manual
    upgrade step.
    """

    def __init__(self, casefile_root: Path) -> None:
        self.casefile = Casefile(root=Path(casefile_root).resolve())

    def load(self) -> ContextManifest:
        path = self.casefile.context_file
        if not path.exists():
            return ContextManifest()
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as exc:
            raise ContextManifestError(f"Cannot read {path}: {exc}") from exc
        try:
            raw = json.loads(text)
        except json.JSONDecodeError as exc:
            raise ContextManifestError(f"Malformed JSON in {path}: {exc}") from exc
        return ContextManifest.from_json(raw)

    def save(self, manifest: ContextManifest) -> None:
        meta = self.casefile.metadata_dir
        meta.mkdir(parents=True, exist_ok=True)
        path = self.casefile.context_file
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(
            json.dumps(manifest.to_json(), indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        tmp.replace(path)

    def resolve_files(self, manifest: ContextManifest | None = None) -> list[ResolvedContextFile]:
        """Expand the manifest into concrete on-disk files, sorted by path.

        Each entry is matched against the casefile root using either a direct
        path (cheaper) or `pathlib.Path.glob` for entries containing glob
        characters. Hits outside the casefile root are silently dropped as
        a defense against pattern injection (e.g. `../escape/*`).
        """
        manifest = manifest or self.load()
        seen: set[Path] = set()
        out: list[ResolvedContextFile] = []
        root = self.casefile.root
        for pattern in manifest.files:
            matches = self._expand(root, pattern)
            for match in matches:
                resolved = match.resolve()
                if not resolved.is_file():
                    continue
                try:
                    resolved.relative_to(root)
                except ValueError:
                    continue
                if resolved in seen:
                    continue
                seen.add(resolved)
                rel = resolved.relative_to(root).as_posix()
                try:
                    size = resolved.stat().st_size
                except OSError:
                    continue
                out.append(
                    ResolvedContextFile(
                        relative_path=rel,
                        absolute_path=resolved,
                        size_bytes=size,
                    )
                )
        out.sort(key=lambda entry: entry.relative_path)
        return out

    @staticmethod
    def _expand(root: Path, pattern: str) -> Iterable[Path]:
        if any(ch in pattern for ch in "*?["):
            try:
                return list(root.glob(pattern))
            except ValueError as exc:
                # `Path.glob` raises ValueError for genuinely malformed
                # patterns (e.g. one containing a NUL). Silently dropping
                # them hides manifest misconfiguration; surface a warning
                # so it shows up in the application log.
                _logger.warning(
                    "Invalid context-manifest glob %r under %s: %s",
                    pattern,
                    root,
                    exc,
                )
                return []
            except OSError as exc:
                _logger.warning(
                    "OS error while expanding context-manifest glob %r under %s: %s",
                    pattern,
                    root,
                    exc,
                )
                return []
        candidate = root / pattern
        return [candidate] if candidate.exists() else []


def matches_any(pattern_set: Iterable[str], relative_path: str) -> bool:
    """True if `relative_path` matches any glob in `pattern_set`.

    Helper used by callers to check whether a candidate addition is already
    covered by an existing pattern.
    """
    for pattern in pattern_set:
        if fnmatch.fnmatchcase(relative_path, pattern):
            return True
    return False
