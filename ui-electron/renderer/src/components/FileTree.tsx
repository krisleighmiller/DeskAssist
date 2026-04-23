import { useEffect, useMemo, useRef, useState } from "react";
import type { FileTreeNode } from "../types";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { InputDialog } from "./InputDialog";

/** Lightweight summary of the lanes in the active casefile. We only
 * need (id, name, root) here — the FileTree uses these to detect
 * which directory rows correspond to a registered lane root and to
 * populate the "Compare with…" picker. Lifted to a local interface
 * so we don't drag the full `Lane` type (and its `attachments`
 * reverse dependency) into the tree. */
export interface FileTreeLaneInfo {
  id: string;
  name: string;
  root: string;
  /** M2.5: whether this lane has AI write access. Undefined/true means writable. */
  writable?: boolean;
}

interface FileTreeProps {
  root: FileTreeNode | null;
  activePath: string | null;
  hasWorkspace: boolean;
  error: string | null;
  onOpenFile: (path: string) => void;
  // NOTE: pre-M2.1 versions also rendered ancestor / attachment /
  // context overlay trees as separate sections below the main tree.
  // That UI was confusing — users saw `_ancestors/...` / `_attachments/...`
  // virtual paths next to real lane files with no clear meaning. The
  // overlay system still drives AI scope behind the scenes (see
  // `src/assistant_app/casefile/scope.py`); the tree just no longer
  // visualises it. The associated props (`overlays`, `showOverlays`,
  // `onToggleOverlays`, `onOpenOverlayFile`, …) were dropped.
  /** M3.5c+: casefile root, used to compute relative paths for the
   * right-click "Copy relative path" / "Add to casefile context" actions
   * and to populate drag payloads. When null, only absolute-path actions
   * are offered. */
  casefileRoot?: string | null;
  /** Invoked when the user dismisses the error banner that surfaces above
   * the tree. The parent owns the error state and is responsible for
   * clearing it. When omitted the banner becomes non-dismissible (which
   * is fine for fatal load failures but a bad UX for transient operation
   * errors, so callers should generally provide it). */
  onDismissError?: () => void;
  /** M3.5c+: invoked when the user picks "Add to casefile context" from
   * the right-click menu (or drops a tree node onto the context editor's
   * drop target — the FileTree just sets up the dataTransfer payload).
   * The path passed is the casefile-relative POSIX path. */
  onAddToContext?: (relativePath: string) => void;
  /** Invoked when the user picks "Rename..." from the context menu.
   * The parent is responsible for performing the rename via the bridge
   * (which validates and may reject) and refreshing the tree. The
   * current path is the absolute on-disk path; `newName` is a basename
   * the user typed (no path separators — the prompt enforces that). */
  onRename?: (path: string, newName: string) => Promise<void> | void;
  /** Invoked when the user clicks the toolbar "Refresh" button. The
   * parent should re-fetch the workspace tree (and overlays, if open).
   * The button is hidden when this prop is omitted. */
  onRefresh?: () => void;
  // ----- M2: browser-driven workspace mutations -----
  /** Lane root the tree is currently rooted at. Used to compute the
   * lane-relative paths shown in the Move… prompt and to validate
   * destinations when typed by hand. */
  activeLaneRoot?: string | null;
  /** Additional roots (besides `activeLaneRoot`) that belong to the
   * active lane's scope — typically the lane's read-only attachment
   * roots. Tree rows at or under any of these are tinted with the
   * `in-active-lane` colour cue. */
  activeLaneScopeRoots?: string[];
  /** Active lane id, used to skip the "Attach to current lane" action
   * when the right-clicked node *is* the active lane's own root. */
  activeLaneId?: string | null;
  /** All lanes in the open casefile. The FileTree uses this to:
   *   - tag rows whose path equals a lane root with the lane name,
   *   - enable the "Compare with…" action only on lane-root rows,
   *   - populate the compare picker.
   * When omitted the lane-aware actions are simply hidden. */
  lanes?: FileTreeLaneInfo[];
  /** Create a new (empty) file at `<parentDir>/<name>`. The bridge
   * validates the parent and refuses to clobber an existing entry. */
  onCreateFile?: (parentDir: string, name: string) => Promise<void> | void;
  /** Create a new directory at `<parentDir>/<name>`. */
  onCreateFolder?: (parentDir: string, name: string) => Promise<void> | void;
  /** Move `sourcePath` to `destinationPath` (both lane-absolute). Used
   * by both the Move… prompt and the drag-and-drop drop handler. */
  onMoveEntry?: (sourcePath: string, destinationPath: string) => Promise<void> | void;
  /** Move the entry to the OS trash. The parent is responsible for
   * confirming the action with the user; the FileTree just calls
   * straight through to the bridge. */
  onTrashEntry?: (path: string) => Promise<void> | void;
  /** Register the right-clicked directory as a new lane in the open
   * casefile. The parent owns the registration form / dialog. */
  onCreateLaneFromPath?: (path: string, defaultName: string) => Promise<void> | void;
  /** Attach the right-clicked directory to any lane the user selects.
   * A secondary lane-picker menu is shown before the label prompt.
   * M2.5: replaces the old single-target `onAttachToActiveLane`. */
  onAttachToLane?: (path: string, laneId: string, name: string) => Promise<void> | void;
  /** Start a comparison between two lanes. Invoked when the user picks
   * a target lane from the "Compare with…" sub-menu. */
  onStartLaneComparison?: (selfLaneId: string, otherLaneId: string) => Promise<void> | void;
  /** Switch the active lane to the lane whose root was right-clicked.
   * Added in M2.5 so lane switching works without the Lanes tab. */
  onSwitchLane?: (laneId: string) => void | Promise<void>;
  /** Rename the lane whose root was right-clicked.
   * Added in M2.5 so lane editing works without the Lanes tab. */
  onUpdateLaneName?: (laneId: string, newName: string) => Promise<void> | void;
  /** Remove the lane whose root was right-clicked.
   * Added in M2.5 so lane removal works without the Lanes tab. */
  onRemoveLane?: (laneId: string) => Promise<void> | void;
  /** Toggle the AI write access for the lane whose root was right-clicked.
   * M2.5: per-directory read/write permissions. */
  onSetLaneWritable?: (laneId: string, writable: boolean) => Promise<void> | void;
  /** Reset the casefile metadata (soft reset — keeps data files on disk).
   * M2.5: restored from LanesTab. */
  onSoftResetCasefile?: () => Promise<void> | void;
  /** Hard-reset the casefile metadata directory entirely.
   * M2.5: restored from LanesTab. */
  onHardResetCasefile?: () => Promise<void> | void;
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

/** Return true when `nodePath` is at or under any of the supplied
 * roots. Both `/` and `\` are accepted as separators so the check
 * works on Windows and POSIX without normalising every node up front. */
function pathInAnyRoot(
  nodePath: string,
  primary: string | null | undefined,
  extras: string[] | null | undefined
): boolean {
  const candidates: string[] = [];
  if (primary) candidates.push(primary);
  if (extras) {
    for (const root of extras) {
      if (root && !candidates.includes(root)) candidates.push(root);
    }
  }
  for (const root of candidates) {
    if (
      nodePath === root ||
      nodePath.startsWith(`${root}/`) ||
      nodePath.startsWith(`${root}\\`)
    ) {
      return true;
    }
  }
  return false;
}

interface NodeProps {
  node: FileTreeNode;
  expanded: Set<string>;
  toggle: (path: string) => void;
  activePath: string | null;
  selected: Set<string>;
  depth: number;
  /** Path of the row currently being dragged over (drop target highlight).
   * Only set for directory rows that accept moves. */
  dragOverPath: string | null;
  onRowClick: (event: React.MouseEvent, node: FileTreeNode) => void;
  onContextMenu: (event: React.MouseEvent, node: FileTreeNode) => void;
  onDragStartNode: (event: React.DragEvent, node: FileTreeNode) => void;
  /** Cleanup hook called on dragend (whether the drop succeeded or was
   * cancelled). Used to clear the FileTree's internal drag state so a
   * cancelled drag does not leave a stale source payload behind. */
  onDragEndNode: () => void;
  /** Optional drop handlers. Only provided when the parent has wired
   * `onMoveEntry` AND the row is a real (non-overlay) directory. The
   * TreeNode itself decides per-row whether to actually attach them. */
  onDragOverDir?: (event: React.DragEvent, node: FileTreeNode) => void;
  onDragLeaveDir?: (event: React.DragEvent, node: FileTreeNode) => void;
  onDropOnDir?: (event: React.DragEvent, node: FileTreeNode) => void;
  /** Map of `lane root path → lane name`. Looked up per-row to add a
   * "lane" badge next to directory rows that correspond to registered
   * lanes. Cheaper than walking the lanes array on every render. */
  laneRootByPath?: Map<string, string>;
  /** Absolute path of the currently active lane root, if any. Rows
   * whose path equals or descends from this root get a `in-active-lane`
   * CSS class so the user can see at a glance which subtree the active
   * lane covers (M2.1 colour cue replacing the old overlay sections). */
  activeLaneRoot?: string | null;
  /** Additional roots that belong to the active lane's scope but live
   * outside its write root — currently the lane's read-only attachment
   * roots (e.g. `ModelA` lane writes under `TEST_TASK/ash` but also
   * scopes in `TEST_TASK/ash_notes` as the `notes` attachment). Rows
   * at or under any of these paths receive the same `in-active-lane`
   * tint as the lane root itself. */
  activeLaneScopeRoots?: string[];
}

function TreeNode({
  node,
  expanded,
  toggle,
  activePath,
  selected,
  depth,
  dragOverPath,
  onRowClick,
  onContextMenu,
  onDragStartNode,
  onDragEndNode,
  onDragOverDir,
  onDragLeaveDir,
  onDropOnDir,
  laneRootByPath,
  activeLaneRoot,
  activeLaneScopeRoots,
}: NodeProps): JSX.Element {
  const isSelected = selected.has(node.path);
  const selClass = isSelected ? " selected" : "";
  // True when this row is at or below any of the active lane's scope
  // roots — the lane's own write root plus any attachment roots. Used
  // purely for the colour cue; the row stays clickable and its file
  // ops are identical to any other casefile-internal row.
  const inActiveLane =
    !node.path.startsWith("_") &&
    pathInAnyRoot(node.path, activeLaneRoot, activeLaneScopeRoots);
  const laneClass = inActiveLane ? " in-active-lane" : "";
  if (node.type === "file") {
    const isActive = activePath === node.path;
    return (
      <div
        className={`tree-row${isActive ? " active" : ""}${selClass}${laneClass}`}
        style={{ paddingLeft: depth * 16 + 4 }}
        onClick={(event) => onRowClick(event, node)}
        onContextMenu={(event) => onContextMenu(event, node)}
        title={node.path}
        draggable
        onDragStart={(event) => onDragStartNode(event, node)}
        onDragEnd={onDragEndNode}
      >
        {/* The bullet sits in the same column as a directory's
            arrow — that way file rows and directory rows at the same
            depth visually align on their leading glyph, not on the
            first letter of the name. There is intentionally no second
            "icon" column for files. */}
        <span className="twisty file-bullet">·</span>
        <span>{node.name}</span>
      </div>
    );
  }
  const isOpen = expanded.has(node.path);
  const sorted = [...(node.children ?? [])].sort(compareNodes);
  // Overlay nodes use virtual paths starting with "_" — they live outside
  // the lane and are read-only, so they never accept drops even if the
  // parent wired up move handlers.
  const isOverlay = node.path.startsWith("_");
  const acceptsDrop = !isOverlay && Boolean(onDropOnDir);
  const dragOverClass = dragOverPath === node.path ? " drag-over" : "";
  const laneBadge = laneRootByPath?.get(node.path);
  // Per-child dragOverPath threading: pass it down so deeper directory
  // rows can highlight too. Files don't read it.
  return (
    <div>
      <div
        className={`tree-row${selClass}${dragOverClass}${laneClass}`}
        style={{ paddingLeft: depth * 16 + 4 }}
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
        onDragEnd={onDragEndNode}
        onDragOver={acceptsDrop && onDragOverDir ? (event) => onDragOverDir(event, node) : undefined}
        onDragLeave={acceptsDrop && onDragLeaveDir ? (event) => onDragLeaveDir(event, node) : undefined}
        onDrop={acceptsDrop && onDropOnDir ? (event) => onDropOnDir(event, node) : undefined}
      >
        {/* Directories are marked by the chevron only; the previous
            box icon (▣) was removed so directory rows and file rows
            share the same single-glyph leading column. */}
        <span className="twisty">{isOpen ? "▾" : "▸"}</span>
        <span>{node.name}</span>
        {laneBadge && <span className="lane-badge" title={`Lane: ${laneBadge}`}>lane</span>}
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
              dragOverPath={dragOverPath}
              onRowClick={onRowClick}
              onContextMenu={onContextMenu}
              onDragStartNode={onDragStartNode}
              onDragEndNode={onDragEndNode}
              onDragOverDir={onDragOverDir}
              onDragLeaveDir={onDragLeaveDir}
              onDropOnDir={onDropOnDir}
              laneRootByPath={laneRootByPath}
              activeLaneRoot={activeLaneRoot}
              activeLaneScopeRoots={activeLaneScopeRoots}
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
  expanded: Set<string>
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
  return out;
}

/** Pick the path separator used by an absolute path. We sniff per path
 * rather than assume `process.platform` because the Electron renderer
 * doesn't have access to `process.platform` at runtime and because the
 * bridge sometimes returns POSIX paths even on Windows (overlay roots
 * for read-only attachments registered from a different drive layout).
 */
function pathSepFor(samplePath: string): "/" | "\\" {
  return samplePath.includes("\\") && !samplePath.includes("/") ? "\\" : "/";
}

/** Join `parent` and `name` using the parent's native separator. Strips
 * any trailing separators on `parent` first so we don't end up with
 * `foo//bar` on POSIX or `C:\foo\\bar` on Windows. */
function joinPath(parent: string, name: string): string {
  const sep = pathSepFor(parent);
  const base = parent.replace(/[\\/]+$/, "");
  return `${base}${sep}${name}`;
}

/** True when `candidate` is `ancestor` or sits inside it. Used to block
 * moves that would relocate a directory into one of its own children
 * (which the bridge rejects, but checking client-side gives a clearer
 * error message and keeps the drag UI from highlighting an illegal
 * drop target). */
function isPathOrDescendant(candidate: string, ancestor: string): boolean {
  if (candidate === ancestor) return true;
  const sep = pathSepFor(ancestor);
  return candidate.startsWith(ancestor + sep);
}

export function FileTree({
  root,
  activePath,
  hasWorkspace,
  error,
  onOpenFile,
  casefileRoot,
  onDismissError,
  onAddToContext,
  onRename,
  onRefresh,
  activeLaneRoot,
  activeLaneScopeRoots,
  activeLaneId,
  lanes,
  onCreateFile,
  onCreateFolder,
  onMoveEntry,
  onTrashEntry,
  onCreateLaneFromPath,
  onAttachToLane,
  onStartLaneComparison,
  onSwitchLane,
  onUpdateLaneName,
  onRemoveLane,
  onSetLaneWritable,
  onSoftResetCasefile,
  onHardResetCasefile,
}: FileTreeProps): JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [menu, setMenu] = useState<MenuState | null>(null);
  // Multi-selection state. `selected` is the set of selected node paths;
  // `anchor` is the most recent plain/ctrl-click target and serves as the
  // shift-click range origin, mirroring File-Explorer / Finder behaviour.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  // Drag-and-drop highlight: which directory row the user is currently
  // hovering over with a tree-node payload. Null when nothing is being
  // dragged or the cursor is outside any drop target.
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  // The drag payload(s) for the currently-active intra-tree drag, mirrored
  // out of the dataTransfer object. We need this because HTML5 drag-and-drop
  // hides `dataTransfer.getData()` during dragenter/dragover for security
  // reasons (only `dataTransfer.types` is readable); without a side-channel
  // copy of the payload we can't validate the prospective drop target,
  // can't call preventDefault, and the drop event never fires. We clear it
  // in onDragEnd so a cancelled drag doesn't poison subsequent ones.
  const dragSourceRef = useRef<FileTreeDragPayload[] | null>(null);
  // Compare-with picker: a second context menu spawned from the main
  // menu's "Compare with…" item. We don't reuse `menu` because that one
  // closes on item-select, and we want the picker to live independently.
  const [pickerMenu, setPickerMenu] = useState<{
    x: number;
    y: number;
    items: ContextMenuItem[];
  } | null>(null);
  // Single-field text-input dialog state. We render `<InputDialog />`
  // when this is non-null and resolve the stashed promise on submit /
  // cancel. This is the replacement for `window.prompt`, which Electron
  // doesn't display — see InputDialog.tsx for the full rationale.
  const [inputDialog, setInputDialog] = useState<{
    title: string;
    message?: string;
    defaultValue: string;
    confirmLabel?: string;
    selection?: { start: number; end: number };
    resolve: (value: string | null) => void;
  } | null>(null);

  /** Promise-returning replacement for `window.prompt`. Resolves with the
   * trimmed user input, or null on cancel. The caller is responsible for
   * any further validation (empty-string check, separator check, etc.).
   * The dialog auto-focuses and selects its content on open and supports
   * Enter to submit / Esc to cancel — i.e. it behaves like `window.prompt`
   * with a less hostile look. */
  const promptForInput = (opts: {
    title: string;
    message?: string;
    defaultValue?: string;
    confirmLabel?: string;
    selection?: { start: number; end: number };
  }): Promise<string | null> => {
    return new Promise<string | null>((resolve) => {
      setInputDialog({
        title: opts.title,
        message: opts.message,
        defaultValue: opts.defaultValue ?? "",
        confirmLabel: opts.confirmLabel,
        selection: opts.selection,
        resolve,
      });
    });
  };

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
    () => flattenVisible(root, expanded),
    [root, expanded]
  );

