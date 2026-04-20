import { useEffect, useState } from "react";
import type { ContextManifestDto } from "../types";

interface ContextEditorProps {
  context: ContextManifestDto | null;
  busy: boolean;
  error: string | null;
  onSave: (manifest: { files: string[]; autoIncludeMaxBytes: number }) => Promise<void>;
}

const DEFAULT_MAX_KB = 32;

// Local editor state for the workspace context manifest
// (`.casefile/context.json`). Patterns can be literal paths or globs
// (e.g. `*.md`, `prompts/**/*.txt`); the backend resolves them and reports
// matched files + sizes back via `context.resolved`.
export function ContextEditor({
  context,
  busy,
  error,
  onSave,
}: ContextEditorProps): JSX.Element {
  const [files, setFiles] = useState<string[]>([]);
  const [maxKb, setMaxKb] = useState<number>(DEFAULT_MAX_KB);
  const [draft, setDraft] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (context) {
      setFiles([...context.files]);
      setMaxKb(Math.max(0, Math.round(context.autoIncludeMaxBytes / 1024)));
    }
  }, [context]);

  const addPattern = () => {
    const value = draft.trim();
    if (!value) return;
    if (files.includes(value)) {
      setLocalError(`Pattern "${value}" already in list`);
      return;
    }
    setFiles([...files, value]);
    setDraft("");
    setLocalError(null);
  };

  const save = async () => {
    setLocalError(null);
    try {
      await onSave({
        files,
        autoIncludeMaxBytes: Math.max(0, Math.round(maxKb)) * 1024,
      });
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="context-editor">
      <div className="context-header">
        <strong>Casefile context (always-on)</strong>
        <span className="muted">
          Files matched here are visible to every lane via <code>_context/...</code>.
        </span>
      </div>
      <ul className="context-list">
        {files.length === 0 && (
          <li className="muted">No patterns yet. Add e.g. <code>*.md</code> or <code>prompts/**/*.txt</code>.</li>
        )}
        {files.map((pattern) => (
          <li key={pattern} className="context-row">
            <code>{pattern}</code>
            <button
              type="button"
              className="link-button"
              onClick={() => setFiles(files.filter((f) => f !== pattern))}
            >
              remove
            </button>
          </li>
        ))}
      </ul>
      <div className="context-add">
        <input
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="path or glob (e.g. Comparison_Prompt.txt or *.md)"
        />
        <button type="button" onClick={addPattern}>
          Add
        </button>
      </div>
      <label className="context-max">
        <span>Auto-include cap (KB)</span>
        <input
          type="number"
          min={0}
          step={1}
          value={maxKb}
          onChange={(event) => setMaxKb(Number(event.target.value) || 0)}
        />
      </label>
      {context && context.resolved.length > 0 && (
        <details className="context-resolved">
          <summary>Resolved ({context.resolved.length} file{context.resolved.length === 1 ? "" : "s"})</summary>
          <ul>
            {context.resolved.map((entry) => {
              const inline = entry.sizeBytes <= context.autoIncludeMaxBytes;
              return (
                <li key={entry.absolutePath}>
                  <code>{entry.path}</code>
                  <span className="muted">
                    {" "}
                    {entry.sizeBytes} bytes {inline ? "(auto-included)" : "(read on demand)"}
                  </span>
                </li>
              );
            })}
          </ul>
        </details>
      )}
      {(localError || error) && (
        <div className="lane-form-error">Error: {localError || error}</div>
      )}
      <div className="lane-form-actions">
        <button type="button" onClick={save} disabled={busy}>
          {busy ? "Saving..." : "Save context"}
        </button>
      </div>
    </div>
  );
}
