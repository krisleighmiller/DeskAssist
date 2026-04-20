import { useEffect, useState } from "react";
import type { FileTreeNode, OverlayTreeDto } from "../types";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

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
  /** M3.5c+: casefile root, used to compute relative paths for the
   * right-click "Copy relative path" / "Add to casefile context" actions
   * and to populate drag payloads. When null, only absolute-path actions
   * are offered. */
  casefileRoot?: string | null;
  /** M3.5c+: invoked when the user picks "Add to casefile context" from
   * the right-click menu (or drops a tree node onto the context editor's
   * drop target — the FileTree just sets up the dataTransfer payload).
   * The path passed is the casefile-relative POSIX path. */
  onAddToContext?: (relativePath: string) => void;
}

function compareNodes(a: FileTreeNode, b: FileTreeNode): number {
  if (a.type !== b.type) {
    return a.type === "dir" ? -1 : 1;
  }
  return a.name.localeCompare(b.name);
}

interface MenuState {
  x: number;
  y: number;
  node: FileTreeNode;
  /** Absolute filesystem path. Always equals node.path for the active-lane
   * tree, but for overlay trees node.path is the virtual prefix and we
   * don't have the real fs path — in that case we fall back to the prefix. */
  absolutePath: string;
  /** Path relative to the casefile root, or null if it could not be
   * computed (overlay nodes, or nodes outside the casefile root). */
  relativePath: string | null;
}

interface NodeProps {
  node: FileTreeNode;
  expanded: Set<string>;
  toggle: (path: string) => void;
  activePath: string | null;
  onOpenFile: (path: string) => void;
  depth: number;
  onContextMenu: (event: React.MouseEvent, node: FileTreeNode) => void;
  onDragStartNode: (event: React.DragEvent, node: FileTreeNode) => void;
}

function TreeNode({
  node,
  expanded,
  toggle,
  activePath,
  onOpenFile,
  depth,
  onContextMenu,
  onDragStartNode,
}: NodeProps): JSX.Element {
  if (node.type === "file") {
    const isActive = activePath === node.path;
    return (
      <div
        className={`tree-row${isActive ? " active" : ""}`}
        style={{ paddingLeft: depth * 10 + 8 }}
        onClick={() => onOpenFile(node.path)}
        onContextMenu={(event) => onContextMenu(event, node)}
        title={node.path}
        draggable
        onDragStart={(event) => onDragStartNode(event, node)}
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
        onContextMenu={(event) => onContextMenu(event, node)}
        title={node.path}
        draggable
        onDragStart={(event) => onDragStartNode(event, node)}
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
              onContextMenu={onContextMenu}
              onDragStartNode={onDragStartNode}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Compute a POSIX path relative to `base`, or null if `path` is not
 * inside `base`. We do this in the renderer (not via the bridge) because
 * it has to fire on every right-click and a synchronous string-prefix
 * check is plenty given that tree nodes already carry absolute paths.
 *
 * Both inputs are normalized to forward slashes so a Windows base of
 * `C:\foo` matches a tree path of `C:/foo/bar.txt`; mixing native and
 * POSIX separators is the dominant source of "off-by-one slash" bugs in
 * Electron file paths.
 */
function relativeFromBase(absolute: string, base: string): string | null {
  const a = absolute.replace(/\\/g, "/");
  const b = base.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!b) return null;
  if (a === b) return ".";
  if (a.startsWith(b + "/")) return a.slice(b.length + 1);
  return null;
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for environments without the async clipboard API.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } finally {
      document.body.removeChild(ta);
    }
  }
}

/** Custom MIME type for our drag payloads. The drop targets read this to
 * distinguish "a tree row was dragged" from any other drag activity (URL,
 * external file, text selection, etc.). The payload is a JSON string with
 * `{ relativePath, absolutePath, type }`. */
export const FILETREE_DRAG_MIME = "application/x-deskassist-tree-node";

export interface FileTreeDragPayload {
  relativePath: string | null;
  absolutePath: string;
  type: "file" | "dir";
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
  casefileRoot,
  onAddToContext,
}: FileTreeProps): JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [menu, setMenu] = useState<MenuState | null>(null);

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

  const handleContextMenu = (event: React.MouseEvent, node: FileTreeNode) => {
    event.preventDefault();
    event.stopPropagation();
    // Overlay node paths are virtual prefixes (e.g. `_ancestors/foo/bar.md`)
    // and therefore have no meaningful "absolute path" we can copy. We still
    // offer Copy name / Copy virtual path for them.
    const isVirtual = node.path.startsWith("_");
    const absolutePath = node.path;
    const relativePath = isVirtual
      ? null
      : casefileRoot
        ? relativeFromBase(absolutePath, casefileRoot)
        : null;
    setMenu({
      x: event.clientX,
      y: event.clientY,
      node,
      absolutePath,
      relativePath,
    });
  };

  const handleDragStartNode = (event: React.DragEvent, node: FileTreeNode) => {
    const isVirtual = node.path.startsWith("_");
    const relativePath = isVirtual
      ? null
      : casefileRoot
        ? relativeFromBase(node.path, casefileRoot)
        : null;
    const payload: FileTreeDragPayload = {
      relativePath,
      absolutePath: node.path,
      type: node.type,
    };
    event.dataTransfer.setData(FILETREE_DRAG_MIME, JSON.stringify(payload));
    // Also include plain text so the payload is dragable into any text
    // input (e.g. the chat composer): the relative path if we have one,
    // otherwise the absolute path / virtual prefix.
    event.dataTransfer.setData("text/plain", relativePath ?? node.path);
    event.dataTransfer.effectAllowed = "copy";
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

  const menuItems: ContextMenuItem[] = menu
    ? [
        {
          label: "Copy name",
          onSelect: () => void copyToClipboard(menu.node.name),
        },
        {
          label: menu.relativePath ? "Copy relative path" : "Copy relative path (n/a)",
          onSelect: () => {
            if (menu.relativePath) void copyToClipboard(menu.relativePath);
          },
          disabled: !menu.relativePath,
          separator: !onAddToContext,
        },
        {
          label: "Copy full path",
          onSelect: () => void copyToClipboard(menu.absolutePath),
          separator: Boolean(onAddToContext),
        },
        ...(onAddToContext
          ? [
              {
                label: menu.relativePath
                  ? `Add to casefile context (${menu.node.type})`
                  : "Add to casefile context (n/a)",
                onSelect: () => {
                  if (menu.relativePath && onAddToContext) {
                    // For directories we add a recursive glob so the
                    // context editor's resolver picks up everything inside.
                    const pattern =
                      menu.node.type === "dir"
                        ? `${menu.relativePath.replace(/\/$/, "")}/**/*`
                        : menu.relativePath;
                    onAddToContext(pattern);
                  }
                },
                disabled: !menu.relativePath,
              },
            ]
          : []),
      ]
    : [];

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
        onContextMenu={handleContextMenu}
        onDragStartNode={handleDragStartNode}
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
                onContextMenu={handleContextMenu}
                onDragStartNode={handleDragStartNode}
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
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