  // Map of lane-root absolute path → lane name. Built once per `lanes`
  // change so each row can do an O(1) lookup instead of scanning the
  // lanes array on every render.
  const laneRootByPath = useMemo(() => {
    const m = new Map<string, string>();
    if (lanes) for (const lane of lanes) m.set(lane.root, lane.name);
    return m;
  }, [lanes]);

  /** Resolve the lane id for a given absolute path, or null if it isn't
   * a registered lane root. The renderer uses this when the user picks
   * "Compare with…" on a tree row to find the source lane id. */
  const laneIdAtPath = (absPath: string): string | null => {
    if (!lanes) return null;
    for (const lane of lanes) {
      if (lane.root === absPath) return lane.id;
    }
    return null;
  };

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
      onOpenFile(node.path);
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

  /** Build a `FileTreeDragPayload` for a tree-node absolute path. The
   * `virtualPath` field remains in the payload type for downstream
   * consumers (chat composer, context editor) but is no longer
   * populated here — the FileTree now only renders real on-disk lane
   * paths since the overlay sections were removed. */
  const buildPayload = (path: string, type: "file" | "dir"): FileTreeDragPayload => {
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
    // Use "copyMove" so the OS arrow shows a copy cursor for non-tree
    // drop targets (composer, context editor) while still letting the
    // FileTree's own drop handler treat the gesture as a move. The
    // dropEffect is decided per-target in onDragOver.
    event.dataTransfer.effectAllowed = "copyMove";
    // Side-channel for the dragOver handler — see the dragSourceRef
    // declaration. Cleared by `handleDragEndNode` whether the drop
    // succeeded or was cancelled.
    dragSourceRef.current = payloads;
  };

