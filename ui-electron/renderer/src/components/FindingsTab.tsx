export function FindingsTab(): JSX.Element {
  return (
    <div className="placeholder">
      <p>
        <strong>Findings</strong> become first-class in <code>M3</code>:
      </p>
      <ul>
        <li>Structured records persisted under <code>.casefile/findings/</code>.</li>
        <li>Bound to a lane (or a lane comparison) with citations back into source files.</li>
        <li>Exportable as a markdown review note.</li>
      </ul>
      <p style={{ color: "#6b7280" }}>
        For now, capture observations in the Notes tab.
      </p>
    </div>
  );
}
