from __future__ import annotations

import codecs
from pathlib import Path
from typing import Iterable, Mapping
import shutil

from assistant_app.casefile.models import ScopedDirectory

# Hard upper bound for LLM-initiated file writes.  At 10 MB a single save_file
# call can already saturate the model's context; anything larger is almost
# certainly unintentional and could fill disk rapidly across repeated calls.
MAX_WRITE_BYTES: int = 10 * 1024 * 1024  # 10 MB


class WorkspaceFilesystem:
    """A scoped view of the filesystem for chat tools.

    `workspace_root` is the primary workspace root used for bare relative
    paths. M3.5 introduced `read_overlays`, which layer additional read-only
    roots on top of that primary root. M2.5's corrected scope model extends
    that further with `scoped_directories`: every directory in scope is
    addressable via `_scope/<label>/...`, and each mount may be independently
    read-only or writable.

    Bare relative writes continue to target `workspace_root` only when that
    root is writable in the current scope. Writes to mounted `_scope/...`
    prefixes succeed only when the specific mounted directory is writable.

    Backward compatibility: if `scoped_directories` is omitted, the class
    behaves as it did in M2/M3 — one write root plus optional read-only
    overlays.
    """

    def __init__(
        self,
        workspace_root: Path,
        *,
        read_overlays: Mapping[str, Path] | None = None,
        scoped_directories: Iterable[ScopedDirectory] | None = None,
    ) -> None:
        self.workspace_root = workspace_root.resolve()
        scoped = tuple(scoped_directories or ())
        self._scoped_mode = bool(scoped)
        self._workspace_writable = (
            True
            if not scoped
            else any(
                entry.writable and entry.path.resolve() == self.workspace_root
                for entry in scoped
            )
        )
        self._bare_read_allowed = (not scoped) or any(
            entry.path.resolve() == self.workspace_root for entry in scoped
        )
        mounts: list[tuple[str, Path, bool]] = []
        seen_prefixes: set[str] = set()
        for entry in scoped:
            prefix = f"_scope/{entry.label}".strip("/")
            if not prefix or prefix in seen_prefixes:
                continue
            mounts.append((prefix, entry.path.resolve(), entry.writable))
            seen_prefixes.add(prefix)
        for prefix, root in (read_overlays or {}).items():
            norm_prefix = prefix.strip("/")
            if not norm_prefix:
                continue
            if norm_prefix.startswith("_scope/") and scoped:
                # `scoped_directories` is the source of truth for `_scope/...`
                # mounts once the corrected scope model is active.
                continue
            if norm_prefix in seen_prefixes:
                continue
            mounts.append((norm_prefix, Path(root).resolve(), False))
            seen_prefixes.add(norm_prefix)
        # Sort longer prefixes first so nested mounts resolve to the most
        # specific target rather than a broader parent prefix.
        self._mounts: tuple[tuple[str, Path, bool], ...] = tuple(
            sorted(mounts, key=lambda item: -len(item[0]))
        )
        writable_roots = [self.workspace_root] if self._workspace_writable else []
        writable_roots.extend(root for _prefix, root, writable in self._mounts if writable)
        self._protected_write_roots: frozenset[Path] = frozenset(writable_roots)

    # ----- mount helpers -----

    @property
    def overlay_prefixes(self) -> tuple[str, ...]:
        return tuple(prefix for prefix, _, _ in self._mounts)

    def _split_mount(self, candidate: str) -> tuple[str, Path, str, bool] | None:
        """Return (prefix, mount_root, remaining_path, writable) or None if no match."""
        norm = candidate.strip().lstrip("/")
        if not norm:
            return None
        for prefix, mount_root, writable in self._mounts:
            if norm == prefix:
                return prefix, mount_root, "", writable
            if norm.startswith(prefix + "/"):
                return prefix, mount_root, norm[len(prefix) + 1 :], writable
        return None

    def _resolve_mount(self, mount_root: Path, remaining: str) -> Path:
        target = (mount_root / remaining).resolve() if remaining else mount_root
        if not (target == mount_root or target.is_relative_to(mount_root)):
            raise PermissionError(f"Path escapes mounted scope: {remaining}")
        return target

    def _resolve_for_read(self, candidate: str) -> tuple[Path, str | None]:
        """Resolve `candidate` as a read.

        Returns `(absolute_path, virtual_prefix_or_none)`. When the path
        matched an overlay, the virtual prefix is returned so callers can
        rewrite the response back into virtual form. When it falls through
        to the write root, the second element is None and the caller can
        report the absolute path as-is (existing M2/M3 behavior).
        """
        match = self._split_mount(candidate)
        if match is not None:
            prefix, mount_root, remaining, _writable = match
            return self._resolve_mount(mount_root, remaining), prefix
        if self._scoped_mode and not self._bare_read_allowed:
            raise PermissionError(
                "Bare relative reads are not allowed in this scope; use a "
                "`_scope/<label>/...` path instead."
            )
        return self.resolve_relative(candidate), None

    def _resolve_for_write(self, candidate: str) -> Path:
        match = self._split_mount(candidate)
        if match is not None:
            prefix, mount_root, remaining, writable = match
            if not writable:
                raise PermissionError(
                    f"Read-only scope paths cannot be written: {candidate!r}"
                )
            return self._resolve_mount(mount_root, remaining)
        if not self._workspace_writable:
            raise PermissionError(
                "Bare relative writes are not allowed in this scope; use a writable "
                "`_scope/<label>/...` path instead."
            )
        return self.resolve_relative(candidate)

    def _reject_protected_root_delete(self, target: Path, candidate: str) -> None:
        if target in self._protected_write_roots:
            raise PermissionError(
                f"Refusing to delete scoped root directory: {candidate!r}. "
                "Delete a child path instead."
            )

    @staticmethod
    def _virtualize(prefix: str, mount_root: Path, absolute: Path) -> str:
        try:
            rel = absolute.relative_to(mount_root)
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

    def read_text_bounded(self, candidate: str, max_bytes: int) -> tuple[str, bool, Path]:
        """Read up to ``max_bytes`` of UTF-8 text from *candidate*.

        SECURITY (M1): the budget is enforced in *bytes*, not characters,
        so a file heavy in multi-byte sequences cannot blow past the
        intended memory cap. A binary-content sniff (NUL in the first
        8 KiB) rejects non-text files before we try a full decode.
        """
        if max_bytes <= 0:
            raise ValueError("max_bytes must be greater than 0")
        target, _ = self._resolve_for_read(candidate)
        if not target.exists():
            raise FileNotFoundError(f"File not found: {candidate}")
        if not target.is_file():
            raise IsADirectoryError(f"Not a file: {candidate}")
        _CHUNK = 65536
        _SNIFF = 8192
        parts: list[bytes] = []
        total = 0
        truncated = False
        try:
            with target.open("rb") as fh:
                while total < max_bytes:
                    to_read = min(_CHUNK, max_bytes - total)
                    raw = fh.read(to_read)
                    if not raw:
                        break
                    # Binary sniff: NUL bytes in early content.
                    if total < _SNIFF:
                        sniff_end = min(len(raw), _SNIFF - total)
                        if b"\x00" in raw[:sniff_end]:
                            raise ValueError(
                                f"File appears to be binary (contains NUL bytes): {candidate}"
                            )
                    parts.append(raw)
                    total += len(raw)
                # Check for remaining data beyond the budget.
                if fh.read(1):
                    truncated = True
        except ValueError:
            raise
        except OSError:
            raise
        blob = b"".join(parts)
        try:
            text = blob.decode("utf-8")
        except UnicodeDecodeError:
            raise ValueError(f"File is not valid UTF-8 text: {candidate}")
        return text, truncated, target

    def list_dir(self, candidate: str) -> tuple[Path, list[dict[str, str]]]:
        normalized_input = candidate.strip()
        if (
            self._scoped_mode
            and not self._bare_read_allowed
            and normalized_input in {"", ".", "./"}
        ):
            # A fully read-only scoped session still needs a discoverable root.
            # Return only virtual mount names, never the casefile-root contents.
            return self.workspace_root, self._top_level_overlay_entries()
        virtual_entries = self._virtual_overlay_entries(normalized_input)
        if virtual_entries is not None:
            return self.workspace_root, virtual_entries
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
        if prefix is None and self._mounts:
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
                for mount_prefix, _root, _writable in self._mounts:
                    top = mount_prefix.split("/", 1)[0]
                    if top in seen_top:
                        continue
                    seen_top.add(top)
                    entries.append({"name": top, "type": "overlay"})
        return target, entries

    def _top_level_overlay_entries(self) -> list[dict[str, str]]:
        entries: list[dict[str, str]] = []
        seen_top: set[str] = set()
        for mount_prefix, _root, _writable in self._mounts:
            top = mount_prefix.split("/", 1)[0]
            if top in seen_top:
                continue
            seen_top.add(top)
            entries.append({"name": top, "type": "overlay"})
        return entries

    def _virtual_overlay_entries(self, candidate: str) -> list[dict[str, str]] | None:
        normalized = candidate.strip().strip("/")
        if not normalized:
            return None
        child_names: set[str] = set()
        for mount_prefix, _root, _writable in self._mounts:
            if mount_prefix == normalized:
                return None
            if not mount_prefix.startswith(normalized + "/"):
                continue
            remainder = mount_prefix[len(normalized) + 1 :]
            child = remainder.split("/", 1)[0]
            if child:
                child_names.add(child)
        if not child_names:
            return None
        return [{"name": name, "type": "overlay"} for name in sorted(child_names, key=str.lower)]

    # ----- write operations -----

    def save_text(self, candidate: str, content: str, overwrite: bool) -> tuple[Path, int]:
        target = self._resolve_for_write(candidate)
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
        target = self._resolve_for_write(candidate)
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
        target = self._resolve_for_write(candidate)
        if not target.exists():
            raise FileNotFoundError(f"File not found: {candidate}")
        if not target.is_file():
            raise IsADirectoryError(f"Not a file: {candidate}")
        target.unlink()
        return target

    def delete_path(self, candidate: str, recursive: bool) -> tuple[Path, str]:
        target = self._resolve_for_write(candidate)
        self._reject_protected_root_delete(target, candidate)
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
