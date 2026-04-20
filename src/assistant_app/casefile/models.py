from __future__ import annotations

from dataclasses import dataclass
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
    """

    id: str
    name: str
    kind: LaneKind
    root: Path


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


@dataclass(slots=True, frozen=True)
class CasefileSnapshot:
    """An IPC-friendly point-in-time view of a casefile + its lanes."""

    casefile: Casefile
    lanes: tuple[Lane, ...]
    active_lane_id: str | None

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
