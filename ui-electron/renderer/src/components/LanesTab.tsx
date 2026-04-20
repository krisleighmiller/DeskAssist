import type React from "react";
import { useMemo, useState } from "react";
import type {
  CasefileSnapshot,
  ChangedFileDto,
  Lane,
  LaneComparisonDto,
  LaneKind,
  RegisterLaneInput,
} from "../types";
import { LANE_KINDS } from "../types";

interface LanesTabProps {
  casefile: CasefileSnapshot | null;
  onSwitchLane: (laneId: string) => void;
  onRegisterLane: (input: RegisterLaneInput) => Promise<void>;
  onChooseLaneRoot: () => Promise<string | null>;
  comparison: LaneComparisonDto | null;
  comparisonBusy: boolean;
  onCompare: (leftLaneId: string, rightLaneId: string) => Promise<void>;
  onClearComparison: () => void;
  onOpenDiff: (path: string) => void;
  onOpenLaneFile: (laneId: string, path: string) => void;
}

export function LanesTab({
  casefile,
  onSwitchLane,
  onRegisterLane,
  onChooseLaneRoot,
  comparison,
  comparisonBusy,
  onCompare,
  onClearComparison,
  onOpenDiff,
  onOpenLaneFile,
}: LanesTabProps): JSX.Element {
  const [showForm, setShowForm] = useState(false);
  const [compareTarget, setCompareTarget] = useState<string>("");

  // Pick a sensible default compare target when the user opens the dropdown
  // for the first time: the first lane that isn't the active one.
  const defaultTarget = useMemo(() => {
    if (!casefile) return "";
    const other = casefile.lanes.find((l) => l.id !== casefile.activeLaneId);
    return other ? other.id : "";
  }, [casefile]);

  const effectiveTarget = compareTarget || defaultTarget;

  if (!casefile) {
    return (
      <div className="placeholder">
        <p>
          <strong>No casefile open.</strong>
        </p>
        <p>
          Use <em>Open Casefile</em> in the toolbar. A casefile is any directory; selecting one
          creates a <code>.casefile/</code> metadata folder and a default <code>main</code> lane
          rooted at the casefile itself.
        </p>
      </div>
    );
  }

  return (
    <div className="lanes">
      <div className="lanes-header">
        <span className="lanes-title">Lanes in this casefile</span>
        <button type="button" onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Cancel" : "Register lane"}
        </button>
      </div>
      <ul className="lane-list">
        {casefile.lanes.map((lane) => (
          <LaneRow
            key={lane.id}
            lane={lane}
            isActive={lane.id === casefile.activeLaneId}
            onSelect={() => onSwitchLane(lane.id)}
          />
        ))}
      </ul>
      {casefile.lanes.length >= 2 && (
        <div className="compare-controls">
          <span className="lanes-title">Compare</span>
          <span className="muted">{lanesById(casefile, casefile.activeLaneId)?.name ?? "active"} ↔</span>
          <select
            value={effectiveTarget}
            onChange={(event) => setCompareTarget(event.target.value)}
          >
            {casefile.lanes
              .filter((l) => l.id !== casefile.activeLaneId)
              .map((lane) => (
                <option key={lane.id} value={lane.id}>
                  {lane.name}
                </option>
              ))}
          </select>
          <button
            type="button"
            disabled={
              comparisonBusy || !casefile.activeLaneId || !effectiveTarget
            }
            onClick={() => {
              if (casefile.activeLaneId && effectiveTarget) {
                void onCompare(casefile.activeLaneId, effectiveTarget);
              }
            }}
          >
            {comparisonBusy ? "Comparing..." : "Compare"}
          </button>
          {comparison && (
            <button type="button" onClick={onClearComparison} className="link-button">
              Clear
            </button>
          )}
        </div>
      )}
      {comparison && (
        <ComparisonResults
          comparison={comparison}
          casefile={casefile}
          onOpenDiff={onOpenDiff}
          onOpenLaneFile={onOpenLaneFile}
        />
      )}
      {showForm && (
        <RegisterLaneForm
          onChooseLaneRoot={onChooseLaneRoot}
          onSubmit={async (input) => {
            await onRegisterLane(input);
            setShowForm(false);
          }}
          existingIds={new Set(casefile.lanes.map((l) => l.id))}
        />
      )}
    </div>
  );
}

function lanesById(snapshot: CasefileSnapshot, laneId: string | null): Lane | null {
  if (!laneId) return null;
  return snapshot.lanes.find((l) => l.id === laneId) ?? null;
}

interface ComparisonResultsProps {
  comparison: LaneComparisonDto;
  casefile: CasefileSnapshot;
  onOpenDiff: (path: string) => void;
  onOpenLaneFile: (laneId: string, path: string) => void;
}

