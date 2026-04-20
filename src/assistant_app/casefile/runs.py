"""Persistent record of user-initiated command runs.

The ``RunsStore`` lets the renderer launch one of the safe-allowlisted
commands (see :mod:`assistant_app.system_exec`) from a casefile and keep
the captured stdout / stderr / exit code on disk under
``.casefile/runs/<id>.json``. This is intentionally separate from the
LLM-facing ``sys_exec`` tool: runs here are *user* actions and produce a
permanent, browsable artifact rather than feeding tool output back into a
chat turn.

A run record is written exactly once after the command finishes (or
fails). Ranges enforced for timeout/output-cap match the LLM tool so the
allowlist semantics are uniform.
"""

from __future__ import annotations

import json
import re
import secrets
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from assistant_app.casefile.models import Casefile
from assistant_app.system_exec import run_safe, validate_command

RUN_FILE_VERSION = 1

# Defaults match the LLM tool so the renderer doesn't need to remember
# different limits per surface. Both can be overridden per-call within the
# bounds enforced by `run_safe`.
DEFAULT_RUN_TIMEOUT_SECONDS = 30
DEFAULT_RUN_MAX_OUTPUT_CHARS = 8000


class RunFileError(ValueError):
    """Raised when a run JSON file is malformed in a way the loader cannot recover."""


@dataclass(slots=True, frozen=True)
class RunRecord:
    """Captured outcome of a single command execution.

    `error` is set only when the run was rejected before/after spawning
    (validation failure, timeout, etc.). A non-zero `exit_code` with
    `error == None` is a normal "command ran but failed" result, not a
    bridge error — the renderer should still display stdout/stderr.
    """

    id: str
    command: str
    lane_id: str | None
    cwd: str
    started_at: str
    finished_at: str
    exit_code: int | None
    stdout: str
    stderr: str
    stdout_truncated: bool
    stderr_truncated: bool
    timeout_seconds: int
    max_output_chars: int
    error: str | None

    def to_json(self) -> dict[str, Any]:
        return {
            "version": RUN_FILE_VERSION,
            "id": self.id,
            "command": self.command,
            "lane_id": self.lane_id,
            "cwd": self.cwd,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "exit_code": self.exit_code,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "stdout_truncated": self.stdout_truncated,
            "stderr_truncated": self.stderr_truncated,
            "timeout_seconds": self.timeout_seconds,
            "max_output_chars": self.max_output_chars,
            "error": self.error,
        }

    @classmethod
    def from_json(cls, raw: object) -> "RunRecord":
        if not isinstance(raw, dict):
            raise RunFileError(f"run file must be an object, got {type(raw).__name__}")
        try:
            return cls(
                id=str(raw["id"]),
                command=str(raw.get("command", "")),
                lane_id=raw.get("lane_id") if isinstance(raw.get("lane_id"), str) else None,
                cwd=str(raw.get("cwd", "")),
                started_at=str(raw.get("started_at", "")),
                finished_at=str(raw.get("finished_at", "")),
                exit_code=(
                    int(raw["exit_code"])
                    if isinstance(raw.get("exit_code"), int)
                    else None
                ),
                stdout=str(raw.get("stdout", "")),
                stderr=str(raw.get("stderr", "")),
                stdout_truncated=bool(raw.get("stdout_truncated", False)),
                stderr_truncated=bool(raw.get("stderr_truncated", False)),
                timeout_seconds=int(raw.get("timeout_seconds", DEFAULT_RUN_TIMEOUT_SECONDS)),
                max_output_chars=int(
                    raw.get("max_output_chars", DEFAULT_RUN_MAX_OUTPUT_CHARS)
                ),
                error=raw["error"] if isinstance(raw.get("error"), str) else None,
            )
        except KeyError as exc:
            raise RunFileError(f"run file missing required field: {exc.args[0]!r}") from exc


@dataclass(slots=True, frozen=True)
class RunSummary:
    """Lightweight projection used by the list endpoint."""

    id: str
    command: str
    lane_id: str | None
    started_at: str
    exit_code: int | None
    error: str | None

    @classmethod
    def from_record(cls, record: RunRecord) -> "RunSummary":
        return cls(
            id=record.id,
            command=record.command,
            lane_id=record.lane_id,
            started_at=record.started_at,
            exit_code=record.exit_code,
            error=record.error,
        )


_ID_SAFE_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
_ID_FORMAT = "%Y%m%dT%H%M%S"


def generate_run_id(now: datetime | None = None) -> str:
    """Sortable, filesystem-safe run id (`<UTC ts>-<8 hex bytes>`)."""
    moment = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    return f"{moment.strftime(_ID_FORMAT).lower()}-{secrets.token_hex(8)}"


def _validate_run_id(candidate: str) -> str:
    if "/" in candidate or "\\" in candidate or ".." in candidate or "\x00" in candidate:
        raise ValueError(f"Invalid run id (path-like characters): {candidate!r}")
    lowered = candidate.strip().lower()
    if not _ID_SAFE_RE.match(lowered):
        raise ValueError(f"Invalid run id: {candidate!r}")
    return lowered


