from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Iterator

from assistant_app.casefile.models import Lane


# Files/directories that are noise for a lane comparison. The casefile metadata
# directory is excluded because it carries our own bookkeeping (lanes.json,
# chats, findings) which is intentionally not part of "what differs between
# the two attempts".
DEFAULT_SKIP_DIR_NAMES: frozenset[str] = frozenset(
    {".casefile", ".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv"}
)


@dataclass(slots=True, frozen=True)
class FileEntry:
    """A single file's relative path and content hash inside a lane."""

    path: str  # POSIX-style relative path, lane-root-relative
    sha256: str
    size: int


@dataclass(slots=True, frozen=True)
class ChangedFile:
    path: str
    left_sha256: str
    right_sha256: str
    left_size: int
    right_size: int


@dataclass(slots=True, frozen=True)
class LaneComparison:
    """The result of `compare_lanes(a, b)`.

    `added` are files present in `right` but not `left`; `removed` are
    present in `left` but not `right`; `changed` are present in both but
    differ by content hash. Identical files are deliberately not surfaced.
    """

    left_lane_id: str
    right_lane_id: str
    added: tuple[str, ...]
    removed: tuple[str, ...]
    changed: tuple[ChangedFile, ...]

    def to_json(self) -> dict[str, object]:
        return {
            "leftLaneId": self.left_lane_id,
            "rightLaneId": self.right_lane_id,
            "added": list(self.added),
            "removed": list(self.removed),
            "changed": [
                {
                    "path": c.path,
                    "leftSha256": c.left_sha256,
                    "rightSha256": c.right_sha256,
                    "leftSize": c.left_size,
                    "rightSize": c.right_size,
                }
                for c in self.changed
            ],
        }


def _walk_files(
    root: Path, *, skip_dir_names: frozenset[str], max_files: int
) -> Iterator[Path]:
    count = 0
    stack: list[Path] = [root]
    while stack:
        current = stack.pop()
        try:
            children = sorted(current.iterdir(), key=lambda p: p.name)
        except (FileNotFoundError, PermissionError):
            continue
        for child in children:
            if child.is_symlink():
                # Skip symlinks: following them risks both cycles and
                # leaking out of the lane root.
                continue
            if child.is_dir():
                if child.name in skip_dir_names:
                    continue
                stack.append(child)
            elif child.is_file():
                if count >= max_files:
                    raise RuntimeError(
                        f"Lane comparison exceeded {max_files} files; refusing to continue."
                    )
                count += 1
                yield child


def _hash_file(path: Path, *, max_bytes: int) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(65536)
            if not chunk:
                break
            digest.update(chunk)
            size += len(chunk)
            if size > max_bytes:
                # File exceeds max_bytes.  Rather than returning a bare
                # "oversize:{N}" marker (which would make *all* oversized files
                # compare equal regardless of content), include a partial hash
                # of the bytes read so far.  Two different oversized files will
                # almost certainly produce different partial hashes, giving
                # true changed-detection instead of false negatives.
                return f"oversize:{max_bytes}:{digest.hexdigest()[:16]}", size
    return digest.hexdigest(), size


@dataclass
class _BytesBudget:
    """Mutable counter for total bytes read across both lanes in a comparison."""

    bytes_read: int = field(default=0)


def _index_lane(
    lane_root: Path,
    *,
    skip_dir_names: frozenset[str],
    max_files: int,
    max_bytes_per_file: int,
    budget: _BytesBudget,
    max_total_bytes: int,
) -> dict[str, FileEntry]:
    resolved_root = lane_root.resolve()
    if not resolved_root.exists() or not resolved_root.is_dir():
        return {}
    index: dict[str, FileEntry] = {}
    for path in _walk_files(resolved_root, skip_dir_names=skip_dir_names, max_files=max_files):
        try:
            rel = path.relative_to(resolved_root)
        except ValueError:
            continue
        sha, size = _hash_file(path, max_bytes=max_bytes_per_file)
        budget.bytes_read += min(size, max_bytes_per_file)
        if budget.bytes_read > max_total_bytes:
            raise RuntimeError(
                f"Lane comparison exceeded {max_total_bytes:,} bytes total across "
                "both lanes; refusing to continue. Use a smaller lane root or "
                "increase max_total_bytes."
            )
        index[rel.as_posix()] = FileEntry(path=rel.as_posix(), sha256=sha, size=size)
    return index


def compare_lanes(
    left: Lane,
    right: Lane,
    *,
    skip_dir_names: Iterable[str] = DEFAULT_SKIP_DIR_NAMES,
    max_files_per_lane: int = 250_000,
    max_bytes_per_file: int = 5_000_000,
    max_total_bytes: int = 2_000_000_000,
) -> LaneComparison:
    """Compute file-level differences between two lanes.

    The comparison is content-based (sha256), not size/mtime, so a "no-op"
    edit (open + save) does not surface as a change. Symlinks are skipped
    on purpose to avoid both cycles and lane-escape paths. Common build /
    VCS / metadata directories are skipped by default; pass an empty
    `skip_dir_names` to compare verbatim.

    ``max_total_bytes`` caps the combined byte-read work across both lanes
    (default 2 GB).  Raise it explicitly for unusually large lane roots;
    do not remove it, as a malicious or misconfigured lane root (e.g. a bind
    mount of /proc) could otherwise lock the process for minutes.
    """
    skip_set = frozenset(skip_dir_names)
    # Shared budget so the limit applies to the combined work of both lanes.
    budget = _BytesBudget()
    left_index = _index_lane(
        left.root,
        skip_dir_names=skip_set,
        max_files=max_files_per_lane,
        max_bytes_per_file=max_bytes_per_file,
        budget=budget,
        max_total_bytes=max_total_bytes,
    )
    right_index = _index_lane(
        right.root,
        skip_dir_names=skip_set,
        max_files=max_files_per_lane,
        max_bytes_per_file=max_bytes_per_file,
        budget=budget,
        max_total_bytes=max_total_bytes,
    )
    left_paths = set(left_index)
    right_paths = set(right_index)
    added = sorted(right_paths - left_paths)
    removed = sorted(left_paths - right_paths)
    changed: list[ChangedFile] = []
    for path in sorted(left_paths & right_paths):
        l = left_index[path]
        r = right_index[path]
        if l.sha256 != r.sha256:
            changed.append(
                ChangedFile(
                    path=path,
                    left_sha256=l.sha256,
                    right_sha256=r.sha256,
                    left_size=l.size,
                    right_size=r.size,
                )
            )
    return LaneComparison(
        left_lane_id=left.id,
        right_lane_id=right.id,
        added=tuple(added),
        removed=tuple(removed),
        changed=tuple(changed),
    )
