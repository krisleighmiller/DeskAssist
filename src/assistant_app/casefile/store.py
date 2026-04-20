from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from assistant_app.casefile.models import (
    Casefile,
    CasefileSnapshot,
    DEFAULT_LANE_KIND,
    Lane,
    coerce_lane_kind,
)

LANES_FILE_VERSION = 1


class LanesFileError(ValueError):
    """Raised when `lanes.json` is malformed in a way the loader cannot recover from."""


_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")


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
                name="Main",
                kind=DEFAULT_LANE_KIND,
                root=self.casefile.root,
            )
            self._write_lanes_file([default_lane], active_lane_id="main")

    # ----- lanes.json -----

    def load_snapshot(self) -> CasefileSnapshot:
        """Load lanes + active lane id. Auto-initializes if needed."""
        if not self.casefile.lanes_file.exists():
            self.ensure_initialized()
        raw = self._read_lanes_file()
        version = raw.get("version")
        if not isinstance(version, int) or version > LANES_FILE_VERSION:
            raise LanesFileError(
                f"Unsupported lanes.json version: {version!r} (this build understands <= {LANES_FILE_VERSION})"
            )
        lanes_raw = raw.get("lanes")
        if not isinstance(lanes_raw, list):
            raise LanesFileError("lanes.json: 'lanes' must be an array")
        lanes: list[Lane] = []
        seen_ids: set[str] = set()
        for entry in lanes_raw:
            lane = self._lane_from_raw(entry)
            if lane.id in seen_ids:
                raise LanesFileError(f"Duplicate lane id in lanes.json: {lane.id!r}")
            seen_ids.add(lane.id)
            lanes.append(lane)
        active = raw.get("active_lane_id")
        active_lane_id: str | None = None
        if isinstance(active, str) and active in seen_ids:
            active_lane_id = active
        elif lanes:
            active_lane_id = lanes[0].id
        return CasefileSnapshot(
            casefile=self.casefile,
            lanes=tuple(lanes),
            active_lane_id=active_lane_id,
        )

    def register_lane(
        self,
        *,
        name: str,
        kind: str,
        root: Path,
        lane_id: str | None = None,
    ) -> CasefileSnapshot:
        """Add a new lane and return the updated snapshot.

        `root` may be absolute or relative to the casefile root. Lane roots
        outside the casefile are explicitly allowed (lanes are sibling
        directories in the documented model).
        """
        snapshot = self.load_snapshot()
        existing_ids = {lane.id for lane in snapshot.lanes}
        candidate = normalize_lane_id(lane_id) if lane_id else slug_from_name(name)
        final_id = self._unique_id(candidate, existing_ids)
        resolved_root = self._resolve_lane_root(root)
        if not resolved_root.exists():
            raise FileNotFoundError(f"Lane root does not exist: {resolved_root}")
        if not resolved_root.is_dir():
            raise NotADirectoryError(f"Lane root is not a directory: {resolved_root}")
        lane = Lane(
            id=final_id,
            name=name.strip() or final_id,
            kind=coerce_lane_kind(kind),
            root=resolved_root,
        )
        new_lanes = list(snapshot.lanes) + [lane]
        active = snapshot.active_lane_id or lane.id
        self._write_lanes_file(new_lanes, active_lane_id=active)
        return self.load_snapshot()

    def set_active_lane(self, lane_id: str) -> CasefileSnapshot:
        snapshot = self.load_snapshot()
        ids = {lane.id for lane in snapshot.lanes}
        if lane_id not in ids:
            raise KeyError(f"Unknown lane id: {lane_id!r}")
        self._write_lanes_file(list(snapshot.lanes), active_lane_id=lane_id)
        return self.load_snapshot()

    def remove_lane(self, lane_id: str) -> CasefileSnapshot:
        snapshot = self.load_snapshot()
        remaining = [lane for lane in snapshot.lanes if lane.id != lane_id]
        if len(remaining) == len(snapshot.lanes):
            raise KeyError(f"Unknown lane id: {lane_id!r}")
        new_active = snapshot.active_lane_id
        if new_active == lane_id:
            new_active = remaining[0].id if remaining else None
        self._write_lanes_file(remaining, active_lane_id=new_active)
        return self.load_snapshot()

    # ----- chat history per lane -----

    def chat_log_path(self, lane_id: str) -> Path:
        # normalize_lane_id is intentionally re-run as a defense-in-depth
        # check against any caller that bypasses register_lane.
        safe = normalize_lane_id(lane_id)
        return self.casefile.chats_dir / f"{safe}.jsonl"

    def append_chat_messages(
        self, lane_id: str, messages: list[dict[str, Any]]
    ) -> Path:
        path = self.chat_log_path(lane_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            for message in messages:
                handle.write(json.dumps(message, ensure_ascii=False))
                handle.write("\n")
        return path

    def read_chat_messages(self, lane_id: str) -> list[dict[str, Any]]:
        path = self.chat_log_path(lane_id)
        if not path.exists():
            return []
        out: list[dict[str, Any]] = []
        with path.open("r", encoding="utf-8") as handle:
            for line_no, raw_line in enumerate(handle, start=1):
                line = raw_line.strip()
                if not line:
                    continue
                try:
                    parsed = json.loads(line)
                except json.JSONDecodeError as exc:
                    raise LanesFileError(
                        f"Corrupt chat log {path} at line {line_no}: {exc}"
                    ) from exc
                if isinstance(parsed, dict):
                    out.append(parsed)
        return out

    def clear_chat_messages(self, lane_id: str) -> None:
        path = self.chat_log_path(lane_id)
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
            serialized_lanes.append(
                {
                    "id": lane.id,
                    "name": lane.name,
                    "kind": lane.kind,
                    "root": root_repr,
                }
            )
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

    def _lane_from_raw(self, entry: object) -> Lane:
        if not isinstance(entry, dict):
            raise LanesFileError(f"Lane entry must be an object, got {type(entry).__name__}")
        raw_id = entry.get("id")
        if not isinstance(raw_id, str):
            raise LanesFileError("Lane entry missing string 'id'")
        try:
            lane_id = normalize_lane_id(raw_id)
        except ValueError as exc:
            raise LanesFileError(str(exc)) from exc
        raw_name = entry.get("name")
        name = raw_name.strip() if isinstance(raw_name, str) and raw_name.strip() else lane_id
        kind = coerce_lane_kind(entry.get("kind"))
        raw_root = entry.get("root")
        if not isinstance(raw_root, str):
            raise LanesFileError(f"Lane {lane_id!r} missing string 'root'")
        resolved_root = self._resolve_lane_root(Path(raw_root))
        return Lane(id=lane_id, name=name, kind=kind, root=resolved_root)

    def _resolve_lane_root(self, root: Path) -> Path:
        if root.is_absolute():
            return root.resolve()
        return (self.casefile.root / root).resolve()

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
