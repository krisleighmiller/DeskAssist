from __future__ import annotations

from pathlib import Path
from typing import Any

from assistant_app.casefile.context import (
    ContextManifest,
    ContextManifestStore,
    ResolvedContextFile,
)
from assistant_app.casefile.models import (
    AttachmentMode,
    CasefileSnapshot,
    ComparisonSessionConfig,
    DEFAULT_ATTACHMENT_MODE,
    Lane,
    LaneAttachment,
)
from assistant_app.casefile.scope import (
    ScopeContext,
    comparison_id_for_lanes,
    resolve_comparison_scope,
    resolve_scope,
)
from assistant_app.casefile.store import CasefileStore


class CasefileService:
    """Higher-level orchestration over a CasefileStore.

    The store knows about JSON layout. The service knows about user-facing
    operations (open, register, switch) and resolves lane ids into
    `WorkspaceFilesystem`-shaped roots that the chat service consumes.
    """

    def __init__(self, casefile_root: Path) -> None:
        self.store = CasefileStore(casefile_root)

    # ----- lifecycle -----

    def open(self) -> CasefileSnapshot:
        self.store.ensure_initialized()
        return self.store.load_snapshot()

    def snapshot(self) -> CasefileSnapshot:
        return self.store.load_snapshot()

    def register_lane(
        self,
        *,
        name: str,
        kind: str,
        root: Path,
        lane_id: str | None = None,
        parent_id: str | None = None,
        attachments: list[LaneAttachment] | None = None,
        writable: bool = True,
    ) -> CasefileSnapshot:
        return self.store.register_lane(
            name=name,
            kind=kind,
            root=root,
            lane_id=lane_id,
            parent_id=parent_id,
            attachments=attachments,
            writable=writable,
        )

    def set_active_lane(self, lane_id: str) -> CasefileSnapshot:
        return self.store.set_active_lane(lane_id)

    def update_lane_attachments(
        self, lane_id: str, attachments: list[LaneAttachment]
    ) -> CasefileSnapshot:
        return self.store.update_lane_attachments(lane_id, attachments)

    def set_lane_parent(self, lane_id: str, parent_id: str | None) -> CasefileSnapshot:
        return self.store.set_lane_parent(lane_id, parent_id)

    def update_lane(
        self,
        lane_id: str,
        *,
        name: str | None = None,
        kind: str | None = None,
        root: Path | None = None,
        writable: bool | None = None,
    ) -> CasefileSnapshot:
        """Update an existing lane's `name` / `kind` / `root` / `writable` (M4.6 / M2.5).

        Each field is independently optional. Parent and attachments
        have their own dedicated mutators (`set_lane_parent`,
        `update_lane_attachments`); the lane id is intentionally
        immutable here.
        """
        return self.store.update_lane(
            lane_id, name=name, kind=kind, root=root, writable=writable,
        )

    def remove_lane(self, lane_id: str) -> CasefileSnapshot:
        """Remove a lane from the casefile (M4.6).

        On-disk per-lane data files (`chats/<id>.jsonl`,
        `notes/<id>.md`) are intentionally **not** deleted.
        Re-registering a lane with the same id will surface the prior
        data again. This mirrors the "hidden but recoverable" decision
        from the M4.6 spec.
        """
        return self.store.remove_lane(lane_id)

    def hard_reset(self) -> CasefileSnapshot:
        """Restore the casefile to its pre-DeskAssist state (M4.6).

        Wipes the entire `.casefile/` directory and re-initializes it,
        so the returned snapshot is identical in shape to one from a
        first-time `casefile:open` against a directory that had never
        been opened before.
        """
        self.store.hard_reset()
        return self.open()

    def soft_reset(self, *, keep_prompts: bool) -> CasefileSnapshot:
        """Clear per-task scratch but keep durable setup (M4.6)."""
        self.store.soft_reset(keep_prompts=keep_prompts)
        return self.snapshot()

    def find_root_conflict(
        self, root: Path, *, exclude_lane_id: str | None = None
    ) -> str | None:
        """Return the id of an existing lane whose root resolves to `root`.

        Used by the M4.6 lane-edit / lane-register paths to surface a
        non-blocking warning when a new or edited lane points at a
        directory another lane already references. The system permits
        overlapping roots; this helper just makes the overlap visible.
        """
        snapshot = self.store.load_snapshot()
        try:
            resolved = self.store.resolve_lane_root(root)
        except OSError:
            return None
        for lane in snapshot.lanes:
            if exclude_lane_id is not None and lane.id == exclude_lane_id:
                continue
            if lane.root == resolved:
                return lane.id
        return None

    # ----- context manifest -----

    def context_store(self) -> ContextManifestStore:
        return ContextManifestStore(self.store.casefile.root)

    def load_context_manifest(self) -> ContextManifest:
        return self.context_store().load()

    def save_context_manifest(self, manifest: ContextManifest) -> ContextManifest:
        store = self.context_store()
        store.save(manifest)
        return store.load()

    def resolve_scope(self, lane_id: str) -> ScopeContext:
        snapshot = self.store.load_snapshot()
        return resolve_scope(snapshot, lane_id)

    # ----- comparison sessions (M3.5c) -----

    def comparison_id(self, lane_ids: list[str]) -> str:
        return comparison_id_for_lanes(lane_ids)

    def resolve_comparison_scope(self, lane_ids: list[str]) -> ScopeContext:
        snapshot = self.store.load_snapshot()
        session = self.store.ensure_comparison_session(lane_ids)
        return resolve_comparison_scope(
            snapshot,
            lane_ids,
            comparison_attachments=session.attachments,
        )

    def get_comparison_session(self, lane_ids: list[str]) -> ComparisonSessionConfig:
        return self.store.ensure_comparison_session(lane_ids)

    def update_comparison_attachments(
        self, lane_ids: list[str], attachments: list[LaneAttachment]
    ) -> ComparisonSessionConfig:
        return self.store.update_comparison_attachments(lane_ids, attachments)

    def append_comparison_chat(
        self, lane_ids: list[str], messages: list[dict[str, Any]]
    ) -> None:
        if not messages:
            return
        self.store.append_comparison_chat_messages(lane_ids, messages)

    def read_comparison_chat(
        self, lane_ids: list[str]
    ) -> tuple[list[dict[str, Any]], int]:
        return self.store.read_comparison_chat_messages(lane_ids)

    # ----- lookups used by the chat bridge -----

    def resolve_lane(self, lane_id: str | None) -> Lane:
        snapshot = self.store.load_snapshot()
        if lane_id is None:
            if snapshot.active_lane is None:
                raise ValueError("Casefile has no active lane")
            return snapshot.active_lane
        return snapshot.lane_by_id(lane_id)

    # ----- chat persistence -----

    def append_chat(self, lane_id: str, messages: list[dict[str, Any]]) -> None:
        if not messages:
            return
        self.store.append_chat_messages(lane_id, messages)

    def read_chat(self, lane_id: str) -> tuple[list[dict[str, Any]], int]:
        """Return ``(messages, skipped_corrupt_count)`` for the lane's chat log."""
        return self.store.read_chat_messages(lane_id)

    # ----- IPC serialization -----

    def serialize(self, snapshot: CasefileSnapshot) -> dict[str, Any]:
        return {
            "root": str(snapshot.casefile.root),
            "lanes": [serialize_lane(lane) for lane in snapshot.lanes],
            "activeLaneId": snapshot.active_lane_id,
            "skippedActiveLaneId": snapshot.skipped_active_lane_id,
        }


