from __future__ import annotations

import json
import logging
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
    DEFAULT_LANE_KIND,
    Lane,
    LaneAttachment,
    coerce_attachment_mode,
    coerce_lane_kind,
)

# Bumped from 1 to 2 in M3.5 when lanes gained `parent_id` and `attachments`.
# Version 1 files are still loadable: missing fields default to "no parent,
# no attachments" and the file is rewritten as version 2 on first mutation.
LANES_FILE_VERSION = 2

# Maximum size for a single serialised chat message line.  An LLM response
# with embedded tool results can be large, but 1 MB per line is already
# generous.  Anything larger almost certainly indicates runaway content.
MAX_CHAT_LINE_BYTES: int = 1 * 1024 * 1024  # 1 MB
COMPARISONS_FILE_VERSION = 1

_logger = logging.getLogger(__name__)


class LanesFileError(ValueError):
    """Raised when `lanes.json` is malformed in a way the loader cannot recover from."""


_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")


def _new_session_id() -> str:
    return str(uuid.uuid4())


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


def normalize_lane_id(raw: str) -> str:
    """Normalize a free-form lane id to the on-disk shape.

    Lane ids appear in filenames (`.casefile/chats/<id>.jsonl`) and IPC, so we
    keep them ASCII, lowercase, and limited to `[a-z0-9_-]`. Reserved and
    special-meaning names are rejected.

    Inputs that look like a path (contain a separator, NUL, or a traversal
    sequence) are rejected outright rather than sanitized — silently
    "cleaning" `../escape` into `escape` would make path-traversal mistakes
    invisible to callers.
    """
    if "/" in raw or "\\" in raw or "\x00" in raw or ".." in raw:
        raise ValueError(f"Invalid lane id (contains path-like characters): {raw!r}")
    candidate = raw.strip().lower()
    candidate = re.sub(r"[^a-z0-9_-]+", "-", candidate).strip("-")
    if not candidate:
        raise ValueError("Lane id is empty after normalization")
    if not _ID_RE.match(candidate):
        raise ValueError(f"Invalid lane id after normalization: {candidate!r}")
    if candidate in {".", "..", "casefile"}:
        raise ValueError(f"Reserved lane id: {candidate!r}")
    return candidate


def slug_from_name(name: str) -> str:
    """Generate a sensible default lane id from a name."""
    return normalize_lane_id(name or "lane")


_ATTACHMENT_NAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]*$")