  const handleDragEndNode = () => {
    dragSourceRef.current = null;
    if (dragOverPath !== null) setDragOverPath(null);
  };

  // ---------- M2: drag-and-drop move within the tree ----------
  //
  // The FileTree accepts its OWN drag payloads on directory rows and
  // turns them into `onMoveEntry(source, dest)` calls. External drags
  // (URLs, OS files) are ignored because we deliberately don't read
  // `text/uri-list` or `Files` here — those would conflate "import a
  // file" with "move within the workspace" and the import semantics
  // belong elsewhere.

  /** Read the FILETREE drag payload from a DataTransfer. Returns []
   * when the source isn't a tree drag (so the drop handler can bail
   * silently rather than throwing on JSON parse). */
  const readTreePayload = (dt: DataTransfer): FileTreeDragPayload[] => {
    const raw = dt.getData(FILETREE_DRAG_MIME);
    if (!raw) return [];
    try {
      return parseDragPayload(raw);
    } catch {
      return [];
    }
  };

  /** True iff every payload entry is a non-overlay path that can legally
   * move into `destDir` (i.e. is not destDir itself, not an ancestor of
   * destDir, and is on the same separator/root family). */
  const canDropOnDir = (payloads: FileTreeDragPayload[], destDir: string): boolean => {
    if (payloads.length === 0) return false;
    if (!onMoveEntry) return false;
    if (destDir.startsWith("_")) return false;
    for (const p of payloads) {
      const src = p.absolutePath;
      if (!src || src.startsWith("_")) return false;
      // Block moves of the destination itself, and any ancestor of it.
      if (isPathOrDescendant(destDir, src)) return false;
      // Block dropping a node onto its current parent — that's a no-op
      // and just adds noise to the tree refresh.
      const parentOfSrc = src.replace(/[\\/][^\\/]+$/, "");
      if (parentOfSrc === destDir) return false;
    }
    return true;
  };

