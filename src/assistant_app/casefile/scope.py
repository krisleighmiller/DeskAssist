from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

from assistant_app.casefile.context import (
    ContextManifest,
    ContextManifestStore,
    ResolvedContextFile,
)
from assistant_app.casefile.models import CasefileSnapshot, ScopedDirectory

# All in-scope directories (excluding the write root) are surfaced to the
# model under this flat prefix: `_scope/<label>/`.  The label is the
# human-readable name of the directory, slugified and de-duplicated.
# This replaces the old hierarchical `_ancestors/<id>/`, `_attachments/<name>/`,
# and `_lanes/<id>/` prefixes — the model now sees a flat list of named roots
# with no structural hierarchy encoded in the path.
SCOPE_PREFIX = "_scope"

# Context files stay under their own prefix so the model can distinguish
# "authoritative shared instructions" from ordinary scope directories.
CONTEXT_PREFIX = "_context"


def _slug(name: str) -> str:
    """Convert a human-readable name to a safe, lowercase virtual path segment."""
    s = re.sub(r"[^a-zA-Z0-9]", "_", name.lower().strip())
    s = re.sub(r"_+", "_", s).strip("_")
    return s or "dir"


def _unique_label(base: str, seen: set[str]) -> str:
    """Return `base` if unseen, otherwise `base_2`, `base_3`, …"""
    candidate = base
    i = 2
    while candidate in seen:
        candidate = f"{base}_{i}"
        i += 1
    seen.add(candidate)
    return candidate


@dataclass(slots=True, frozen=True)
class ScopeContext:
    """The fully-resolved scope for one chat session.

    A session is defined by a flat list of ``ScopedDirectory`` entries.
    Each entry carries a real path, a human-readable label, and a writable
    flag.  The model addresses directories via ``_scope/<label>/`` virtual
    paths; write operations are restricted to directories where
    ``writable=True``.

    The ``lane_id`` field keeps the session anchored to a persistence key
    (used for chat log filenames).  For single-lane sessions this is the
    lane's own id; for multi-lane (comparison) sessions it is the synthetic
    comparison id.

    ``casefile_root`` anchors the ``_context/`` overlay for casefile-wide
    context files.
    """

    lane_id: str
    directories: tuple[ScopedDirectory, ...]
    casefile_root: Path
    context_files: tuple[ResolvedContextFile, ...] = field(default_factory=tuple)
    auto_include_max_bytes: int = 0

    @property
    def write_root(self) -> Path:
        """Primary write root: first writable directory, or casefile_root as fallback.

        The fallback keeps the comparison-chat code path working without changes:
        comparison sessions set all directories read-only and use casefile_root
        as a dummy write root (writes are blocked by ``enable_writes=False``
        in the tool registry).
        """
        for d in self.directories:
            if d.writable:
                return d.path
        return self.casefile_root

    def overlay_map(self) -> dict[str, Path]:
        """Map virtual prefixes to real disk paths for ``WorkspaceFilesystem``.

        Read-only directories are surfaced as ``_scope/<label>/``.
        The writable directory is the ``write_root`` and is NOT in this map —
        the model addresses it with bare relative paths (no prefix).
        Context files get their own ``_context/`` prefix.
        """
        mapping: dict[str, Path] = {}
        for d in self.directories:
            if not d.writable:
                mapping[f"{SCOPE_PREFIX}/{d.label}"] = d.path
        if self.context_files:
            mapping[CONTEXT_PREFIX] = self.casefile_root
        return mapping

    def auto_include_candidates(self) -> tuple[ResolvedContextFile, ...]:
        """Subset of context_files small enough to be pre-loaded into context."""
        if self.auto_include_max_bytes <= 0:
            return ()
        return tuple(
            entry
            for entry in self.context_files
            if entry.size_bytes <= self.auto_include_max_bytes
        )


