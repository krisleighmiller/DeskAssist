import { useMemo, useState } from "react";
import type {
  CasefileSnapshot,
  ExportResult,
  FindingDraft,
  FindingDto,
  Lane,
  Severity,
} from "../types";
import { SEVERITIES } from "../types";

interface FindingsTabProps {
  casefile: CasefileSnapshot | null;
  findings: FindingDto[];
  busy: boolean;
  lastExport: ExportResult | null;
  onCreate: (draft: FindingDraft) => Promise<void>;
  onUpdate: (id: string, draft: Partial<FindingDraft>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onExport: (laneIds: string[]) => Promise<void>;
}

type FilterMode = "active" | "all" | string; // "active", "all", or a lane id

export function FindingsTab({
  casefile,
  findings,
  busy,
  lastExport,
  onCreate,
  onUpdate,
  onDelete,
  onExport,
}: FindingsTabProps): JSX.Element {
  const [filter, setFilter] = useState<FilterMode>("active");
  const [editing, setEditing] = useState<FindingDto | null>(null);
  const [creating, setCreating] = useState(false);

  if (!casefile) {
    return (
      <div className="placeholder">
        <p>
          <strong>Findings</strong> live inside a casefile. Open one with{" "}
          <em>Open Casefile</em> in the toolbar.
        </p>
      </div>
    );
  }

  const activeLane = casefile.lanes.find((l) => l.id === casefile.activeLaneId) ?? null;

  // Filter the list of findings client-side. We always pull "all" from the
  // backend so switching the filter is instant; for big casefiles we'd
  // re-fetch on filter change instead.
  const visible = useMemo(() => {
    if (filter === "all") return findings;
    if (filter === "active") {
      if (!activeLane) return [];
      return findings.filter((f) => f.laneIds.includes(activeLane.id));
    }
    return findings.filter((f) => f.laneIds.includes(filter));
  }, [filter, findings, activeLane]);

  const exportLaneIds =
    filter === "all"
      ? casefile.lanes.map((l) => l.id)
      : filter === "active"
        ? activeLane
          ? [activeLane.id]
          : []
        : [filter];

  return (
    <div className="findings">
      <div className="findings-header">
        <div className="findings-filter">
          <label htmlFor="findings-filter-select">Show</label>
          <select
            id="findings-filter-select"
            value={filter}
            onChange={(event) => setFilter(event.target.value as FilterMode)}
          >
            <option value="active">Active lane{activeLane ? ` (${activeLane.name})` : ""}</option>
            <option value="all">All lanes</option>
            {casefile.lanes.map((lane) => (
              <option key={lane.id} value={lane.id}>
                Lane: {lane.name}
              </option>
            ))}
          </select>
        </div>
        <div className="findings-actions">
          <button
            type="button"
            onClick={() => {
              setCreating(true);
              setEditing(null);
            }}
            disabled={busy}
          >
            New finding
          </button>
          <button
            type="button"
            onClick={() => onExport(exportLaneIds)}
            disabled={busy || exportLaneIds.length === 0}
            title="Write a markdown review of findings + notes for the current selection."
          >
            Export
          </button>
        </div>
      </div>
      {lastExport && (
        <div className="export-banner">
          Exported to <code>{lastExport.path}</code>
        </div>
      )}
      <div className="findings-body">
        <ul className="findings-list">
          {visible.length === 0 ? (
            <li className="findings-empty">
              {findings.length === 0
                ? "No findings recorded yet."
                : "No findings match the current filter."}
            </li>
          ) : (
            visible.map((finding) => (
              <FindingRow
                key={finding.id}
                finding={finding}
                lanes={casefile.lanes}
                onEdit={() => {
                  setEditing(finding);
                  setCreating(false);
                }}
                onDelete={() => onDelete(finding.id)}
              />
            ))
          )}
        </ul>
        {(creating || editing) && (
          <FindingForm
            casefile={casefile}
            initial={editing}
            busy={busy}
            onSubmit={async (draft) => {
              if (editing) {
                await onUpdate(editing.id, draft);
              } else {
                await onCreate(draft);
              }
              setCreating(false);
              setEditing(null);
            }}
            onCancel={() => {
              setCreating(false);
              setEditing(null);
            }}
          />
        )}
      </div>
    </div>
  );
}

interface FindingRowProps {
  finding: FindingDto;
  lanes: Lane[];
  onEdit: () => void;
  onDelete: () => void;
}

function FindingRow({ finding, lanes, onEdit, onDelete }: FindingRowProps): JSX.Element {
  const laneNames = finding.laneIds
    .map((id) => lanes.find((l) => l.id === id)?.name ?? id)
    .join(", ");
  return (
    <li className="finding-row">
      <div className="finding-row-head">
        <span className={`finding-severity sev-${finding.severity}`}>{finding.severity}</span>
        <span className="finding-title" onClick={onEdit}>
          {finding.title}
        </span>
        <span className="finding-actions">
          <button type="button" onClick={onEdit}>
            Edit
          </button>
          <button
            type="button"
            onClick={() => {
              if (confirm(`Delete finding "${finding.title}"?`)) {
                onDelete();
              }
            }}
          >
            Delete
          </button>
        </span>
      </div>
      <div className="finding-row-meta">
        <span>Lanes: {laneNames}</span>
        <span>Created: {finding.createdAt}</span>
      </div>
      {finding.body.trim() && <div className="finding-body-preview">{finding.body}</div>}
      {finding.sourceRefs.length > 0 && (
        <ul className="finding-refs">
          {finding.sourceRefs.map((ref, i) => {
            const range =
              ref.lineStart != null && ref.lineEnd != null
                ? `:L${ref.lineStart}-L${ref.lineEnd}`
                : ref.lineStart != null
                  ? `:L${ref.lineStart}`
                  : "";
            return (
              <li key={`${ref.laneId}:${ref.path}:${i}`}>
                <code>
                  {ref.laneId} — {ref.path}
                  {range}
                </code>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

interface FindingFormProps {
  casefile: CasefileSnapshot;
  initial: FindingDto | null;
  busy: boolean;
  onSubmit: (draft: FindingDraft) => Promise<void>;
  onCancel: () => void;
}

function FindingForm({
  casefile,
  initial,
  busy,
  onSubmit,
  onCancel,
}: FindingFormProps): JSX.Element {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [severity, setSeverity] = useState<Severity>(initial?.severity ?? "info");
  const [laneIds, setLaneIds] = useState<string[]>(
    initial?.laneIds ?? (casefile.activeLaneId ? [casefile.activeLaneId] : [])
  );
  const [error, setError] = useState<string | null>(null);

  const toggleLane = (id: string) => {
    setLaneIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const submit = async () => {
    setError(null);
    if (!title.trim()) {
      setError("Title is required");
      return;
    }
    if (laneIds.length === 0) {
      setError("Pick at least one lane");
      return;
    }
    try {
      await onSubmit({
        title: title.trim(),
        body,
        severity,
        laneIds,
        sourceRefs: initial?.sourceRefs.map((r) => ({
          laneId: r.laneId,
          path: r.path,
          lineStart: r.lineStart ?? undefined,
          lineEnd: r.lineEnd ?? undefined,
        })),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="finding-form">
      <h4>{initial ? "Edit finding" : "New finding"}</h4>
      <label className="finding-form-row">
        <span>Title</span>
        <input value={title} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label className="finding-form-row">
        <span>Severity</span>
        <select value={severity} onChange={(event) => setSeverity(event.target.value as Severity)}>
          {SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="finding-form-lanes">
        <legend>Lanes</legend>
        {casefile.lanes.map((lane) => (
          <label key={lane.id}>
            <input
              type="checkbox"
              checked={laneIds.includes(lane.id)}
              onChange={() => toggleLane(lane.id)}
            />
            {lane.name} <span className="muted">({lane.id})</span>
          </label>
        ))}
      </fieldset>
      <label className="finding-form-row">
        <span>Body</span>
        <textarea
          value={body}
          rows={6}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Markdown..."
        />
      </label>
      {error && <div className="finding-form-error">Error: {error}</div>}
      <div className="finding-form-actions">
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" onClick={submit} disabled={busy}>
          {initial ? "Save" : "Create"}
        </button>
      </div>
    </div>
  );
}
