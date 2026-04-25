import { useEffect, useRef, useState } from "react";
import {
  type CasefileSnapshot,
  type Lane,
  type RecentContext,
} from "../types";
import { ContextMenu } from "./ContextMenu";

interface ToolbarProps {
  casefile: CasefileSnapshot | null;
  recentContexts: RecentContext[];
  onOpenRecentContext: (root: string, activeLaneId: string | null) => void | Promise<void>;
  onSwitchLane?: (laneId: string) => void;
  /** M2.5: Lane management actions surfaced in the toolbar dropdown so
   * they are reachable without right-clicking the file tree. */
  onUpdateLaneName?: (laneId: string, newName: string) => Promise<void>;
  onRemoveLane?: (laneId: string) => Promise<void>;
  onSetLaneWritable?: (laneId: string, writable: boolean) => Promise<void>;
  onHardResetCasefile?: () => Promise<void>;
  onSoftResetCasefile?: () => Promise<void>;
}

function ancestorChain(casefile: CasefileSnapshot, laneId: string | null): Lane[] {
  if (!laneId) return [];
  const byId = new Map(casefile.lanes.map((l) => [l.id, l]));
  const chain: Lane[] = [];
  let current = byId.get(laneId);
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
    onSwitchLane,
    onUpdateLaneName,
    onRemoveLane,
    onSetLaneWritable,
    onHardResetCasefile,
    onSoftResetCasefile,
  } = props;

  const chain = casefile ? ancestorChain(casefile, casefile.activeLaneId) : [];

  const [laneMenuOpen, setLaneMenuOpen] = useState(false);
  const [recentMenuOpen, setRecentMenuOpen] = useState(false);
  const laneButtonRef = useRef<HTMLButtonElement>(null);
  const recentButtonRef = useRef<HTMLButtonElement>(null);

  const activeLane = casefile
    ? casefile.lanes.find((l) => l.id === casefile.activeLaneId) ?? null
    : null;

  const openLaneMenu = () => {
    setLaneMenuOpen(true);
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

  /** Build the items list for the Lane ▾ dropdown. */
  const buildLaneMenuItems = () => {
    if (!casefile) return [];
    const items: import("./ContextMenu").ContextMenuItem[] = [];

    // Switch to another lane.
    const others = casefile.lanes.filter((l) => l.id !== casefile.activeLaneId);
    if (others.length > 0) {
      for (const lane of others) {
        items.push({
          label: `Switch to "${lane.name}"`,
          onSelect: () => {
            void Promise.resolve(onSwitchLane?.(lane.id));
          },
        });
      }
      items[items.length - 1] = { ...items[items.length - 1], separator: true };
    }

    // Active-lane management (rename, access toggle, remove).
    if (activeLane) {
      if (onUpdateLaneName) {
        items.push({
          label: "Rename context…",
          onSelect: () => {
            const newName = window.prompt("New name for this context:", activeLane.name);
            if (!newName?.trim() || newName.trim() === activeLane.name) return;
            void onUpdateLaneName(activeLane.id, newName.trim());
          },
        });
      }
      if (onSetLaneWritable) {
        const isWritable = activeLane.writable !== false;
        items.push({
          label: isWritable
            ? "Set AI access: read-only"
            : "Set AI access: writable",
          onSelect: () => {
            void onSetLaneWritable(activeLane.id, !isWritable);
          },
        });
      }
      if (onRemoveLane) {
        items.push({
          label: "Remove context",
          onSelect: () => {
            const ok = window.confirm(
              `Remove context "${activeLane.name}"?\n\nThis removes it from the workspace but does not delete any files.`
            );
            if (!ok) return;
            void onRemoveLane(activeLane.id);
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

  // Position the dropdown flush below the "Lane ▾" button.
  const laneMenuPos = (() => {
    if (!laneButtonRef.current) return { x: 0, y: 32 };
    const rect = laneButtonRef.current.getBoundingClientRect();
    return { x: rect.left, y: rect.bottom + 2 };
  })();

  const recentMenuPos = (() => {
    if (!recentButtonRef.current) return { x: 0, y: 32 };
    const rect = recentButtonRef.current.getBoundingClientRect();
    return { x: rect.left, y: rect.bottom + 2 };
  })();

  const recentItems: ContextMenuItem[] = recentContexts.map((context) => {
    const rootName = basenameFromPath(context.root);
    const laneSuffix = context.activeLaneName ? ` / ${context.activeLaneName}` : "";
    return {
      label: `${rootName}${laneSuffix}`,
      onSelect: () => {
        void Promise.resolve(onOpenRecentContext(context.root, context.activeLaneId));
      },
    };
  });

  return (
    <div className="toolbar">
      {recentContexts.length > 0 && (
        <div className="toolbar-lane-menu-wrapper">
          <button
            ref={recentButtonRef}
            type="button"
            className="toolbar-lane-btn"
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
            chain.map((lane, idx) => {
              const isLast = idx === chain.length - 1;
              return (
                <span key={lane.id} className="breadcrumb-segment">
                  <span className="breadcrumb-sep"> / </span>
                  {onSwitchLane && !isLast ? (
                    <button
                      type="button"
                      className="breadcrumb-link"
                      onClick={() => onSwitchLane(lane.id)}
                      title={lane.root}
                    >
                      {lane.name}
                    </button>
                  ) : (
                    <span
                      className={`breadcrumb-segment-label${isLast ? " active" : ""}`}
                      title={lane.root}
                    >
                      {lane.name}
                      <span className="breadcrumb-kind"> ({lane.kind})</span>
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
        <div className="toolbar-lane-menu-wrapper">
          <button
            ref={laneButtonRef}
            type="button"
            className="toolbar-lane-btn"
            aria-haspopup="menu"
            aria-expanded={laneMenuOpen}
            onClick={openLaneMenu}
            title="Context management actions"
          >
            Context ▾
          </button>
          {laneMenuOpen && (
            <ContextMenu
              x={laneMenuPos.x}
              y={laneMenuPos.y}
              items={buildLaneMenuItems()}
              onClose={() => setLaneMenuOpen(false)}
            />
          )}
        </div>
      )}
    </div>
  );
}
