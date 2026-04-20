from __future__ import annotations

import codecs
from pathlib import Path
from typing import Mapping
import shutil

# Hard upper bound for LLM-initiated file writes.  At 10 MB a single save_file
# call can already saturate the model's context; anything larger is almost
# certainly unintentional and could fill disk rapidly across repeated calls.
MAX_WRITE_BYTES: int = 10 * 1024 * 1024  # 10 MB


class WorkspaceFilesystem:
    """A scoped view of the filesystem for chat tools.

    `workspace_root` is the *write* root: every save/append/delete operation
    is required to resolve inside it. M3.5 introduced `read_overlays`, which
    layer additional **read-only** roots on top of the write root, each
    addressable through a virtual prefix (e.g. `_ancestors/TASK_9/...`).

    The model never sees absolute paths in tool responses for overlay hits;
    it sees the same virtual path it requested. That keeps the on-disk
    layout an implementation detail and lets the user treat the cascade
    (lane + ancestors + attachments + casefile context) as one logical
    workspace.

    Backward compatibility: if `read_overlays` is omitted, the class behaves
    exactly as it did in M2/M3 — single root, write-everywhere, no virtual
    routing.
    """

    def __init__(
        self,
        workspace_root: Path,
        *,
        read_overlays: Mapping[str, Path] | None = None,
    ) -> None:
        self.workspace_root = workspace_root.resolve()
        # Sort longer prefixes first so `_ancestors/foo/_attachments/bar`
        # resolves to its specific overlay rather than the more general
        # `_ancestors/foo` overlay when both are registered.
        self._read_overlays: tuple[tuple[str, Path], ...] = tuple(
            sorted(
                (
                    (prefix.strip("/"), Path(root).resolve())
                    for prefix, root in (read_overlays or {}).items()
                    if prefix.strip("/")
                ),
                key=lambda item: -len(item[0]),
            )
        )

    # ----- read overlay helpers -----

    @property
    def overlay_prefixes(self) -> tuple[str, ...]:
        return tuple(prefix for prefix, _ in self._read_overlays)

    def _split_overlay(self, candidate: str) -> tuple[str, Path, str] | None:
        """Return (prefix, overlay_root, remaining_path) or None if no match."""
        norm = candidate.strip().lstrip("/")
        if not norm:
            return None
        for prefix, overlay_root in self._read_overlays:
            if norm == prefix:
                return prefix, overlay_root, ""
            if norm.startswith(prefix + "/"):
                return prefix, overlay_root, norm[len(prefix) + 1 :]
        return None

    def _resolve_overlay(self, overlay_root: Path, remaining: str) -> Path:
        target = (overlay_root / remaining).resolve() if remaining else overlay_root
        if not (target == overlay_root or target.is_relative_to(overlay_root)):
            raise PermissionError(f"Path escapes overlay: {remaining}")
        return target

    def _resolve_for_read(self, candidate: str) -> tuple[Path, str | None]:
        """Resolve `candidate` as a read.

        Returns `(absolute_path, virtual_prefix_or_none)`. When the path
        matched an overlay, the virtual prefix is returned so callers can
        rewrite the response back into virtual form. When it falls through
        to the write root, the second element is None and the caller can
        report the absolute path as-is (existing M2/M3 behavior).
        """
        match = self._split_overlay(candidate)
        if match is not None:
            prefix, overlay_root, remaining = match
            return self._resolve_overlay(overlay_root, remaining), prefix
        return self.resolve_relative(candidate), None

    @staticmethod
    def _virtualize(prefix: str, overlay_root: Path, absolute: Path) -> str:
        try:
            rel = absolute.relative_to(overlay_root)
        except ValueError:
            return str(absolute)
        rel_str = rel.as_posix()
        return prefix if rel_str in ("", ".") else f"{prefix}/{rel_str}"

    # ----- write-root resolution (M2/M3 semantics, unchanged) -----

    def resolve_relative(self, candidate: str) -> Path:
        path = (self.workspace_root / candidate).resolve()
        if not path.is_relative_to(self.workspace_root):
            raise PermissionError(f"Path escapes workspace: {candidate}")
        return path

    # ----- read operations (overlay-aware) -----

    def read_text_bounded(self, candidate: str, max_chars: int) -> tuple[str, bool, Path]:
        if max_chars <= 0:
            raise ValueError("max_chars must be greater than 0")
        target, _ = self._resolve_for_read(candidate)
        if not target.exists():
            raise FileNotFoundError(f"File not found: {candidate}")
        if not target.is_file():
            raise IsADirectoryError(f"Not a file: {candidate}")
        # Read in binary chunks and decode incrementally to avoid allocating the
        # entire file in memory even for very large files with no newlines.
        # Using an incremental decoder handles multi-byte UTF-8 sequences that
        # straddle chunk boundaries without raising a spurious UnicodeDecodeError.
        _CHUNK = 65536
        decoder = codecs.getincrementaldecoder("utf-8")(errors="strict")
        parts: list[str] = []
        total = 0
        try:
            with target.open("rb") as fh:
                while True:
                    raw = fh.read(_CHUNK)
                    final = not raw
                    chunk = decoder.decode(raw, final=final)
                    if chunk:
                        remaining = max_chars - total
                        if len(chunk) > remaining:
                            # We have more than enough characters — truncate and stop.
                            parts.append(chunk[:remaining])
                            return "".join(parts), True, target
                        parts.append(chunk)
                        total += len(chunk)
                    if final:
                        break
        except UnicodeDecodeError:
            raise ValueError(f"File is not valid UTF-8 text: {candidate}")
        return "".join(parts), False, target

    def list_dir(self, candidate: str) -> tuple[Path, list[dict[str, str]]]:
        target, prefix = self._resolve_for_read(candidate)
        # Special case: listing the write root with overlays present should
        # surface the available virtual prefixes too, so the model can
        # discover them with a normal `list_dir(".")`. We tag overlay
        # entries with type "overlay" to make the distinction obvious.
        if not target.exists():
            raise FileNotFoundError(f"Directory not found: {candidate}")
        if not target.is_dir():
            raise NotADirectoryError(f"Not a directory: {candidate}")
        entries: list[dict[str, str]] = []
        for item in sorted(target.iterdir(), key=lambda p: p.name.lower()):
            entries.append({"name": item.name, "type": "dir" if item.is_dir() else "file"})
        # Append the top-level overlay prefixes when listing the write root.
        if prefix is None and self._read_overlays:
            try:
                normalized_candidate = (
                    Path(candidate).resolve()
                    if Path(candidate).is_absolute()
                    else (self.workspace_root / candidate).resolve()
                )
            except OSError:
                normalized_candidate = target
            if normalized_candidate == self.workspace_root:
                seen_top: set[str] = set()
                for overlay_prefix, _ in self._read_overlays:
                    top = overlay_prefix.split("/", 1)[0]
                    if top in seen_top:
                        continue
                    seen_top.add(top)
                    entries.append({"name": top, "type": "overlay"})
        return target, entries

    # ----- write operations (write root only, unchanged) -----

    def save_text(self, candidate: str, content: str, overwrite: bool) -> tuple[Path, int]:
        self._reject_overlay_write(candidate)
        target = self.resolve_relative(candidate)
        if target.exists() and not overwrite:
            raise FileExistsError(f"File already exists: {candidate}")
        encoded = content.encode("utf-8")
        if len(encoded) > MAX_WRITE_BYTES:
            raise ValueError(
                f"Content size ({len(encoded):,} bytes) exceeds the maximum allowed "
                f"write size ({MAX_WRITE_BYTES:,} bytes)"
            )
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        return target, len(encoded)

    def append_text(self, candidate: str, content: str) -> tuple[Path, int]:
        self._reject_overlay_write(candidate)
        target = self.resolve_relative(candidate)
        encoded = content.encode("utf-8")
        if len(encoded) > MAX_WRITE_BYTES:
            raise ValueError(
                f"Append content size ({len(encoded):,} bytes) exceeds the maximum allowed "
                f"write size ({MAX_WRITE_BYTES:,} bytes)"
            )
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("a", encoding="utf-8") as handle:
            handle.write(content)
        return target, len(encoded)

    def delete_file(self, candidate: str) -> Path:
        self._reject_overlay_write(candidate)
        target = self.resolve_relative(candidate)
        if not target.exists():
            raise FileNotFoundError(f"File not found: {candidate}")
        if not target.is_file():
            raise IsADirectoryError(f"Not a file: {candidate}")
        target.unlink()
        return target

    def delete_path(self, candidate: str, recursive: bool) -> tuple[Path, str]:
        self._reject_overlay_write(candidate)
        target = self.resolve_relative(candidate)
        if not target.exists():
            raise FileNotFoundError(f"Path not found: {candidate}")
        if target.is_file():
            target.unlink()
            return target, "file"
        if not recursive:
            raise IsADirectoryError(
                f"Path is a directory: {candidate}. Set recursive=true to delete directories."
            )
        shutil.rmtree(target)
        return target, "dir"

    def _reject_overlay_write(self, candidate: str) -> None:
        if self._split_overlay(candidate) is not None:
            raise PermissionError(
                f"Read-only overlay paths cannot be written: {candidate!r}"
            )
