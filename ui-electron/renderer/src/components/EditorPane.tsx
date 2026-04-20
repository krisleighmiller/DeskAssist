import { useEffect } from "react";
import Editor from "@monaco-editor/react";
import { languageFromPath } from "../lib/language";

export interface OpenTab {
  path: string;
  content: string;
  savedContent: string;
  truncated: boolean;
}

interface EditorPaneProps {
  tabs: OpenTab[];
  activePath: string | null;
  onSelectTab: (path: string) => void;
  onCloseTab: (path: string) => void;
  onEdit: (path: string, content: string) => void;
  onSave: (path: string) => void;
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

export function EditorPane({
  tabs,
  activePath,
  onSelectTab,
  onCloseTab,
  onEdit,
  onSave,
}: EditorPaneProps): JSX.Element {
  const active = tabs.find((t) => t.path === activePath) ?? null;
  const dirty = active ? active.content !== active.savedContent : false;

  // Keyboard shortcut: Ctrl/Cmd+S saves the active tab.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        if (active && dirty) {
          event.preventDefault();
          onSave(active.path);
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
            const isActive = tab.path === activePath;
            const tabDirty = tab.content !== tab.savedContent;
            return (
              <div
                key={tab.path}
                className={`tab${isActive ? " active" : ""}`}
                onClick={() => onSelectTab(tab.path)}
                title={tab.path}
              >
                <span>{basename(tab.path)}</span>
                {tabDirty && <span className="dirty-dot">●</span>}
                <span
                  className="close"
                  onClick={(event) => {
                    event.stopPropagation();
                    onCloseTab(tab.path);
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
            onChange={(value) => onEdit(active.path, value ?? "")}
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
            <span title={active.path}>{basename(active.path)}</span>
            <span>{languageFromPath(active.path)}</span>
            {active.truncated && <span className="truncated">truncated</span>}
            <span style={{ marginLeft: "auto" }}>
              <button type="button" disabled={!dirty} onClick={() => onSave(active.path)}>
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
