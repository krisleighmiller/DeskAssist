import { useEffect, useRef, useState } from "react";
import {
  type CasefileSnapshot,
  type Context,
  type RecentContext,
} from "../types";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

interface ToolbarProps {
  casefile: CasefileSnapshot | null;
  recentContexts: RecentContext[];
  onOpenRecentContext: (root: string, activeContextId: string | null) => void | Promise<void>;
  onSwitchContext?: (contextId: string) => void;
  /** M2.5: Context management actions surfaced in the toolbar dropdown so
   * they are reachable without right-clicking the file tree. */
  onUpdateContextName?: (contextId: string, newName: string) => Promise<void>;
  onRemoveContext?: (contextId: string) => Promise<void>;
  onSetContextWritable?: (contextId: string, writable: boolean) => Promise<void>;
  onHardResetCasefile?: () => Promise<void>;
  onSoftResetCasefile?: () => Promise<void>;
  onQuickCapture?: () => void | Promise<void>;
}

function ancestorChain(casefile: CasefileSnapshot, contextId: string | null): Context[] {
  if (!contextId) return [];
  const byId = new Map(casefile.contexts.map((l) => [l.id, l]));
  const chain: Context[] = [];
  let current = byId.get(contextId);
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    chain.unshift(current);
    seen.add(current.id);
    const parentId = current.parentId ?? null;
    current = parentId ? byId.get(parentId) : undefined;
  }
  return chain;
}

function basenameFromPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function Toolbar(props: ToolbarProps): JSX.Element {
  const {
    casefile,
    recentContexts,
    onOpenRecentContext,
    onSwitchContext,
    onUpdateContextName,
    onRemoveContext,
    onSetContextWritable,
    onHardResetCasefile,
    onSoftResetCasefile,
    onQuickCapture,
  } = props;

  const chain = casefile ? ancestorChain(casefile, casefile.activeContextId) : [];

  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [recentMenuOpen, setRecentMenuOpen] = useState(false);
  const contextButtonRef = useRef<HTMLButtonElement>(null);
  const recentButtonRef = useRef<HTMLButtonElement>(null);

  const activeContext = casefile
    ? casefile.contexts.find((l) => l.id === casefile.activeContextId) ?? null
    : null;

  const openContextMenu = () => {
    setContextMenuOpen(true);
  };

  const openRecentMenu = () => {
    setRecentMenuOpen(true);
  };

  useEffect(() => {
    const openFromAppMenu = () => setRecentMenuOpen(true);
    window.addEventListener("deskassist:open-recent-menu", openFromAppMenu);
    return () => {
      window.removeEventListener("deskassist:open-recent-menu", openFromAppMenu);
    };
  }, []);

  /** Build the items list for the Context ▾ dropdown. */
  const buildContextMenuItems = () => {
    if (!casefile) return [];
    const items: import("./ContextMenu").ContextMenuItem[] = [];

    // Switch to another context.
    const others = casefile.contexts.filter((l) => l.id !== casefile.activeContextId);
    if (others.length > 0) {
      for (const context of others) {
        items.push({
          label: `Switch to "${context.name}"`,
          onSelect: () => {
            void Promise.resolve(onSwitchContext?.(context.id));
          },
        });
      }
      items[items.length - 1] = { ...items[items.length - 1], separator: true };
    }

    // Active-context management (rename, access toggle, remove).
    if (activeContext) {
      if (onUpdateContextName) {
        items.push({
          label: "Rename context…",
          onSelect: () => {
            const newName = window.prompt("New name for this context:", activeContext.name);
            if (!newName?.trim() || newName.trim() === activeContext.name) return;
            void onUpdateContextName(activeContext.id, newName.trim());
          },
        });
      }
      if (onSetContextWritable) {
        const isWritable = activeContext.writable !== false;
        items.push({
          label: isWritable
            ? "Set AI access: read-only"
            : "Set AI access: writable",
          onSelect: () => {
            void onSetContextWritable(activeContext.id, !isWritable);
          },
        });
      }
      if (onRemoveContext) {
        items.push({
          label: "Remove context",
          onSelect: () => {
            const ok = window.confirm(
              `Remove context "${activeContext.name}"?\n\nThis removes it from the workspace but does not delete any files.`
            );
            if (!ok) return;
            void onRemoveContext(activeContext.id);
          },
          separator: !!(onSoftResetCasefile || onHardResetCasefile),
        });
      }
    }

    // Casefile-level reset actions.
    if (onSoftResetCasefile) {
      items.push({
        label: "Reset workspace (soft)…",
        onSelect: () => {
          const ok = window.confirm(
            "Soft reset clears context registrations and chat history metadata. Files on disk are preserved."
          );
          if (!ok) return;
          void onSoftResetCasefile();
        },
      });
    }
    if (onHardResetCasefile) {
      items.push({
        label: "Hard reset workspace…",
        onSelect: () => {
          const ok = window.confirm(
            "Hard reset deletes the workspace metadata folder (.casefile).\n\nConversation history, context registrations, and settings will be permanently removed. Files on disk are preserved.\n\nThis cannot be undone. Continue?"
          );
          if (!ok) return;
          void onHardResetCasefile();
        },
      });
    }

    return items;
  };

  // Position the dropdown flush below the "Context ▾" button.
  const contextMenuPos = (() => {
    if (!contextButtonRef.current) return { x: 0, y: 32 };
    const rect = contextButtonRef.current.getBoundingClientRect();
    return { x: rect.left, y: rect.bottom + 2 };
  })();

  const recentMenuPos = (() => {
    if (!recentButtonRef.current) return { x: 0, y: 32 };
    const rect = recentButtonRef.current.getBoundingClientRect();
    return { x: rect.left, y: rect.bottom + 2 };
  })();

  const recentItems: ContextMenuItem[] = recentContexts.map((context) => {
    const rootName = basenameFromPath(context.root);
    const contextSuffix = context.activeContextName ? ` / ${context.activeContextName}` : "";
    return {
      label: `${rootName}${contextSuffix}`,
      onSelect: () => {
        void Promise.resolve(onOpenRecentContext(context.root, context.activeContextId));
      },
    };
  });

  return (
    <div className="toolbar">
      {recentContexts.length > 0 && (
        <div className="toolbar-context-menu-wrapper">
          <button
            ref={recentButtonRef}
            type="button"
            className="toolbar-context-btn"
            aria-haspopup="menu"
            aria-expanded={recentMenuOpen}
            onClick={openRecentMenu}
            title="Recent work"
          >
            Recent ▾
          </button>
          {recentMenuOpen && (
            <ContextMenu
              x={recentMenuPos.x}
              y={recentMenuPos.y}
              items={recentItems}
              onClose={() => setRecentMenuOpen(false)}
            />
          )}
        </div>
      )}
      {casefile ? (
        <span className="breadcrumb" title={casefile.root}>
          <span className="breadcrumb-root">{casefile.root}</span>
          {chain.length === 0 ? (
            <span className="breadcrumb-empty"> — no active context</span>
          ) : (
            chain.map((context, idx) => {
              const isLast = idx === chain.length - 1;
              return (
                <span key={context.id} className="breadcrumb-segment">
                  <span className="breadcrumb-sep"> / </span>
                  {onSwitchContext && !isLast ? (
                    <button
                      type="button"
                      className="breadcrumb-link"
                      onClick={() => onSwitchContext(context.id)}
                      title={context.root}
                    >
                      {context.name}
                    </button>
                  ) : (
                    <span
                      className={`breadcrumb-segment-label${isLast ? " active" : ""}`}
                      title={context.root}
                    >
                      {context.name}
                      <span className="breadcrumb-kind"> ({context.kind})</span>
                    </span>
                  )}
                </span>
              );
            })
          )}
        </span>
      ) : (
        <span className="breadcrumb breadcrumb-empty">No workspace open</span>
      )}
      {casefile && (
        <div className="toolbar-context-menu-wrapper">
          <button
            ref={contextButtonRef}
            type="button"
            className="toolbar-context-btn"
            aria-haspopup="menu"
            aria-expanded={contextMenuOpen}
            onClick={openContextMenu}
            title="Context management actions"
          >
            Context ▾
          </button>
          {contextMenuOpen && (
            <ContextMenu
              x={contextMenuPos.x}
              y={contextMenuPos.y}
              items={buildContextMenuItems()}
              onClose={() => setContextMenuOpen(false)}
            />
          )}
        </div>
      )}
      {casefile && onQuickCapture && (
        <button
          type="button"
          className="toolbar-context-btn"
          onClick={() => {
            void Promise.resolve(onQuickCapture());
          }}
          title="Open quick-capture.md in this workspace"
        >
          Quick Capture
        </button>
      )}
    </div>
  );
}
