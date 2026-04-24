import type React from "react";
import { useMemo, useState } from "react";
import type {
  CasefileSnapshot,
  ChangedFileDto,
  ContextManifestDto,
  Lane,
  LaneAttachmentInput,
  LaneComparisonDto,
  LaneKind,
  LaneUpdateInput,
  RegisterLaneInput,
  UpdateLaneResult,
} from "../types";
import { LANE_KINDS } from "../types";
import { ContextEditor } from "./ContextEditor";
import { FILETREE_DRAG_MIME, parseDragPayload } from "./FileTree";

/** Drop handler for the lane-root and attachment-root inputs. Both stores
 * need a *real* on-disk path; when the user drags an overlay-tree node
 * (e.g. an ancestor directory shown as `_ancestors/<lane>/<sub>`), the
 * structured payload's `absolutePath` already carries the resolved real
 * path — we read it from the FileTree drag MIME instead of letting the
 * browser insert the plain-text fallback (which would be the virtual
 * path and then fail server-side with "Lane root does not exist" or the
 * matching attachment-root error). Returns true if the drop was handled. */
function handleLanePathDrop(
  event: React.DragEvent<HTMLInputElement>,
  setRoot: (value: string) => void
): boolean {
  const raw = event.dataTransfer.getData(FILETREE_DRAG_MIME);
  if (!raw) return false;
  try {
    const payloads = parseDragPayload(raw);
    const dirPayload = payloads.find((p) => p.type === "dir") ?? payloads[0];
    if (!dirPayload) return false;
    event.preventDefault();
    setRoot(dirPayload.absolutePath);
    return true;
  } catch {
    return false;
  }
}

function handleLanePathDragOver(event: React.DragEvent<HTMLInputElement>): void {
  if (event.dataTransfer.types.includes(FILETREE_DRAG_MIME)) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }
}

interface LanesTabProps {
  casefile: CasefileSnapshot | null;
  onSwitchLane: (laneId: string) => void;
  onRegisterLane: (input: RegisterLaneInput) => Promise<void>;
  onChooseLaneRoot: () => Promise<string | null>;
  comparison: LaneComparisonDto | null;
  comparisonBusy: boolean;
  onCompare: (leftLaneId: string, rightLaneId: string) => Promise<void>;
  onClearComparison: () => void;
  onOpenDiff: (path: string) => void;
  onOpenLaneFile: (laneId: string, path: string) => void;
  /** M3.5c: open a multi-lane comparison chat session. */
  onOpenComparisonChat: (laneIds: string[]) => Promise<void>;
  // M3.5
  context: ContextManifestDto | null;
  contextBusy: boolean;
  contextError: string | null;
  onSaveContext: (manifest: { files: string[]; autoIncludeMaxBytes: number }) => Promise<void>;
  onSetLaneParent: (laneId: string, parentId: string | null) => Promise<void>;
  onUpdateLaneAttachments: (
    laneId: string,
    attachments: LaneAttachmentInput[]
  ) => Promise<void>;
  // M4.6: lane CRUD + casefile reset.
  onUpdateLane: (laneId: string, update: LaneUpdateInput) => Promise<UpdateLaneResult>;
  onRemoveLane: (laneId: string) => Promise<void>;
  onHardResetCasefile: () => Promise<void>;
  onSoftResetCasefile: (keepPrompts: boolean) => Promise<void>;
}

interface LaneNode {
  lane: Lane;
  children: LaneNode[];
}

