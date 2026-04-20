export function LanesTab(): JSX.Element {
  return (
    <div className="placeholder">
      <p>
        <strong>Lanes</strong> arrive in <code>M2</code>.
      </p>
      <p>
        A casefile will hold one or more named lanes (each with a <code>kind</code> like
        <code> repo</code>, <code>doc</code>, <code>rubric</code>, <code>review</code>). The
        workspace tree, chat history, and findings will all be scoped to the active lane, with a
        switcher here.
      </p>
      <p style={{ color: "#6b7280" }}>
        Until then, the toolbar's <em>Choose Workspace</em> picks a single bare directory.
      </p>
    </div>
  );
}
