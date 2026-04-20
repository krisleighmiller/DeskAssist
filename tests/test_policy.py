from assistant_app.security.policy import INTERNAL_CAPABILITY, authorize, sanitize_command


def test_sanitize_command_removes_untrusted_keys():
    cleaned = sanitize_command(
        {
            "cmd": "sys_exec",
            "params": {"command": "echo hello"},
            "silent": 1,
            "force": True,
        }
    )
    assert cleaned == {
        "cmd": "sys_exec",
        "params": {"command": "echo hello"},
    }


def test_authorize_requires_enabled_for_external_call():
    allowed, reason = authorize(
        "sys_exec",
        has_cmd_fn=lambda _: False,
        allowed_cmds=frozenset({"sys_exec"}),
    )
    assert not allowed
    assert "not enabled" in reason


def test_authorize_allows_internal_capability_allowlisted_command():
    allowed, reason = authorize(
        "sys_exec",
        capability=INTERNAL_CAPABILITY,
        has_cmd_fn=lambda _: False,
        has_internal_cmd_fn=lambda cmd: cmd == "sys_exec",
        allowed_cmds=frozenset({"sys_exec"}),
    )
    assert allowed
    assert reason == "internal capability"


def test_authorize_denies_internal_command_not_internal_enabled():
    allowed, reason = authorize(
        "sys_exec",
        capability=INTERNAL_CAPABILITY,
        has_cmd_fn=lambda _: False,
        has_internal_cmd_fn=lambda _: False,
        allowed_cmds=frozenset({"sys_exec"}),
    )
    assert not allowed
    assert "not enabled for internal execution" in reason


def test_authorize_internal_can_use_externally_enabled_command():
    allowed, reason = authorize(
        "read_file",
        capability=INTERNAL_CAPABILITY,
        has_cmd_fn=lambda cmd: cmd == "read_file",
        has_internal_cmd_fn=lambda _: False,
        allowed_cmds=frozenset({"read_file"}),
    )
    assert allowed
    assert reason == "enabled"
