from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

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
    read_overlays: tuple[ReadOverlay, ...] = field(default_factory=tuple)
    context_files: tuple[ResolvedContextFile, ...] = field(default_factory=tuple)
    auto_include_max_bytes: int = 0
    casefile_root: Path = field(default_factory=lambda: Path("."))

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
