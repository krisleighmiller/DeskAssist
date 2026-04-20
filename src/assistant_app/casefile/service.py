from __future__ import annotations

from pathlib import Path
from typing import Any

from assistant_app.casefile.context import (
    ContextManifest,
    ContextManifestStore,
    ResolvedContextFile,
)
from assistant_app.casefile.findings import Finding, SourceRef
from assistant_app.casefile.models import CasefileSnapshot, Lane, LaneAttachment
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
    ) -> CasefileSnapshot:
        return self.store.register_lane(
            name=name,
            kind=kind,
            root=root,
            lane_id=lane_id,
            parent_id=parent_id,
            attachments=attachments,
        )

    def set_active_lane(self, lane_id: str) -> CasefileSnapshot:
        return self.store.set_active_lane(lane_id)

    def update_lane_attachments(
        self, lane_id: str, attachments: list[LaneAttachment]
    ) -> CasefileSnapshot:
        return self.store.update_lane_attachments(lane_id, attachments)

    def set_lane_parent(self, lane_id: str, parent_id: str | None) -> CasefileSnapshot:
        return self.store.set_lane_parent(lane_id, parent_id)

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
        return resolve_comparison_scope(snapshot, lane_ids)

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
        }


def serialize_lane(lane: Lane) -> dict[str, Any]:
    return {
        "id": lane.id,
        "name": lane.name,
        "kind": lane.kind,
        "root": str(lane.root),
        "parentId": lane.parent_id,
        "attachments": [serialize_attachment(att) for att in lane.attachments],
    }


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
        out.append(LaneAttachment(name=name.strip(), root=Path(root)))
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
        "readOverlays": [
            {"prefix": ov.prefix, "root": str(ov.root), "label": ov.label}
            for ov in scope.read_overlays
        ],
        "contextFiles": [serialize_context_file(entry) for entry in scope.context_files],
        "autoIncludeMaxBytes": scope.auto_include_max_bytes,
    }


def serialize_finding(finding: Finding) -> dict[str, Any]:
    """IPC-shaped finding (camelCase) for the renderer."""
    return {
        "id": finding.id,
        "title": finding.title,
        "body": finding.body,
        "severity": finding.severity,
        "createdAt": finding.created_at,
        "updatedAt": finding.updated_at,
        "laneIds": list(finding.lane_ids),
        "sourceRefs": [
            {
                "laneId": ref.lane_id,
                "path": ref.path,
                "lineStart": ref.line_start,
                "lineEnd": ref.line_end,
            }
            for ref in finding.source_refs
        ],
    }


def parse_source_refs(raw: Any) -> list[SourceRef]:
    """Inverse of `serialize_finding`'s sourceRefs field, tolerant of partial input."""
    if not isinstance(raw, list):
        return []
    out: list[SourceRef] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        lane_id = item.get("laneId") or item.get("lane_id")
        path = item.get("path")
        if not isinstance(lane_id, str) or not lane_id:
            continue
        if not isinstance(path, str) or not path:
            continue
        line_start = item.get("lineStart") if "lineStart" in item else item.get("line_start")
        line_end = item.get("lineEnd") if "lineEnd" in item else item.get("line_end")
        out.append(
            SourceRef(
                lane_id=lane_id,
                path=path,
                line_start=int(line_start) if isinstance(line_start, int) else None,
                line_end=int(line_end) if isinstance(line_end, int) else None,
            )
        )
    return out
