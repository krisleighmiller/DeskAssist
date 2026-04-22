from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

from assistant_app.casefile.context import (
    ContextManifest,
    ContextManifestStore,
    ResolvedContextFile,
)
from assistant_app.casefile.models import CasefileSnapshot

# Virtual path prefixes the chat model sees in tool responses. Stable, short,
# and chosen so they cannot collide with any sane real directory name (the
# leading underscore is the giveaway). Documented to the model in the chat
# system prompt.
ANCESTOR_PREFIX = "_ancestors"
ATTACHMENT_PREFIX = "_attachments"
CONTEXT_PREFIX = "_context"
# M3.5c: comparison-chat sessions surface every participating lane under
# `_lanes/<lane_id>/...` so the model has a stable virtual prefix for "the
# files that belong to lane X" even when X is not the (non-existent) write
# root of the session.
LANES_PREFIX = "_lanes"


@dataclass(slots=True, frozen=True)
class ReadOverlay:
    """One read-only root surfaced to the chat under a virtual prefix.

    `prefix` is the full virtual path (e.g. `_ancestors/TASK_9`,
    `_attachments/ash_notes`). The model uses this prefix in tool calls;
    the WorkspaceFilesystem rewrites it to `root` before touching disk.
    """

    prefix: str
    root: Path
    label: str  # Human-friendly label for the system prompt (e.g. lane name).


@dataclass(slots=True, frozen=True)
class ScopeContext:
    """The fully-resolved read/write context for a chat in one lane.

    A chat in this scope:
      - writes only to `write_root` (the lane's own directory),
      - reads from `write_root` *and* every overlay in `read_overlays`,
      - sees casefile-wide context files under `_context/...`.

    The resolver guarantees `read_overlays` is in priority order:
    attachments first (paired notes are usually closest in intent), then
    ancestors nearest-first (parent before grandparent), then the casefile
    context bucket. Order matters when two roots happen to have the same
    relative subpath — the first match wins.
    """

    lane_id: str
    write_root: Path
    # `casefile_root` is required: it anchors the `_context/...` overlay,
    # which would otherwise default to a relative `Path(".")` and silently
    # resolve to the process CWD at use time. That footgun is bad enough
    # for a chat tool that may modify the model's view of the workspace,
    # so we require callers to pass an explicit (typically absolute) path.
    casefile_root: Path
    read_overlays: tuple[ReadOverlay, ...] = field(default_factory=tuple)
    context_files: tuple[ResolvedContextFile, ...] = field(default_factory=tuple)
    auto_include_max_bytes: int = 0

    def overlay_map(self) -> dict[str, Path]:
        """Adapter for `WorkspaceFilesystem(read_overlays=...)`."""
        mapping: dict[str, Path] = {
            overlay.prefix: overlay.root for overlay in self.read_overlays
        }
        # The casefile context bucket is itself an overlay; the model can
        # `read_file("_context/Behavior_Issues.md")` directly. We point it
        # at the casefile root and rely on the file list in `context_files`
        # to advertise the available paths.
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
    """Compute the `ScopeContext` for the given lane.

    `manifest` and `context_files` are accepted as parameters so callers can
    inject a stub in tests or reuse a freshly-loaded manifest, but if either
    is None the resolver loads it from disk via `ContextManifestStore`.
    """
    lane = snapshot.lane_by_id(lane_id)
    overlays: list[ReadOverlay] = []

    # Attachments first — they're the most specific extra context
    # (typically paired notes for the same lane).
    for attachment in lane.attachments:
        overlays.append(
            ReadOverlay(
                prefix=f"{ATTACHMENT_PREFIX}/{attachment.name}",
                root=attachment.root,
                label=attachment.name,
            )
        )

    # Then ancestors, nearest first. Each ancestor contributes its own root
    # and its attachments. We deliberately do *not* include an ancestor's
    # *other children* — siblings remain isolated, which is the M2 promise.
    for ancestor in snapshot.ancestors_of(lane_id):
        overlays.append(
            ReadOverlay(
                prefix=f"{ANCESTOR_PREFIX}/{ancestor.id}",
                root=ancestor.root,
                label=ancestor.name,
            )
        )
        for attachment in ancestor.attachments:
            overlays.append(
                ReadOverlay(
                    prefix=f"{ANCESTOR_PREFIX}/{ancestor.id}/{ATTACHMENT_PREFIX}/{attachment.name}",
                    root=attachment.root,
                    label=f"{ancestor.name} / {attachment.name}",
                )
            )

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

    return ScopeContext(
        lane_id=lane.id,
        write_root=lane.root,
        read_overlays=tuple(overlays),
        context_files=loaded_files,
        auto_include_max_bytes=loaded_manifest.auto_include_max_bytes,
        casefile_root=snapshot.casefile.root,
    )


