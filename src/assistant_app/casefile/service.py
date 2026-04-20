from __future__ import annotations

from pathlib import Path
from typing import Any

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