function ComparisonResults({
  comparison,
  casefile,
  onOpenDiff,
  onOpenLaneFile,
}: ComparisonResultsProps): JSX.Element {
  const left = lanesById(casefile, comparison.leftLaneId);
  const right = lanesById(casefile, comparison.rightLaneId);
  const summary = `${comparison.added.length} added · ${comparison.removed.length} removed · ${comparison.changed.length} changed`;
  return (
    <div className="comparison">
      <div className="comparison-header">
        <strong>
          {left?.name ?? comparison.leftLaneId} ↔ {right?.name ?? comparison.rightLaneId}
        </strong>
        <span className="muted">{summary}</span>
      </div>
      <ComparisonSection title="Changed">
        {comparison.changed.length === 0 ? (
          <EmptyHint>No changed files.</EmptyHint>
        ) : (
          comparison.changed.map((change) => (
            <ChangedFileRow
              key={change.path}
              change={change}
              onOpenDiff={() => onOpenDiff(change.path)}
            />
          ))
        )}
      </ComparisonSection>
      <ComparisonSection title="Added">
        {comparison.added.length === 0 ? (
          <EmptyHint>None.</EmptyHint>
        ) : (
          comparison.added.map((path) => (
            <li key={path} className="comparison-row">
              <code>{path}</code>
              <button
                type="button"
                className="link-button"
                onClick={() => onOpenLaneFile(comparison.rightLaneId, path)}
              >
                open in {right?.name ?? comparison.rightLaneId}
              </button>
            </li>
          ))
        )}
      </ComparisonSection>
      <ComparisonSection title="Removed">
        {comparison.removed.length === 0 ? (
          <EmptyHint>None.</EmptyHint>
        ) : (
          comparison.removed.map((path) => (
            <li key={path} className="comparison-row">
              <code>{path}</code>
              <button
                type="button"
                className="link-button"
                onClick={() => onOpenLaneFile(comparison.leftLaneId, path)}
              >
                open in {left?.name ?? comparison.leftLaneId}
              </button>
            </li>
          ))
        )}
      </ComparisonSection>
    </div>
  );
}

function ComparisonSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="comparison-section">
      <div className="comparison-section-title">{title}</div>
      <ul className="comparison-list">{children}</ul>
    </div>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }): JSX.Element {
  return <li className="comparison-empty">{children}</li>;
}

function ChangedFileRow({
  change,
  onOpenDiff,
}: {
  change: ChangedFileDto;
  onOpenDiff: () => void;
}): JSX.Element {
  return (
    <li className="comparison-row">
      <code>{change.path}</code>
      <span className="muted">
        {change.leftSize} → {change.rightSize} bytes
      </span>
      <button type="button" className="link-button" onClick={onOpenDiff}>
        diff
      </button>
    </li>
  );
}

interface LaneRowProps {
  lane: Lane;
  isActive: boolean;
  onSelect: () => void;
}

function LaneRow({ lane, isActive, onSelect }: LaneRowProps): JSX.Element {
  return (
    <li className={`lane-row${isActive ? " active" : ""}`} onClick={onSelect} title={lane.root}>
      <div className="lane-row-main">
        <span className="lane-name">{lane.name}</span>
        <span className="lane-kind">{lane.kind}</span>
        {isActive && <span className="lane-active-badge">active</span>}
      </div>
      <div className="lane-root">{lane.root}</div>
    </li>
  );
}

interface RegisterLaneFormProps {
  existingIds: Set<string>;
  onChooseLaneRoot: () => Promise<string | null>;
  onSubmit: (input: RegisterLaneInput) => Promise<void>;
}

function RegisterLaneForm({
  existingIds,
  onChooseLaneRoot,
  onSubmit,
}: RegisterLaneFormProps): JSX.Element {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<LaneKind>("repo");
  const [root, setRoot] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    if (!root.trim()) {
      setError("Lane directory is required");
      return;
    }
    setBusy(true);
    try {
      await onSubmit({ name: name.trim(), kind, root: root.trim() });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lane-form">
      <h4>Register Lane</h4>
      <label className="lane-form-row">
        <span>Name</span>
        <input
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Attempt A"
        />
      </label>
      <label className="lane-form-row">
        <span>Kind</span>
        <select value={kind} onChange={(event) => setKind(event.target.value as LaneKind)}>
          {LANE_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </label>
      <label className="lane-form-row">
        <span>Root</span>
        <input
          type="text"
          value={root}
          onChange={(event) => setRoot(event.target.value)}
          placeholder="absolute path or relative-to-casefile"
        />
        <button
          type="button"
          onClick={async () => {
            const chosen = await onChooseLaneRoot();
            if (chosen) {
              setRoot(chosen);
            }
          }}
          disabled={busy}
        >
          Browse
        </button>
      </label>
      {existingIds.size > 0 && (
        <div className="lane-form-hint">
          Existing ids: {Array.from(existingIds).sort().join(", ")}
        </div>
      )}
      {error && <div className="lane-form-error">Error: {error}</div>}
      <div className="lane-form-actions">
        <button type="button" onClick={submit} disabled={busy}>
          {busy ? "Registering..." : "Register"}
        </button>
      </div>
    </div>
  );
}
