import { useEffect } from "react";
import Editor, { DiffEditor } from "@monaco-editor/react";
import { languageFromPath } from "../lib/language";

/**
 * The editor pane supports two kinds of tabs:
 *
 *   - `file`: a regular Monaco editor tied to a file inside the active lane.
 *     `path` is the absolute on-disk path; `content` is the in-memory
 *     buffer and `savedContent` is what was last persisted, so dirty state
 *     is `content !== savedContent`.
 *
 *   - `diff`: a Monaco DiffEditor showing the same relative path across
 *     two lanes (M3 lane comparison). Diff tabs are read-only and have no
 *     dirty state.
 *
 * Each tab also carries an opaque `key` so the strip and active-tab
 * tracking can disambiguate between, say, the user's editable `foo.py`
 * file and a `diff:a↔b:foo.py` view of that same path.
 */
export interface FileTab {
  kind: "file";
  key: string; // == path for file tabs
  path: string;
  content: string;
  savedContent: string;
  truncated: boolean;
}

export interface DiffTab {
  kind: "diff";
  key: string; // synthetic: diff:leftId:rightId:path
  path: string; // relative path inside both lanes
  leftLaneId: string;
  rightLaneId: string;
  leftLaneName: string;
  rightLaneName: string;
  leftContent: string;
  rightContent: string;
  language: string;
}

export type OpenTab = FileTab | DiffTab;

interface EditorPaneProps {
  tabs: OpenTab[];
  activeKey: string | null;
  onSelectTab: (key: string) => void;
  onCloseTab: (key: string) => void;
  onEdit: (key: string, content: string) => void;
  onSave: (key: string) => void;
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

function tabLabel(tab: OpenTab): string {
  if (tab.kind === "file") return basename(tab.path);
  return `${basename(tab.path)} · diff(${tab.leftLaneId}↔${tab.rightLaneId})`;
}

function isDirty(tab: OpenTab): boolean {
  return tab.kind === "file" && tab.content !== tab.savedContent;
}

export function EditorPane({
  tabs,
  activeKey,
  onSelectTab,
  onCloseTab,
  onEdit,
  onSave,
}: EditorPaneProps): JSX.Element {
  const active = tabs.find((t) => t.key === activeKey) ?? null;
  const dirty = active ? isDirty(active) : false;

  // Keyboard shortcut: Ctrl/Cmd+S saves the active file tab. Diff tabs are
  // read-only so the shortcut is intentionally a no-op for them.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        if (active && active.kind === "file" && dirty) {
          event.preventDefault();
          onSave(active.key);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [active, dirty, onSave]);

  return (
    <>
      <div className="tab-strip">
        {tabs.length === 0 ? (
          <div className="tab" style={{ color: "#6b7280" }}>
            No file open
          </div>
        ) : (
          tabs.map((tab) => {
            const isActive = tab.key === activeKey;
            return (
              <div
                key={tab.key}
                className={`tab${isActive ? " active" : ""}${tab.kind === "diff" ? " diff" : ""}`}
                onClick={() => onSelectTab(tab.key)}
                title={tab.kind === "file" ? tab.path : `${tab.leftLaneId} ↔ ${tab.rightLaneId} : ${tab.path}`}
              >
                <span>{tabLabel(tab)}</span>
                {isDirty(tab) && <span className="dirty-dot">●</span>}
                <span
                  className="close"
                  onClick={(event) => {
                    event.stopPropagation();
                    onCloseTab(tab.key);
                  }}
                >
                  ×
                </span>
              </div>
            );
          })
        )}
      </div>
      <div className="editor-host">
        {active ? (
          active.kind === "file" ? (
            <Editor
              theme="vs-dark"
              path={active.path}
              language={languageFromPath(active.path)}
              value={active.content}
              onChange={(value) => onEdit(active.key, value ?? "")}
              options={{
                automaticLayout: true,
                minimap: { enabled: false },
                fontSize: 13,
                tabSize: 2,
                scrollBeyondLastLine: false,
                wordWrap: "off",
              }}
            />
          ) : (
            <DiffEditor
              theme="vs-dark"
              language={active.language}
              original={active.leftContent}
              modified={active.rightContent}
              options={{
                automaticLayout: true,
                readOnly: true,
                renderSideBySide: true,
                minimap: { enabled: false },
                fontSize: 13,
                originalEditable: false,
              }}
            />
          )
        ) : (
          <div className="editor-empty">Open a file from the workspace tree.</div>
        )}
      </div>
      <div className="editor-status">
        {active ? (
          active.kind === "file" ? (
            <>
              <span title={active.path}>{basename(active.path)}</span>
              <span>{languageFromPath(active.path)}</span>
              {active.truncated && <span className="truncated">truncated</span>}
              <span style={{ marginLeft: "auto" }}>
                <button type="button" disabled={!dirty} onClick={() => onSave(active.key)}>
                  {dirty ? "Save (Ctrl+S)" : "Saved"}
                </button>
              </span>
            </>
          ) : (
            <>
              <span title={active.path}>{basename(active.path)}</span>
              <span>{active.language}</span>
              <span className="diff-meta">
                {active.leftLaneName} ↔ {active.rightLaneName}
              </span>
              <span style={{ marginLeft: "auto", color: "#6b7280" }}>read-only diff</span>
            </>
          )
        ) : (
          <span>No file selected</span>
        )}
      </div>
    </>
  );
}
