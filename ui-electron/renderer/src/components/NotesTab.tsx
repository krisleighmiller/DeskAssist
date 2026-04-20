interface NotesTabProps {
  value: string;
  onChange: (value: string) => void;
}

export function NotesTab({ value, onChange }: NotesTabProps): JSX.Element {
  return (
    <div className="notes">
      <span className="hint">
        Free-form scratch. Local to this device for now; per-lane persistent notes ship in M2.
      </span>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Notes, observations, half-formed thoughts..."
        spellCheck={false}
      />
    </div>
  );
}