def serialize_lane(lane: Lane) -> dict[str, Any]:
    result: dict[str, Any] = {
        "id": lane.id,
        "sessionId": lane.session_id,
        "name": lane.name,
        "kind": lane.kind,
        "root": str(lane.root),
        "parentId": lane.parent_id,
        "attachments": [serialize_attachment(att) for att in lane.attachments],
        "writable": lane.writable,
    }
    return result


def serialize_attachment(attachment: LaneAttachment) -> dict[str, Any]:
    return {
        "name": attachment.name,
        "root": str(attachment.root),
        "mode": attachment.mode,
    }


def parse_attachments(raw: Any) -> list[LaneAttachment]:
    """Parse `[{name, root, mode?}]` entries from IPC into LaneAttachment objects.

    The store re-validates names and resolves roots; this parser only does
    enough type checking to fail loudly on malformed payloads.
    """
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ValueError("attachments must be an array")
    out: list[LaneAttachment] = []
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError("attachment entry must be an object")
        name = item.get("name")
        root = item.get("root")
        if not isinstance(name, str) or not name.strip():
            raise ValueError("attachment.name is required")
        if not isinstance(root, str) or not root.strip():
            raise ValueError("attachment.root is required")
        mode_raw = item.get("mode")
        if mode_raw == "read":
            mode: AttachmentMode = "read"
        else:
            mode = DEFAULT_ATTACHMENT_MODE
        out.append(LaneAttachment(name=name.strip(), root=Path(root), mode=mode))
    return out


def serialize_context_file(entry: ResolvedContextFile) -> dict[str, Any]:
    return {
        "path": entry.relative_path,
        "absolutePath": str(entry.absolute_path),
        "sizeBytes": entry.size_bytes,
    }


def serialize_context_manifest(
    manifest: ContextManifest, files: list[ResolvedContextFile]
) -> dict[str, Any]:
    return {
        "files": list(manifest.files),
        "autoIncludeMaxBytes": manifest.auto_include_max_bytes,
        "resolved": [serialize_context_file(entry) for entry in files],
    }


def serialize_scope(scope: ScopeContext) -> dict[str, Any]:
    return {
        "laneId": scope.lane_id,
        "writeRoot": str(scope.write_root),
        "casefileRoot": str(scope.casefile_root),
        "directories": [
            {
                "path": str(d.path),
                "label": d.label,
                "writable": d.writable,
            }
            for d in scope.directories
        ],
        "contextFiles": [serialize_context_file(entry) for entry in scope.context_files],
        "autoIncludeMaxBytes": scope.auto_include_max_bytes,
    }
