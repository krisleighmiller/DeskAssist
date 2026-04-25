from __future__ import annotations

from pathlib import Path

import pytest

from assistant_app import electron_bridge as bridge


def test_register_context_defaults_attachment_mode_to_write(tmp_path: Path) -> None:
    casefile_root = tmp_path / "case"
    casefile_root.mkdir()
    context_root = tmp_path / "context"
    context_root.mkdir()
    reference_root = tmp_path / "reference"
    reference_root.mkdir()

    bridge.dispatch({"command": "casefile:open", "root": str(casefile_root)})
    response = bridge.dispatch(
        {
            "command": "casefile:registerContext",
            "casefileRoot": str(casefile_root),
            "context": {
                "name": "Context",
                "kind": "repo",
                "root": str(context_root),
                "id": "context",
                "attachments": [{"name": "reference", "root": str(reference_root)}],
            },
        }
    )

    context = next(item for item in response["casefile"]["contexts"] if item["id"] == "context")
    assert context["attachments"] == [
        {"name": "reference", "root": str(reference_root.resolve()), "mode": "write"}
    ]


def test_register_context_rejects_invalid_attachment_mode(tmp_path: Path) -> None:
    casefile_root = tmp_path / "case"
    casefile_root.mkdir()
    context_root = tmp_path / "context"
    context_root.mkdir()
    reference_root = tmp_path / "reference"
    reference_root.mkdir()

    bridge.dispatch({"command": "casefile:open", "root": str(casefile_root)})
    with pytest.raises(ValueError, match="Attachment mode"):
        bridge.dispatch(
            {
                "command": "casefile:registerContext",
                "casefileRoot": str(casefile_root),
                "context": {
                    "name": "Context",
                    "kind": "repo",
                    "root": str(context_root),
                    "id": "context",
                    "attachments": [
                        {"name": "reference", "root": str(reference_root), "mode": "readonly"}
                    ],
                },
            }
        )


def test_update_context_bridge_updates_writable_flag(tmp_path: Path) -> None:
    casefile_root = tmp_path / "case"
    casefile_root.mkdir()
    context_root = tmp_path / "context"
    context_root.mkdir()

    bridge.dispatch({"command": "casefile:open", "root": str(casefile_root)})
    bridge.dispatch(
        {
            "command": "casefile:registerContext",
            "casefileRoot": str(casefile_root),
            "context": {"name": "Context", "kind": "repo", "root": str(context_root), "id": "context"},
        }
    )

    response = bridge.dispatch(
        {
            "command": "casefile:updateContext",
            "casefileRoot": str(casefile_root),
            "contextId": "context",
            "writable": False,
        }
    )

    context = next(item for item in response["casefile"]["contexts"] if item["id"] == "context")
    assert context["writable"] is False


def test_update_context_rejects_non_boolean_writable(tmp_path: Path) -> None:
    casefile_root = tmp_path / "case"
    casefile_root.mkdir()
    context_root = tmp_path / "context"
    context_root.mkdir()

    bridge.dispatch({"command": "casefile:open", "root": str(casefile_root)})
    bridge.dispatch(
        {
            "command": "casefile:registerContext",
            "casefileRoot": str(casefile_root),
            "context": {"name": "Context", "kind": "repo", "root": str(context_root), "id": "context"},
        }
    )

    with pytest.raises(ValueError, match="writable must be a boolean"):
        bridge.dispatch(
            {
                "command": "casefile:updateContext",
                "casefileRoot": str(casefile_root),
                "contextId": "context",
                "writable": "false",
            }
        )