def comparison_id_for_lanes(lane_ids: Iterable[str]) -> str:
    """Stable synthetic id for a comparison session over the given lanes.

    Sorted so order of selection is irrelevant and the chat log path is
    deterministic — selecting (a, b) and then later (b, a) reuses the same
    history file.  Re-validates each id through the lane-id normaliser so a
    bad input never lands as a filename component.
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
    """Compute the read-only ``ScopeContext`` for a comparison chat.

    A comparison session has *no* write root — by construction every tool
    call is read-only.  We still produce a ``ScopeContext`` so the chat
    pipeline can reuse the single-lane plumbing; the caller is responsible
    for building the tool registry with writes disabled (see
    ``build_default_tool_registry(..., enable_writes=False)``).

    The returned ``write_root`` is the casefile root: a stable, real
    directory we can hand to ``WorkspaceFilesystem`` even though no save /
    append / delete tool will ever resolve a path against it.

    The overlay set is the union of:
      - each participating lane surfaced as ``_lanes/<lane_id>/...`` so the
        model can name "the files of lane X" with a stable prefix,
      - each lane's full ancestor + attachment cascade,
      - the casefile-wide context manifest (loaded once, shared across
        lanes).

    Overlays are de-duplicated by prefix; if two participating lanes share
    an ancestor (which is the common case for siblings), that ancestor's
    overlay is registered exactly once.
    """
    from assistant_app.casefile.context import ContextManifestStore  # avoid cycle

    ids = sorted({raw for raw in lane_ids if raw})
    if len(ids) < 2:
        raise ValueError("Comparison requires at least two distinct lane ids")
    # Validate every lane exists *before* we start building overlays so a
    # typo surfaces as a clean KeyError, not a half-built scope.
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

    overlays: list[ReadOverlay] = []
    seen_prefixes: set[str] = set()

    def _add(prefix: str, root: Path, label: str) -> None:
        if prefix in seen_prefixes:
            return
        seen_prefixes.add(prefix)
        overlays.append(ReadOverlay(prefix=prefix, root=root, label=label))

    for lane in lanes:
        _add(f"{LANES_PREFIX}/{lane.id}", lane.root, lane.name)
        for attachment in lane.attachments:
            _add(
                f"{LANES_PREFIX}/{lane.id}/{ATTACHMENT_PREFIX}/{attachment.name}",
                attachment.root,
                f"{lane.name} / {attachment.name}",
            )
        for ancestor in snapshot.ancestors_of(lane.id):
            _add(
                f"{ANCESTOR_PREFIX}/{ancestor.id}",
                ancestor.root,
                ancestor.name,
            )
            for attachment in ancestor.attachments:
                _add(
                    f"{ANCESTOR_PREFIX}/{ancestor.id}/{ATTACHMENT_PREFIX}/{attachment.name}",
                    attachment.root,
                    f"{ancestor.name} / {attachment.name}",
                )

    return ScopeContext(
        lane_id=comparison_id_for_lanes(ids),
        write_root=snapshot.casefile.root,
        read_overlays=tuple(overlays),
        context_files=loaded_files,
        auto_include_max_bytes=loaded_manifest.auto_include_max_bytes,
        casefile_root=snapshot.casefile.root,
    )
