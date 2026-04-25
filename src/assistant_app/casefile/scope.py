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
from assistant_app.casefile.models import CasefileSnapshot, ContextAttachment, ScopedDirectory

# All in-scope directories (excluding the write root) are surfaced to the
# model under this flat prefix: `_scope/<label>/`.  The label is the
# human-readable name of the directory, slugified and de-duplicated.
# The model sees a flat list of named roots with no structural hierarchy
# encoded in the path.
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

    The ``context_id`` field keeps the session anchored to a persistence key
    (used for chat log filenames).  For single-context sessions this is the
    context's own id; for multi-context (comparison) sessions it is the synthetic
    comparison id.

    ``casefile_root`` anchors the ``_context/`` overlay for casefile-wide
    context files.
    """

    context_id: str
    directories: tuple[ScopedDirectory, ...]
    casefile_root: Path
    context_files: tuple[ResolvedContextFile, ...] = field(default_factory=tuple)
    auto_include_max_bytes: int = 0

    @property
    def write_root(self) -> Path:
        """Primary write root: first writable directory, or casefile_root as fallback.

        The fallback keeps the comparison-chat code path working without changes:
        when a session has no writable directories, callers still get a stable
        root for bare relative reads while write tools remain disabled.
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
    context_id: str,
    *,
    manifest: ContextManifest | None = None,
    context_files: tuple[ResolvedContextFile, ...] | None = None,
) -> ScopeContext:
    """Compute the ``ScopeContext`` for the given context.

    The session contains the context root plus the directories explicitly
    attached to that context. Structural parents are UI organization only; they
    are not added to AI scope implicitly.

    Labels are guaranteed unique within the session; a ``_2`` / ``_3``
    suffix is appended when two directories would otherwise share a label.
    """
    context = snapshot.context_by_id(context_id)

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

    # Context root: writability is now user-configured via context.writable.
    write_label = _unique_label(_slug(context.name), seen_labels)
    dirs.append(ScopedDirectory(path=context.root, label=write_label, writable=context.writable))

    # Attachments: use the attachment's own mode field.
    for attachment in context.attachments:
        label = _unique_label(_slug(attachment.name), seen_labels)
        dirs.append(ScopedDirectory(path=attachment.root, label=label, writable=(attachment.mode == "write")))

    return ScopeContext(
        context_id=context.id,
        directories=tuple(dirs),
        casefile_root=snapshot.casefile.root,
        context_files=loaded_files,
        auto_include_max_bytes=loaded_manifest.auto_include_max_bytes,
    )


def comparison_id_for_contexts(context_ids: Iterable[str]) -> str:
    """Stable synthetic id for a comparison session over the given contexts.

    Sorted so order of selection is irrelevant; selecting (a, b) and then
    (b, a) later reuses the same history file.
    """
    from assistant_app.casefile.store import normalize_context_id  # avoid cycle

    ids = sorted({normalize_context_id(raw) for raw in context_ids})
    if len(ids) < 2:
        raise ValueError("Comparison requires at least two distinct context ids")
    return "_compare__" + "__".join(ids)


def resolve_comparison_scope(
    snapshot: CasefileSnapshot,
    context_ids: Iterable[str],
    *,
    manifest: ContextManifest | None = None,
    context_files: tuple[ResolvedContextFile, ...] | None = None,
    comparison_attachments: Iterable[ContextAttachment] | None = None,
) -> ScopeContext:
    """Compute the ``ScopeContext`` for a multi-context session.

    Each selected context contributes its own root and direct attachments with
    their current access mode. Comparison-session-specific attachments are
    appended as first-class scope entries. Structural parents are not inherited
    into AI scope. Labels are de-duplicated so two directories that would
    otherwise share a label get ``name_2``, ``name_3``, etc.
    """
    from assistant_app.casefile.context import ContextManifestStore  # avoid cycle

    ids = sorted({raw for raw in context_ids if raw})
    if len(ids) < 2:
        raise ValueError("Comparison requires at least two distinct context ids")
    contexts = [snapshot.context_by_id(lid) for lid in ids]

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

    def _add(path: Path, name: str, *, writable: bool) -> None:
        if path in seen_paths:
            return
        seen_paths.add(path)
        label = _unique_label(_slug(name), seen_labels)
        dirs.append(ScopedDirectory(path=path, label=label, writable=writable))

    for context in contexts:
        _add(context.root, context.name, writable=context.writable)
        for att in context.attachments:
            _add(att.root, att.name, writable=(att.mode == "write"))
    for att in comparison_attachments or ():
        _add(att.root, att.name, writable=(att.mode == "write"))
    return ScopeContext(
        context_id=comparison_id_for_contexts(ids),
        directories=tuple(dirs),
        casefile_root=snapshot.casefile.root,
        context_files=loaded_files,
        auto_include_max_bytes=loaded_manifest.auto_include_max_bytes,
    )