function buildLaneForest(lanes: Lane[]): LaneNode[] {
  const byId = new Map<string, LaneNode>(
    lanes.map((lane) => [lane.id, { lane, children: [] }])
  );
  const roots: LaneNode[] = [];
  for (const lane of lanes) {
    const node = byId.get(lane.id)!;
    const parentId = lane.parentId ?? null;
    if (parentId && byId.has(parentId)) {
      byId.get(parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sortNodes = (nodes: LaneNode[]) => {
    nodes.sort((a, b) => a.lane.name.localeCompare(b.lane.name));
    for (const n of nodes) sortNodes(n.children);
  };
  sortNodes(roots);
  return roots;
}

export function LanesTab(props: LanesTabProps): JSX.Element {
  const {
    casefile,
    onSwitchLane,
    onRegisterLane,
    onChooseLaneRoot,
    comparison,
    comparisonBusy,
    onCompare,
    onClearComparison,
    onOpenDiff,
    onOpenLaneFile,
    onOpenComparisonChat,
    context,
    contextBusy,
    contextError,
    onSaveContext,
    onSetLaneParent,
    onUpdateLaneAttachments,
    onUpdateLane,
    onRemoveLane,
    onHardResetCasefile,
    onSoftResetCasefile,
  } = props;

  const [showForm, setShowForm] = useState(false);
  const [showContext, setShowContext] = useState(false);
  const [editLaneId, setEditLaneId] = useState<string | null>(null);
  const [compareLeft, setCompareLeft] = useState<string>("");
  const [compareRight, setCompareRight] = useState<string>("");
  // M4.6: per-casefile destructive-action menu and its modal.
  const [showCasefileMenu, setShowCasefileMenu] = useState(false);
  const [resetMode, setResetMode] = useState<"hard" | "soft" | null>(null);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  const forest = useMemo(
    () => (casefile ? buildLaneForest(casefile.lanes) : []),
    [casefile]
  );

  const compareDefaults = useMemo(() => {
    if (!casefile || casefile.lanes.length < 2) return { left: "", right: "" };
    const active = casefile.activeLaneId ?? casefile.lanes[0].id;
    const other = casefile.lanes.find((l) => l.id !== active);
    return { left: active, right: other ? other.id : "" };
  }, [casefile]);

  const effectiveLeft = compareLeft || compareDefaults.left;
  const effectiveRight = compareRight || compareDefaults.right;

  if (!casefile) {
    return (
      <div className="placeholder">
        <p>
          <strong>No casefile open.</strong>
        </p>
        <p>
          Use <em>Open Casefile</em> in the toolbar. A casefile is any directory; selecting one
          creates a <code>.casefile/</code> metadata folder and a default <code>main</code> lane
          rooted at the casefile itself.
        </p>
      </div>
    );
  }

  const editingLane = editLaneId
    ? casefile.lanes.find((l) => l.id === editLaneId) ?? null
    : null;

  return (
    <div className="lanes">
      <div className="lanes-header">
        <span className="lanes-title">Lanes</span>
        <button type="button" onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Cancel" : "Register lane"}
        </button>
        <button type="button" onClick={() => setShowContext((v) => !v)}>
          {showContext ? "Hide context" : "Edit casefile context"}
        </button>
        {/* M4.6: destructive operations live in an overflow menu so a stray
            click cannot wipe a casefile. */}
        <div className="casefile-menu">
          <button
            type="button"
            className="casefile-menu-trigger"
            aria-label="Casefile actions"
            aria-expanded={showCasefileMenu}
            onClick={() => setShowCasefileMenu((v) => !v)}
          >
            ⋯
          </button>
          {showCasefileMenu && (
            <ul className="casefile-menu-list" role="menu">
              <li>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setShowCasefileMenu(false);
                    setResetError(null);
                    setResetMode("soft");
                  }}
                >
                  New task (soft reset)…
                </button>
              </li>
              <li>
                <button
                  type="button"
                  role="menuitem"
                  className="destructive"
                  onClick={() => {
                    setShowCasefileMenu(false);
                    setResetError(null);
                    setResetMode("hard");
                  }}
                >
                  Revert casefile (hard reset)…
                </button>
              </li>
            </ul>
          )}
        </div>
      </div>

      {showContext && (
        <ContextEditor
          context={context}
          busy={contextBusy}
          error={contextError}
          onSave={onSaveContext}
        />
      )}

      <ul className="lane-tree">
        {forest.map((node) => (
          <LaneTreeNode
            key={node.lane.id}
            node={node}
            depth={0}
            activeLaneId={casefile.activeLaneId}
            onSelect={onSwitchLane}
            onEdit={(id) => setEditLaneId(id === editLaneId ? null : id)}
          />
        ))}
      </ul>

      {editingLane && (
        <LaneEditPanel
          lane={editingLane}
          allLanes={casefile.lanes}
          onClose={() => setEditLaneId(null)}
          onSetParent={onSetLaneParent}
          onUpdateAttachments={onUpdateLaneAttachments}
          onUpdateLane={onUpdateLane}
          onRemoveLane={async (laneId) => {
            await onRemoveLane(laneId);
            setEditLaneId(null);
          }}
          onChooseDir={onChooseLaneRoot}
        />
      )}

      {resetMode && (
        <ResetCasefileDialog
          mode={resetMode}
          busy={resetBusy}
          error={resetError}
          onCancel={() => {
            if (!resetBusy) {
              setResetMode(null);
              setResetError(null);
            }
          }}
          onConfirm={async (keepPrompts) => {
            setResetBusy(true);
            setResetError(null);
            try {
              if (resetMode === "hard") {
                await onHardResetCasefile();
              } else {
                await onSoftResetCasefile(keepPrompts);
              }
              setResetMode(null);
            } catch (err) {
              setResetError(err instanceof Error ? err.message : String(err));
            } finally {
              setResetBusy(false);
            }
          }}
        />
      )}

      {casefile.lanes.length >= 2 && (
        <div className="compare-controls">
          <span className="lanes-title">Diff lanes</span>
          <select
            value={effectiveLeft}
            onChange={(event) => setCompareLeft(event.target.value)}
          >
            {casefile.lanes.map((lane) => (
              <option key={lane.id} value={lane.id}>
                {lane.name}
              </option>
            ))}
          </select>
          <span className="muted">↔</span>
          <select
            value={effectiveRight}
            onChange={(event) => setCompareRight(event.target.value)}
          >
            {casefile.lanes
              .filter((l) => l.id !== effectiveLeft)
              .map((lane) => (
                <option key={lane.id} value={lane.id}>
                  {lane.name}
                </option>
              ))}
          </select>
          <button
            type="button"
            disabled={
              comparisonBusy ||
              !effectiveLeft ||
              !effectiveRight ||
              effectiveLeft === effectiveRight
            }
            onClick={() => {
              if (effectiveLeft && effectiveRight && effectiveLeft !== effectiveRight) {
                void onCompare(effectiveLeft, effectiveRight);
              }
            }}
            title="Compare two lanes' file trees side by side"
          >
            {comparisonBusy ? "Diffing..." : "Diff files"}
          </button>
          {comparison && (
            <button type="button" onClick={onClearComparison} className="link-button">
              Clear
            </button>
          )}
          <button
            type="button"
            disabled={
              !effectiveLeft || !effectiveRight || effectiveLeft === effectiveRight
            }
            onClick={() => {
              if (effectiveLeft && effectiveRight && effectiveLeft !== effectiveRight) {
                void onOpenComparisonChat([effectiveLeft, effectiveRight]);
              }
            }}
            title="Open a scoped chat across both lanes; each directory keeps its configured AI read/write access"
          >
            Open compare chat
          </button>
        </div>
      )}
      {comparison && (
        <ComparisonResults
          comparison={comparison}
          casefile={casefile}
          onOpenDiff={onOpenDiff}
          onOpenLaneFile={onOpenLaneFile}
        />
      )}
      {showForm && (
        <RegisterLaneForm
          casefile={casefile}
          onChooseLaneRoot={onChooseLaneRoot}
          onSubmit={async (input) => {
            await onRegisterLane(input);
            setShowForm(false);
          }}
        />
      )}
    </div>
  );
}

interface LaneTreeNodeProps {
  node: LaneNode;
  depth: number;
  activeLaneId: string | null;
  onSelect: (laneId: string) => void;
  onEdit: (laneId: string) => void;
}

function LaneTreeNode({
  node,
  depth,
  activeLaneId,
  onSelect,
  onEdit,
}: LaneTreeNodeProps): JSX.Element {
  const { lane, children } = node;
  const isActive = lane.id === activeLaneId;
  const attachmentCount = lane.attachments?.length ?? 0;
  return (
    <li className="lane-tree-node">
      <div
        className={`lane-row${isActive ? " active" : ""}`}
        style={{ paddingLeft: depth * 14 + 6 }}
        onClick={() => onSelect(lane.id)}
        title={lane.root}
      >
        <div className="lane-row-main">
          <span className="lane-name">{lane.name}</span>
          <span className="lane-kind">{lane.kind}</span>
          {attachmentCount > 0 && (
            <span className="lane-attachments-badge" title="attachments">
              +{attachmentCount}
            </span>
          )}
          {isActive && <span className="lane-active-badge">active</span>}
          <button
            type="button"
            className="link-button"
            onClick={(event) => {
              event.stopPropagation();
              onEdit(lane.id);
            }}
          >
            edit
          </button>
        </div>
        <div className="lane-root">{lane.root}</div>
      </div>
      {children.length > 0 && (
        <ul className="lane-tree">
          {children.map((child) => (
            <LaneTreeNode
              key={child.lane.id}
              node={child}
              depth={depth + 1}
              activeLaneId={activeLaneId}
              onSelect={onSelect}
              onEdit={onEdit}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function lanesById(snapshot: CasefileSnapshot, laneId: string | null): Lane | null {
  if (!laneId) return null;
  return snapshot.lanes.find((l) => l.id === laneId) ?? null;
}

interface ComparisonResultsProps {
  comparison: LaneComparisonDto;
  casefile: CasefileSnapshot;
  onOpenDiff: (path: string) => void;
  onOpenLaneFile: (laneId: string, path: string) => void;
}

function ComparisonResults({
  comparison,
  casefile,
  onOpenDiff,
  onOpenLaneFile,
}: ComparisonResultsProps): JSX.Element {
  const left = lanesById(casefile, comparison.leftLaneId);
  const right = lanesById(casefile, comparison.rightLaneId);
  const summary = `${comparison.added.length} added · ${comparison.removed.length} removed · ${comparison.changed.length} changed`;
  return (
    <div className="comparison">
      <div className="comparison-header">
        <strong>
          {left?.name ?? comparison.leftLaneId} ↔ {right?.name ?? comparison.rightLaneId}
        </strong>
        <span className="muted">{summary}</span>
      </div>
      <ComparisonSection title="Changed">
        {comparison.changed.length === 0 ? (
          <EmptyHint>No changed files.</EmptyHint>
        ) : (
          comparison.changed.map((change) => (
            <ChangedFileRow
              key={change.path}
              change={change}
              onOpenDiff={() => onOpenDiff(change.path)}
            />
          ))
        )}
      </ComparisonSection>
      <ComparisonSection title="Added">
        {comparison.added.length === 0 ? (
          <EmptyHint>None.</EmptyHint>
        ) : (
          comparison.added.map((path) => (
            <li key={path} className="comparison-row">
              <code>{path}</code>
              <button
                type="button"
                className="link-button"
                onClick={() => onOpenLaneFile(comparison.rightLaneId, path)}
              >
                open in {right?.name ?? comparison.rightLaneId}
              </button>
            </li>
          ))
        )}
      </ComparisonSection>
      <ComparisonSection title="Removed">
        {comparison.removed.length === 0 ? (
          <EmptyHint>None.</EmptyHint>
        ) : (
          comparison.removed.map((path) => (
            <li key={path} className="comparison-row">
              <code>{path}</code>
              <button
                type="button"
                className="link-button"
                onClick={() => onOpenLaneFile(comparison.leftLaneId, path)}
              >
                open in {left?.name ?? comparison.leftLaneId}
              </button>
            </li>
          ))
        )}
      </ComparisonSection>
    </div>
  );
}

function ComparisonSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="comparison-section">
      <div className="comparison-section-title">{title}</div>
      <ul className="comparison-list">{children}</ul>
    </div>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }): JSX.Element {
  return <li className="comparison-empty">{children}</li>;
}

function ChangedFileRow({
  change,
  onOpenDiff,
}: {
  change: ChangedFileDto;
  onOpenDiff: () => void;
}): JSX.Element {
  return (
    <li className="comparison-row">
      <code>{change.path}</code>
      <span className="muted">
        {change.leftSize} → {change.rightSize} bytes
      </span>
      <button type="button" className="link-button" onClick={onOpenDiff}>
        diff
      </button>
    </li>
  );
}

interface LaneEditPanelProps {
  lane: Lane;
  allLanes: Lane[];
  onClose: () => void;
  onSetParent: (laneId: string, parentId: string | null) => Promise<void>;
  onUpdateAttachments: (
    laneId: string,
    attachments: LaneAttachmentInput[]
  ) => Promise<void>;
  // M4.6: edit name/kind/root + remove the lane.
  onUpdateLane: (laneId: string, update: LaneUpdateInput) => Promise<UpdateLaneResult>;
  onRemoveLane: (laneId: string) => Promise<void>;
  onChooseDir: () => Promise<string | null>;
}

// Lanes that would create a cycle if chosen as `lane`'s parent. We compute
// the set of `lane` plus all of its descendants and disallow them as parents.
function descendantsOf(laneId: string, all: Lane[]): Set<string> {
  const out = new Set<string>([laneId]);
  let added = true;
  while (added) {
    added = false;
    for (const l of all) {
      if (l.parentId && out.has(l.parentId) && !out.has(l.id)) {
        out.add(l.id);
        added = true;
      }
    }
  }
  return out;
}

function LaneEditPanel({
  lane,
  allLanes,
  onClose,
  onSetParent,
  onUpdateAttachments,
  onUpdateLane,
  onRemoveLane,
  onChooseDir,
}: LaneEditPanelProps): JSX.Element {
  // Core lane fields (M4.6).
  const [laneName, setLaneName] = useState<string>(lane.name);
  const [laneKind, setLaneKind] = useState<LaneKind>(lane.kind);
  const [laneRoot, setLaneRoot] = useState<string>(lane.root);

  const [parentId, setParentId] = useState<string>(lane.parentId ?? "");
  const [attachments, setAttachments] = useState<LaneAttachmentInput[]>(
    (lane.attachments ?? []).map((a) => ({ name: a.name, root: a.root }))
  );
  const [newName, setNewName] = useState("");
  const [newRoot, setNewRoot] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // M4.6: post-save warning when the new root collides with another lane.
  const [rootConflictWith, setRootConflictWith] = useState<string | null>(null);
  // M4.6: confirmation flow for removing the lane.
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);

  const forbiddenParents = useMemo(
    () => descendantsOf(lane.id, allLanes),
    [lane.id, allLanes]
  );

  const save = async () => {
    setError(null);
    setRootConflictWith(null);
    setBusy(true);
    try {
      // 1. M4.6 core fields: name / kind / root via casefile:updateLane.
      //    Only send fields the user actually changed; the bridge
      //    distinguishes "omitted" from "null" and a no-op call still
      //    triggers the round-trip cost.
      const update: LaneUpdateInput = {};
      const trimmedName = laneName.trim();
      if (trimmedName && trimmedName !== lane.name) update.name = trimmedName;
      if (laneKind !== lane.kind) update.kind = laneKind;
      const trimmedRoot = laneRoot.trim();
      if (trimmedRoot && trimmedRoot !== lane.root) update.root = trimmedRoot;
      if (Object.keys(update).length > 0) {
        const result = await onUpdateLane(lane.id, update);
        if (result.rootConflict) {
          // Surface the warning, but do not abort the rest of the save —
          // the backend already accepted the change.
          setRootConflictWith(result.rootConflict.conflictingLaneId);
        }
      }
      // 2. Parent.
      const wantParent = parentId.trim() ? parentId.trim() : null;
      if ((lane.parentId ?? null) !== wantParent) {
        await onSetParent(lane.id, wantParent);
      }
      // 3. Attachments.
      const before = JSON.stringify(lane.attachments ?? []);
      const after = JSON.stringify(attachments);
      if (before !== after) {
        await onUpdateAttachments(lane.id, attachments);
      }
      // Close only when nothing surfaced a warning the user needs to see.
      if (!rootConflictWith) onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setRemoving(true);
    setError(null);
    try {
      await onRemoveLane(lane.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRemoving(false);
    }
  };

  const conflictLaneName =
    rootConflictWith != null
      ? allLanes.find((l) => l.id === rootConflictWith)?.name ?? rootConflictWith
      : null;

  const addAttachment = () => {
    const name = newName.trim();
    const root = newRoot.trim();
    if (!name || !root) {
      setError("Attachment name and root are required");
      return;
    }
    if (attachments.some((a) => a.name === name)) {
      setError(`Attachment "${name}" already exists`);
      return;
    }
    setAttachments([...attachments, { name, root }]);
    setNewName("");
    setNewRoot("");
    setError(null);
  };

  return (
    <div className="lane-edit-panel">
      <div className="lane-edit-header">
        <strong>Edit lane: {lane.name}</strong>
        <button type="button" className="link-button" onClick={onClose}>
          close
        </button>
      </div>
      <label className="lane-form-row">
        <span>Name</span>
        <input
          type="text"
          value={laneName}
          onChange={(event) => setLaneName(event.target.value)}
          placeholder="Lane name"
        />
      </label>
      <label className="lane-form-row">
        <span>Kind</span>
        <select
          value={laneKind}
          onChange={(event) => setLaneKind(event.target.value as LaneKind)}
        >
          {LANE_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </label>
      <label className="lane-form-row">
        <span>Root</span>
        <input
          type="text"
          value={laneRoot}
          onChange={(event) => setLaneRoot(event.target.value)}
          onDragOver={handleLanePathDragOver}
          onDrop={(event) => handleLanePathDrop(event, setLaneRoot)}
          placeholder="absolute or casefile-relative path"
        />
        <button
          type="button"
          onClick={async () => {
            const chosen = await onChooseDir();
            if (chosen) setLaneRoot(chosen);
          }}
          disabled={busy}
        >
          Browse
        </button>
      </label>
      {rootConflictWith && (
        <div className="lane-form-warning">
          Heads up: <strong>{conflictLaneName}</strong> already references this
          directory. Both lanes will see the same files.
        </div>
      )}
      <label className="lane-form-row">
        <span>Parent</span>
        <select value={parentId} onChange={(event) => setParentId(event.target.value)}>
          <option value="">(top level)</option>
          {allLanes
            .filter((l) => !forbiddenParents.has(l.id))
            .map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
        </select>
      </label>
      <div className="lane-form-row">
        <span>Attachments</span>
        <ul className="attachment-list">
          {attachments.length === 0 && (
            <li className="muted">None — paired notes/log directories live here.</li>
          )}
          {attachments.map((att) => (
            <li key={att.name} className="attachment-row">
              <code>{att.name}</code>
              <span className="muted" title={att.root}>{att.root}</span>
              <button
                type="button"
                className="link-button"
                onClick={() =>
                  setAttachments(attachments.filter((a) => a.name !== att.name))
                }
              >
                remove
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="lane-form-row attachment-add">
        <input
          type="text"
          placeholder="name (e.g. notes)"
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
        />
        <input
          type="text"
          placeholder="absolute or casefile-relative path"
          value={newRoot}
          onChange={(event) => setNewRoot(event.target.value)}
          onDragOver={handleLanePathDragOver}
          onDrop={(event) => handleLanePathDrop(event, setNewRoot)}
        />
        <button
          type="button"
          onClick={async () => {
            const chosen = await onChooseDir();
            if (chosen) setNewRoot(chosen);
          }}
        >
          Browse
        </button>
        <button type="button" onClick={addAttachment}>
          Add
        </button>
      </div>
      {error && <div className="lane-form-error">Error: {error}</div>}
      <div className="lane-form-actions">
        <button type="button" onClick={save} disabled={busy || removing}>
          {busy ? "Saving..." : "Save"}
        </button>
        <span className="lane-form-spacer" />
        {/* M4.6: removal is gated by a two-step "click → confirm" so a stray
            click on the lane edit panel cannot delete a lane outright.
            The chat log / notes remain on disk and can be recovered by
            re-registering the lane with the same id. */}
        {!confirmRemove ? (
          <button
            type="button"
            className="destructive"
            onClick={() => setConfirmRemove(true)}
            disabled={busy || removing}
            title="Remove this lane (data on disk is preserved)"
          >
            Remove lane
          </button>
        ) : (
          <>
            <span className="lane-form-confirm">
              Remove <strong>{lane.name}</strong>? Chat / notes stay on disk.
            </span>
            <button
              type="button"
              onClick={() => setConfirmRemove(false)}
              disabled={removing}
            >
              Cancel
            </button>
            <button
              type="button"
              className="destructive"
              onClick={remove}
              disabled={removing}
            >
              {removing ? "Removing..." : "Yes, remove"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// M4.6: confirmation dialog for casefile reset (hard or soft).
interface ResetCasefileDialogProps {
  mode: "hard" | "soft";
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (keepPrompts: boolean) => void;
}

function ResetCasefileDialog({
  mode,
  busy,
  error,
  onCancel,
  onConfirm,
}: ResetCasefileDialogProps): JSX.Element {
  // Soft-reset specifically asks whether to keep prompt drafts; hard
  // reset always wipes everything.
  const [keepPrompts, setKeepPrompts] = useState(true);
  const isHard = mode === "hard";
  return (
    <div className="reset-dialog-backdrop" onClick={busy ? undefined : onCancel}>
      <div
        className="reset-dialog"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <h3>{isHard ? "Revert casefile?" : "Start a new task?"}</h3>
        {isHard ? (
          <p>
            This deletes the entire <code>.casefile/</code> directory: all
            lanes, chat history, notes, prompts, and saved context. The
            casefile will look as if it had never been opened in
            DeskAssist.{" "}
            <strong>This cannot be undone.</strong>
          </p>
        ) : (
          <>
            <p>
              This clears chat history and notes, and restores a fresh
              default <code>main</code> lane. Your casefile context
              manifest and inbox sources are preserved.
            </p>
            <label className="lane-form-row">
              <input
                type="checkbox"
                checked={keepPrompts}
                onChange={(event) => setKeepPrompts(event.target.checked)}
              />
              <span>Keep prompt drafts</span>
            </label>
          </>
        )}
        {error && <div className="lane-form-error">Error: {error}</div>}
        <div className="lane-form-actions">
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="destructive"
            onClick={() => onConfirm(isHard ? false : keepPrompts)}
            disabled={busy}
          >
            {busy
              ? isHard
                ? "Reverting..."
                : "Resetting..."
              : isHard
              ? "Yes, revert"
              : "Yes, reset"}
          </button>
        </div>
      </div>
    </div>
  );
}

interface RegisterLaneFormProps {
  casefile: CasefileSnapshot;
  onChooseLaneRoot: () => Promise<string | null>;
  onSubmit: (input: RegisterLaneInput) => Promise<void>;
}

function RegisterLaneForm({
  casefile,
  onChooseLaneRoot,
  onSubmit,
}: RegisterLaneFormProps): JSX.Element {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<LaneKind>("repo");
  const [root, setRoot] = useState("");
  const [parentId, setParentId] = useState<string>(casefile.activeLaneId ?? "");
  const [attachments, setAttachments] = useState<LaneAttachmentInput[]>([]);
  const [newName, setNewName] = useState("");
  const [newRoot, setNewRoot] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    if (!root.trim()) {
      setError("Lane directory is required");
      return;
    }
    setBusy(true);
    try {
      await onSubmit({
        name: name.trim(),
        kind,
        root: root.trim(),
        parentId: parentId.trim() ? parentId.trim() : null,
        attachments,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const addAttachment = () => {
    const an = newName.trim();
    const ar = newRoot.trim();
    if (!an || !ar) {
      setError("Attachment name and root are required");
      return;
    }
    if (attachments.some((a) => a.name === an)) {
      setError(`Attachment "${an}" already exists`);
      return;
    }
    setAttachments([...attachments, { name: an, root: ar }]);
    setNewName("");
    setNewRoot("");
    setError(null);
  };

  return (
    <div className="lane-form">
      <h4>Register Lane</h4>
      <label className="lane-form-row">
        <span>Name</span>
        <input
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Attempt A"
        />
      </label>
      <label className="lane-form-row">
        <span>Kind</span>
        <select value={kind} onChange={(event) => setKind(event.target.value as LaneKind)}>
          {LANE_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </label>
      <label className="lane-form-row">
        <span>Parent</span>
        <select value={parentId} onChange={(event) => setParentId(event.target.value)}>
          <option value="">(top level)</option>
          {casefile.lanes.map((lane) => (
            <option key={lane.id} value={lane.id}>
              {lane.name}
            </option>
          ))}
        </select>
      </label>
      <label className="lane-form-row">
        <span>Root</span>
        <input
          type="text"
          value={root}
          onChange={(event) => setRoot(event.target.value)}
          onDragOver={handleLanePathDragOver}
          onDrop={(event) => handleLanePathDrop(event, setRoot)}
          placeholder="absolute path or relative-to-casefile"
        />
        <button
          type="button"
          onClick={async () => {
            const chosen = await onChooseLaneRoot();
            if (chosen) setRoot(chosen);
          }}
          disabled={busy}
        >
          Browse
        </button>
      </label>
      <div className="lane-form-row">
        <span>Attachments</span>
        <ul className="attachment-list">
          {attachments.length === 0 && (
            <li className="muted">None — add paired note dirs (e.g. ash_notes for ash).</li>
          )}
          {attachments.map((att) => (
            <li key={att.name} className="attachment-row">
              <code>{att.name}</code>
              <span className="muted" title={att.root}>{att.root}</span>
              <button
                type="button"
                className="link-button"
                onClick={() =>
                  setAttachments(attachments.filter((a) => a.name !== att.name))
                }
              >
                remove
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="lane-form-row attachment-add">
        <input
          type="text"
          placeholder="name"
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
        />
        <input
          type="text"
          placeholder="absolute or casefile-relative path"
          value={newRoot}
          onChange={(event) => setNewRoot(event.target.value)}
          onDragOver={handleLanePathDragOver}
          onDrop={(event) => handleLanePathDrop(event, setNewRoot)}
        />
        <button
          type="button"
          onClick={async () => {
            const chosen = await onChooseLaneRoot();
            if (chosen) setNewRoot(chosen);
          }}
        >
          Browse
        </button>
        <button type="button" onClick={addAttachment}>
          Add
        </button>
      </div>
      {error && <div className="lane-form-error">Error: {error}</div>}
      <div className="lane-form-actions">
        <button type="button" onClick={submit} disabled={busy}>
          {busy ? "Registering..." : "Register"}
        </button>
      </div>
    </div>
  );
}
