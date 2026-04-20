"""Safe primitives for executing local commands.

This module is the *only* place that should ever spawn a child process on the
user's behalf. Both the LLM-facing ``sys_exec`` tool (in
``assistant_app.tools.system_tools``) and the user-driven Run launcher (in
``assistant_app.casefile.runs``) call into the helpers here, so the
allowlist, the no-shell policy, and the bounded-IO/timeout enforcement live
in exactly one tested location.

Design notes:

* ``shell=False`` is mandatory and must never be flipped on. The
  ``ALLOWED_EXECUTABLES`` whitelist blocks unknown binaries but cannot
  prevent shell metacharacter injection (redirections, command substitution,
  &&-chaining) if a shell were spawned.
* Output capture is bounded *during* read so a runaway child cannot blow up
  memory; we keep draining the pipes after the cap to prevent the child
  from blocking on backpressure.
* Errors raised here use the exact same exception types and message
  fragments the historical ``sys_exec`` tool produced; ``test_tools.py``
  asserts on those substrings.
"""

from __future__ import annotations

import os
import selectors
import subprocess
import time
from pathlib import Path
from shlex import split

# Intentionally small allowlist for low-risk utility commands.
# Adding to this list is a security-relevant change; review carefully.
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


def validate_command(raw_command: str) -> list[str]:
    """Split ``raw_command`` and reject anything not on the safe allowlist.

    Returns the argv list ready for ``subprocess.Popen``. Raises
    ``ValueError`` for empty input and ``PermissionError`` for either an
    absolute / relative path invocation or a non-allowlisted basename. Both
    error messages are load-bearing — ``test_tools.py`` greps for fragments
    of them.
    """
    if not isinstance(raw_command, str) or not raw_command.strip():
        raise ValueError("command is required")
    command = split(raw_command)
    if not command:
        raise ValueError("command is required")
    executable = command[0].lower()
    executable_basename = os.path.basename(executable)
    if executable != executable_basename:
        raise PermissionError(
            "Executable path invocation is blocked by safe defaults"
        )
    if executable_basename not in ALLOWED_EXECUTABLES:
        raise PermissionError(
            f"Executable '{executable_basename}' is not allowed by safe defaults"
        )
    return command


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
    # Explicit `if` guards rather than `assert` because asserts are stripped
    # under `python -O`/`-OO`. If a future caller hands us a Popen without
    # piped stdout/stderr we want a clear error here, not an opaque
    # `AttributeError` from `None.read1(...)` deeper in.
    if process.stdout is None or process.stderr is None:
        raise RuntimeError(
            "Popen must be created with stdout=PIPE and stderr=PIPE"
        )
    cap = max_output_chars + 1
    stdout_buf = bytearray()
    stderr_buf = bytearray()
    deadline = time.monotonic() + timeout_seconds

    # `with` ensures the selector's epoll/kqueue fd is released even when we
    # bail out of the loop with TimeoutError (GC-based cleanup is too fragile
    # for OS resources).
    with selectors.DefaultSelector() as selector:
        selector.register(process.stdout, selectors.EVENT_READ, "stdout")
        selector.register(process.stderr, selectors.EVENT_READ, "stderr")

        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                process.kill()
                process.wait()
                raise TimeoutError(f"command timed out after {timeout_seconds}s")

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
                # Continue draining even after cap to avoid pipe backpressure.

            if process.poll() is not None and not events:
                break

    process.wait()
    return bytes(stdout_buf), bytes(stderr_buf)


def run_safe(
    command: list[str],
    *,
    cwd: Path,
    timeout_seconds: int,
    max_output_chars: int,
) -> dict[str, object]:
    """Execute ``command`` in ``cwd`` with bounded IO and a hard timeout.

    Range-checks ``timeout_seconds`` and ``max_output_chars`` here so callers
    can rely on a single error path. Returns a dict matching the historical
    ``sys_exec`` shape: ``command`` (joined), ``exit_code``, ``stdout``,
    ``stderr``, ``stdout_truncated``, ``stderr_truncated``,
    ``timeout_seconds``.
    """
    if not isinstance(command, list) or not command:
        raise ValueError("command must be a non-empty list of args")
    if timeout_seconds < 1 or timeout_seconds > 120:
        raise ValueError("timeout_seconds must be between 1 and 120")
    if max_output_chars < 1 or max_output_chars > 200_000:
        raise ValueError("max_output_chars must be between 1 and 200000")

    process = subprocess.Popen(
        command,
        # See module docstring; this must remain shell=False.
        shell=False,
        cwd=str(cwd),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    stdout_raw, stderr_raw = _read_bounded_streams(
        process, timeout_seconds, max_output_chars
    )
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


__all__ = ["ALLOWED_EXECUTABLES", "validate_command", "run_safe"]
