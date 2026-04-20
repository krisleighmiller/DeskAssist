import { useEffect, useState } from "react";
import type { FileTreeNode, OverlayTreeDto } from "../types";

interface FileTreeProps {
  root: FileTreeNode | null;
  activePath: string | null;
  hasWorkspace: boolean;
  error: string | null;
  onOpenFile: (path: string) => void;
  // M3.5: optional overlay (ancestor / attachment / context) trees and toggle
  // state. When `showOverlays` is true the parent component fetches the
  // overlays via the bridge and passes them in; the tree renders them as
  // collapsible siblings under the main lane root.
  overlays?: OverlayTreeDto[];
  overlaysLoading?: boolean;
  overlaysError?: string | null;
  showOverlays?: boolean;
  canShowOverlays?: boolean;
  onToggleOverlays?: () => void;
  onOpenOverlayFile?: (virtualPath: string) => void;
}

function compareNodes(a: FileTreeNode, b: FileTreeNode): number {
  if (a.type !== b.type) {
    return a.type === "dir" ? -1 : 1;
  }
  return a.name.localeCompare(b.name);
}

interface NodeProps {
  node: FileTreeNode;
  expanded: Set<string>;
  toggle: (path: string) => void;
  activePath: string | null;
  onOpenFile: (path: string) => void;
  depth: number;
}

function TreeNode({ node, expanded, toggle, activePath, onOpenFile, depth }: NodeProps): JSX.Element {
  if (node.type === "file") {
    const isActive = activePath === node.path;
    return (
      <div
        className={`tree-row${isActive ? " active" : ""}`}
        style={{ paddingLeft: depth * 10 + 8 }}
        onClick={() => onOpenFile(node.path)}
        title={node.path}
      >
        <span className="twisty"> </span>
        <span className="icon">·</span>
        <span>{node.name}</span>
      </div>
    );
  }
  const isOpen = expanded.has(node.path);
  const sorted = [...(node.children ?? [])].sort(compareNodes);
  return (
    <div>
      <div
        className="tree-row"
        style={{ paddingLeft: depth * 10 + 4 }}
        onClick={() => toggle(node.path)}
        title={node.path}
      >
        <span className="twisty">{isOpen ? "▾" : "▸"}</span>
        <span className="icon">▣</span>
        <span>{node.name}</span>
      </div>
      {isOpen && sorted.length > 0 && (
        <div>
          {sorted.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              expanded={expanded}
              toggle={toggle}
              activePath={activePath}
              onOpenFile={onOpenFile}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function FileTree({
  root,
  activePath,
  hasWorkspace,
  error,
  onOpenFile,
  overlays,
  overlaysLoading,
  overlaysError,
  showOverlays,
  canShowOverlays,
  onToggleOverlays,
  onOpenOverlayFile,
}: FileTreeProps): JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (root) {
      setExpanded((prev) => {
        if (prev.has(root.path)) return prev;
        const next = new Set(prev);
        next.add(root.path);
        return next;
      });
    }
  }, [root]);

  // Auto-expand newly-arriving overlay roots so the user sees their
  // contents on first toggle without an extra click each.
  useEffect(() => {
    if (!showOverlays || !overlays) return;
    setExpanded((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const overlay of overlays) {
        if (overlay.tree && !next.has(overlay.tree.path)) {
          next.add(overlay.tree.path);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [showOverlays, overlays]);

  const toggle = (p: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  };

  if (error) {
    return <div className="file-tree"><div className="empty">Error: {error}</div></div>;
  }
  if (!hasWorkspace) {
    return (
      <div className="file-tree">
        <div className="empty">No workspace selected. Choose one from the toolbar.</div>
      </div>
    );
  }
  if (!root) {
    return <div className="file-tree"><div className="empty">Loading...</div></div>;
  }

  return (
    <div className="file-tree">
      {canShowOverlays && onToggleOverlays && (
        <label className="overlay-toggle">
          <input
            type="checkbox"
            checked={Boolean(showOverlays)}
            onChange={onToggleOverlays}
          />
          <span>Show ancestor / attachment / context files</span>
          {overlaysLoading && <span className="muted"> (loading…)</span>}
        </label>
      )}
      <TreeNode
        node={root}
        expanded={expanded}
        toggle={toggle}
        activePath={activePath}
        onOpenFile={onOpenFile}
        depth={0}
      />
      {showOverlays && overlays && overlays.length > 0 && (
        <div className="overlay-section">
          <div className="overlay-section-title">Inherited context</div>
          {overlays.map((overlay) =>
            overlay.tree ? (
              <TreeNode
                key={overlay.prefix}
                node={overlay.tree}
                expanded={expanded}
                toggle={toggle}
                activePath={activePath}
                onOpenFile={(virtualPath) => {
                  if (onOpenOverlayFile) onOpenOverlayFile(virtualPath);
                }}
                depth={0}
              />
            ) : (
              <div key={overlay.prefix} className="empty">
                {overlay.prefix}: {overlay.error || "unavailable"}
              </div>
            )
          )}
        </div>
      )}
      {showOverlays && overlaysError && (
        <div className="empty">Overlay error: {overlaysError}</div>
      )}
    </div>
  );
}
