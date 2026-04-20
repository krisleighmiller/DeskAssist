from __future__ import annotations

import os
import selectors
import subprocess
import time
from pathlib import Path
from shlex import split

# Intentionally small allowlist for low-risk utility commands.
ALLOWED_EXECUTABLES = frozenset(
    {
        "echo",
        "printf",
        "pwd",
        "date",
        "uname",
        "whoami",
    }
)


def make_sys_exec_tool(workspace_root: Path):
    def _bounded_decode(value: bytes, max_chars: int) -> tuple[str, bool]:
        text = value.decode("utf-8", errors="replace")
        if len(text) <= max_chars:
            return text, False
        return text[:max_chars], True

    def _read_bounded_streams(
        process: subprocess.Popen[bytes],
        timeout_seconds: int,
        max_output_chars: int,
    ) -> tuple[bytes, bytes]:
        assert process.stdout is not None
        assert process.stderr is not None
        cap = max_output_chars + 1
        stdout_buf = bytearray()
        stderr_buf = bytearray()
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ, "stdout")
        selector.register(process.stderr, selectors.EVENT_READ, "stderr")
        deadline = time.monotonic() + timeout_seconds

        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                process.kill()
                process.wait()
                raise TimeoutError(f"sys_exec timed out after {timeout_seconds}s")

            events = selector.select(timeout=min(0.2, remaining))
            for key, _ in events:
                stream = key.fileobj
                channel = key.data
                chunk = stream.read1(4096)
                if not chunk:
                    selector.unregister(stream)
                    continue

                target = stdout_buf if channel == "stdout" else stderr_buf
                if len(target) < cap:
                    remaining_capacity = cap - len(target)
                    target.extend(chunk[:remaining_capacity])
                # Continue draining even after cap to avoid child-process pipe backpressure.

            if process.poll() is not None and not events:
                break

        process.wait()
        return bytes(stdout_buf), bytes(stderr_buf)

    def sys_exec(params: dict[str, object]) -> dict[str, object]:
        raw_command = params.get("command")
        if not isinstance(raw_command, str) or not raw_command.strip():
            raise ValueError("command is required")

        confirmed = params.get("confirm", False)
        if confirmed is not True:
            raise PermissionError("sys_exec requires confirm=true")

        command = split(raw_command)
        if not command:
            raise ValueError("command is required")
        executable = command[0].lower()
        executable_basename = os.path.basename(executable)
        if executable != executable_basename:
            raise PermissionError("Executable path invocation is blocked by safe defaults")
        if executable_basename not in ALLOWED_EXECUTABLES:
            raise PermissionError(
                f"Executable '{executable_basename}' is not allowed by safe defaults"
            )

        timeout_seconds = int(params.get("timeout_seconds", 30))
        if timeout_seconds < 1 or timeout_seconds > 120:
            raise ValueError("timeout_seconds must be between 1 and 120")

        max_output_chars = int(params.get("max_output_chars", 8000))
        if max_output_chars < 1 or max_output_chars > 200000:
            raise ValueError("max_output_chars must be between 1 and 200000")

        process = subprocess.Popen(
            command,
            # shell=False is mandatory and must never be changed.  ALLOWED_EXECUTABLES
            # blocks path-based invocation but cannot prevent shell metacharacter
            # injection (e.g. redirections, command substitution) if shell=True were
            # ever set.  Arguments are passed as a list, not a shell string.
            shell=False,
            cwd=str(workspace_root),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        stdout_raw, stderr_raw = _read_bounded_streams(process, timeout_seconds, max_output_chars)
        stdout, stdout_truncated = _bounded_decode(stdout_raw, max_output_chars)
        stderr, stderr_truncated = _bounded_decode(stderr_raw, max_output_chars)
        return {
            "command": " ".join(command),
            "exit_code": process.returncode,
            "stdout": stdout,
            "stderr": stderr,
            "stdout_truncated": stdout_truncated,
            "stderr_truncated": stderr_truncated,
            "timeout_seconds": timeout_seconds,
        }

    return sys_exec
