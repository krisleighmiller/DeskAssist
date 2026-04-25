import { useEffect } from "react";
import Editor from "@monaco-editor/react";
import { languageFromPath } from "../lib/language";

/**
 * Regular Monaco editor tab tied to a file inside a context.
 * `path` is the absolute on-disk path; `content` is the in-memory
 * buffer and `savedContent` is what was last persisted, so dirty
 * state is `content !== savedContent`.
 */
interface FileTab {
  kind: "file";
  /** Synthetic; e.g. `context:<contextId>:<path>` or `overlay:<contextId>:<virtualPath>`. */
  key: string;
  path: string;
  content: string;
  savedContent: string;
  truncated: boolean;
}

export type OpenTab = FileTab;

interface EditorPaneProps {
  tabs: OpenTab[];
  activeKey: string | null;
  onSelectTab: (key: string) => void;
  onCloseTab: (key: string) => void;
  onEdit: (key: string, content: string) => void;
  onSave: (key: string) => void;
  onRequestRename?: (path: string) => void;
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

function tabLabel(tab: OpenTab): string {
  return basename(tab.path);
}

function isDirty(tab: OpenTab): boolean {
  return tab.content !== tab.savedContent;
}

export function EditorPane({
  tabs,
  activeKey,
  onSelectTab,
  onCloseTab,
  onEdit,
  onSave,
  onRequestRename,
}: EditorPaneProps): JSX.Element {
  const active = tabs.find((t) => t.key === activeKey) ?? null;
  const dirty = active ? isDirty(active) : false;

  const requestRename = (tab: OpenTab) => onRequestRename?.(tab.path);

  // Keyboard shortcut: Ctrl/Cmd+S saves the active file tab.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        if (active && dirty) {
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
                className={`tab${isActive ? " active" : ""}`}
                onClick={() => onSelectTab(tab.key)}
                onContextMenu={(event) => {
                  if (!onRequestRename) return;
                  event.preventDefault();
                  onSelectTab(tab.key);
                  requestRename(tab);
                }}
                title={onRequestRename ? "Right-click to rename file" : tab.path}
              >
                <span className={onRequestRename ? "tab-label-rename" : undefined}>
                  {tabLabel(tab)}
                </span>
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
          <div className="editor-empty">Open a file from the workspace tree.</div>
        )}
      </div>
      <div className="editor-status">
        {active ? (
          <>
            {onRequestRename ? (
              <button
                type="button"
                className="editor-status-file"
                title="Right-click to rename file"
                onContextMenu={(event) => {
                  event.preventDefault();
                  requestRename(active);
                }}
              >
                {basename(active.path)}
              </button>
            ) : (
              <span title={active.path}>{basename(active.path)}</span>
            )}
            <span>{languageFromPath(active.path)}</span>
            {active.truncated && <span className="truncated">truncated</span>}
            <span style={{ marginLeft: "auto" }}>
              <button type="button" disabled={!dirty} onClick={() => onSave(active.key)}>
                {dirty ? "Save (Ctrl+S)" : "Saved"}
              </button>
            </span>
          </>
        ) : (
          <span>No file selected</span>
        )}
      </div>
    </>
  );
}