def _now_iso(now: datetime | None = None) -> str:
    moment = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


class RunsStore:
    """Filesystem-backed log of user-initiated commands.

    Each run is one ``<id>.json`` file under ``.casefile/runs/``. Like
    findings, no separate index file: the directory listing is fast enough
    and avoids index-drift bugs.
    """

    def __init__(self, casefile_root: Path) -> None:
        self.casefile = Casefile(root=Path(casefile_root).resolve())

    @property
    def directory(self) -> Path:
        return self.casefile.metadata_dir / "runs"

    def _path_for(self, run_id: str) -> Path:
        safe = _validate_run_id(run_id)
        return self.directory / f"{safe}.json"

    def ensure_directory(self) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)

    # ----- listing / reading -----

    def list(self, *, lane_id: str | None = None) -> list[RunSummary]:
        if not self.directory.exists():
            return []
        records: list[RunRecord] = []
        for entry in self.directory.iterdir():
            if entry.suffix != ".json" or not entry.is_file():
                continue
            try:
                records.append(self._load_file(entry))
            except RunFileError:
                # A single corrupt file mustn't blank the whole tab.
                continue
        if lane_id is not None:
            records = [r for r in records if r.lane_id == lane_id]
        # Newest first; started_at is ISO-8601 so lex order works.
        records.sort(key=lambda r: r.started_at, reverse=True)
        return [RunSummary.from_record(r) for r in records]

    def get(self, run_id: str) -> RunRecord:
        path = self._path_for(run_id)
        if not path.exists():
            raise KeyError(f"Unknown run id: {run_id}")
        return self._load_file(path)

    def delete(self, run_id: str) -> None:
        path = self._path_for(run_id)
        if not path.exists():
            raise KeyError(f"Unknown run id: {run_id}")
        path.unlink()

    # ----- start a new run -----

    def start(
        self,
        *,
        command: str,
        cwd: Path,
        lane_id: str | None = None,
        timeout_seconds: int = DEFAULT_RUN_TIMEOUT_SECONDS,
        max_output_chars: int = DEFAULT_RUN_MAX_OUTPUT_CHARS,
        now: datetime | None = None,
    ) -> RunRecord:
        """Validate, execute, and persist a new run.

        Validation failures (allowlist, path-invocation, range) are
        captured into the persisted record's ``error`` field so the
        renderer can show *why* a run was rejected rather than just
        getting an opaque bridge error. Execution failures (timeout,
        OSError) are recorded the same way.
        """
        cwd_resolved = Path(cwd).resolve()
        run_id = generate_run_id(now)
        started_at = _now_iso(now)

        # Default record skeleton — gets fleshed out below.
        def _build(
            *,
            exit_code: int | None,
            stdout: str = "",
            stderr: str = "",
            stdout_truncated: bool = False,
            stderr_truncated: bool = False,
            error: str | None = None,
            recorded_command: str | None = None,
        ) -> RunRecord:
            return RunRecord(
                id=run_id,
                command=recorded_command if recorded_command is not None else command,
                lane_id=lane_id,
                cwd=str(cwd_resolved),
                started_at=started_at,
                finished_at=_now_iso(),
                exit_code=exit_code,
                stdout=stdout,
                stderr=stderr,
                stdout_truncated=stdout_truncated,
                stderr_truncated=stderr_truncated,
                timeout_seconds=timeout_seconds,
                max_output_chars=max_output_chars,
                error=error,
            )

        try:
            argv = validate_command(command)
        except (ValueError, PermissionError) as exc:
            record = _build(exit_code=None, error=f"{type(exc).__name__}: {exc}")
            self._write(record)
            return record

        try:
            result = run_safe(
                argv,
                cwd=cwd_resolved,
                timeout_seconds=timeout_seconds,
                max_output_chars=max_output_chars,
            )
        except (ValueError, TimeoutError, OSError) as exc:
            record = _build(
                exit_code=None,
                error=f"{type(exc).__name__}: {exc}",
                recorded_command=" ".join(argv),
            )
            self._write(record)
            return record

        record = _build(
            exit_code=int(result.get("exit_code", -1)),
            stdout=str(result.get("stdout", "")),
            stderr=str(result.get("stderr", "")),
            stdout_truncated=bool(result.get("stdout_truncated", False)),
            stderr_truncated=bool(result.get("stderr_truncated", False)),
            recorded_command=str(result.get("command", " ".join(argv))),
        )
        self._write(record)
        return record

    # ----- internal IO -----

    def _write(self, record: RunRecord) -> None:
        self.ensure_directory()
        path = self._path_for(record.id)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(record.to_json(), indent=2), encoding="utf-8")
        tmp.replace(path)

    def _load_file(self, path: Path) -> RunRecord:
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise RunFileError(f"failed to read {path.name}: {exc}") from exc
        return RunRecord.from_json(raw)


__all__ = [
    "DEFAULT_RUN_MAX_OUTPUT_CHARS",
    "DEFAULT_RUN_TIMEOUT_SECONDS",
    "RUN_FILE_VERSION",
    "RunFileError",
    "RunRecord",
    "RunSummary",
    "RunsStore",
    "generate_run_id",
]
