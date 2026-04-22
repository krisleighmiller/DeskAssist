from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal


# Known lane kinds. Kept as a Literal so callers can rely on the name set,
# but the store also accepts arbitrary strings (forward compatibility); see
# `coerce_lane_kind` below.
LaneKind = Literal["repo", "doc", "rubric", "review", "other"]

LANE_KINDS: frozenset[str] = frozenset({"repo", "doc", "rubric", "review", "other"})
DEFAULT_LANE_KIND: LaneKind = "repo"


def coerce_lane_kind(value: object) -> LaneKind:
    """Best-effort coerce a stored kind into a known LaneKind, defaulting to 'other'.

    Forward compatibility: a casefile written by a future version of the app
    may carry a kind we do not recognize. Rather than refusing to load, we
    surface unknown kinds as 'other' at the type level. Callers that care about
    the original string should read it from the raw store.
    """
    if isinstance(value, str) and value in LANE_KINDS:
        return value  # type: ignore[return-value]
    return "other"


# An attachment is a sibling read-only directory that travels with a lane.
# Typical use: pairing analyst notes (`ash_notes/`) with the code being
# discussed (`ash/`). Attachments are exposed to chats as virtual roots
# (`_attachments/<name>/...`) and can never be written to.
AttachmentMode = Literal["read"]
DEFAULT_ATTACHMENT_MODE: AttachmentMode = "read"


@dataclass(slots=True, frozen=True)
class LaneAttachment:
    """A read-only sibling directory associated with a lane.

    `name` is the user-facing label and the virtual path segment the model
    sees (`_attachments/<name>/...`). It is normalized by the store to be
    filesystem-safe.
    `root` is an absolute directory path. It may live anywhere on disk;
    attachments are explicitly allowed to point outside the casefile.
    `mode` is reserved for future write-attachments; M3.5a only ships "read".
    """

    name: str
    root: Path
    mode: AttachmentMode = DEFAULT_ATTACHMENT_MODE


@dataclass(slots=True, frozen=True)
class Lane:
    """A registered lane inside a casefile.

    `id` is the stable identifier used in URLs, file paths
    (`.casefile/chats/<id>.jsonl`), and IPC.
    `name` is presentational.
    `kind` hints at default panels and tools (M3+).
    `root` is the *resolved absolute* directory that scoping/IO operates on.
    A lane root may be inside or outside the casefile root; lanes are
    deliberately allowed to be sibling directories (see ARCHITECTURE.md).
    `parent_id` is None for top-level lanes; otherwise the id of the
    enclosing scope. Children inherit read-only access to ancestor roots
    and ancestor attachments. Cycles are forbidden by the store.
    `attachments` is the list of sibling read-only directories that travel
    with this lane (see `LaneAttachment`).
    """

    id: str
    name: str
    kind: LaneKind
    root: Path
    parent_id: str | None = None
    attachments: tuple[LaneAttachment, ...] = field(default_factory=tuple)


@dataclass(slots=True, frozen=True)
class Casefile:
    """A casefile: a directory plus its `.casefile/` metadata folder."""

    root: Path

    @property
    def metadata_dir(self) -> Path:
        return self.root / ".casefile"

    @property
    def lanes_file(self) -> Path:
        return self.metadata_dir / "lanes.json"

    @property
    def chats_dir(self) -> Path:
        return self.metadata_dir / "chats"

    @property
    def context_file(self) -> Path:
        # M3.5: workspace-level "always-on" file manifest.
        return self.metadata_dir / "context.json"


@dataclass(slots=True, frozen=True)
class CasefileSnapshot:
    """An IPC-friendly point-in-time view of a casefile + its lanes.

    Lanes are stored as a flat tuple here even though they form a tree
    (via `Lane.parent_id`). Tree shape is something callers and the
    renderer can compute on demand from the parent links; storing the
    flat list keeps lookups O(1) by id and round-trips cleanly to JSON.
    """

    casefile: Casefile
    lanes: tuple[Lane, ...]
    active_lane_id: str | None
    # When the on-disk `active_lane_id` referenced a lane that no longer
    # exists, the loader silently falls back to the first remaining lane.
    # The id of the missing lane is surfaced here so the renderer can show
    # a one-time warning (instead of the active selection silently moving).
    skipped_active_lane_id: str | None = None

    def lane_by_id(self, lane_id: str) -> Lane:
        for lane in self.lanes:
            if lane.id == lane_id:
                return lane
        raise KeyError(f"Unknown lane id: {lane_id}")

    @property
    def active_lane(self) -> Lane | None:
        if self.active_lane_id is None:
            return None
        try:
            return self.lane_by_id(self.active_lane_id)
        except KeyError:
            return None

    def ancestors_of(self, lane_id: str) -> tuple[Lane, ...]:
        """Return ancestors of `lane_id` in nearest-first order.

        Stops if the parent chain references a missing lane (broken parent
        link) or detects a cycle, returning what it has so far. The store
        rejects cycles on write, so a cycle here means tampering.
        """
        out: list[Lane] = []
        seen: set[str] = {lane_id}
        current = self.lane_by_id(lane_id).parent_id
        while current is not None:
            if current in seen:
                break
            seen.add(current)
            try:
                parent = self.lane_by_id(current)
            except KeyError:
                break
            out.append(parent)
            current = parent.parent_id
        return tuple(out)
