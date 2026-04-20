from __future__ import annotations

import json
import re
import secrets
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Literal

from assistant_app.casefile.models import Casefile

FINDING_FILE_VERSION = 1

Severity = Literal["info", "low", "medium", "high", "critical"]
SEVERITIES: tuple[Severity, ...] = ("info", "low", "medium", "high", "critical")
DEFAULT_SEVERITY: Severity = "info"


class FindingFileError(ValueError):
    """Raised when a finding JSON file is malformed in a way the loader cannot recover from."""


def coerce_severity(value: object) -> Severity:
    if isinstance(value, str) and value in SEVERITIES:
        return value  # type: ignore[return-value]
    return DEFAULT_SEVERITY


@dataclass(slots=True, frozen=True)
class SourceRef:
    """A pointer back into a lane's filesystem.

    `line_start`/`line_end` are 1-indexed and inclusive; both optional so a
    SourceRef can also point at a whole file (most common for review
    findings).
    """

    lane_id: str
    path: str
    line_start: int | None = None
    line_end: int | None = None

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {"lane_id": self.lane_id, "path": self.path}
        if self.line_start is not None:
            out["line_start"] = self.line_start
        if self.line_end is not None:
            out["line_end"] = self.line_end
        return out

    @classmethod
    def from_json(cls, raw: object) -> "SourceRef":
        if not isinstance(raw, dict):
            raise FindingFileError(f"source_ref must be an object, got {type(raw).__name__}")
        lane_id = raw.get("lane_id")
        path = raw.get("path")
        if not isinstance(lane_id, str) or not lane_id:
            raise FindingFileError("source_ref.lane_id is required")
        if not isinstance(path, str) or not path:
            raise FindingFileError("source_ref.path is required")
        line_start = raw.get("line_start")
        line_end = raw.get("line_end")
        return cls(
            lane_id=lane_id,
            path=path,
            line_start=int(line_start) if isinstance(line_start, int) else None,
            line_end=int(line_end) if isinstance(line_end, int) else None,
        )


@dataclass(slots=True, frozen=True)
class Finding:
    """A captured observation against one or two lanes.

    `lane_ids` carries the lane(s) the finding is *about*. A single-lane
    finding has one entry; a comparison finding has exactly two. We store a
    list rather than two separate fields so the same shape works for both
    cases and so future "applies to lanes A,B,C" extensions don't require
    a schema change.
    """

    id: str
    title: str
    body: str
    severity: Severity
    created_at: str  # ISO-8601 UTC, lexically sortable
    updated_at: str
    lane_ids: tuple[str, ...]
    source_refs: tuple[SourceRef, ...] = field(default_factory=tuple)

    def to_json(self) -> dict[str, Any]:
        return {
            "version": FINDING_FILE_VERSION,
            "id": self.id,
            "title": self.title,
            "body": self.body,
            "severity": self.severity,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "lane_ids": list(self.lane_ids),
            "source_refs": [ref.to_json() for ref in self.source_refs],
        }

    @classmethod
    def from_json(cls, raw: object) -> "Finding":
        if not isinstance(raw, dict):
            raise FindingFileError("Finding file must be a JSON object")
        version = raw.get("version")
        if not isinstance(version, int) or version > FINDING_FILE_VERSION:
            raise FindingFileError(
                f"Unsupported finding version: {version!r} (this build understands <= {FINDING_FILE_VERSION})"
            )
        finding_id = raw.get("id")
        if not isinstance(finding_id, str) or not finding_id:
            raise FindingFileError("Finding requires an 'id'")
        title = raw.get("title")
        if not isinstance(title, str):
            raise FindingFileError("Finding 'title' must be a string")
        body = raw.get("body") if isinstance(raw.get("body"), str) else ""
        severity = coerce_severity(raw.get("severity"))
        created_at = raw.get("created_at")
        updated_at = raw.get("updated_at")
        if not isinstance(created_at, str) or not created_at:
            raise FindingFileError("Finding 'created_at' must be a non-empty string")
        if not isinstance(updated_at, str) or not updated_at:
            updated_at = created_at
        raw_lanes = raw.get("lane_ids")
        if not isinstance(raw_lanes, list) or not raw_lanes or not all(
            isinstance(item, str) and item for item in raw_lanes
        ):
            raise FindingFileError("Finding 'lane_ids' must be a non-empty list of strings")
        raw_refs = raw.get("source_refs", [])
        if not isinstance(raw_refs, list):
            raise FindingFileError("Finding 'source_refs' must be a list")
        return cls(
            id=finding_id,
            title=title,
            body=body,
            severity=severity,
            created_at=created_at,
            updated_at=updated_at,
            lane_ids=tuple(raw_lanes),
            source_refs=tuple(SourceRef.from_json(ref) for ref in raw_refs),
        )


_ID_SAFE_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
_ID_FORMAT = "%Y%m%dT%H%M%S"


def generate_finding_id(now: datetime | None = None) -> str:
    """Generate a stable, sortable, filesystem-safe finding id.

    Format: `<UTC timestamp>-<6 hex chars>`. The timestamp prefix gives us
    chronological ordering without a separate sort key file; the hex suffix
    handles the case where two findings are created in the same second.
    """
    moment = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    # Lowercased so the in-memory id matches the on-disk filename without
    # round-tripping through `_validate_finding_id`.
    return f"{moment.strftime(_ID_FORMAT).lower()}-{secrets.token_hex(3)}"


