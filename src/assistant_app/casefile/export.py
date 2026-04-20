from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

from assistant_app.casefile.findings import Finding, FindingsStore
from assistant_app.casefile.models import Casefile, Lane
from assistant_app.casefile.notes import NotesStore


_SLUG_RE = re.compile(r"[^a-z0-9]+")


def _slugify(value: str) -> str:
    cleaned = _SLUG_RE.sub("-", value.lower()).strip("-")
    return cleaned or "review"


def _format_lane_label(lanes: Iterable[Lane], lane_id: str) -> str:
    for lane in lanes:
        if lane.id == lane_id:
            return f"{lane.name} (`{lane.id}`)"
    return f"`{lane_id}`"


def render_review_markdown(
    *,
    casefile: Casefile,
    lanes: Iterable[Lane],
    selected_lane_ids: Iterable[str],
    findings: Iterable[Finding],
    notes_by_lane: dict[str, str],
    generated_at: datetime | None = None,
) -> str:
    """Render a review document as a single markdown string.

    The shape is intentionally minimal and human-readable: a header, a per-lane
    notes section, and a per-finding section. Findings cite their lanes and
    source files so a reader can navigate back into the casefile.
    """
    lanes_list = list(lanes)
    selected_ids = list(selected_lane_ids)
    moment = (generated_at or datetime.now(timezone.utc)).astimezone(timezone.utc)
    timestamp = moment.strftime("%Y-%m-%d %H:%M UTC")

    lines: list[str] = []
    lines.append(f"# Casefile Review: {casefile.root.name}")
    lines.append("")
    lines.append(f"_Generated {timestamp}_")
    lines.append("")
    lines.append(f"- Casefile: `{casefile.root}`")
    lines.append(
        "- Lanes covered: "
        + ", ".join(_format_lane_label(lanes_list, lid) for lid in selected_ids)
    )
    lines.append("")

    # Notes — one subsection per selected lane that has notes.
    notes_present = [
        (lid, notes_by_lane.get(lid, "").strip())
        for lid in selected_ids
        if notes_by_lane.get(lid, "").strip()
    ]
    lines.append("## Notes")
    lines.append("")
    if not notes_present:
        lines.append("_No notes recorded for the selected lanes._")
        lines.append("")
    else:
        for lid, body in notes_present:
            lines.append(f"### {_format_lane_label(lanes_list, lid)}")
            lines.append("")
            lines.append(body)
            lines.append("")

    # Findings — one subsection per finding, ordered as given.
    lines.append("## Findings")
    lines.append("")
    findings_list = list(findings)
    if not findings_list:
        lines.append("_No findings recorded for the selected lanes._")
        lines.append("")
    else:
        for finding in findings_list:
            lane_label = ", ".join(_format_lane_label(lanes_list, lid) for lid in finding.lane_ids)
            lines.append(f"### {finding.title}")
            lines.append("")
            lines.append(
                f"- Severity: **{finding.severity}**  "
                f"\n- Lanes: {lane_label}  "
                f"\n- Created: {finding.created_at}  "
                f"\n- Updated: {finding.updated_at}  "
                f"\n- Id: `{finding.id}`"
            )
            lines.append("")
            if finding.body.strip():
                lines.append(finding.body.strip())
                lines.append("")
            if finding.source_refs:
                lines.append("**Source references:**")
                lines.append("")
                for ref in finding.source_refs:
                    range_suffix = ""
                    if ref.line_start is not None and ref.line_end is not None:
                        range_suffix = f":L{ref.line_start}-L{ref.line_end}"
                    elif ref.line_start is not None:
                        range_suffix = f":L{ref.line_start}"
                    lines.append(f"- `{ref.lane_id}` — `{ref.path}{range_suffix}`")
                lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def export_review(
    *,
    casefile_root: Path,
    lanes: Iterable[Lane],
    selected_lane_ids: Iterable[str],
    generated_at: datetime | None = None,
) -> tuple[Path, str]:
    """Collect findings + notes for the given lanes and write a markdown file.

    Returns `(output_path, markdown)`. Output lives in
    `<casefile>/.casefile/exports/<timestamp>-<slug>.md`.
    """
    casefile = Casefile(root=Path(casefile_root).resolve())
    selected_ids = list(selected_lane_ids)
    if not selected_ids:
        raise ValueError("export_review requires at least one lane id")

    findings_store = FindingsStore(casefile.root)
    notes_store = NotesStore(casefile.root)

    # Findings about the selected lanes: a finding is included if any of
    # its lane_ids is in the selection. This naturally covers comparison
    # findings (lane_ids = [a, b]) when either lane is selected.
    selection_set = set(selected_ids)
    matching_findings = [
        f
        for f in findings_store.list()
        if any(lid in selection_set for lid in f.lane_ids)
    ]

    notes_by_lane = {lid: notes_store.read(lid) for lid in selected_ids}

    moment = (generated_at or datetime.now(timezone.utc)).astimezone(timezone.utc)
    markdown = render_review_markdown(
        casefile=casefile,
        lanes=lanes,
        selected_lane_ids=selected_ids,
        findings=matching_findings,
        notes_by_lane=notes_by_lane,
        generated_at=moment,
    )

    exports_dir = casefile.metadata_dir / "exports"
    exports_dir.mkdir(parents=True, exist_ok=True)
    slug_source = "-".join(selected_ids) if len(selected_ids) <= 3 else "review"
    filename = f"{moment.strftime('%Y%m%dt%H%M%S')}-{_slugify(slug_source)}.md"
    output_path = exports_dir / filename
    output_path.write_text(markdown, encoding="utf-8")
    return output_path, markdown