  const handleDragOverDir = (event: React.DragEvent, node: FileTreeNode) => {
    // Only honour intra-tree drags. External drags (OS files, URLs, text)
    // expose different MIME types and should fall through to the default
    // browser handling so they can't accidentally mutate the workspace.
    // `dataTransfer.types` is the only thing that's readable during
    // dragenter/dragover — `getData()` is intentionally blanked by the
    // platform until `drop`, which is why we mirror the payload through
    // `dragSourceRef` for validation here.
    if (!event.dataTransfer.types.includes(FILETREE_DRAG_MIME)) {
      if (dragOverPath === node.path) setDragOverPath(null);
      return;
    }
    const payloads = dragSourceRef.current ?? [];
    if (!canDropOnDir(payloads, node.path)) {
      // Important: do NOT preventDefault — the row should not show a
      // drop cursor for invalid targets. Also clear any stale highlight
      // we set on a previous row.
      if (dragOverPath === node.path) setDragOverPath(null);
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (dragOverPath !== node.path) setDragOverPath(node.path);
  };

  const handleDragLeaveDir = (_event: React.DragEvent, node: FileTreeNode) => {
    if (dragOverPath === node.path) setDragOverPath(null);
  };

  const handleDropOnDir = (event: React.DragEvent, node: FileTreeNode) => {
    setDragOverPath(null);
    const payloads = readTreePayload(event.dataTransfer);
    if (!canDropOnDir(payloads, node.path) || !onMoveEntry) return;
    event.preventDefault();
    // Fire moves sequentially. Multi-file moves are rare here (drag
    // typically carries a single row) and serialising keeps the bridge
    // contract simple; if any one fails, surface the error and stop so
    // the tree state stays consistent with what the user can see.
    void (async () => {
      for (const payload of payloads) {
        const src = payload.absolutePath;
        const basename = src.split(/[\\/]/).pop() ?? src;
        const dest = joinPath(node.path, basename);
        try {
          await onMoveEntry(src, dest);
        } catch (err) {
          // Upstream (`useLaneWorkspace.handleMoveEntry`) already routes
          // the error into the tree-level error banner via
          // `setTreeError`, so we just log here for debugging and stop
          // the batch; an alert on top of the banner would double-
          // report the same failure.
          console.error("FileTree drop move failed:", err);
          return;
        }
      }
    })();
  };

  // Errors used to replace the entire tree, which meant a single
  // operation-level failure (e.g. "Path escapes casefile root" from a
  // malformed move) wiped out the user's whole navigation surface and
  // left them with no way to recover short of switching casefiles. We
  // now distinguish two cases:
  //   1) No workspace / no tree to show       → render the error full-page
  //      (there's nothing else useful to display anyway).
  //   2) Tree exists                          → render a dismissible banner
  //      ABOVE the tree so the user can read the error and keep working.
  // The banner element is built once and inserted into both branches
  // below so the dismiss UX stays consistent.
  const errorBanner = error ? (
    <div className="file-tree-error" role="alert">
      <span className="file-tree-error-text">{error}</span>
      {onDismissError && (
        <button
          type="button"
          className="file-tree-error-dismiss"
          onClick={onDismissError}
          title="Dismiss error"
          aria-label="Dismiss error"
        >
          ×
        </button>
      )}
    </div>
  ) : null;

  if (!hasWorkspace) {
    return (
      <div className="file-tree">
        {errorBanner}
        <div className="empty">No workspace selected. Choose one from the toolbar.</div>
      </div>
    );
  }
  if (!root) {
    return (
      <div className="file-tree">
        {errorBanner}
        <div className="empty">{error ? "Tree unavailable." : "Loading..."}</div>
      </div>
    );
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
      // Rename is intentionally single-target only: bulk rename is a
      // distinct UX (templates, find/replace, ...) and would be more
      // confusing than useful as a menu entry. The underscore-prefix
      // guard is a leftover from when the tree rendered virtual overlay
      // nodes — kept as a defensive check, even though no overlay
      // entries reach this code path now that overlays are gone.
      ...(onRename
        ? [
            {
              label: "Rename…",
              onSelect: () => {
                const target = menu.node;
                const currentName = target.name;
                // Pre-select just the base name (everything before the
                // last "."), matching VS Code / Finder. The dot itself
                // and the extension stay highlighted-but-not-selected
                // so a typing user replaces the basename only.
                const dot = currentName.lastIndexOf(".");
                const selection =
                  target.type === "file" && dot > 0
                    ? { start: 0, end: dot }
                    : undefined;
                void (async () => {
                  const proposed = await promptForInput({
                    title: `Rename "${currentName}"`,
                    message: "Enter the new name (no path separators).",
                    defaultValue: currentName,
                    confirmLabel: "Rename",
                    selection,
                  });
                  if (proposed == null) return;
                  const trimmed = proposed.trim();
                  if (!trimmed || trimmed === currentName) return;
                  if (trimmed.includes("/") || trimmed.includes("\\")) {
                    window.alert(
                      "Name must not contain path separators ('/' or '\\')."
                    );
                    return;
                  }
                  try {
                    await Promise.resolve(onRename(target.path, trimmed));
                  } catch (err) {
                    // The parent (`useLaneWorkspace`) routes this into
                    // the tree-level error banner; just log here.
                    console.error("FileTree rename failed:", err);
                  }
                })();
              },
              disabled:
                multi ||
                menu.node.path.startsWith("_") ||
                // Don't let the user rename the workspace root from the
                // tree — that's a casefile-level decision.
                (root != null && menu.node.path === root.path),
            },
          ]
        : []),
      // ---------- M2: file ops ----------
      // New file / new folder act on the right-clicked dir, or on the
      // parent dir of a right-clicked file. The underscore guard is
      // defensive; the tree no longer renders overlay nodes.
      ...(onCreateFile && !menu.node.path.startsWith("_") && !multi
        ? [
            {
              label: "New file…",
              onSelect: () => {
                const parentDir =
                  menu.node.type === "dir"
                    ? menu.node.path
                    : menu.node.path.replace(/[\\/][^\\/]+$/, "");
                void (async () => {
                  const name = await promptForInput({
                    title: "New file",
                    message: `Create a file inside "${
                      parentDir.split(/[\\/]/).pop() ?? parentDir
                    }".`,
                    defaultValue: "untitled.txt",
                    confirmLabel: "Create",
                  });
                  if (name == null) return;
                  const trimmed = name.trim();
                  if (!trimmed) return;
                  if (trimmed.includes("/") || trimmed.includes("\\")) {
                    window.alert(
                      "Name must not contain path separators ('/' or '\\')."
                    );
                    return;
                  }
                  try {
                    await Promise.resolve(onCreateFile(parentDir, trimmed));
                  } catch (err) {
                    console.error("FileTree create file failed:", err);
                  }
                })();
              },
            },
          ]
        : []),
      ...(onCreateFolder && !menu.node.path.startsWith("_") && !multi
        ? [
            {
              label: "New folder…",
              onSelect: () => {
                const parentDir =
                  menu.node.type === "dir"
                    ? menu.node.path
                    : menu.node.path.replace(/[\\/][^\\/]+$/, "");
                void (async () => {
                  const name = await promptForInput({
                    title: "New folder",
                    message: `Create a folder inside "${
                      parentDir.split(/[\\/]/).pop() ?? parentDir
                    }".`,
                    defaultValue: "new-folder",
                    confirmLabel: "Create",
                  });
                  if (name == null) return;
                  const trimmed = name.trim();
                  if (!trimmed) return;
                  if (trimmed.includes("/") || trimmed.includes("\\")) {
                    window.alert(
                      "Name must not contain path separators ('/' or '\\')."
                    );
                    return;
                  }
                  try {
                    await Promise.resolve(onCreateFolder(parentDir, trimmed));
                  } catch (err) {
                    console.error("FileTree create folder failed:", err);
                  }
                })();
              },
            },
          ]
        : []),
      ...(onMoveEntry && casefileRoot
        ? [
            {
              label: "Move…",
              onSelect: () => {
                const target = menu.node;
                const sep = pathSepFor(casefileRoot);
                // Move is casefile-wide, not lane-scoped: lanes only
                // affect what the chat agent sees, not what the user
                // can move where. The prompt accepts (and pre-fills)
                // a casefile-relative path.
                const current = relativeFromBase(target.path, casefileRoot);
                if (current == null || current === ".") {
                  window.alert(
                    "This entry isn't inside the current casefile."
                  );
                  return;
                }
                void (async () => {
                  const proposed = await promptForInput({
                    title: `Move "${target.name}"`,
                    message: "Type the new casefile-relative path.",
                    defaultValue: current,
                    confirmLabel: "Move",
                  });
                  if (proposed == null) return;
                  const cleaned = proposed
                    .trim()
                    .replace(/^[\\/]+/, "")
                    .replace(/[\\/]+$/, "");
                  if (!cleaned || cleaned === current) return;
                  // Normalise typed POSIX-style separators to the
                  // casefile's native separator so the bridge sees a
                  // consistent path.
                  const normalised = cleaned.split(/[\\/]/).join(sep);
                  const dest = `${casefileRoot.replace(/[\\/]+$/, "")}${sep}${normalised}`;
                  try {
                    await Promise.resolve(onMoveEntry(target.path, dest));
                  } catch (err) {
                    console.error("FileTree move failed:", err);
                  }
                })();
              },
              disabled:
                multi ||
                menu.node.path.startsWith("_") ||
                (root != null && menu.node.path === root.path),
            },
          ]
        : []),
      ...(onTrashEntry
        ? [
            {
              label: multi ? `Move ${count} items to Trash` : "Move to Trash",
              onSelect: () => {
                // The bridge uses Electron's `shell.trashItem`, so this
                // is recoverable from the OS trash. Still confirm to
                // avoid accidental triggering — it's a destructive
                // single-keypress action otherwise.
                const description = multi
                  ? `${count} selected items`
                  : `"${menu.node.name}"`;
                const ok = window.confirm(
                  `Move ${description} to the OS Trash?\n\n` +
                  `You can restore items from your system Trash if needed.`
                );
                if (!ok) return;
                void (async () => {
                  for (const p of paths) {
                    if (p.startsWith("_")) continue;
                    if (root != null && p === root.path) continue;
                    try {
                      await onTrashEntry(p);
                    } catch (err) {
                      console.error("FileTree trash failed:", p, err);
                      return;
                    }
                  }
                })();
              },
              disabled: paths.every(
                (p) => p.startsWith("_") || (root != null && p === root.path)
              ),
              separator: true,
            },
          ]
        : []),
      // ---------- M2: lane integration ----------
      // Single-target, directory-only, real (non-overlay) actions for
      // promoting browser selections into lane workflows.
      ...(onCreateLaneFromPath &&
      !multi &&
      menu.node.type === "dir" &&
      !menu.node.path.startsWith("_") &&
      // Don't offer "Create lane from this folder" on a path that's
      // already a registered lane root — registering the same dir
      // twice would conflict.
      !laneRootByPath.has(menu.node.path)
        ? [
            {
              label: "Create lane here…",
              onSelect: () => {
                const target = menu.node;
                const defaultName = target.name;
                void (async () => {
                  const name = await promptForInput({
                    title: "Create lane",
                    message: "Name for the new lane.",
                    defaultValue: defaultName,
                    confirmLabel: "Create lane",
                  });
                  if (name == null) return;
                  const trimmed = name.trim();
                  if (!trimmed) return;
                  try {
                    await Promise.resolve(
                      onCreateLaneFromPath(target.path, trimmed)
                    );
                  } catch (err) {
                    console.error("FileTree create lane failed:", err);
                  }
                })();
              },
            },
          ]
        : []),
      // "Set as active lane" — on a lane-root directory that is NOT the
      // currently active lane.
      ...(onSwitchLane &&
      !multi &&
      menu.node.type === "dir" &&
      laneRootByPath.has(menu.node.path)
        ? (() => {
            const laneId = laneIdAtPath(menu.node.path);
            const alreadyActive = laneId === activeLaneId;
            if (!laneId || alreadyActive) return [];
            return [
              {
                label: "Set as active lane",
                onSelect: () => {
                  void Promise.resolve(onSwitchLane(laneId)).catch((err) => {
                    console.error("FileTree switch lane failed:", err);
                  });
                },
              },
            ];
          })()
        : []),
      // "Rename lane…" — on a lane-root directory.
      ...(onUpdateLaneName &&
      !multi &&
      menu.node.type === "dir" &&
      laneRootByPath.has(menu.node.path)
        ? (() => {
            const laneId = laneIdAtPath(menu.node.path);
            const currentLaneName = laneRootByPath.get(menu.node.path) ?? "";
            if (!laneId) return [];
            return [
              {
                label: "Rename lane…",
                onSelect: () => {
                  void (async () => {
                    const name = await promptForInput({
                      title: "Rename lane",
                      message: "Enter the new lane name.",
                      defaultValue: currentLaneName,
                      confirmLabel: "Rename",
                    });
                    if (name == null) return;
                    const trimmed = name.trim();
                    if (!trimmed || trimmed === currentLaneName) return;
                    try {
                      await Promise.resolve(onUpdateLaneName(laneId, trimmed));
                    } catch (err) {
                      console.error("FileTree rename lane failed:", err);
                    }
                  })();
                },
              },
            ];
          })()
        : []),
      // "Remove lane" — on a lane-root directory.
      ...(onRemoveLane &&
      !multi &&
      menu.node.type === "dir" &&
      laneRootByPath.has(menu.node.path)
        ? (() => {
            const laneId = laneIdAtPath(menu.node.path);
            const laneName = laneRootByPath.get(menu.node.path) ?? "";
            if (!laneId) return [];
            return [
              {
                label: "Remove lane",
                onSelect: () => {
                  const ok = window.confirm(
                    `Remove lane "${laneName}"?\n\nThis removes it from the casefile but does not delete any files.`
                  );
                  if (!ok) return;
                  void Promise.resolve(onRemoveLane(laneId)).catch((err) => {
                    console.error("FileTree remove lane failed:", err);
                  });
                },
              },
            ];
          })()
        : []),
      // "Set as read-only" / "Set as writable" — on a lane-root directory.
      ...(onSetLaneWritable &&
      !multi &&
      menu.node.type === "dir" &&
      laneRootByPath.has(menu.node.path)
        ? (() => {
            const laneId = laneIdAtPath(menu.node.path);
            if (!laneId) return [];
            const lane = lanes?.find((l) => l.id === laneId);
            const currentlyWritable = lane ? (lane.writable !== false) : true;
            return [
              {
                label: currentlyWritable ? "Set AI access: read-only" : "Set AI access: writable",
                onSelect: () => {
                  void Promise.resolve(onSetLaneWritable(laneId, !currentlyWritable)).catch(
                    (err) => { console.error("FileTree set lane writable failed:", err); }
                  );
                },
              },
            ];
          })()
        : []),
      // Casefile reset actions — on the casefile root node.
      ...((onSoftResetCasefile || onHardResetCasefile) &&
      !multi &&
      menu.node.type === "dir" &&
      casefileRoot &&
      menu.node.path === casefileRoot
        ? [
            ...(onSoftResetCasefile
              ? [
                  {
                    label: "Reset casefile (soft)…",
                    onSelect: () => {
                      const ok = window.confirm(
                        "Soft reset clears lane registrations and chat history metadata. Files on disk are preserved."
                      );
                      if (!ok) return;
                      void Promise.resolve(onSoftResetCasefile()).catch((err) => {
                        console.error("FileTree soft reset failed:", err);
                      });
                    },
                  },
                ]
              : []),
            ...(onHardResetCasefile
              ? [
                  {
                    label: "Hard reset casefile…",
                    onSelect: () => {
                      const ok = window.confirm(
                        "Hard reset deletes the entire .casefile metadata folder.\n\nConversation history, lane registrations, and settings will be permanently removed. Files on disk are preserved.\n\nThis cannot be undone. Continue?"
                      );
                      if (!ok) return;
                      void Promise.resolve(onHardResetCasefile()).catch((err) => {
                        console.error("FileTree hard reset failed:", err);
                      });
                    },
                  },
                ]
              : []),
          ]
        : []),
      ...(onAttachToLane &&
      lanes &&
      lanes.length > 0 &&
      !multi &&
      menu.node.type === "dir" &&
      !menu.node.path.startsWith("_")
        ? [
            {
              label: "Attach to lane…",
              onSelect: () => {
                const target = menu.node;
                const attachableLanes = lanes.filter(
                  (l) => l.root !== target.path
                );
                if (attachableLanes.length === 0) return;
                // Build a picker that lists every lane the user can attach to.
                const pickerItems: ContextMenuItem[] = attachableLanes.map(
                  (lane) => ({
                    label: lane.name,
                    onSelect: () => {
                      void (async () => {
                        const label = await promptForInput({
                          title: `Attach "${target.name}" to "${lane.name}"`,
                          message:
                            "Attachment label — how this directory will be referenced in the lane's scope.",
                          defaultValue: target.name,
                          confirmLabel: "Attach",
                        });
                        if (label == null) return;
                        const trimmed = label.trim();
                        if (!trimmed) return;
                        try {
                          await Promise.resolve(
                            onAttachToLane(target.path, lane.id, trimmed)
                          );
                        } catch (err) {
                          console.error("FileTree attach to lane failed:", err);
                        }
                      })();
                    },
                  })
                );
                setPickerMenu({ x: menu.x, y: menu.y, items: pickerItems });
              },
            },
          ]
        : []),
      // "Compare with…" only on a directory row that EQUALS a registered
      // lane root, with at least one other lane available. The selected
      // lane is the left side; the picker chooses the right side.
      ...(onStartLaneComparison &&
      !multi &&
      menu.node.type === "dir" &&
      laneRootByPath.has(menu.node.path) &&
      lanes &&
      lanes.length >= 2
        ? (() => {
            const selfId = laneIdAtPath(menu.node.path);
            const others = lanes.filter((l) => l.id !== selfId);
            if (!selfId || others.length === 0) return [];
            return [
              {
                label: "Compare with…",
                onSelect: () => {
                  // Build the picker as a second context menu pinned at
                  // the same anchor. Each item triggers the comparison.
                  const items: ContextMenuItem[] = others.map((other) => ({
                    label: other.name,
                    onSelect: () => {
                      void Promise.resolve(
                        onStartLaneComparison(selfId, other.id)
                      ).catch((err) => {
                        console.error("FileTree compare failed:", err);
                      });
                    },
                  }));
                  setPickerMenu({ x: menu.x, y: menu.y, items });
                },
              },
            ];
          })()
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
      {errorBanner}
      {(onRefresh || onCreateFile || onCreateFolder) && (
        <div className="file-tree-toolbar">
          <div className="file-tree-toolbar-row">
            {onRefresh && (
              <button
                type="button"
                className="file-tree-refresh"
                onClick={onRefresh}
                title="Refresh file tree"
                aria-label="Refresh file tree"
              >
                ⟳ Refresh
              </button>
            )}
            {/* Toolbar shortcuts for "new file/folder at the default
                target". Right-clicking any directory in the tree gives
                you a per-folder version of the same action. Default
                target prefers the active lane root (so the existing
                lane-driven workflow keeps working), and falls back to
                the casefile root when no lane is active — file ops
                are casefile-wide; lanes only affect chat scope. */}
            {(() => {
              const defaultTarget = activeLaneRoot ?? casefileRoot ?? null;
              if (!defaultTarget) return null;
              const targetLabel = activeLaneRoot ? "lane root" : "casefile root";
              return (
                <>
                  {onCreateFile && (
                    <button
                      type="button"
                      className="file-tree-refresh"
                      onClick={() => {
                        void (async () => {
                          const name = await promptForInput({
                            title: "New file",
                            message: `Create a file at the ${targetLabel}.`,
                            defaultValue: "untitled.txt",
                            confirmLabel: "Create",
                          });
                          if (name == null) return;
                          const trimmed = name.trim();
                          if (!trimmed) return;
                          if (
                            trimmed.includes("/") ||
                            trimmed.includes("\\")
                          ) {
                            window.alert(
                              "Name must not contain path separators."
                            );
                            return;
                          }
                          try {
                            await Promise.resolve(
                              onCreateFile(defaultTarget, trimmed)
                            );
                          } catch (err) {
                            console.error(
                              "FileTree toolbar create file failed:",
                              err
                            );
                          }
                        })();
                      }}
                      title={`New file at ${targetLabel}`}
                      aria-label={`New file at ${targetLabel}`}
                    >
                      + File
                    </button>
                  )}
                  {onCreateFolder && (
                    <button
                      type="button"
                      className="file-tree-refresh"
                      onClick={() => {
                        void (async () => {
                          const name = await promptForInput({
                            title: "New folder",
                            message: `Create a folder at the ${targetLabel}.`,
                            defaultValue: "new-folder",
                            confirmLabel: "Create",
                          });
                          if (name == null) return;
                          const trimmed = name.trim();
                          if (!trimmed) return;
                          if (
                            trimmed.includes("/") ||
                            trimmed.includes("\\")
                          ) {
                            window.alert(
                              "Name must not contain path separators."
                            );
                            return;
                          }
                          try {
                            await Promise.resolve(
                              onCreateFolder(defaultTarget, trimmed)
                            );
                          } catch (err) {
                            console.error(
                              "FileTree toolbar create folder failed:",
                              err
                            );
                          }
                        })();
                      }}
                      title={`New folder at ${targetLabel}`}
                      aria-label={`New folder at ${targetLabel}`}
                    >
                      + Folder
                    </button>
                  )}
                </>
              );
            })()}
          </div>
        </div>
      )}
      <TreeNode
        node={root}
        expanded={expanded}
        toggle={toggle}
        activePath={activePath}
        selected={selected}
        depth={0}
        dragOverPath={dragOverPath}
        onRowClick={handleRowClick}
        onContextMenu={handleContextMenu}
        onDragStartNode={handleDragStartNode}
        onDragEndNode={handleDragEndNode}
        onDragOverDir={onMoveEntry ? handleDragOverDir : undefined}
        onDragLeaveDir={onMoveEntry ? handleDragLeaveDir : undefined}
        onDropOnDir={onMoveEntry ? handleDropOnDir : undefined}
        laneRootByPath={laneRootByPath}
        activeLaneRoot={activeLaneRoot}
        activeLaneScopeRoots={activeLaneScopeRoots}
      />
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      )}
      {/* Secondary "Compare with…" picker. Rendered after the primary
          menu so its outside-click handler doesn't immediately close
          on the same gesture that opened it. */}
      {pickerMenu && (
        <ContextMenu
          x={pickerMenu.x}
          y={pickerMenu.y}
          items={pickerMenu.items}
          onClose={() => setPickerMenu(null)}
        />
      )}
      {inputDialog && (
        <InputDialog
          title={inputDialog.title}
          message={inputDialog.message}
          defaultValue={inputDialog.defaultValue}
          confirmLabel={inputDialog.confirmLabel}
          selection={inputDialog.selection}
          onSubmit={(value) => {
            const resolve = inputDialog.resolve;
            setInputDialog(null);
            resolve(value);
          }}
          onCancel={() => {
            const resolve = inputDialog.resolve;
            setInputDialog(null);
            resolve(null);
          }}
        />
      )}
    </div>
  );
}
