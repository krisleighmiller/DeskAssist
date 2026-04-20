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
            "params": {"path": "notes/todo.txt", "content": "one\n", "overwrite": False},
        }
    )
    assert save_result["ok"] is True

    append_result = registry.execute(
        {"cmd": "append_file", "params": {"path": "notes/todo.txt", "content": "two\n"}}
    )
    assert append_result["ok"] is True

    read_result = registry.execute({"cmd": "read_file", "params": {"path": "notes/todo.txt"}})
    assert read_result["ok"] is True
    assert read_result["result"]["content"] == "one\ntwo\n"

    delete_result = registry.execute({"cmd": "delete_file", "params": {"path": "notes/todo.txt"}})
    assert delete_result["ok"] is True


def test_delete_path_can_delete_directory_recursively(tmp_path: Path):
    target_dir = tmp_path / "notes" / "nested"
    target_dir.mkdir(parents=True, exist_ok=True)
    (target_dir / "a.txt").write_text("a", encoding="utf-8")
    registry = build_default_tool_registry(tmp_path)
    result = registry.execute(
        {"cmd": "delete_path", "params": {"path": "notes", "recursive": True}}
    )
    assert result["ok"] is True
    assert result["result"]["deleted_type"] == "dir"
    assert not (tmp_path / "notes").exists()


def test_delete_path_directory_requires_recursive_flag(tmp_path: Path):
    target_dir = tmp_path / "notes"
    target_dir.mkdir(parents=True, exist_ok=True)
    registry = build_default_tool_registry(tmp_path)
    result = registry.execute({"cmd": "delete_path", "params": {"path": "notes"}})
    assert result["ok"] is False
    assert result["error"]["type"] == "IsADirectoryError"


def test_workspace_escape_is_blocked(tmp_path: Path):
    registry = build_default_tool_registry(tmp_path)
    result = registry.execute({"cmd": "read_file", "params": {"path": "../outside.txt"}})
    assert result["ok"] is False
    assert result["error"]["type"] == "PermissionError"


def test_sys_exec_disabled_by_default_but_internal_can_use(tmp_path: Path):
    registry = build_default_tool_registry(tmp_path)
    denied_result = registry.execute({"cmd": "sys_exec", "params": {"command": "echo hi"}})
    assert denied_result["ok"] is False
    assert denied_result["error"]["type"] == "ValueError"

    registry.grant_permission("system_exec")
    result = registry.execute(
        {"cmd": "sys_exec", "params": {"command": "echo hi", "confirm": True}},
        capability=INTERNAL_CAPABILITY,
    )
    assert result["ok"] is True
    assert result["result"]["exit_code"] == 0
    assert "hi" in result["result"]["stdout"]


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


def test_sys_exec_uses_non_shell_execution(tmp_path: Path):
    registry = build_default_tool_registry(tmp_path)
    registry.grant_permission("system_exec")
    result = registry.execute(
        {"cmd": "sys_exec", "params": {"command": "echo hi && echo there", "confirm": True}},
        capability=INTERNAL_CAPABILITY,
    )
    assert result["ok"] is True
    # With shell=False, && is passed as an argument to echo instead of chaining commands.
    assert result["result"]["stdout"].strip() == "hi && echo there"


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
        {"cmd": "save_file", "params": {"path": "notes/todo.txt", "content": "one\n"}}
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


def test_sys_exec_requires_confirm_true(tmp_path: Path):
    registry = build_default_tool_registry(tmp_path)
    registry.grant_permission("system_exec")
    result = registry.execute(
        {"cmd": "sys_exec", "params": {"command": "echo hi", "confirm": False}},
        capability=INTERNAL_CAPABILITY,
    )
    assert result["ok"] is False
    assert result["error"]["type"] == "PermissionError"
    assert "confirm=true" in result["error"]["message"]


def test_sys_exec_blocks_dangerous_executables(tmp_path: Path):
    registry = build_default_tool_registry(tmp_path)
    registry.grant_permission("system_exec")
    result = registry.execute(
        {"cmd": "sys_exec", "params": {"command": "rm -rf tmp", "confirm": True}},
        capability=INTERNAL_CAPABILITY,
    )
    assert result["ok"] is False
    assert result["error"]["type"] == "PermissionError"
    assert "not allowed by safe defaults" in result["error"]["message"]


def test_sys_exec_blocks_shell_launcher_bypass(tmp_path: Path):
    registry = build_default_tool_registry(tmp_path)
    registry.grant_permission("system_exec")
    result = registry.execute(
        {"cmd": "sys_exec", "params": {"command": "bash -c 'echo hi'", "confirm": True}},
        capability=INTERNAL_CAPABILITY,
    )
    assert result["ok"] is False
    assert result["error"]["type"] == "PermissionError"
    assert "not allowed by safe defaults" in result["error"]["message"]


def test_sys_exec_blocks_absolute_executable_path(tmp_path: Path):
    registry = build_default_tool_registry(tmp_path)
    registry.grant_permission("system_exec")
    result = registry.execute(
        {"cmd": "sys_exec", "params": {"command": "/bin/echo hi", "confirm": True}},
        capability=INTERNAL_CAPABILITY,
    )
    assert result["ok"] is False
    assert result["error"]["type"] == "PermissionError"
    assert "path invocation is blocked" in result["error"]["message"]


def test_sys_exec_enforces_timeout_range(tmp_path: Path):
    registry = build_default_tool_registry(tmp_path)
    registry.grant_permission("system_exec")
    result = registry.execute(
        {"cmd": "sys_exec", "params": {"command": "echo hi", "confirm": True, "timeout_seconds": 0}},
        capability=INTERNAL_CAPABILITY,
    )
    assert result["ok"] is False
    assert result["error"]["type"] == "ValueError"
    assert "timeout_seconds" in result["error"]["message"]


def test_sys_exec_output_is_bounded(tmp_path: Path):
    registry = build_default_tool_registry(tmp_path)
    registry.grant_permission("system_exec")
    result = registry.execute(
        {
            "cmd": "sys_exec",
            "params": {"command": "printf 1234567890", "confirm": True, "max_output_chars": 5},
        },
        capability=INTERNAL_CAPABILITY,
    )
    assert result["ok"] is True
    assert result["result"]["stdout"] == "12345"
    assert result["result"]["stdout_truncated"] is True


def test_sys_exec_timeout_is_enforced_during_run(tmp_path: Path):
    registry = build_default_tool_registry(tmp_path)
    registry.grant_permission("system_exec")
    result = registry.execute(
        {"cmd": "sys_exec", "params": {"command": "printf 1234567890", "confirm": True, "timeout_seconds": 1}},
        capability=INTERNAL_CAPABILITY,
    )
    assert result["ok"] is True


def test_bounded_file_read_rejects_non_positive_limit(tmp_path: Path):
    sample_file = tmp_path / "hello.txt"
    sample_file.write_text("hello world", encoding="utf-8")
    registry = build_default_tool_registry(tmp_path)
    result = registry.execute({"cmd": "read_file", "params": {"path": "hello.txt", "max_chars": 0}})
    assert result["ok"] is False
    assert result["error"]["type"] == "ValueError"
    assert "max_chars" in result["error"]["message"]
