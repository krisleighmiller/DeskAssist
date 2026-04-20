import { useEffect, useState } from "react";
import type { ContextManifestDto } from "../types";
import { FILETREE_DRAG_MIME, type FileTreeDragPayload } from "./FileTree";

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
  const [dropActive, setDropActive] = useState(false);

  useEffect(() => {
    if (context) {
      setFiles([...context.files]);
      setMaxKb(Math.max(0, Math.round(context.autoIncludeMaxBytes / 1024)));
    }
  }, [context]);

  const mergePatterns = (incoming: string[]) => {
    if (incoming.length === 0) return;
    setFiles((prev) => {
      const seen = new Set(prev);
      const next = [...prev];
      const skipped: string[] = [];
      for (const raw of incoming) {
        const value = raw.trim();
        if (!value) continue;
        if (seen.has(value)) {
          skipped.push(value);
          continue;
        }
        seen.add(value);
        next.push(value);
      }
      if (skipped.length > 0) {
        setLocalError(
          `Already in list: ${skipped.slice(0, 3).join(", ")}${skipped.length > 3 ? "…" : ""}`
        );
      } else {
        setLocalError(null);
      }
      return next;
    });
  };

  const addPattern = () => {
    const value = draft.trim();
    if (!value) return;
    mergePatterns([value]);
    setDraft("");
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (event.dataTransfer.types.includes(FILETREE_DRAG_MIME)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      if (!dropActive) setDropActive(true);
    }
  };

  const handleDragLeave = () => setDropActive(false);

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    setDropActive(false);
    const raw = event.dataTransfer.getData(FILETREE_DRAG_MIME);
    if (!raw) return;
    event.preventDefault();
    try {
      const payload = JSON.parse(raw) as FileTreeDragPayload;
      if (!payload.relativePath) {
        setLocalError(
          "Cannot add this entry: it lives outside the casefile root or is a virtual overlay path."
        );
        return;
      }
      const pattern =
        payload.type === "dir"
          ? `${payload.relativePath.replace(/\/$/, "")}/**/*`
          : payload.relativePath;
      mergePatterns([pattern]);
    } catch {
      setLocalError("Could not parse dropped item.");
    }
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
    <div
      className={`context-editor${dropActive ? " drop-target" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="context-header">
        <strong>Casefile context (always-on)</strong>
        <span className="muted">
          Files matched here are visible to every lane via <code>_context/...</code>.
          Drag files from the tree, or right-click → "Add to casefile context".
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