def _validate_finding_id(candidate: str) -> str:
    if "/" in candidate or "\\" in candidate or ".." in candidate or "\x00" in candidate:
        raise ValueError(f"Invalid finding id (path-like characters): {candidate!r}")
    lowered = candidate.strip().lower()
    if not _ID_SAFE_RE.match(lowered):
        raise ValueError(f"Invalid finding id: {candidate!r}")
    return lowered


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class FindingsStore:
    """Filesystem-backed CRUD for `.casefile/findings/`.

    Each finding is one `<id>.json` file. We deliberately do not maintain a
    separate index; listing the directory is fast enough at the casefile
    sizes we expect, and dropping the index removes a class of "index drifted
    from files" bugs.
    """

    def __init__(self, casefile_root: Path) -> None:
        self.casefile = Casefile(root=Path(casefile_root).resolve())

    # ----- paths -----

    @property
    def directory(self) -> Path:
        return self.casefile.metadata_dir / "findings"

    def _path_for(self, finding_id: str) -> Path:
        safe = _validate_finding_id(finding_id)
        return self.directory / f"{safe}.json"

    def ensure_directory(self) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)

    # ----- CRUD -----

    def list(self, *, lane_id: str | None = None) -> list[Finding]:
        if not self.directory.exists():
            return []
        findings: list[Finding] = []
        for entry in self.directory.iterdir():
            if entry.suffix != ".json" or not entry.is_file():
                continue
            try:
                finding = self._load_file(entry)
            except FindingFileError:
                # Skip but do not crash: a single corrupt file should not
                # prevent the user from seeing the rest of their findings.
                # Future: surface the corrupt file in the UI.
                continue
            if lane_id is None or lane_id in finding.lane_ids:
                findings.append(finding)
        # Newest first — created_at is ISO-8601 so lexicographic order works.
        findings.sort(key=lambda f: f.created_at, reverse=True)
        return findings

    def get(self, finding_id: str) -> Finding:
        path = self._path_for(finding_id)
        if not path.exists():
            raise KeyError(f"Unknown finding id: {finding_id}")
        return self._load_file(path)

    def create(
        self,
        *,
        title: str,
        body: str,
        severity: str,
        lane_ids: Iterable[str],
        source_refs: Iterable[SourceRef] = (),
        finding_id: str | None = None,
        now: datetime | None = None,
    ) -> Finding:
        title_clean = title.strip()
        if not title_clean:
            raise ValueError("Finding title is required")
        lanes_tuple = tuple(lane_ids)
        if not lanes_tuple:
            raise ValueError("Finding requires at least one lane_id")
        for lane in lanes_tuple:
            if not isinstance(lane, str) or not lane:
                raise ValueError("lane_ids entries must be non-empty strings")
        timestamp = _now_iso() if now is None else now.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        new_id = _validate_finding_id(finding_id) if finding_id else generate_finding_id(now)
        finding = Finding(
            id=new_id,
            title=title_clean,
            body=body,
            severity=coerce_severity(severity),
            created_at=timestamp,
            updated_at=timestamp,
            lane_ids=lanes_tuple,
            source_refs=tuple(source_refs),
        )
        self._write_finding(finding, expect_existing=False)
        return finding

    def update(
        self,
        finding_id: str,
        *,
        title: str | None = None,
        body: str | None = None,
        severity: str | None = None,
        lane_ids: Iterable[str] | None = None,
        source_refs: Iterable[SourceRef] | None = None,
        now: datetime | None = None,
    ) -> Finding:
        existing = self.get(finding_id)
        new_title = existing.title if title is None else title.strip()
        if not new_title:
            raise ValueError("Finding title is required")
        new_lanes = existing.lane_ids if lane_ids is None else tuple(lane_ids)
        if not new_lanes:
            raise ValueError("Finding requires at least one lane_id")
        new_refs = (
            existing.source_refs if source_refs is None else tuple(source_refs)
        )
        updated = replace(
            existing,
            title=new_title,
            body=existing.body if body is None else body,
            severity=existing.severity if severity is None else coerce_severity(severity),
            lane_ids=new_lanes,
            source_refs=new_refs,
            updated_at=(
                _now_iso()
                if now is None
                else now.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            ),
        )
        self._write_finding(updated, expect_existing=True)
        return updated

    def delete(self, finding_id: str) -> None:
        path = self._path_for(finding_id)
        if not path.exists():
            raise KeyError(f"Unknown finding id: {finding_id}")
        path.unlink()

    # ----- internals -----

    def _write_finding(self, finding: Finding, *, expect_existing: bool) -> None:
        self.ensure_directory()
        path = self._path_for(finding.id)
        if expect_existing and not path.exists():
            raise KeyError(f"Cannot update missing finding: {finding.id}")
        if not expect_existing and path.exists():
            raise FileExistsError(f"Finding already exists: {finding.id}")
        # Atomic write: write to .tmp then rename. Avoids leaving a half-written
        # finding on disk if the process is interrupted mid-write.
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(finding.to_json(), indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        tmp.replace(path)

    def _load_file(self, path: Path) -> Finding:
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as exc:
            raise FindingFileError(f"Cannot read {path}: {exc}") from exc
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            raise FindingFileError(f"Malformed JSON in {path}: {exc}") from exc
        return Finding.from_json(data)
