from __future__ import annotations

from pathlib import Path

from assistant_app.casefile.findings import FindingsStore
from assistant_app.casefile.service import serialize_finding


def make_findings_list_tool(casefile_root: Path):
    """Read-only tool: list findings, optionally filtered to a lane.

    Returns the same IPC-shaped objects the renderer sees, so the model can
    cite ids that the user can resolve in the UI.
    """
    store = FindingsStore(casefile_root)

    def findings_list(params: dict[str, object]) -> dict[str, object]:
        raw_lane = params.get("lane_id")
        lane_id = raw_lane if isinstance(raw_lane, str) and raw_lane else None
        findings = store.list(lane_id=lane_id)
        return {
            "count": len(findings),
            "findings": [serialize_finding(f) for f in findings],
        }

    return findings_list


def make_findings_read_tool(casefile_root: Path):
    """Read-only tool: read a single finding by id."""
    store = FindingsStore(casefile_root)

    def findings_read(params: dict[str, object]) -> dict[str, object]:
        raw_id = params.get("id")
        if not isinstance(raw_id, str) or not raw_id:
            raise ValueError("id is required")
        finding = store.get(raw_id)
        return {"finding": serialize_finding(finding)}

    return findings_read
