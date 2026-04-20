import { useState } from "react";
import type { CasefileSnapshot, Lane, LaneKind, RegisterLaneInput } from "../types";
import { LANE_KINDS } from "../types";

interface LanesTabProps {
  casefile: CasefileSnapshot | null;
  onSwitchLane: (laneId: string) => void;
  onRegisterLane: (input: RegisterLaneInput) => Promise<void>;
  onChooseLaneRoot: () => Promise<string | null>;
}

export function LanesTab({
  casefile,
  onSwitchLane,
  onRegisterLane,
  onChooseLaneRoot,
}: LanesTabProps): JSX.Element {
  const [showForm, setShowForm] = useState(false);

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
