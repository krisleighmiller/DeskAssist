interface NotesTabProps {
  value: string;
  hasActiveLane: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
  onChange: (value: string) => void;
}

export function NotesTab({
  value,
  hasActiveLane,
  loading,
  saving,
  error,
  onChange,
}: NotesTabProps): JSX.Element {
  if (!hasActiveLane) {
    return (
      <div className="notes">
        <span className="hint">Open a casefile and pick a lane to take notes.</span>
      </div>
    );
  }
  return (
    <div className="notes">
      <span className="hint">
        Per-lane notes saved to <code>.casefile/notes/&lt;lane&gt;.md</code>.
        {loading ? " Loading..." : saving ? " Saving..." : " Autosaves on pause."}
        {error && <span className="notes-error"> · {error}</span>}
      </span>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Notes, observations, half-formed thoughts..."
        spellCheck={false}
        disabled={loading}
      />
    </div>
  );
}
