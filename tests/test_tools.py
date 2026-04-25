from pathlib import Path

import pytest

from assistant_app.security.policy import INTERNAL_CAPABILITY
from assistant_app.tools import build_default_tool_registry


def test_list_dir_and_read_file_within_workspace(tmp_path: Path):
    sample_file = tmp_path / "hello.txt"
    sample_file.write_text("hello world", encoding="utf-8")

    registry = build_default_tool_registry(tmp_path)
    list_result = registry.execute({"cmd": "list_dir", "params": {"path": "."}})
    assert list_result["ok"] is True
    names = [entry["name"] for entry in list_result["result"]["entries"]]
    assert "hello.txt" in names

    read_result = registry.execute(
        {"cmd": "read_file", "params": {"path": "hello.txt", "max_chars": 5}}
    )
    assert read_result["ok"] is True
    assert read_result["result"]["content"] == "hello"
    assert read_result["result"]["truncated"] is True


def test_save_append_delete_file_roundtrip(tmp_path: Path):
    registry = build_default_tool_registry(tmp_path)
    save_result = registry.execute(
        {
            "cmd": "save_file",
            "params": {"path": "scratch/todo.txt", "content": "one\n", "overwrite": False},
        }
    )
    assert save_result["ok"] is True

    append_result = registry.execute(
        {"cmd": "append_file", "params": {"path": "scratch/todo.txt", "content": "two\n"}}
    )
    assert append_result["ok"] is True

    read_result = registry.execute({"cmd": "read_file", "params": {"path": "scratch/todo.txt"}})
    assert read_result["ok"] is True
    assert read_result["result"]["content"] == "one\ntwo\n"

    delete_result = registry.execute({"cmd": "delete_file", "params": {"path": "scratch/todo.txt"}})
    assert delete_result["ok"] is True


def test_delete_path_can_delete_directory_recursively(tmp_path: Path):
    target_dir = tmp_path / "scratch" / "nested"
    target_dir.mkdir(parents=True, exist_ok=True)
    (target_dir / "a.txt").write_text("a", encoding="utf-8")
    registry = build_default_tool_registry(tmp_path)
    result = registry.execute(
        {"cmd": "delete_path", "params": {"path": "scratch", "recursive": True}}
    )
    assert result["ok"] is True
    assert result["result"]["deleted_type"] == "dir"
    assert not (tmp_path / "reference").exists()


def test_delete_path_directory_requires_recursive_flag(tmp_path: Path):
    target_dir = tmp_path / "scratch"
    target_dir.mkdir(parents=True, exist_ok=True)
    registry = build_default_tool_registry(tmp_path)
    result = registry.execute({"cmd": "delete_path", "params": {"path": "scratch"}})
    assert result["ok"] is False
    assert result["error"]["type"] == "IsADirectoryError"


def test_workspace_escape_is_blocked(tmp_path: Path):
    registry = build_default_tool_registry(tmp_path)
    result = registry.execute({"cmd": "read_file", "params": {"path": "../outside.txt"}})
    assert result["ok"] is False
    assert result["error"]["type"] == "PermissionError"


def test_unknown_command_returns_structured_error(tmp_path: Path):
    registry = build_default_tool_registry(tmp_path)
    result = registry.execute({"cmd": "not_a_command", "params": {}})
    assert result["ok"] is False
    assert result["error"]["type"] == "PermissionError"


def test_unknown_parameter_rejected_by_schema(tmp_path: Path):
    registry = build_default_tool_registry(tmp_path)
    result = registry.execute({"cmd": "read_file", "params": {"path": "a.txt", "extra": True}})
    assert result["ok"] is False
    assert result["error"]["type"] == "ValueError"
    assert "Unknown parameter" in result["error"]["message"]


def test_missing_required_parameter_rejected(tmp_path: Path):
    registry = build_default_tool_registry(tmp_path)
    result = registry.execute({"cmd": "save_file", "params": {"path": "a.txt"}})
    assert result["ok"] is False
    assert result["error"]["type"] == "ValueError"
    assert "Missing required parameter" in result["error"]["message"]


def test_parameter_type_validation_rejected(tmp_path: Path):
    registry = build_default_tool_registry(tmp_path)
    result = registry.execute({"cmd": "read_file", "params": {"path": "a.txt", "max_chars": "10"}})
    assert result["ok"] is False
    assert result["error"]["type"] == "TypeError"
    assert "max_chars" in result["error"]["message"]


def test_internal_execution_requires_registry_internal_enable(tmp_path: Path):
    registry = build_default_tool_registry(tmp_path)
    registry.register("internal_only_probe", lambda _: {"ok": True}, internal_enabled=False)
    result = registry.execute(
        {"cmd": "internal_only_probe", "params": {}},
        capability=INTERNAL_CAPABILITY,
    )
    assert result["ok"] is False
    assert result["error"]["type"] == "PermissionError"
    assert "not enabled for internal execution" in result["error"]["message"]


def test_registry_rejects_duplicate_command_registration(tmp_path: Path):
    registry = build_default_tool_registry(tmp_path)
    with pytest.raises(ValueError):
        registry.register("read_file", lambda _: {"ok": True})


def test_workspace_write_permission_enforced(tmp_path: Path):
    registry = build_default_tool_registry(tmp_path)
    registry.revoke_permission("workspace_write")
    result = registry.execute(
        {"cmd": "save_file", "params": {"path": "scratch/todo.txt", "content": "one\n"}}
    )
    assert result["ok"] is False
    assert result["error"]["type"] == "PermissionError"
    assert "workspace_write" in result["error"]["message"]


def test_workspace_read_permission_enforced(tmp_path: Path):
    sample_file = tmp_path / "hello.txt"
    sample_file.write_text("hello", encoding="utf-8")
    registry = build_default_tool_registry(tmp_path)
    registry.revoke_permission("workspace_read")
    result = registry.execute({"cmd": "read_file", "params": {"path": "hello.txt"}})
    assert result["ok"] is False
    assert result["error"]["type"] == "PermissionError"
    assert "workspace_read" in result["error"]["message"]


def test_bounded_file_read_rejects_non_positive_limit(tmp_path: Path):
    sample_file = tmp_path / "hello.txt"
    sample_file.write_text("hello world", encoding="utf-8")
    registry = build_default_tool_registry(tmp_path)
    result = registry.execute({"cmd": "read_file", "params": {"path": "hello.txt", "max_chars": 0}})
    assert result["ok"] is False
    assert result["error"]["type"] == "ValueError"
    assert "max_bytes" in result["error"]["message"]


def test_no_bridge_handler_uses_internal_capability():
    """Structural invariant: no electron_bridge handler threads INTERNAL_CAPABILITY.

    If this test fails because you intentionally added a trusted-automation
    handler, follow the checklist in
    assistant_app.security.policy._InternalCapability and update this test.
    """
    import ast
    import inspect
    import assistant_app.electron_bridge as bridge_module

    source = inspect.getsource(bridge_module)
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if isinstance(node, ast.keyword):
            if node.arg == "capability":
                value = node.value
                if isinstance(value, ast.Attribute) and value.attr == "INTERNAL_CAPABILITY":
                    raise AssertionError(
                        "electron_bridge passes INTERNAL_CAPABILITY to execute_tool_command; "
                        "update this test if intentional and follow the audit checklist."
                    )
                if isinstance(value, ast.Name) and value.id == "INTERNAL_CAPABILITY":
                    raise AssertionError(
                        "electron_bridge passes INTERNAL_CAPABILITY to execute_tool_command; "
                        "update this test if intentional and follow the audit checklist."
                    )
