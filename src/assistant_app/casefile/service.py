from __future__ import annotations

from pathlib import Path
from typing import Any

from assistant_app.casefile.findings import Finding, SourceRef
from assistant_app.casefile.models import CasefileSnapshot, Lane
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
        self, *, name: str, kind: str, root: Path, lane_id: str | None = None
    ) -> CasefileSnapshot:
        return self.store.register_lane(name=name, kind=kind, root=root, lane_id=lane_id)

    def set_active_lane(self, lane_id: str) -> CasefileSnapshot:
        return self.store.set_active_lane(lane_id)

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

    def read_chat(self, lane_id: str) -> list[dict[str, Any]]:
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
