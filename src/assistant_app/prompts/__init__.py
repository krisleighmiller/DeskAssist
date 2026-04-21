"""Product-owned system-prompt assets for DeskAssist.

This package owns the **assistant charter** — the layer-2 system prompt
that establishes DeskAssist's identity as an analyst's workbench rather
than a coding agent. The charter is product-owned (one file, version
controlled, identical across all casefiles) and is prepended above the
casefile auto-context (M3.5a) and any user-selected prompt draft (M4.1)
on every chat turn, including comparison sessions.

See `plans/MILESTONE_M4_5_ASSISTANT_CHARTER.md` for the milestone spec.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

# Tag injected charter messages so `electron_bridge` can keep injection
# idempotent across resumed turns. Mirrors `_CONTEXT_MARKER` and
# `_PROMPT_MARKER` in `electron_bridge.py`.
CHARTER_MARKER = "[DeskAssist charter]"

# Hard cap on the on-disk charter body. The charter ships on every turn
# for every provider, so runaway growth is a real cost. 8 KiB is a
# generous ceiling; ~2 KiB is the soft target documented in the
# milestone spec.
MAX_CHARTER_BYTES = 8 * 1024

_CHARTER_PATH = Path(__file__).parent / "charter.md"


class CharterError(RuntimeError):
    """Raised when the charter file is missing, empty, or oversized.

    These are programmer / packaging errors (the package shipped without
    its own asset, or the asset grew unchecked), not runtime conditions
    a user can recover from, so they are raised loudly rather than
    silently swallowed.
    """


@lru_cache(maxsize=1)
def load_charter() -> str:
    """Return the assistant charter body, cached for the process lifetime.

    The charter is bundled alongside the Python package and only changes
    between releases, so a single read at first use is sufficient.
    Returns the body with surrounding whitespace stripped; the marker
    prefix is added by `build_charter_system_content`.
    """
    try:
        body = _CHARTER_PATH.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise CharterError(
            f"Assistant charter is missing: {_CHARTER_PATH}"
        ) from exc
    except OSError as exc:
        raise CharterError(
            f"Cannot read assistant charter at {_CHARTER_PATH}: {exc}"
        ) from exc
    encoded = body.encode("utf-8")
    if len(encoded) > MAX_CHARTER_BYTES:
        raise CharterError(
            f"Assistant charter at {_CHARTER_PATH} is {len(encoded):,} bytes, "
            f"exceeding the {MAX_CHARTER_BYTES:,}-byte cap. Trim it before shipping."
        )
    stripped = body.strip()
    if not stripped:
        raise CharterError(f"Assistant charter at {_CHARTER_PATH} is empty.")
    return stripped


def build_charter_system_content() -> str:
    """Format the charter as the body of a `role: "system"` message.

    The marker is included as a prefix so `_history_has_charter_marker`
    in `electron_bridge` matches even if the charter body itself starts
    with a heading or other content the marker check might collide with.
    """
    return f"{CHARTER_MARKER}\n\n{load_charter()}"