def normalize_attachment_name(raw: str) -> str:
    """Normalize an attachment name for use as a virtual path segment.

    Attachment names appear in tool responses as `_attachments/<name>/...`,
    so they must not contain path separators. We allow mixed case here since
    the segment is purely informational (lane ids carry the lowercase
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
    orchestration (active lane management, chat persistence policy, lane
    resolution for ChatService) lives in `CasefileService`.
    """

    def __init__(self, casefile_root: Path) -> None:
        self.casefile = Casefile(root=Path(casefile_root).resolve())

    # ----- metadata directory -----

    def ensure_initialized(self) -> None:
        """Create `.casefile/` and a default `lanes.json` if absent.

        The default lane points at the casefile root itself with id `main`,
        kind `repo`. This makes "open a directory as a casefile" work without
        requiring the user to register anything first.
        """
        meta = self.casefile.metadata_dir
        meta.mkdir(parents=True, exist_ok=True)
        self.casefile.chats_dir.mkdir(parents=True, exist_ok=True)
        if not self.casefile.lanes_file.exists():
            default_lane = Lane(
                id="main",
                session_id=_new_session_id(),
                name="Main",
                kind=DEFAULT_LANE_KIND,
                root=self.casefile.root,
            )
            self._write_lanes_file([default_lane], active_lane_id="main")

    # ----- lanes.json -----

    def load_snapshot(self) -> CasefileSnapshot:
        """Load lanes + active lane id. Auto-initializes if needed.

        Version 1 (M2/M3) files load without their parent/attachment fields;
        every lane is treated as a top-level lane with no attachments. The
        file is *not* rewritten just for being read — the upgrade happens on
        the next mutation, keeping `load_snapshot` side-effect free.
        """
        if not self.casefile.lanes_file.exists():
            self.ensure_initialized()
        raw = self._read_lanes_file()
        version = raw.get("version")
        # `bool` is a subclass of `int`; explicitly reject booleans so a
        # tampered `"version": true` cannot impersonate version 1.
        if not isinstance(version, int) or isinstance(version, bool) or version > LANES_FILE_VERSION:
            raise LanesFileError(
                f"Unsupported lanes.json version: {version!r} (this build understands <= {LANES_FILE_VERSION})"
            )
        lanes_raw = raw.get("lanes")
        if not isinstance(lanes_raw, list):
            raise LanesFileError("lanes.json: 'lanes' must be an array")
        lanes: list[Lane] = []
        seen_ids: set[str] = set()
        for entry in lanes_raw:
            lane = self._lane_from_raw(entry, file_version=version)
            if lane.id in seen_ids:
                raise LanesFileError(f"Duplicate lane id in lanes.json: {lane.id!r}")
            seen_ids.add(lane.id)
            lanes.append(lane)
        # Drop dangling parent_ids rather than hard-failing — a parent could
        # be deleted out-of-band. The lane still loads, just as a root.
        cleaned: list[Lane] = []
        for lane in lanes:
            if lane.parent_id is not None and lane.parent_id not in seen_ids:
                cleaned.append(
                    Lane(
                        id=lane.id,
                        session_id=lane.session_id,
                        name=lane.name,
                        kind=lane.kind,
                        root=lane.root,
                        parent_id=None,
                        attachments=lane.attachments,
                        writable=lane.writable,
                    )
                )
            else:
                cleaned.append(lane)
        active = raw.get("active_lane_id")
        active_lane_id: str | None = None
        skipped_active_lane_id: str | None = None
        if isinstance(active, str) and active in seen_ids:
            active_lane_id = active
        else:
            # If the stored active id is a non-empty string but does not
            # correspond to any current lane, surface it so the caller can
            # warn the user that the active selection was implicitly moved.
            if isinstance(active, str) and active.strip():
                skipped_active_lane_id = active
            if cleaned:
                active_lane_id = cleaned[0].id
        return CasefileSnapshot(
            casefile=self.casefile,
            lanes=tuple(cleaned),
            active_lane_id=active_lane_id,
            skipped_active_lane_id=skipped_active_lane_id,
        )

    def register_lane(
        self,
        *,
        name: str,
        kind: str,
        root: Path,
        lane_id: str | None = None,
        parent_id: str | None = None,
        attachments: Iterable[LaneAttachment] | None = None,
        writable: bool = True,
    ) -> CasefileSnapshot:
        """Add a new lane and return the updated snapshot.

        `root` may be absolute or relative to the casefile root. Lane roots
        outside the casefile are explicitly allowed (lanes are sibling
        directories in the documented model).

        `parent_id`, when provided, must refer to an existing lane. Cycles
        cannot occur at registration (a brand-new lane has no descendants),
        but the field is validated to exist so a bad UI never leaves an
        orphan parent reference on disk.

        `attachments` may include directories anywhere on disk. Names must
        be unique within a single lane; the same directory may legitimately
        appear as an attachment on multiple lanes.
        """
        if type(writable) is not bool:
            raise TypeError("writable must be a boolean")
        snapshot = self.load_snapshot()
        existing_ids = {lane.id for lane in snapshot.lanes}
        candidate = normalize_lane_id(lane_id) if lane_id else slug_from_name(name)
        final_id = self._unique_id(candidate, existing_ids)
        resolved_root = self._resolve_lane_root(root)
        if not resolved_root.exists():
            raise FileNotFoundError(f"Lane root does not exist: {resolved_root}")
        if not resolved_root.is_dir():
            raise NotADirectoryError(f"Lane root is not a directory: {resolved_root}")
        resolved_parent: str | None = None
        if parent_id is not None and parent_id != "":
            if parent_id not in existing_ids:
                raise KeyError(f"Unknown parent_id: {parent_id!r}")
            resolved_parent = parent_id
        resolved_attachments = self._normalize_attachments(attachments)
        lane = Lane(
            id=final_id,
            session_id=_new_session_id(),
            name=name.strip() or final_id,
            kind=coerce_lane_kind(kind),
            root=resolved_root,
            parent_id=resolved_parent,
            attachments=resolved_attachments,
            writable=writable,
        )
        new_lanes = list(snapshot.lanes) + [lane]
        active = snapshot.active_lane_id or lane.id
        self._write_lanes_file(new_lanes, active_lane_id=active)
        return self.load_snapshot()

    def update_lane_attachments(
        self,
        lane_id: str,
        attachments: Iterable[LaneAttachment],
    ) -> CasefileSnapshot:
        """Replace a lane's attachment list. Used by the renderer-side editor."""
        snapshot = self.load_snapshot()
        target = snapshot.lane_by_id(lane_id)
        normalized = self._normalize_attachments(attachments)
        replaced = Lane(
            id=target.id,
            session_id=target.session_id,
            name=target.name,
            kind=target.kind,
            root=target.root,
            parent_id=target.parent_id,
            attachments=normalized,
            writable=target.writable,
        )
        new_lanes = [replaced if lane.id == lane_id else lane for lane in snapshot.lanes]
        self._write_lanes_file(new_lanes, active_lane_id=snapshot.active_lane_id)
        return self.load_snapshot()

    def set_lane_parent(self, lane_id: str, parent_id: str | None) -> CasefileSnapshot:
        """Reparent an existing lane, rejecting cycles."""
        snapshot = self.load_snapshot()
        target = snapshot.lane_by_id(lane_id)
        if parent_id is not None:
            if parent_id == lane_id:
                raise ValueError("A lane cannot be its own parent")
            # Walk the proposed parent's ancestor chain; if we see lane_id
            # in there, we'd be creating a cycle.
            cursor: str | None = parent_id
            seen: set[str] = set()
            while cursor is not None:
                if cursor == lane_id:
                    raise ValueError(
                        f"Cycle detected: cannot make {parent_id!r} the parent of {lane_id!r}"
                    )
                if cursor in seen:
                    break
                seen.add(cursor)
                try:
                    cursor = snapshot.lane_by_id(cursor).parent_id
                except KeyError:
                    raise KeyError(f"Unknown parent_id: {parent_id!r}") from None
        replaced = Lane(
            id=target.id,
            session_id=target.session_id,
            name=target.name,
            kind=target.kind,
            root=target.root,
            parent_id=parent_id,
            attachments=target.attachments,
            writable=target.writable,
        )
        new_lanes = [replaced if lane.id == lane_id else lane for lane in snapshot.lanes]
        self._write_lanes_file(new_lanes, active_lane_id=snapshot.active_lane_id)
        return self.load_snapshot()

    def set_active_lane(self, lane_id: str) -> CasefileSnapshot:
        snapshot = self.load_snapshot()
        ids = {lane.id for lane in snapshot.lanes}
        if lane_id not in ids:
            raise KeyError(f"Unknown lane id: {lane_id!r}")
        self._write_lanes_file(list(snapshot.lanes), active_lane_id=lane_id)
        return self.load_snapshot()

    def update_lane(
        self,
        lane_id: str,
        *,
        name: str | None = None,
        kind: str | None = None,
        root: Path | None = None,
        writable: bool | None = None,
    ) -> CasefileSnapshot:
        """Update a lane's `name` / `kind` / `root` / `writable` in place.

        Each kwarg is independently optional: ``None`` means "leave the
        field unchanged". The lane id, parent, and attachments are
        explicitly *not* editable here — the id is the filename stem for
        chats and renaming it would require migrating those
        files; parent + attachments have their own dedicated mutators
        from M3.5b.

        A new ``root`` is resolved (relative roots are anchored at the
        casefile root) and must point at an existing directory; the same
        validation as ``register_lane``.
        """
        snapshot = self.load_snapshot()
        target = snapshot.lane_by_id(lane_id)
        if name is not None:
            cleaned = name.strip()
            if not cleaned:
                raise ValueError("Lane name cannot be empty")
            new_name = cleaned
        else:
            new_name = target.name
        new_kind = coerce_lane_kind(kind) if isinstance(kind, str) and kind else target.kind
        if root is not None:
            resolved = self._resolve_lane_root(root)
            if not resolved.exists():
                raise FileNotFoundError(f"Lane root does not exist: {resolved}")
            if not resolved.is_dir():
                raise NotADirectoryError(f"Lane root is not a directory: {resolved}")
            new_root = resolved
        else:
            new_root = target.root
        if writable is not None and type(writable) is not bool:
            raise TypeError("writable must be a boolean")
        new_writable = target.writable if writable is None else writable
        replaced = Lane(
            id=target.id,
            session_id=target.session_id,
            name=new_name,
            kind=new_kind,
            root=new_root,
            parent_id=target.parent_id,
            attachments=target.attachments,
            writable=new_writable,
        )
        new_lanes = [replaced if lane.id == lane_id else lane for lane in snapshot.lanes]
        self._write_lanes_file(new_lanes, active_lane_id=snapshot.active_lane_id)
        return self.load_snapshot()

    def remove_lane(self, lane_id: str) -> CasefileSnapshot:
        snapshot = self.load_snapshot()
        remaining = [lane for lane in snapshot.lanes if lane.id != lane_id]
        if len(remaining) == len(snapshot.lanes):
            raise KeyError(f"Unknown lane id: {lane_id!r}")
        # Re-parent any direct children to the deleted lane's parent so we
        # never leave dangling references on disk. The lane id is known to
        # exist (the `len(remaining) == len(snapshot.lanes)` guard above
        # would have raised otherwise), so a direct lookup is sufficient.
        deleted_parent = snapshot.lane_by_id(lane_id).parent_id
        re_parented: list[Lane] = []
        for lane in remaining:
            if lane.parent_id == lane_id:
                re_parented.append(
                    Lane(
                        id=lane.id,
                        session_id=lane.session_id,
                        name=lane.name,
                        kind=lane.kind,
                        root=lane.root,
                        parent_id=deleted_parent,
                        attachments=lane.attachments,
                        writable=lane.writable,
                    )
                )
            else:
                re_parented.append(lane)
        new_active = snapshot.active_lane_id
        if new_active == lane_id:
            new_active = re_parented[0].id if re_parented else None
        self._write_lanes_file(re_parented, active_lane_id=new_active)
        return self.load_snapshot()

    # ----- casefile-level reset -----

    def hard_reset(self) -> None:
        """Delete the entire ``.casefile/`` metadata directory.

        After a hard reset the casefile is indistinguishable from one
        that was never opened in DeskAssist. The next ``load_snapshot``
        / ``ensure_initialized`` call will recreate the metadata
        directory with a fresh default ``main`` lane.

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

        * ``chats/`` (per-lane and ``_compare__*`` logs).
        * ``lanes.json`` — re-initialized to the default single ``main``
          lane via ``ensure_initialized`` after deletion.
        * Legacy ``notes/`` and ``prompts/`` directories if present.

        Preserves:

        * ``context.json`` (auto-include manifest).

        Idempotent: running this on a casefile that's already in the
        target state succeeds without error.
        """
        meta = self.casefile.metadata_dir
        for name in ("chats", "notes", "prompts"):
            path = meta / name
            if path.exists():
                shutil.rmtree(path)
        # Drop lanes.json so ensure_initialized re-creates the default
        # `main` lane. Writing an empty lanes file would leave the
        # casefile lane-less, which the renderer can render but is
        # almost never what a "new task" reset wants.
        if self.casefile.lanes_file.exists():
            self.casefile.lanes_file.unlink()
        if self.casefile.comparisons_file.exists():
            self.casefile.comparisons_file.unlink()
        self.ensure_initialized()

    # ----- comparison session metadata -----

    def comparison_id(self, lane_ids: Iterable[str]) -> str:
        ids = sorted({normalize_lane_id(raw) for raw in lane_ids})
        if len(ids) < 2:
            raise ValueError("Comparison requires at least two distinct lane ids")
        return "_compare__" + "__".join(ids)

    def get_comparison_session(
        self, lane_ids: Iterable[str]
    ) -> ComparisonSessionConfig:
        comparison_id = self.comparison_id(lane_ids)
        sessions = self._read_comparisons_file()
        existing = sessions.get(comparison_id)
        if existing is not None:
            return existing
        ids = tuple(sorted({normalize_lane_id(raw) for raw in lane_ids}))
        return ComparisonSessionConfig(
            id=comparison_id,
            session_id=_new_session_id(),
            lane_ids=ids,
        )

    def ensure_comparison_session(
        self, lane_ids: Iterable[str]
    ) -> ComparisonSessionConfig:
        session = self.get_comparison_session(lane_ids)
        sessions = self._read_comparisons_file()
        if session.id not in sessions:
            sessions[session.id] = session
            self._write_comparisons_file(sessions)
        return session

    def update_comparison_attachments(
        self, lane_ids: Iterable[str], attachments: Iterable[LaneAttachment]
    ) -> ComparisonSessionConfig:
        session = self.get_comparison_session(lane_ids)
        normalized = self._normalize_attachments(attachments)
        updated = ComparisonSessionConfig(
            id=session.id,
            session_id=session.session_id,
            lane_ids=session.lane_ids,
            attachments=normalized,
        )
        sessions = self._read_comparisons_file()
        sessions[updated.id] = updated
        self._write_comparisons_file(sessions)
        return updated

    # ----- chat history per lane -----

    def chat_log_path(self, lane_id: str) -> Path:
        # normalize_lane_id is intentionally re-run as a defense-in-depth
        # check against any caller that bypasses register_lane.
        safe = normalize_lane_id(lane_id)
        return self.casefile.chats_dir / f"{safe}.jsonl"

    def comparison_chat_log_path(self, lane_ids: Iterable[str]) -> Path:
        """Return the on-disk log path for a comparison chat over ``lane_ids``.

        Kept as the legacy structural path for migration fallback. New writes
        use the comparison session UUID via `_session_chat_log_path`.
        """
        return self.casefile.chats_dir / f"{self.comparison_id(lane_ids)}.jsonl"

    def _session_chat_log_path(self, session_id: str) -> Path:
        safe = _normalize_session_id(session_id)
        return self.casefile.chats_dir / f"{safe}.jsonl"

    def append_comparison_chat_messages(
        self, lane_ids: Iterable[str], messages: list[dict[str, Any]]
    ) -> Path:
        """Append messages to the comparison-session log; same caps as
        per-lane appends so a runaway response can't bloat the log."""
        session = self.ensure_comparison_session(lane_ids)
        path = self._session_chat_log_path(session.session_id)
        path.parent.mkdir(parents=True, exist_ok=True)
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
        with path.open("a", encoding="utf-8") as handle:
            for line in serialized:
                handle.write(line)
                handle.write("\n")
        return path

    def read_comparison_chat_messages(
        self, lane_ids: Iterable[str]
    ) -> tuple[list[dict[str, Any]], int]:
        """Read the comparison-session log; mirrors ``read_chat_messages``."""
        session = self.get_comparison_session(lane_ids)
        path = self._session_chat_log_path(session.session_id)
        if not path.exists():
            legacy_path = self.comparison_chat_log_path(lane_ids)
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
        self, lane_id: str, messages: list[dict[str, Any]]
    ) -> Path:
        lane = self.load_snapshot().lane_by_id(lane_id)
        path = self._session_chat_log_path(lane.session_id)
        path.parent.mkdir(parents=True, exist_ok=True)
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
        with path.open("a", encoding="utf-8") as handle:
            for line in serialized:
                handle.write(line)
                handle.write("\n")
        return path

    def read_chat_messages(self, lane_id: str) -> tuple[list[dict[str, Any]], int]:
        """Read chat messages from the lane log.

        Returns ``(messages, skipped_count)`` where ``skipped_count`` is the
        number of corrupt lines that were skipped with a warning.  Callers
        should surface a non-zero count to the user so that slow log rot is
        not invisible.
        """
        lane = self.load_snapshot().lane_by_id(lane_id)
        path = self._session_chat_log_path(lane.session_id)
        if not path.exists():
            legacy_path = self.chat_log_path(lane_id)
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

    def clear_chat_messages(self, lane_id: str) -> None:
        lane = self.load_snapshot().lane_by_id(lane_id)
        for path in (self._session_chat_log_path(lane.session_id), self.chat_log_path(lane_id)):
            if path.exists():
                path.unlink()

    # ----- internals -----

    def _read_lanes_file(self) -> dict[str, Any]:
        try:
            text = self.casefile.lanes_file.read_text(encoding="utf-8")
        except OSError as exc:
            raise LanesFileError(f"Cannot read {self.casefile.lanes_file}: {exc}") from exc
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            raise LanesFileError(f"Malformed JSON in {self.casefile.lanes_file}: {exc}") from exc
        if not isinstance(data, dict):
            raise LanesFileError("lanes.json must be a JSON object at the top level")
        return data

    def _read_comparisons_file(self) -> dict[str, ComparisonSessionConfig]:
        path = self.casefile.comparisons_file
        if not path.exists():
            return {}
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as exc:
            raise LanesFileError(f"Cannot read {path}: {exc}") from exc
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            raise LanesFileError(f"Malformed JSON in {path}: {exc}") from exc
        if not isinstance(data, dict):
            raise LanesFileError("comparisons.json must be a JSON object at the top level")
        version = data.get("version")
        if version != COMPARISONS_FILE_VERSION:
            raise LanesFileError(
                f"Unsupported comparisons.json version: {version!r} "
                f"(this build understands {COMPARISONS_FILE_VERSION})"
            )
        raw_sessions = data.get("sessions", [])
        if not isinstance(raw_sessions, list):
            raise LanesFileError("comparisons.json: 'sessions' must be an array")
        out: dict[str, ComparisonSessionConfig] = {}
        for item in raw_sessions:
            if not isinstance(item, dict):
                continue
            raw_id = item.get("id")
            raw_lane_ids = item.get("lane_ids")
            if not isinstance(raw_id, str) or not isinstance(raw_lane_ids, list):
                continue
            try:
                lane_ids = tuple(sorted({normalize_lane_id(raw) for raw in raw_lane_ids}))
            except ValueError:
                continue
            if len(lane_ids) < 2:
                continue
            comparison_id = self.comparison_id(lane_ids)
            if raw_id != comparison_id:
                continue
            raw_attachments = item.get("attachments", [])
            if not isinstance(raw_attachments, list):
                raw_attachments = []
            parsed_attachments: list[LaneAttachment] = []
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
                    LaneAttachment(
                        name=normalized_name,
                        root=self._resolve_lane_root(Path(att_root)),
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
                lane_ids=lane_ids,
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
                    "lane_ids": list(session.lane_ids),
                    "attachments": [
                        self._serialize_attachment(attachment)
                        for attachment in session.attachments
                    ],
                }
                for session in sorted(sessions.values(), key=lambda entry: entry.id)
            ],
        }
        meta = self.casefile.metadata_dir
        meta.mkdir(parents=True, exist_ok=True)
        tmp = self.casefile.comparisons_file.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        tmp.replace(self.casefile.comparisons_file)

    def _serialize_attachment(self, attachment: LaneAttachment) -> dict[str, Any]:
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

    def _write_lanes_file(self, lanes: list[Lane], active_lane_id: str | None) -> None:
        # Lane roots are written *relative to the casefile root* whenever they
        # live inside the casefile, and as absolute paths otherwise. This keeps
        # casefiles portable when moved together with their in-tree lanes.
        serialized_lanes: list[dict[str, Any]] = []
        for lane in lanes:
            try:
                rel = lane.root.relative_to(self.casefile.root)
                root_repr = rel.as_posix() or "."
            except ValueError:
                root_repr = str(lane.root)
            entry: dict[str, Any] = {
                "id": lane.id,
                "session_id": lane.session_id,
                "name": lane.name,
                "kind": lane.kind,
                "root": root_repr,
                "parent_id": lane.parent_id,
                "attachments": [self._serialize_attachment(a) for a in lane.attachments],
            }
            # Only write `writable` when it differs from the default (True)
            # to keep existing lane files forward-compatible.
            if not lane.writable:
                entry["writable"] = False
            serialized_lanes.append(entry)
        payload = {
            "version": LANES_FILE_VERSION,
            "lanes": serialized_lanes,
            "active_lane_id": active_lane_id,
        }
        meta = self.casefile.metadata_dir
        meta.mkdir(parents=True, exist_ok=True)
        # Atomic-ish write: write to a temp file then rename.
        tmp = self.casefile.lanes_file.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        tmp.replace(self.casefile.lanes_file)

    def _lane_from_raw(self, entry: object, *, file_version: int) -> Lane:
        if not isinstance(entry, dict):
            raise LanesFileError(f"Lane entry must be an object, got {type(entry).__name__}")
        raw_id = entry.get("id")
        if not isinstance(raw_id, str):
            raise LanesFileError("Lane entry missing string 'id'")
        try:
            lane_id = normalize_lane_id(raw_id)
        except ValueError as exc:
            raise LanesFileError(str(exc)) from exc
        session_id = _coerce_session_id(
            entry.get("session_id"),
            kind="lane",
            root=self.casefile.root,
            identifier=lane_id,
        )
        raw_name = entry.get("name")
        name = raw_name.strip() if isinstance(raw_name, str) and raw_name.strip() else lane_id
        kind = coerce_lane_kind(entry.get("kind"))
        raw_root = entry.get("root")
        if not isinstance(raw_root, str):
            raise LanesFileError(f"Lane {lane_id!r} missing string 'root'")
        resolved_root = self._resolve_lane_root(Path(raw_root))
        # parent_id and attachments only exist in v2+. Loading a v1 file
        # silently treats every lane as a root with no attachments.
        parent_id: str | None = None
        attachments: tuple[LaneAttachment, ...] = ()
        if file_version >= 2:
            raw_parent = entry.get("parent_id")
            if isinstance(raw_parent, str) and raw_parent.strip():
                # Re-normalize so a hand-edited file with mixed case still loads.
                try:
                    parent_id = normalize_lane_id(raw_parent)
                except ValueError:
                    parent_id = None
            raw_attachments = entry.get("attachments", [])
            if isinstance(raw_attachments, list):
                parsed: list[LaneAttachment] = []
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
                        LaneAttachment(
                            name=normalized_name,
                            root=self._resolve_lane_root(Path(att_root)),
                            mode=mode,
                        )
                    )
                attachments = tuple(parsed)
        raw_writable = entry.get("writable", True)
        writable = raw_writable if type(raw_writable) is bool else False
        return Lane(
            id=lane_id,
            session_id=session_id,
            name=name,
            kind=kind,
            root=resolved_root,
            parent_id=parent_id,
            attachments=attachments,
            writable=writable,
        )

    def resolve_lane_root(self, root: Path) -> Path:
        """Resolve `root` against the casefile root.

        Absolute paths are resolved as-is; relative paths are anchored at
        the casefile root. This is the public counterpart to the internal
        helper used during lane registration / update.
        """
        if root.is_absolute():
            return root.resolve()
        return (self.casefile.root / root).resolve()

    # Internal alias preserved for backward compatibility with call sites
    # that already reach in by the underscored name. New callers should
    # use `resolve_lane_root`.
    _resolve_lane_root = resolve_lane_root

    def _normalize_attachments(
        self, attachments: Iterable[LaneAttachment] | None
    ) -> tuple[LaneAttachment, ...]:
        if attachments is None:
            return ()
        seen: set[str] = set()
        out: list[LaneAttachment] = []
        for attachment in attachments:
            normalized_name = normalize_attachment_name(attachment.name)
            if normalized_name in seen:
                raise ValueError(f"Duplicate attachment name on lane: {normalized_name!r}")
            seen.add(normalized_name)
            resolved = self._resolve_lane_root(attachment.root)
            if not resolved.exists():
                raise FileNotFoundError(f"Attachment root does not exist: {resolved}")
            if not resolved.is_dir():
                raise NotADirectoryError(f"Attachment root is not a directory: {resolved}")
            mode = coerce_attachment_mode(attachment.mode)
            out.append(
                LaneAttachment(
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
