from __future__ import annotations

import json
import logging
import os
import re
import shutil
import uuid
from pathlib import Path
from typing import Any, Iterable

from assistant_app.casefile.models import (
    Casefile,
    CasefileSnapshot,
    ComparisonSessionConfig,
    DEFAULT_ATTACHMENT_MODE,
    DEFAULT_CONTEXT_KIND,
    Context,
    ContextAttachment,
    coerce_attachment_mode,
    coerce_context_kind,
)

# Bumped from 1 to 2 in M3.5 when contexts gained `parent_id` and `attachments`.
# Version 1 files are still loadable: missing fields default to "no parent,
# no attachments" and the file is rewritten as version 2 on first mutation.
CONTEXTS_FILE_VERSION = 2

# Maximum size for a single serialised chat message line.  An LLM response
# with embedded tool results can be large, but 1 MB per line is already
# generous.  Anything larger almost certainly indicates runaway content.
MAX_CHAT_LINE_BYTES: int = 1 * 1024 * 1024  # 1 MB
COMPARISONS_FILE_VERSION = 1
PRIVATE_DIR_MODE = 0o700
PRIVATE_FILE_MODE = 0o600

_logger = logging.getLogger(__name__)


class ContextsFileError(ValueError):
    """Raised when `contexts.json` is malformed in a way the loader cannot recover from."""


_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")


def _new_session_id() -> str:
    return str(uuid.uuid4())


def _ensure_private_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    try:
        path.chmod(PRIVATE_DIR_MODE)
    except OSError:
        # Some filesystems do not support POSIX permissions. Best effort is
        # still better than failing casefile initialization on those systems.
        pass


def _write_private_text(path: Path, text: str) -> None:
    _ensure_private_dir(path.parent)
    tmp = path.with_suffix(f"{path.suffix}.tmp")
    tmp.write_text(text, encoding="utf-8")
    try:
        tmp.chmod(PRIVATE_FILE_MODE)
    except OSError:
        pass
    tmp.replace(path)
    try:
        path.chmod(PRIVATE_FILE_MODE)
    except OSError:
        pass


def _write_all(fd: int, blob: bytes) -> None:
    view = memoryview(blob)
    total_written = 0
    while total_written < len(view):
        written = os.write(fd, view[total_written:])
        if written == 0:
            raise OSError("os.write returned 0 before all bytes were written")
        total_written += written


def _append_private_lines(path: Path, lines: list[str]) -> None:
    """Append JSONL lines to a chat log with crash-safe semantics.

    SECURITY (M2): a crash mid-write previously left a partially
    serialised JSONL line at the tail of the log. The next
    ``read_chat_messages`` would skip the corrupt line silently
    (``skippedCorruptLines``) which is an integrity loss — the user
    loses the last turn with no indication until they scroll back.

    Strategy: write the new lines to a *sibling temp file*, ``fsync``
    it, then append its contents to the real log in a single
    complete write loop + ``fsync``. The temp file is always removed. If we
    crash between the fsync and the temp-unlink, the worst case is a
    stale temp file in the chats dir that costs a few KB — never a
    corrupt log.
    """
    _ensure_private_dir(path.parent)
    # Build the complete blob we want to append.
    blob = "".join(f"{line}\n" for line in lines).encode("utf-8")
    # Stage to a temp file first so we can fsync the content before it
    # touches the real log.
    import tempfile as _tf

    tmp_fd, tmp_name = _tf.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    try:
        _write_all(tmp_fd, blob)
        os.fsync(tmp_fd)
        os.close(tmp_fd)
        tmp_fd = -1  # mark as closed
        # Append from the staged temp file to the real log.
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, PRIVATE_FILE_MODE)
        try:
            _write_all(fd, blob)
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        if tmp_fd >= 0:
            os.close(tmp_fd)
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
    try:
        path.chmod(PRIVATE_FILE_MODE)
    except OSError:
        pass