def resolve_scope(
    snapshot: CasefileSnapshot,
    lane_id: str,
    *,
    manifest: ContextManifest | None = None,
    context_files: tuple[ResolvedContextFile, ...] | None = None,
) -> ScopeContext:
    """Compute the ``ScopeContext`` for the given lane.

    The write root is the lane's own directory.  All other directories
    (attachments and ancestor lanes, in priority order) are read-only and
    surfaced under ``_scope/<label>/`` with human-readable slugified labels.

    Labels are guaranteed unique within the session; a ``_2`` / ``_3``
    suffix is appended when two directories would otherwise share a label.
    """
    lane = snapshot.lane_by_id(lane_id)

    if manifest is None or context_files is None:
        store = ContextManifestStore(snapshot.casefile.root)
        loaded_manifest = manifest or store.load()
        loaded_files = tuple(
            context_files
            if context_files is not None
            else store.resolve_files(loaded_manifest)
        )
    else:
        loaded_manifest = manifest
        loaded_files = context_files

    seen_labels: set[str] = set()
    dirs: list[ScopedDirectory] = []

    # Lane root: writability is now user-configured via lane.writable.
    write_label = _unique_label(_slug(lane.name), seen_labels)
    dirs.append(ScopedDirectory(path=lane.root, label=write_label, writable=lane.writable))

    # Attachments: use the attachment's own mode field.
    for attachment in lane.attachments:
        label = _unique_label(_slug(attachment.name), seen_labels)
        dirs.append(ScopedDirectory(path=attachment.root, label=label, writable=(attachment.mode == "write")))

    # Ancestor lanes, nearest first.  Each ancestor contributes its own
    # directory and any attachments it carries.
    for ancestor in snapshot.ancestors_of(lane_id):
        label = _unique_label(_slug(ancestor.name), seen_labels)
        dirs.append(ScopedDirectory(path=ancestor.root, label=label, writable=False))
        for att in ancestor.attachments:
            att_label = _unique_label(_slug(att.name), seen_labels)
            dirs.append(ScopedDirectory(path=att.root, label=att_label, writable=False))

    return ScopeContext(
        lane_id=lane.id,
        directories=tuple(dirs),
        casefile_root=snapshot.casefile.root,
        context_files=loaded_files,
        auto_include_max_bytes=loaded_manifest.auto_include_max_bytes,
    )


def comparison_id_for_lanes(lane_ids: Iterable[str]) -> str:
    """Stable synthetic id for a comparison session over the given lanes.

    Sorted so order of selection is irrelevant; selecting (a, b) and then
    (b, a) later reuses the same history file.
    """
    from assistant_app.casefile.store import normalize_lane_id  # avoid cycle

    ids = sorted({normalize_lane_id(raw) for raw in lane_ids})
    if len(ids) < 2:
        raise ValueError("Comparison requires at least two distinct lane ids")
    return "_compare__" + "__".join(ids)


def resolve_comparison_scope(
    snapshot: CasefileSnapshot,
    lane_ids: Iterable[str],
    *,
    manifest: ContextManifest | None = None,
    context_files: tuple[ResolvedContextFile, ...] | None = None,
) -> ScopeContext:
    """Compute the read-only ``ScopeContext`` for a multi-lane session.

    Every directory is read-only.  Each participating lane (and its
    attachments and ancestors) gets a ``_scope/<label>/`` entry.  Labels are
    de-duplicated so two lanes with the same name get ``name`` and ``name_2``.

    The ``write_root`` property falls back to ``casefile_root`` — no writes
    are possible in a comparison session (the caller must build the tool
    registry with ``enable_writes=False``).
    """
    from assistant_app.casefile.context import ContextManifestStore  # avoid cycle

    ids = sorted({raw for raw in lane_ids if raw})
    if len(ids) < 2:
        raise ValueError("Comparison requires at least two distinct lane ids")
    lanes = [snapshot.lane_by_id(lid) for lid in ids]

    if manifest is None or context_files is None:
        store = ContextManifestStore(snapshot.casefile.root)
        loaded_manifest = manifest or store.load()
        loaded_files = tuple(
            context_files
            if context_files is not None
            else store.resolve_files(loaded_manifest)
        )
    else:
        loaded_manifest = manifest
        loaded_files = context_files

    seen_labels: set[str] = set()
    seen_paths: set[Path] = set()
    dirs: list[ScopedDirectory] = []

    def _add(path: Path, name: str) -> None:
        if path in seen_paths:
            return
        seen_paths.add(path)
        label = _unique_label(_slug(name), seen_labels)
        dirs.append(ScopedDirectory(path=path, label=label, writable=False))

    for lane in lanes:
        _add(lane.root, lane.name)
        for att in lane.attachments:
            _add(att.root, att.name)
        for ancestor in snapshot.ancestors_of(lane.id):
            _add(ancestor.root, ancestor.name)
            for att in ancestor.attachments:
                _add(att.root, att.name)

    return ScopeContext(
        lane_id=comparison_id_for_lanes(ids),
        directories=tuple(dirs),
        casefile_root=snapshot.casefile.root,
        context_files=loaded_files,
        auto_include_max_bytes=loaded_manifest.auto_include_max_bytes,
    )
