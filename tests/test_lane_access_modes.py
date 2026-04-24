from __future__ import annotations

from pathlib import Path

import pytest

from assistant_app import electron_bridge as bridge


def test_register_lane_defaults_attachment_mode_to_write(tmp_path: Path) -> None:
    casefile_root = tmp_path / "case"
    casefile_root.mkdir()
    lane_root = tmp_path / "lane"
    lane_root.mkdir()
    notes_root = tmp_path / "notes"
    notes_root.mkdir()

    bridge.dispatch({"command": "casefile:open", "root": str(casefile_root)})
    response = bridge.dispatch(
        {
            "command": "casefile:registerLane",
            "casefileRoot": str(casefile_root),
            "lane": {
                "name": "Lane",
                "kind": "repo",
                "root": str(lane_root),
                "id": "lane",
                "attachments": [{"name": "notes", "root": str(notes_root)}],
            },
        }
    )

    lane = next(item for item in response["casefile"]["lanes"] if item["id"] == "lane")
    assert lane["attachments"] == [
        {"name": "notes", "root": str(notes_root.resolve()), "mode": "write"}
    ]


def test_register_lane_rejects_invalid_attachment_mode(tmp_path: Path) -> None:
    casefile_root = tmp_path / "case"
    casefile_root.mkdir()
    lane_root = tmp_path / "lane"
    lane_root.mkdir()
    notes_root = tmp_path / "notes"
    notes_root.mkdir()

    bridge.dispatch({"command": "casefile:open", "root": str(casefile_root)})
    with pytest.raises(ValueError, match="Attachment mode"):
        bridge.dispatch(
            {
                "command": "casefile:registerLane",
                "casefileRoot": str(casefile_root),
                "lane": {
                    "name": "Lane",
                    "kind": "repo",
                    "root": str(lane_root),
                    "id": "lane",
                    "attachments": [
                        {"name": "notes", "root": str(notes_root), "mode": "readonly"}
                    ],
                },
            }
        )


def test_update_lane_bridge_updates_writable_flag(tmp_path: Path) -> None:
    casefile_root = tmp_path / "case"
    casefile_root.mkdir()
    lane_root = tmp_path / "lane"
    lane_root.mkdir()

    bridge.dispatch({"command": "casefile:open", "root": str(casefile_root)})
    bridge.dispatch(
        {
            "command": "casefile:registerLane",
            "casefileRoot": str(casefile_root),
            "lane": {"name": "Lane", "kind": "repo", "root": str(lane_root), "id": "lane"},
        }
    )

    response = bridge.dispatch(
        {
            "command": "casefile:updateLane",
            "casefileRoot": str(casefile_root),
            "laneId": "lane",
            "writable": False,
        }
    )

    lane = next(item for item in response["casefile"]["lanes"] if item["id"] == "lane")
    assert lane["writable"] is False


def test_update_lane_rejects_non_boolean_writable(tmp_path: Path) -> None:
    casefile_root = tmp_path / "case"
    casefile_root.mkdir()
    lane_root = tmp_path / "lane"
    lane_root.mkdir()

    bridge.dispatch({"command": "casefile:open", "root": str(casefile_root)})
    bridge.dispatch(
        {
            "command": "casefile:registerLane",
            "casefileRoot": str(casefile_root),
            "lane": {"name": "Lane", "kind": "repo", "root": str(lane_root), "id": "lane"},
        }
    )

    with pytest.raises(ValueError, match="writable must be a boolean"):
        bridge.dispatch(
            {
                "command": "casefile:updateLane",
                "casefileRoot": str(casefile_root),
                "laneId": "lane",
                "writable": "false",
            }
        )