def _stable_migrated_session_id(kind: str, root: Path, identifier: str) -> str:
    """Stable UUID fallback for metadata written before session ids existed."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"deskassist:{kind}:{root}:{identifier}"))


def _coerce_session_id(value: object, *, kind: str, root: Path, identifier: str) -> str:
    if isinstance(value, str):
        try:
            return str(uuid.UUID(value))
        except ValueError:
            pass
    return _stable_migrated_session_id(kind, root, identifier)


def _normalize_session_id(value: str) -> str:
    return str(uuid.UUID(value))


def normalize_context_id(raw: str) -> str:
    """Normalize a free-form context id to the on-disk shape.

    Context ids appear in filenames (`.casefile/chats/<id>.jsonl`) and IPC, so we
    keep them ASCII, lowercase, and limited to `[a-z0-9_-]`. Reserved and
    special-meaning names are rejected.

    Inputs that look like a path (contain a separator, NUL, or a traversal
    sequence) are rejected outright rather than sanitized — silently
    "cleaning" `../escape` into `escape` would make path-traversal mistakes
    invisible to callers.
    """
    if "/" in raw or "\\" in raw or "\x00" in raw or ".." in raw:
        raise ValueError(f"Invalid context id (contains path-like characters): {raw!r}")
    candidate = raw.strip().lower()
    candidate = re.sub(r"[^a-z0-9_-]+", "-", candidate).strip("-")
    if not candidate:
        raise ValueError("Context id is empty after normalization")
    if not _ID_RE.match(candidate):
        raise ValueError(f"Invalid context id after normalization: {candidate!r}")
    if candidate in {".", "..", "casefile"}:
        raise ValueError(f"Reserved context id: {candidate!r}")
    return candidate


def slug_from_name(name: str) -> str:
    """Generate a sensible default context id from a name."""
    return normalize_context_id(name or "context")


_ATTACHMENT_NAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]*$")


def normalize_attachment_name(raw: str) -> str:
    """Normalize an attachment name for use as a virtual path segment.

    Attachment names appear in tool responses as `_scope/<name>/...`,
    so they must not contain path separators. We allow mixed case here since
    the segment is purely informational (context ids carry the lowercase
    constraint, attachments do not).
    """
    candidate = raw.strip()
    if not candidate:
        raise ValueError("Attachment name is empty")
    if "/" in candidate or "\\" in candidate or "\x00" in candidate or ".." in candidate:
        raise ValueError(f"Invalid attachment name (path-like): {raw!r}")
    if not _ATTACHMENT_NAME_RE.match(candidate):
        raise ValueError(f"Invalid attachment name: {raw!r}")
    return candidate


class CasefileStore:
    """Filesystem-backed CRUD for a single casefile's `.casefile/` directory.

    This class deliberately knows about the on-disk layout. Higher-level
    orchestration (active context management, chat persistence policy, context
    resolution for ChatService) lives in `CasefileService`.
    """

    def __init__(self, casefile_root: Path) -> None:
        self.casefile = Casefile(root=Path(casefile_root).resolve())

    # ----- metadata directory -----

    def ensure_initialized(self) -> None:
        """Create `.casefile/` and a default `contexts.json` if absent.

        The default context points at the casefile root itself with id `main`,
        kind `repo`. This makes "open a directory as a casefile" work without
        requiring the user to register anything first.
        """
        meta = self.casefile.metadata_dir
        _ensure_private_dir(meta)
        _ensure_private_dir(self.casefile.chats_dir)
        if not self.casefile.contexts_file.exists():
            default_context = Context(
                id="main",
                session_id=_new_session_id(),
                name="Main",
                kind=DEFAULT_CONTEXT_KIND,
                root=self.casefile.root,
            )
            self._write_contexts_file([default_context], active_context_id="main")

    # ----- contexts.json -----

    def load_snapshot(self) -> CasefileSnapshot:
        """Load contexts + active context id. Auto-initializes if needed.

        Version 1 (M2/M3) files load without their parent/attachment fields;
        every context is treated as a top-level context with no attachments. The
        file is *not* rewritten just for being read — the upgrade happens on
        the next mutation, keeping `load_snapshot` side-effect free.
        """
        if not self.casefile.contexts_file.exists():
            self.ensure_initialized()
        raw = self._read_contexts_file()
        version = raw.get("version")
        # `bool` is a subclass of `int`; explicitly reject booleans so a
        # tampered `"version": true` cannot impersonate version 1.
        if not isinstance(version, int) or isinstance(version, bool) or version > CONTEXTS_FILE_VERSION:
            raise ContextsFileError(
                f"Unsupported contexts.json version: {version!r} (this build understands <= {CONTEXTS_FILE_VERSION})"
            )
        contexts_raw = raw.get("contexts")
        if not isinstance(contexts_raw, list):
            raise ContextsFileError("contexts.json: 'contexts' must be an array")
        contexts: list[Context] = []
        seen_ids: set[str] = set()
        for entry in contexts_raw:
            context = self._context_from_raw(entry, file_version=version)
            if context.id in seen_ids:
                raise ContextsFileError(f"Duplicate context id in contexts.json: {context.id!r}")
            seen_ids.add(context.id)
            contexts.append(context)
        # Drop dangling parent_ids rather than hard-failing — a parent could
        # be deleted out-of-band. The context still loads, just as a root.
        cleaned: list[Context] = []
        for context in contexts:
            if context.parent_id is not None and context.parent_id not in seen_ids:
                cleaned.append(
                    Context(
                        id=context.id,
                        session_id=context.session_id,
                        name=context.name,
                        kind=context.kind,
                        root=context.root,
                        parent_id=None,
                        attachments=context.attachments,
                        writable=context.writable,
                    )
                )
            else:
                cleaned.append(context)
        active = raw.get("active_context_id")
        active_context_id: str | None = None
        skipped_active_context_id: str | None = None
        if isinstance(active, str) and active in seen_ids:
            active_context_id = active
        else:
            # If the stored active id is a non-empty string but does not
            # correspond to any current context, surface it so the caller can
            # warn the user that the active selection was implicitly moved.
            if isinstance(active, str) and active.strip():
                skipped_active_context_id = active
            if cleaned:
                active_context_id = cleaned[0].id
        return CasefileSnapshot(
            casefile=self.casefile,
            contexts=tuple(cleaned),
            active_context_id=active_context_id,
            skipped_active_context_id=skipped_active_context_id,
        )

    def register_context(
        self,
        *,
        name: str,
        kind: str,
        root: Path,
        context_id: str | None = None,
        parent_id: str | None = None,
        attachments: Iterable[ContextAttachment] | None = None,
        writable: bool = True,
    ) -> CasefileSnapshot:
        """Add a new context and return the updated snapshot.

        `root` may be absolute or relative to the casefile root. Context roots
        outside the casefile are explicitly allowed (contexts are sibling
        directories in the documented model).

        `parent_id`, when provided, must refer to an existing context. Cycles
        cannot occur at registration (a brand-new context has no descendants),
        but the field is validated to exist so a bad UI never leaves an
        orphan parent reference on disk.

        `attachments` may include directories anywhere on disk. Names must
        be unique within a single context; the same directory may legitimately
        appear as an attachment on multiple contexts.
        """
        if type(writable) is not bool:
            raise TypeError("writable must be a boolean")
        snapshot = self.load_snapshot()
        existing_ids = {context.id for context in snapshot.contexts}
        candidate = normalize_context_id(context_id) if context_id else slug_from_name(name)
        final_id = self._unique_id(candidate, existing_ids)
        resolved_root = self._resolve_context_root(root)
        if not resolved_root.exists():
            raise FileNotFoundError(f"Context root does not exist: {resolved_root}")
        if not resolved_root.is_dir():
            raise NotADirectoryError(f"Context root is not a directory: {resolved_root}")
        resolved_parent: str | None = None
        if parent_id is not None and parent_id != "":
            if parent_id not in existing_ids:
                raise KeyError(f"Unknown parent_id: {parent_id!r}")
            resolved_parent = parent_id
        resolved_attachments = self._normalize_attachments(attachments)
        context = Context(
            id=final_id,
            session_id=_new_session_id(),
            name=name.strip() or final_id,
            kind=coerce_context_kind(kind),
            root=resolved_root,
            parent_id=resolved_parent,
            attachments=resolved_attachments,
            writable=writable,
        )
        new_contexts = list(snapshot.contexts) + [context]
        active = snapshot.active_context_id or context.id
        self._write_contexts_file(new_contexts, active_context_id=active)
        return self.load_snapshot()

    def update_context_attachments(
        self,
        context_id: str,
        attachments: Iterable[ContextAttachment],
    ) -> CasefileSnapshot:
        """Replace a context's attachment list. Used by the renderer-side editor."""
        snapshot = self.load_snapshot()
        target = snapshot.context_by_id(context_id)
        normalized = self._normalize_attachments(attachments)
        replaced = Context(
            id=target.id,
            session_id=target.session_id,
            name=target.name,
            kind=target.kind,
            root=target.root,
            parent_id=target.parent_id,
            attachments=normalized,
            writable=target.writable,
        )
        new_contexts = [replaced if context.id == context_id else context for context in snapshot.contexts]
        self._write_contexts_file(new_contexts, active_context_id=snapshot.active_context_id)
        return self.load_snapshot()

    def set_context_parent(self, context_id: str, parent_id: str | None) -> CasefileSnapshot:
        """Reparent an existing context, rejecting cycles."""
        snapshot = self.load_snapshot()
        target = snapshot.context_by_id(context_id)
        if parent_id is not None:
            if parent_id == context_id:
                raise ValueError("A context cannot be its own parent")
            # Walk the proposed parent's ancestor chain; if we see context_id
            # in there, we'd be creating a cycle.
            cursor: str | None = parent_id
            seen: set[str] = set()
            while cursor is not None:
                if cursor == context_id:
                    raise ValueError(
                        f"Cycle detected: cannot make {parent_id!r} the parent of {context_id!r}"
                    )
                if cursor in seen:
                    break
                seen.add(cursor)
                try:
                    cursor = snapshot.context_by_id(cursor).parent_id
                except KeyError:
                    raise KeyError(f"Unknown parent_id: {parent_id!r}") from None
        replaced = Context(
            id=target.id,
            session_id=target.session_id,
            name=target.name,
            kind=target.kind,
            root=target.root,
            parent_id=parent_id,
            attachments=target.attachments,
            writable=target.writable,
        )
        new_contexts = [replaced if context.id == context_id else context for context in snapshot.contexts]
        self._write_contexts_file(new_contexts, active_context_id=snapshot.active_context_id)
        return self.load_snapshot()

    def set_active_context(self, context_id: str) -> CasefileSnapshot:
        snapshot = self.load_snapshot()
        ids = {context.id for context in snapshot.contexts}
        if context_id not in ids:
            raise KeyError(f"Unknown context id: {context_id!r}")
        self._write_contexts_file(list(snapshot.contexts), active_context_id=context_id)
        return self.load_snapshot()

    def update_context(
        self,
        context_id: str,
        *,
        name: str | None = None,
        kind: str | None = None,
        root: Path | None = None,
        writable: bool | None = None,
    ) -> CasefileSnapshot:
        """Update a context's `name` / `kind` / `root` / `writable` in place.

        Each kwarg is independently optional: ``None`` means "leave the
        field unchanged". The context id, parent, and attachments are
        explicitly *not* editable here — the id is the filename stem for
        chats and renaming it would require migrating those
        files; parent + attachments have their own dedicated mutators
        from M3.5b.

        A new ``root`` is resolved (relative roots are anchored at the
        casefile root) and must point at an existing directory; the same
        validation as ``register_context``.
        """
        snapshot = self.load_snapshot()
        target = snapshot.context_by_id(context_id)
        if name is not None:
            cleaned = name.strip()
            if not cleaned:
                raise ValueError("Context name cannot be empty")
            new_name = cleaned
        else:
            new_name = target.name
        new_kind = coerce_context_kind(kind) if isinstance(kind, str) and kind else target.kind
        if root is not None:
            resolved = self._resolve_context_root(root)
            if not resolved.exists():
                raise FileNotFoundError(f"Context root does not exist: {resolved}")
            if not resolved.is_dir():
                raise NotADirectoryError(f"Context root is not a directory: {resolved}")
            new_root = resolved
        else:
            new_root = target.root
        if writable is not None and type(writable) is not bool:
            raise TypeError("writable must be a boolean")
        new_writable = target.writable if writable is None else writable
        replaced = Context(
            id=target.id,
            session_id=target.session_id,
            name=new_name,
            kind=new_kind,
            root=new_root,
            parent_id=target.parent_id,
            attachments=target.attachments,
            writable=new_writable,
        )
        new_contexts = [replaced if context.id == context_id else context for context in snapshot.contexts]
        self._write_contexts_file(new_contexts, active_context_id=snapshot.active_context_id)
        return self.load_snapshot()

    def remove_context(self, context_id: str) -> CasefileSnapshot:
        snapshot = self.load_snapshot()
        remaining = [context for context in snapshot.contexts if context.id != context_id]
        if len(remaining) == len(snapshot.contexts):
            raise KeyError(f"Unknown context id: {context_id!r}")
        # Re-parent any direct children to the deleted context's parent so we
        # never leave dangling references on disk. The context id is known to
        # exist (the `len(remaining) == len(snapshot.contexts)` guard above
        # would have raised otherwise), so a direct lookup is sufficient.
        deleted_parent = snapshot.context_by_id(context_id).parent_id
        re_parented: list[Context] = []
        for context in remaining:
            if context.parent_id == context_id:
                re_parented.append(
                    Context(
                        id=context.id,
                        session_id=context.session_id,
                        name=context.name,
                        kind=context.kind,
                        root=context.root,
                        parent_id=deleted_parent,
                        attachments=context.attachments,
                        writable=context.writable,
                    )
                )
            else:
                re_parented.append(context)
        new_active = snapshot.active_context_id
        if new_active == context_id:
            new_active = re_parented[0].id if re_parented else None
        self._write_contexts_file(re_parented, active_context_id=new_active)
        return self.load_snapshot()

    # ----- casefile-level reset -----

    def hard_reset(self) -> None:
        """Delete the entire ``.casefile/`` metadata directory.

        After a hard reset the casefile is indistinguishable from one
        that was never opened in DeskAssist. The next ``load_snapshot``
        / ``ensure_initialized`` call will recreate the metadata
        directory with a fresh default ``main`` context.

        Used by the ``casefile:hardReset`` bridge command for repeatable
        testing (M4.6). No backup is taken; callers that want one
        should snapshot the directory before invoking this.
        """
        meta = self.casefile.metadata_dir
        if meta.exists():
            shutil.rmtree(meta)

    def soft_reset(self) -> None:
        """Wipe per-task scratch but preserve durable casefile setup.

        Removes:

        * ``chats/`` (per-context and ``_compare__*`` logs).
        * ``contexts.json`` — re-initialized to the default single ``main``
          context via ``ensure_initialized`` after deletion.

        Preserves:

        * ``context.json`` (auto-include manifest).

        Idempotent: running this on a casefile that's already in the
        target state succeeds without error.
        """
        meta = self.casefile.metadata_dir
        for name in ("chats",):
            path = meta / name
            if path.exists():
                shutil.rmtree(path)
        # Drop contexts.json so ensure_initialized re-creates the default
        # `main` context. Writing an empty contexts file would leave the
        # casefile context-less, which the renderer can render but is
        # almost never what a "new task" reset wants.
        if self.casefile.contexts_file.exists():
            self.casefile.contexts_file.unlink()
        if self.casefile.comparisons_file.exists():
            self.casefile.comparisons_file.unlink()
        self.ensure_initialized()

    # ----- comparison session metadata -----

    def comparison_id(self, context_ids: Iterable[str]) -> str:
        ids = sorted({normalize_context_id(raw) for raw in context_ids})
        if len(ids) < 2:
            raise ValueError("Comparison requires at least two distinct context ids")
        return "_compare__" + "__".join(ids)

    def get_comparison_session(
        self, context_ids: Iterable[str]
    ) -> ComparisonSessionConfig:
        comparison_id = self.comparison_id(context_ids)
        sessions = self._read_comparisons_file()
        existing = sessions.get(comparison_id)
        if existing is not None:
            return existing
        ids = tuple(sorted({normalize_context_id(raw) for raw in context_ids}))
        return ComparisonSessionConfig(
            id=comparison_id,
            session_id=_new_session_id(),
            context_ids=ids,
        )

    def ensure_comparison_session(
        self, context_ids: Iterable[str]
    ) -> ComparisonSessionConfig:
        session = self.get_comparison_session(context_ids)
        sessions = self._read_comparisons_file()
        if session.id not in sessions:
            sessions[session.id] = session
            self._write_comparisons_file(sessions)
        return session

    def update_comparison_attachments(
        self, context_ids: Iterable[str], attachments: Iterable[ContextAttachment]
    ) -> ComparisonSessionConfig:
        session = self.get_comparison_session(context_ids)
        normalized = self._normalize_attachments(attachments)
        updated = ComparisonSessionConfig(
            id=session.id,
            session_id=session.session_id,
            context_ids=session.context_ids,
            attachments=normalized,
        )
        sessions = self._read_comparisons_file()
        sessions[updated.id] = updated
        self._write_comparisons_file(sessions)
        return updated

    # ----- chat history per context -----

    def chat_log_path(self, context_id: str) -> Path:
        # normalize_context_id is intentionally re-run as a defense-in-depth
        # check against any caller that bypasses register_context.
        safe = normalize_context_id(context_id)
        return self.casefile.chats_dir / f"{safe}.jsonl"

    def comparison_chat_log_path(self, context_ids: Iterable[str]) -> Path:
        """Return the on-disk log path for a comparison chat over ``context_ids``.

        Kept as the legacy structural path for migration fallback. New writes
        use the comparison session UUID via `_session_chat_log_path`.
        """
        return self.casefile.chats_dir / f"{self.comparison_id(context_ids)}.jsonl"

    def _session_chat_log_path(self, session_id: str) -> Path:
        safe = _normalize_session_id(session_id)
        return self.casefile.chats_dir / f"{safe}.jsonl"

    def append_comparison_chat_messages(
        self, context_ids: Iterable[str], messages: list[dict[str, Any]]
    ) -> Path:
        """Append messages to the comparison-session log; same caps as
        per-context appends so a runaway response can't bloat the log."""
        session = self.ensure_comparison_session(context_ids)
        path = self._session_chat_log_path(session.session_id)
        serialized: list[str] = []
        for message in messages:
            line = json.dumps(message, ensure_ascii=False)
            line_bytes = len(line.encode("utf-8"))
            if line_bytes > MAX_CHAT_LINE_BYTES:
                raise ValueError(
                    f"Comparison chat message exceeds maximum line size "
                    f"({line_bytes:,} bytes > {MAX_CHAT_LINE_BYTES:,} bytes)"
                )
            serialized.append(line)
        _append_private_lines(path, serialized)
        return path

    def read_comparison_chat_messages(
        self, context_ids: Iterable[str]
    ) -> tuple[list[dict[str, Any]], int]:
        """Read the comparison-session log; mirrors ``read_chat_messages``."""
        session = self.get_comparison_session(context_ids)
        path = self._session_chat_log_path(session.session_id)
        if not path.exists():
            legacy_path = self.comparison_chat_log_path(context_ids)
            if legacy_path.exists():
                path = legacy_path
        if not path.exists():
            return [], 0
        out: list[dict[str, Any]] = []
        skipped = 0
        with path.open("r", encoding="utf-8") as handle:
            for line_no, raw_line in enumerate(handle, start=1):
                line = raw_line.strip()
                if not line:
                    continue
                try:
                    parsed = json.loads(line)
                except json.JSONDecodeError as exc:
                    _logger.warning(
                        "Skipping corrupt line %d in comparison chat log %s: %s",
                        line_no,
                        path,
                        exc,
                    )
                    skipped += 1
                    continue
                if isinstance(parsed, dict):
                    out.append(parsed)
        return out, skipped

    def append_chat_messages(
        self, context_id: str, messages: list[dict[str, Any]]
    ) -> Path:
        context = self.load_snapshot().context_by_id(context_id)
        path = self._session_chat_log_path(context.session_id)
        # Validate every message before opening the file so that a size
        # violation on message N never leaves messages 0..N-1 partially
        # appended while the caller sees a ValueError.
        serialized: list[str] = []
        for message in messages:
            line = json.dumps(message, ensure_ascii=False)
            line_bytes = len(line.encode("utf-8"))
            if line_bytes > MAX_CHAT_LINE_BYTES:
                raise ValueError(
                    f"Chat message exceeds maximum line size "
                    f"({line_bytes:,} bytes > {MAX_CHAT_LINE_BYTES:,} bytes)"
                )
            serialized.append(line)
        _append_private_lines(path, serialized)
        return path

    def read_chat_messages(self, context_id: str) -> tuple[list[dict[str, Any]], int]:
        """Read chat messages from the context log.

        Returns ``(messages, skipped_count)`` where ``skipped_count`` is the
        number of corrupt lines that were skipped with a warning.  Callers
        should surface a non-zero count to the user so that slow log rot is
        not invisible.
        """
        context = self.load_snapshot().context_by_id(context_id)
        path = self._session_chat_log_path(context.session_id)
        if not path.exists():
            legacy_path = self.chat_log_path(context_id)
            if legacy_path.exists():
                path = legacy_path
        if not path.exists():
            return [], 0
        out: list[dict[str, Any]] = []
        skipped = 0
        with path.open("r", encoding="utf-8") as handle:
            for line_no, raw_line in enumerate(handle, start=1):
                line = raw_line.strip()
                if not line:
                    continue
                try:
                    parsed = json.loads(line)
                except json.JSONDecodeError as exc:
                    # Skip corrupt lines with a warning rather than aborting the
                    # whole chat history.  A single bad write (e.g. from a crash
                    # mid-append) should not make the entire log unreadable.
                    _logger.warning(
                        "Skipping corrupt line %d in chat log %s: %s",
                        line_no,
                        path,
                        exc,
                    )
                    skipped += 1
                    continue
                if isinstance(parsed, dict):
                    out.append(parsed)
        return out, skipped

    def clear_chat_messages(self, context_id: str) -> None:
        context = self.load_snapshot().context_by_id(context_id)
        for path in (self._session_chat_log_path(context.session_id), self.chat_log_path(context_id)):
            if path.exists():
                path.unlink()

    # ----- internals -----

    def _read_contexts_file(self) -> dict[str, Any]:
        try:
            text = self.casefile.contexts_file.read_text(encoding="utf-8")
        except OSError as exc:
            raise ContextsFileError(f"Cannot read {self.casefile.contexts_file}: {exc}") from exc
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            raise ContextsFileError(f"Malformed JSON in {self.casefile.contexts_file}: {exc}") from exc
        if not isinstance(data, dict):
            raise ContextsFileError("contexts.json must be a JSON object at the top level")
        return data

    def _read_comparisons_file(self) -> dict[str, ComparisonSessionConfig]:
        path = self.casefile.comparisons_file
        if not path.exists():
            return {}
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as exc:
            raise ContextsFileError(f"Cannot read {path}: {exc}") from exc
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            raise ContextsFileError(f"Malformed JSON in {path}: {exc}") from exc
        if not isinstance(data, dict):
            raise ContextsFileError("comparisons.json must be a JSON object at the top level")
        version = data.get("version")
        if version != COMPARISONS_FILE_VERSION:
            raise ContextsFileError(
                f"Unsupported comparisons.json version: {version!r} "
                f"(this build understands {COMPARISONS_FILE_VERSION})"
            )
        raw_sessions = data.get("sessions", [])
        if not isinstance(raw_sessions, list):
            raise ContextsFileError("comparisons.json: 'sessions' must be an array")
        out: dict[str, ComparisonSessionConfig] = {}
        for item in raw_sessions:
            if not isinstance(item, dict):
                continue
            raw_id = item.get("id")
            raw_context_ids = item.get("context_ids")
            if not isinstance(raw_id, str) or not isinstance(raw_context_ids, list):
                continue
            try:
                context_ids = tuple(sorted({normalize_context_id(raw) for raw in raw_context_ids}))
            except ValueError:
                continue
            if len(context_ids) < 2:
                continue
            comparison_id = self.comparison_id(context_ids)
            if raw_id != comparison_id:
                continue
            raw_attachments = item.get("attachments", [])
            if not isinstance(raw_attachments, list):
                raw_attachments = []
            parsed_attachments: list[ContextAttachment] = []
            for raw_att in raw_attachments:
                if not isinstance(raw_att, dict):
                    continue
                att_name = raw_att.get("name")
                att_root = raw_att.get("root")
                if not isinstance(att_name, str) or not isinstance(att_root, str):
                    continue
                try:
                    normalized_name = normalize_attachment_name(att_name)
                except ValueError:
                    continue
                try:
                    mode = coerce_attachment_mode(raw_att.get("mode"))
                except ValueError:
                    # Malformed access metadata must not fail open to writable.
                    continue
                parsed_attachments.append(
                    ContextAttachment(
                        name=normalized_name,
                        root=self._resolve_context_root(Path(att_root)),
                        mode=mode,
                    )
                )
            out[comparison_id] = ComparisonSessionConfig(
                id=comparison_id,
                session_id=_coerce_session_id(
                    item.get("session_id"),
                    kind="comparison",
                    root=self.casefile.root,
                    identifier=comparison_id,
                ),
                context_ids=context_ids,
                attachments=tuple(parsed_attachments),
            )
        return out

    def _write_comparisons_file(
        self, sessions: dict[str, ComparisonSessionConfig]
    ) -> None:
        payload = {
            "version": COMPARISONS_FILE_VERSION,
            "sessions": [
                {
                    "id": session.id,
                    "session_id": session.session_id,
                    "context_ids": list(session.context_ids),
                    "attachments": [
                        self._serialize_attachment(attachment)
                        for attachment in session.attachments
                    ],
                }
                for session in sorted(sessions.values(), key=lambda entry: entry.id)
            ],
        }
        _write_private_text(
            self.casefile.comparisons_file,
            json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
        )

    def _serialize_attachment(self, attachment: ContextAttachment) -> dict[str, Any]:
        try:
            rel = attachment.root.relative_to(self.casefile.root)
            root_repr = rel.as_posix() or "."
        except ValueError:
            root_repr = str(attachment.root)
        result: dict[str, Any] = {
            "name": attachment.name,
            "root": root_repr,
        }
        # Only write mode when it differs from the default to keep JSON minimal.
        if attachment.mode != DEFAULT_ATTACHMENT_MODE:
            result["mode"] = attachment.mode
        return result

    def _write_contexts_file(self, contexts: list[Context], active_context_id: str | None) -> None:
        # Context roots are written *relative to the casefile root* whenever they
        # live inside the casefile, and as absolute paths otherwise. This keeps
        # casefiles portable when moved together with their in-tree contexts.
        serialized_contexts: list[dict[str, Any]] = []
        for context in contexts:
            try:
                rel = context.root.relative_to(self.casefile.root)
                root_repr = rel.as_posix() or "."
            except ValueError:
                root_repr = str(context.root)
            entry: dict[str, Any] = {
                "id": context.id,
                "session_id": context.session_id,
                "name": context.name,
                "kind": context.kind,
                "root": root_repr,
                "parent_id": context.parent_id,
                "attachments": [self._serialize_attachment(a) for a in context.attachments],
            }
            # Only write `writable` when it differs from the default (True)
            # to keep existing context files forward-compatible.
            if not context.writable:
                entry["writable"] = False
            serialized_contexts.append(entry)
        payload = {
            "version": CONTEXTS_FILE_VERSION,
            "contexts": serialized_contexts,
            "active_context_id": active_context_id,
        }
        # Atomic-ish write: write to a temp file then rename.
        _write_private_text(
            self.casefile.contexts_file,
            json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
        )

    def _context_from_raw(self, entry: object, *, file_version: int) -> Context:
        if not isinstance(entry, dict):
            raise ContextsFileError(f"Context entry must be an object, got {type(entry).__name__}")
        raw_id = entry.get("id")
        if not isinstance(raw_id, str):
            raise ContextsFileError("Context entry missing string 'id'")
        try:
            context_id = normalize_context_id(raw_id)
        except ValueError as exc:
            raise ContextsFileError(str(exc)) from exc
        session_id = _coerce_session_id(
            entry.get("session_id"),
            kind="context",
            root=self.casefile.root,
            identifier=context_id,
        )
        raw_name = entry.get("name")
        name = raw_name.strip() if isinstance(raw_name, str) and raw_name.strip() else context_id
        kind = coerce_context_kind(entry.get("kind"))
        raw_root = entry.get("root")
        if not isinstance(raw_root, str):
            raise ContextsFileError(f"Context {context_id!r} missing string 'root'")
        resolved_root = self._resolve_context_root(Path(raw_root))
        # parent_id and attachments only exist in v2+. Loading a v1 file
        # silently treats every context as a root with no attachments.
        parent_id: str | None = None
        attachments: tuple[ContextAttachment, ...] = ()
        if file_version >= 2:
            raw_parent = entry.get("parent_id")
            if isinstance(raw_parent, str) and raw_parent.strip():
                # Re-normalize so a hand-edited file with mixed case still loads.
                try:
                    parent_id = normalize_context_id(raw_parent)
                except ValueError:
                    parent_id = None
            raw_attachments = entry.get("attachments", [])
            if isinstance(raw_attachments, list):
                parsed: list[ContextAttachment] = []
                for raw_att in raw_attachments:
                    if not isinstance(raw_att, dict):
                        continue
                    att_name = raw_att.get("name")
                    att_root = raw_att.get("root")
                    if not isinstance(att_name, str) or not isinstance(att_root, str):
                        continue
                    try:
                        normalized_name = normalize_attachment_name(att_name)
                    except ValueError:
                        # Skip the bad attachment rather than failing the whole load.
                        continue
                    try:
                        mode = coerce_attachment_mode(raw_att.get("mode"))
                    except ValueError:
                        # Skip malformed attachment metadata rather than
                        # silently granting write access.
                        continue
                    parsed.append(
                        ContextAttachment(
                            name=normalized_name,
                            root=self._resolve_context_root(Path(att_root)),
                            mode=mode,
                        )
                    )
                attachments = tuple(parsed)
        raw_writable = entry.get("writable", True)
        writable = raw_writable if type(raw_writable) is bool else False
        return Context(
            id=context_id,
            session_id=session_id,
            name=name,
            kind=kind,
            root=resolved_root,
            parent_id=parent_id,
            attachments=attachments,
            writable=writable,
        )

    def resolve_context_root(self, root: Path) -> Path:
        """Resolve `root` against the casefile root.

        Absolute paths are resolved as-is; relative paths are anchored at
        the casefile root. This is the public counterpart to the internal
        helper used during context registration / update.
        """
        if root.is_absolute():
            return root.resolve()
        return (self.casefile.root / root).resolve()

    # Internal alias preserved for backward compatibility with call sites
    # that already reach in by the underscored name. New callers should
    # use `resolve_context_root`.
    _resolve_context_root = resolve_context_root

    def _normalize_attachments(
        self, attachments: Iterable[ContextAttachment] | None
    ) -> tuple[ContextAttachment, ...]:
        if attachments is None:
            return ()
        seen: set[str] = set()
        out: list[ContextAttachment] = []
        for attachment in attachments:
            normalized_name = normalize_attachment_name(attachment.name)
            if normalized_name in seen:
                raise ValueError(f"Duplicate attachment name on context: {normalized_name!r}")
            seen.add(normalized_name)
            resolved = self._resolve_context_root(attachment.root)
            if not resolved.exists():
                raise FileNotFoundError(f"Attachment root does not exist: {resolved}")
            if not resolved.is_dir():
                raise NotADirectoryError(f"Attachment root is not a directory: {resolved}")
            mode = coerce_attachment_mode(attachment.mode)
            out.append(
                ContextAttachment(
                    name=normalized_name,
                    root=resolved,
                    mode=mode,
                )
            )
        return tuple(out)

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
