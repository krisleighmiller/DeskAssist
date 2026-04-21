import { useEffect, useMemo, useRef, useState } from "react";
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
  /** The node the user right-clicked. May or may not be in `selectedPaths`
   * — we resolve "what does this menu act on?" at render time so that
   * acting on a single un-selected node Just Works. */
  node: FileTreeNode;
  /** Snapshot of the multi-selection at the time the menu opened. */
  selectedPaths: string[];
}

interface NodeProps {
  node: FileTreeNode;
  expanded: Set<string>;
  toggle: (path: string) => void;
  activePath: string | null;
  selected: Set<string>;
  depth: number;
  onRowClick: (event: React.MouseEvent, node: FileTreeNode) => void;
  onContextMenu: (event: React.MouseEvent, node: FileTreeNode) => void;
  onDragStartNode: (event: React.DragEvent, node: FileTreeNode) => void;
}

function TreeNode({
  node,
  expanded,
  toggle,
  activePath,
  selected,
  depth,
  onRowClick,
  onContextMenu,
  onDragStartNode,
}: NodeProps): JSX.Element {
  const isSelected = selected.has(node.path);
  const selClass = isSelected ? " selected" : "";
  if (node.type === "file") {
    const isActive = activePath === node.path;
    return (
      <div
        className={`tree-row${isActive ? " active" : ""}${selClass}`}
        style={{ paddingLeft: depth * 10 + 8 }}
        onClick={(event) => onRowClick(event, node)}
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
        className={`tree-row${selClass}`}
        style={{ paddingLeft: depth * 10 + 4 }}
        onClick={(event) => {
          // Plain clicks on a directory toggle expansion; modifier-clicks
          // are pure selection ops and must NOT collapse the row out from
          // under the user mid-range-select.
          if (!event.shiftKey && !event.ctrlKey && !event.metaKey) {
            toggle(node.path);
          }
          onRowClick(event, node);
        }}
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
              selected={selected}
              depth={depth + 1}
              onRowClick={onRowClick}
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

/** Translate a virtual overlay path (e.g. `_ancestors/task/ash_notes`) to
 * the real on-disk absolute path by joining the matching overlay's `root`
 * with the path segment after the prefix. Returns null if no overlay
 * prefix matches the input — callers should treat that as "leave the
 * payload virtual". The match is on full path segments so `_ancestors/foo`
 * does not match `_ancestors/foobar`. We try the longest prefixes first
 * because main.js can register nested overlays (e.g. an attachment
 * mounted under an ancestor). */
function resolveVirtualToReal(
  virtualPath: string,
  overlays: OverlayTreeDto[] | undefined
): string | null {
  if (!overlays || overlays.length === 0) return null;
  const candidates = overlays
    .filter((o) => typeof o.root === "string" && o.root.length > 0)
    .slice()
    .sort((a, b) => b.prefix.length - a.prefix.length);
  for (const overlay of candidates) {
    const prefix = overlay.prefix;
    if (virtualPath === prefix) {
      return overlay.root;
    }
    if (virtualPath.startsWith(prefix + "/")) {
      const rest = virtualPath.slice(prefix.length + 1);
      const base = overlay.root.replace(/[\\/]+$/, "");
      return rest ? `${base}/${rest}` : base;
    }
  }
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
 * external file, text selection, etc.). The payload is a JSON string
 * carrying one OR many `FileTreeDragPayload` entries — multi-select drags
 * always send an array, single-row drags send a single object. Drop
 * handlers should accept both shapes (see `parseDragPayload` below). */
export const FILETREE_DRAG_MIME = "application/x-deskassist-tree-node";

export interface FileTreeDragPayload {
  relativePath: string | null;
  absolutePath: string;
  /** Set for overlay nodes (e.g. `_ancestors/<lane>/foo.md`). Drop targets
   * that need the model-facing virtual path (chat composer) read this;
   * targets that need a real on-disk path (lane attachment editor) read
   * `absolutePath` instead. Undefined for non-overlay nodes. */
  virtualPath?: string;
  type: "file" | "dir";
}

/** Normalise the drag payload string into a list. Older callers that only
 * sent a single object continue to work (and brand-new multi-select
 * drags get the array shape). */
export function parseDragPayload(raw: string): FileTreeDragPayload[] {
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) return parsed as FileTreeDragPayload[];
  return [parsed as FileTreeDragPayload];
}

/** Walk an expanded tree in render order, returning a flat list of node
 * paths. Used to resolve shift-click ranges: the anchor and the clicked
 * node are looked up by index, and every visible row between them
 * (inclusive) joins the selection.
 *
 * Closed directories contribute only themselves (their children are not
 * visible, so they cannot be part of a range). */
function flattenVisible(
  root: FileTreeNode | null,
  expanded: Set<string>,
  overlays: OverlayTreeDto[] | undefined,
  showOverlays: boolean | undefined
): string[] {
  const out: string[] = [];
  const walk = (node: FileTreeNode) => {
    out.push(node.path);
    if (node.type === "dir" && expanded.has(node.path)) {
      const children = [...(node.children ?? [])].sort(compareNodes);
      for (const child of children) walk(child);
    }
  };
  if (root) walk(root);
  if (showOverlays && overlays) {
    for (const overlay of overlays) {
      if (overlay.tree) walk(overlay.tree);
    }
  }
  return out;
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
  // Multi-selection state. `selected` is the set of selected node paths;
  // `anchor` is the most recent plain/ctrl-click target and serves as the
  // shift-click range origin, mirroring File-Explorer / Finder behaviour.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [anchor, setAnchor] = useState<string | null>(null);

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

  // Whenever the tree root changes (different workspace / lane), drop
  // the selection and anchor — keeping them around would orphan paths
  // that no longer exist in the new tree.
  const lastRootPath = useRef<string | null>(null);
  useEffect(() => {
    const next = root?.path ?? null;
    if (next !== lastRootPath.current) {
      lastRootPath.current = next;
      setSelected(new Set());
      setAnchor(null);
    }
  }, [root]);

  // Memoised because the visible-order list is rebuilt for every shift-click.
  const visibleOrder = useMemo(
    () => flattenVisible(root, expanded, overlays, showOverlays),
    [root, expanded, overlays, showOverlays]
  );

  const toggle = (p: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  };

  /** Resolve the new selection given a click event + target node, then
   * decide whether to also "open" the node. Mirrors VSCode / Explorer:
   *   - plain click            → select-only (replace), open if file
   *   - ctrl/meta click        → toggle in selection, do NOT open
   *   - shift click            → range from anchor to node, do NOT open
   *   - shift + ctrl/meta      → extend range without clearing existing
   * The anchor is updated on plain and ctrl-click; shift-click leaves it
   * alone so successive shift-clicks pivot around the same origin. */
  const handleRowClick = (event: React.MouseEvent, node: FileTreeNode) => {
    const path = node.path;
    const isMulti = event.ctrlKey || event.metaKey;
    const isRange = event.shiftKey;

    if (isRange && anchor) {
      const idxAnchor = visibleOrder.indexOf(anchor);
      const idxClicked = visibleOrder.indexOf(path);
      if (idxAnchor !== -1 && idxClicked !== -1) {
        const lo = Math.min(idxAnchor, idxClicked);
        const hi = Math.max(idxAnchor, idxClicked);
        const range = visibleOrder.slice(lo, hi + 1);
        setSelected((prev) => {
          const base = isMulti ? new Set(prev) : new Set<string>();
          for (const p of range) base.add(p);
          return base;
        });
      }
      return;
    }

    if (isMulti) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
      setAnchor(path);
      return;
    }

    // Plain click: select just this node, become the new anchor, and
    // open the file (directories are toggled by the TreeNode itself).
    setSelected(new Set([path]));
    setAnchor(path);
    if (node.type === "file") {
      // Overlay-tree files use virtual paths and have a different opener;
      // route them through the appropriate callback.
      const isVirtual = node.path.startsWith("_");
      if (isVirtual && onOpenOverlayFile) {
        onOpenOverlayFile(node.path);
      } else {
        onOpenFile(node.path);
      }
    }
  };

  const handleContextMenu = (event: React.MouseEvent, node: FileTreeNode) => {
    event.preventDefault();
    event.stopPropagation();
    // If the right-clicked node isn't in the current selection, reset the
    // selection to just this node — File-Explorer behaviour. Otherwise
    // keep the existing multi-selection so menu actions act on all of it.
    let snapshot: string[];
    if (selected.has(node.path)) {
      snapshot = Array.from(selected);
    } else {
      snapshot = [node.path];
      setSelected(new Set([node.path]));
      setAnchor(node.path);
    }
    setMenu({ x: event.clientX, y: event.clientY, node, selectedPaths: snapshot });
  };

  /** Build a `FileTreeDragPayload` for an absolute (or virtual) tree-node
   * path. For overlay nodes (virtual paths like `_ancestors/<lane>/...`)
   * `absolutePath` carries the *real* on-disk path resolved through the
   * overlay's `root`, so drop targets like the lane attachment editor get
   * a path the Python bridge can actually resolve. The virtual path stays
   * available via `virtualPath` for consumers (e.g. the chat composer's
   * text-fallback) that want to surface the model-facing prefix. */
  const buildPayload = (path: string, type: "file" | "dir"): FileTreeDragPayload => {
    const isVirtual = path.startsWith("_");
    if (isVirtual) {
      const real = resolveVirtualToReal(path, overlays);
      return {
        relativePath: null,
        absolutePath: real ?? path,
        virtualPath: path,
        type,
      };
    }
    const relativePath = casefileRoot ? relativeFromBase(path, casefileRoot) : null;
    return { relativePath, absolutePath: path, type };
  };

  const handleDragStartNode = (event: React.DragEvent, node: FileTreeNode) => {
    // If the dragged node is part of the multi-selection, the drag
    // payload covers the whole selection. Otherwise it's just this one
    // row and the multi-selection is left untouched (so the user doesn't
    // lose their selection by dragging an unrelated file).
    let payloads: FileTreeDragPayload[];
    let plainText: string;
    if (selected.has(node.path) && selected.size > 1) {
      // We don't have node-type metadata for arbitrary selected paths
      // (they may live in collapsed branches), so we treat them as
      // files-by-default. Drop targets that care (e.g. the context
      // editor) only consume the relative path anyway.
      payloads = Array.from(selected).map((p) => buildPayload(p, p === node.path ? node.type : "file"));
      plainText = payloads
        .map((p) => p.relativePath ?? p.virtualPath ?? p.absolutePath)
        .join("\n");
    } else {
      payloads = [buildPayload(node.path, node.type)];
      plainText =
        payloads[0].relativePath ?? payloads[0].virtualPath ?? payloads[0].absolutePath;
    }
    event.dataTransfer.setData(FILETREE_DRAG_MIME, JSON.stringify(payloads));
    // Plain-text fallback so the payload drops cleanly into any text
    // input (e.g. the chat composer).
    event.dataTransfer.setData("text/plain", plainText);
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

  // Build menu items from the snapshot, not from `selected` directly —
  // the snapshot is what the user saw when they opened the menu.
  const menuItems: ContextMenuItem[] = (() => {
    if (!menu) return [];
    const paths = menu.selectedPaths;
    const count = paths.length;
    const multi = count > 1;
    const namesOf = (p: string) => p.split(/[\\/]/).pop() ?? p;
    const relOf = (p: string): string | null => {
      if (p.startsWith("_")) return null;
      return casefileRoot ? relativeFromBase(p, casefileRoot) : null;
    };
    const rels = paths.map(relOf);
    const allRel = rels.every((r) => r !== null) ? (rels as string[]) : null;

    return [
      {
        label: multi ? `Copy ${count} names` : "Copy name",
        onSelect: () => {
          const text = multi ? paths.map(namesOf).join("\n") : namesOf(paths[0]);
          void copyToClipboard(text);
        },
      },
      {
        label: multi
          ? allRel
            ? `Copy ${count} relative paths`
            : `Copy relative paths (some n/a)`
          : rels[0]
            ? "Copy relative path"
            : "Copy relative path (n/a)",
        onSelect: () => {
          const usable = rels.filter((r): r is string => r !== null);
          if (usable.length > 0) void copyToClipboard(usable.join("\n"));
        },
        disabled: !rels.some((r) => r !== null),
        separator: !onAddToContext,
      },
      {
        label: multi ? `Copy ${count} full paths` : "Copy full path",
        onSelect: () => {
          void copyToClipboard(multi ? paths.join("\n") : paths[0]);
        },
        separator: Boolean(onAddToContext),
      },
      ...(onAddToContext
        ? [
            {
              label: multi
                ? allRel
                  ? `Add ${count} items to casefile context`
                  : `Add to casefile context (${rels.filter((r) => r !== null).length}/${count})`
                : rels[0]
                  ? `Add to casefile context (${menu.node.type})`
                  : "Add to casefile context (n/a)",
              onSelect: () => {
                if (!onAddToContext) return;
                // Map each path to a pattern: directories get a recursive
                // glob, files keep their literal relative path. Skip any
                // entries we couldn't make relative (overlay / outside).
                for (let i = 0; i < paths.length; i++) {
                  const rel = rels[i];
                  if (!rel) continue;
                  // Without per-path type info we treat the right-clicked
                  // node's type as authoritative for itself, and any
                  // other selected paths as files (the safe default —
                  // users can refine with an explicit dir glob).
                  const isDir = paths[i] === menu.node.path && menu.node.type === "dir";
                  const pattern = isDir ? `${rel.replace(/\/$/, "")}/**/*` : rel;
                  onAddToContext(pattern);
                }
              },
              disabled: !rels.some((r) => r !== null),
            },
          ]
        : []),
    ];
  })();

  return (
    <div
      className="file-tree"
      onClick={(event) => {
        // Click on the empty area below the tree clears the selection
        // (matches Explorer / Finder). Don't clear if the click landed
        // on a tree-row — those have their own handler that has already
        // updated the selection.
        if (event.target === event.currentTarget) {
          setSelected(new Set());
          setAnchor(null);
        }
      }}
    >
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
        selected={selected}
        depth={0}
        onRowClick={handleRowClick}
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
                selected={selected}
                depth={0}
                onRowClick={handleRowClick}
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
