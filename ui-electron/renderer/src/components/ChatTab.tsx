import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ApiKeyStatus,
  CasefileSnapshot,
  ChatMessage,
  ComparisonSession,
  LaneAttachmentInput,
  Lane,
  Provider,
  ToolCall,
} from "../types";
import { api } from "../lib/api";
import { FILETREE_DRAG_MIME, parseDragPayload } from "./FileTree";
import { ContextMenu } from "./ContextMenu";
import { InputDialog } from "./InputDialog";
import { SaveOutputPicker, suggestSaveFilename } from "./SaveOutputPicker";

/** Identifier for a single chat session entry in the session list. Lane
 * sessions are scoped by lane id; comparison sessions get a stable
 * `compare:<id>` prefix so the two namespaces never collide. */
export type ChatSessionId = `lane:${string}` | `compare:${string}`;

const LANE_PREFIX = "lane:";
const COMPARE_PREFIX = "compare:";

export function laneSessionId(laneId: string): ChatSessionId {
  return `${LANE_PREFIX}${laneId}`;
}

export function compareSessionId(comparisonId: string): ChatSessionId {
  return `${COMPARE_PREFIX}${comparisonId}`;
}

/**
 * Parse a chat session id into its kind + raw id. Centralized here
 * with `laneSessionId` / `compareSessionId` so the encoding scheme
 * lives in exactly one place. (Review item #15.)
 */
type ParsedChatSessionId =
  | { kind: "lane"; id: string }
  | { kind: "compare"; id: string };

export function parseChatSessionId(id: ChatSessionId): ParsedChatSessionId | null {
  if (id.startsWith(LANE_PREFIX)) {
    return { kind: "lane", id: id.slice(LANE_PREFIX.length) };
  }
  if (id.startsWith(COMPARE_PREFIX)) {
    return { kind: "compare", id: id.slice(COMPARE_PREFIX.length) };
  }
  if (process.env.NODE_ENV !== "production") {
    console.warn("Unrecognised chat session id", id);
  }
  return null;
}

/** Last assistant tool-call burst, used by the "working" indicator to give
 * the user a hint about *what* the agent is currently doing (e.g. "running
 * read_file, list_dir") rather than just an indeterminate spinner. */
function summariseLastToolCalls(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const names = msg.tool_calls.map((c) => c.name).filter(Boolean);
      if (names.length === 0) return null;
      const unique = Array.from(new Set(names));
      return unique.join(", ");
    }
    // Stop scanning once we hit a previous user turn — older tool calls
    // from prior turns aren't relevant to the in-flight one.
    if (msg.role === "user") return null;
  }
  return null;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}

interface LaneChatProps {
  provider: Provider;
  keyStatus: ApiKeyStatus;
  activeModel: string;
  modelIsDefault: boolean;
  messages: ChatMessage[];
  pendingApprovals: ToolCall[];
  busy: boolean;
  hasActiveLane: boolean;
  /** Lane currently driving this chat (used for the Save... picker
   * destinations and as the Send target). */
  activeLane: Lane | null;
  onSend: (text: string) => void;
  onApproveTools: () => void;
  onDenyTools: () => void;
  /** M2.5: Toggle AI write access for the active lane (true = writable). */
  onSetLaneWritable?: (writable: boolean) => void;
  /** M3: Widen the active single-context chat with another scoped directory. */
  onAddAttachment?: (root: string, name: string) => Promise<void> | void;
  /** M2.5: Remove an attachment from the active lane by its label name. */
  onRemoveAttachment?: (attName: string) => void;
  /** M2.5: Change an attachment's AI access mode. */
  onSetAttachmentMode?: (attName: string, mode: "read" | "write") => void;
}

interface CompareChatProps {
  provider: Provider;
  keyStatus: ApiKeyStatus;
  activeModel: string;
  modelIsDefault: boolean;
  session: ComparisonSession;
  busy: boolean;
  /** Resolved lanes participating in this comparison (used by the Save...
   * picker so each lane's attachments + root are offered). May be a
   * subset of `session.laneIds` if a lane was renamed/removed since the
   * comparison opened — we still surface what we know. */
  lanes: Lane[];
  onSend: (text: string) => void;
  onApproveTools: () => void;
  onDenyTools: () => void;
  onSetLaneWritable?: (laneId: string, writable: boolean) => void;
  onSetAttachmentMode?: (laneId: string, attName: string, mode: "read" | "write") => void;
  onUpdateAttachments?: (
    laneIds: string[],
    attachments: LaneAttachmentInput[]
  ) => Promise<void>;
  onClose: () => void;
}

interface ChatTabProps {
  /** Active casefile (used to resolve lane lookups for the session list).
   * `null` when no casefile is open — in that case the tab just shows a
   * placeholder asking the user to open one. */
  casefile: CasefileSnapshot | null;
  /** All currently-open comparison sessions. The session list shows one
   * row per lane in the casefile plus one row per comparison. */
  comparisonSessions: ComparisonSession[];
  /** Identifier of the session currently being viewed/edited. Driven by
   * `App` so a lane switch from the toolbar updates the chat tab too. */
  activeSessionId: ChatSessionId | null;
  /** User picked a different session in the list. The parent decides
   * what that means (lane switch, comparison focus, etc.). */
  onSelectSession: (id: ChatSessionId) => void;
  /** User dismissed a comparison from the session list. */
  onCloseCompareSession: (comparisonId: string) => void;
  /** Per-session bodies: which one is rendered depends on
   * `activeSessionId`. Both are always passed in so the top tab strip
   * can stay rendered and we don't lose mid-typed input on session
   * switches. */
  laneChat: LaneChatProps;
  /** Compare-chat props minus the bits ChatTab itself fills in:
   * `session` is resolved against `comparisonSessions` via
   * `activeSessionId`, `lanes` are resolved against the live `casefile`
   * snapshot, and `onClose` is wired through `onCloseCompareSession`. */
  compareChat: Omit<CompareChatProps, "session" | "lanes" | "onClose"> & {
    session: ComparisonSession | null;
  };
  /** Fired after `SaveOutputPicker` successfully persists a chat
   * message to disk. The parent uses this to re-list the workspace
   * tree so the new file shows up in the lane file browser without
   * requiring a manual refresh. */
  onAfterSaveOutput?: (path: string) => void;
}

function compactToolResult(content: string): string {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object") {
      const cmd = typeof parsed.cmd === "string" ? parsed.cmd : "tool";
      const status = parsed.ok ? "ok" : "error";
      const summary = typeof parsed.summary === "string" ? parsed.summary : "";
      return `${cmd} (${status})${summary ? ` - ${summary}` : ""}`;
    }
  } catch {
    // not JSON; fall through
  }
  return content.length > 240 ? `${content.slice(0, 240)}...` : content;
}

function describeMessage(msg: ChatMessage): { roleClass: string; text: string } {
  if (msg.role === "tool") {
    return { roleClass: "tool", text: compactToolResult(msg.content ?? "") };
  }
  if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
    const names = msg.tool_calls.map((c) => c.name).join(", ");
    const text = msg.content && msg.content.length > 0
      ? `${msg.content}\n\n[requested tools: ${names}]`
      : `[requested tools: ${names}]`;
    return { roleClass: "tool", text };
  }
  if (msg.role === "user") {
    return { roleClass: "user", text: msg.content || "[empty]" };
  }
  return { roleClass: "assistant", text: msg.content || "[empty]" };
}

function providerHasKey(provider: Provider, status: ApiKeyStatus): boolean {
  if (provider === "openai") return status.openaiConfigured;
  if (provider === "anthropic") return status.anthropicConfigured;
  return status.deepseekConfigured;
}

function ActiveModelFooter({
  activeModel,
  modelIsDefault,
}: {
  activeModel: string;
  modelIsDefault: boolean;
}): JSX.Element {
  return (
    <div
      className="chat-model-footer"
      title={modelIsDefault ? "Using the default configured model" : "Using a custom configured model"}
    >
      Model: <code>{activeModel}</code>
      {modelIsDefault && <span className="muted"> (default)</span>}
    </div>
  );
}

/** Tab strip listing every chat session the user can switch between
 * without leaving the Chat tab. Lane sessions are always offered (one
 * per lane in the casefile); comparison sessions are appended after.
 * Comparison rows get a small × that fires `onCloseCompareSession`. */
function ChatSessionList({
  casefile,
  comparisonSessions,
  activeSessionId,
  onSelectSession,
  onCloseCompareSession,
}: {
  casefile: CasefileSnapshot | null;
  comparisonSessions: ComparisonSession[];
  activeSessionId: ChatSessionId | null;
  onSelectSession: (id: ChatSessionId) => void;
  onCloseCompareSession: (comparisonId: string) => void;
}): JSX.Element | null {
  if (!casefile || casefile.lanes.length === 0) return null;
  return (
    <div className="chat-session-list" role="tablist" aria-label="Chat sessions">
      {casefile.lanes.map((lane) => {
        const id = laneSessionId(lane.id);
        const active = id === activeSessionId;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            className={`chat-session${active ? " active" : ""}`}
            onClick={() => onSelectSession(id)}
            title={`Single-context chat for ${lane.name}`}
          >
            <span className="chat-session-kind">single</span>
            <span className="chat-session-label">{lane.name}</span>
          </button>
        );
      })}
      {comparisonSessions.map((session) => {
        const id = compareSessionId(session.id);
        const active = id === activeSessionId;
        const label = session.lanes.map((l) => l.name).join(" · ");
        return (
          <span
            key={id}
            className={`chat-session scoped${active ? " active" : ""}`}
          >
            <button
              type="button"
              role="tab"
              aria-selected={active}
              className="chat-session-main"
              onClick={() => onSelectSession(id)}
              title={`Multi-context scoped session: ${label}`}
            >
              <span className="chat-session-kind">multi</span>
              <span className="chat-session-label">{label}</span>
            </button>
            <button
              type="button"
              className="chat-session-close"
              aria-label={`Close scoped session ${label}`}
              onClick={(event) => {
                event.stopPropagation();
                onCloseCompareSession(session.id);
              }}
              title="Close this scoped session"
            >
              ×
            </button>
          </span>
        );
      })}
    </div>
  );
}

/** Render one assistant/user/tool message with an inline Save... action
 * that opens a `SaveOutputPicker` next to the message. The picker is
 * rendered conditionally so multiple open pickers don't compete for
 * focus. */
function MessageRow({
  message,
  saveLanes,
  saveable,
  onAfterSave,
}: {
  message: ChatMessage;
  /** Lanes whose attachments + roots are offered as save destinations. */
  saveLanes: Lane[];
  /** Single-lane chats with no active lane have nowhere to save to;
   * comparison chats with no resolved lanes likewise lose the action.
   * In both cases we just hide the button. */
  saveable: boolean;
  /** Optional callback fired with the saved file's absolute path after a
   * successful write. Parent uses this to refresh the file tree so the
   * newly-saved file shows up immediately in the lane workspace. */
  onAfterSave?: (path: string) => void;
}): JSX.Element {
  const [savePickerOpen, setSavePickerOpen] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const { roleClass, text } = describeMessage(message);
  const canSave =
    saveable &&
    saveLanes.length > 0 &&
    (message.role === "assistant" || message.role === "user") &&
    !!message.content;

  return (
    <div className={`msg ${roleClass}`}>
      <span className="role">{message.role}</span>
      <span className="msg-body">{text}</span>
      {canSave && (
        <div className="msg-actions">
          <button
            type="button"
            className="link-button"
            onClick={() => setSavePickerOpen((open) => !open)}
          >
            {savePickerOpen ? "Cancel save" : "Save..."}
          </button>
          {savedAt && !savePickerOpen && (
            <span className="muted" title={savedAt}>
              Saved → {savedAt}
            </span>
          )}
        </div>
      )}
      {savePickerOpen && (
        <SaveOutputPicker
          lanes={saveLanes}
          defaultFilename={suggestSaveFilename(message.content ?? "")}
          body={message.content ?? ""}
          onCancel={() => setSavePickerOpen(false)}
          onSaved={(path) => {
            setSavedAt(path);
            setSavePickerOpen(false);
            onAfterSave?.(path);
          }}
        />
      )}
    </div>
  );
}

interface ScopeHeaderEntry {
  key: string;
  label: string;
  path: string;
  writable: boolean;
  onToggleWritable?: () => void;
  onRemove?: () => void;
  removeLabel?: string;
}

function describeScopeSummary(entries: ScopeHeaderEntry[], mode: "single" | "multi"): string {
  const count = entries.length;
  const writable = entries.filter((entry) => entry.writable).length;
  const directoryWord = count === 1 ? "directory" : "directories";
  const writableText =
    writable === 0
      ? "none are writable"
      : `${writable} ${writable === 1 ? "is" : "are"} writable`;
  if (mode === "single") {
    return `Single-context chat: AI can read ${count} scoped ${directoryWord}; ${writableText}. Switch contexts with the session list, widen with Add related directory, or right-click a pill to narrow/change access.`;
  }
  return `Multi-context chat: AI can read ${count} scoped ${directoryWord}; ${writableText}. Close this session to return to one context, or right-click a pill to narrow/change access.`;
}

function filenameFromPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? "related";
}

function ApprovalPanel({
  pendingApprovals,
  busy,
  onApprove,
  onDeny,
}: {
  pendingApprovals: ToolCall[];
  busy: boolean;
  onApprove: () => void;
  onDeny: () => void;
}): JSX.Element | null {
  if (pendingApprovals.length === 0) return null;
  return (
    <div className="approval-panel">
      <div className="summary">
        {`Approval required for write tools:\n` +
          pendingApprovals
            .map((call) => {
              const input =
                call && typeof call.input === "object" ? JSON.stringify(call.input) : "{}";
              const compactInput = input.length > 240 ? `${input.slice(0, 240)}...` : input;
              return `- ${call.name}: ${compactInput}`;
            })
            .join("\n")}
      </div>
      <div className="approval-actions">
        <button type="button" onClick={onApprove} disabled={busy}>
          Approve and Continue
        </button>
        <button type="button" onClick={onDeny} disabled={busy}>
          Deny
        </button>
      </div>
    </div>
  );
}

/** Displays the AI scope as a compact row of labelled pills — one per
 * directory in scope — each tagged with a (RW) or (RO) badge. Right-clicking
 * a pill reveals any management actions available for that directory. */
function ScopeHeader({
  entries,
  summary,
  extraAction,
}: {
  entries: ScopeHeaderEntry[];
  summary?: string;
  extraAction?: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
  };
}): JSX.Element | null {
  const [scopeMenu, setScopeMenu] = useState<{
    x: number;
    y: number;
    items: Parameters<typeof ContextMenu>[0]["items"];
  } | null>(null);
  const [open, setOpen] = useState(true);

  if (entries.length === 0) return null;

  const handleEntryContext = (event: React.MouseEvent, entry: ScopeHeaderEntry) => {
    event.preventDefault();
    const items: Parameters<typeof ContextMenu>[0]["items"] = [];
    if (entry.onToggleWritable) {
      items.push({
        label: entry.writable ? "Set AI access: read-only" : "Set AI access: writable",
        onSelect: entry.onToggleWritable,
      });
    }
    if (entry.onRemove) {
      items.push({
        label: entry.removeLabel ?? `Remove "${entry.label}" from scope`,
        onSelect: entry.onRemove,
      });
    }
    if (items.length === 0) return;
    setScopeMenu({ x: event.clientX, y: event.clientY, items });
  };

  return (
    <div className="scope-header">
      <div className="scope-header-row">
        <button
          type="button"
          className="scope-header-toggle"
          onClick={() => setOpen((v) => !v)}
          title={open ? "Hide AI scope" : "Show AI scope"}
          aria-expanded={open}
          aria-label="Toggle AI scope visibility"
        >
          AI scope {open ? "▾" : "▸"}
        </button>
        {extraAction && (
          <button
            type="button"
            className="link-button"
            onClick={extraAction.onClick}
            disabled={extraAction.disabled}
          >
            {extraAction.label}
          </button>
        )}
      </div>
      {summary && <div className="scope-header-summary muted">{summary}</div>}
      {open && (
        <div className="scope-header-pills" role="list" aria-label="Directories in AI scope">
          {entries.map((entry) => (
            <span
              key={entry.key}
              className={`scope-pill ${entry.writable ? "scope-pill-rw" : "scope-pill-ro"}`}
              role="listitem"
              title={`${entry.path} — ${entry.writable ? "AI may write" : "AI read-only"}`}
              onContextMenu={(event) => handleEntryContext(event, entry)}
            >
              {entry.label}
              <span className="scope-pill-badge">{entry.writable ? "RW" : "RO"}</span>
            </span>
          ))}
        </div>
      )}
      {scopeMenu && (
        <ContextMenu
          x={scopeMenu.x}
          y={scopeMenu.y}
          items={scopeMenu.items}
          onClose={() => setScopeMenu(null)}
        />
      )}
    </div>
  );
}

function LaneChatBody({
  chat,
  onAfterSave,
}: {
  chat: LaneChatProps;
  onAfterSave?: (path: string) => void;
}): JSX.Element {
  const [input, setInput] = useState("");
  const messagesRef = useRef<HTMLDivElement>(null);
  const [busyStart, setBusyStart] = useState<number | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());
  const [mentionActive, setMentionActive] = useState(false);
  const [mentionPath, setMentionPath] = useState("");
  const [isDragOver, setIsDragOver] = useState(false);
  const [pendingAttachmentRoot, setPendingAttachmentRoot] = useState<string | null>(null);
  const [attachmentDraftName, setAttachmentDraftName] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (chat.busy) {
      setBusyStart((prev) => prev ?? Date.now());
    } else {
      setBusyStart(null);
    }
  }, [chat.busy]);

  useEffect(() => {
    if (busyStart === null) return;
    const interval = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(interval);
  }, [busyStart]);

  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [chat.messages, chat.pendingApprovals, chat.busy]);

  const submit = () => {
    const value = input.trim();
    if (!value) return;
    chat.onSend(value);
    setInput("");
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
    // Trigger @mention picker when @ is typed at the start of a word.
    if (event.key === "@" && !mentionActive) {
      event.preventDefault();
      setMentionActive(true);
      setMentionPath("");
    }
  };

  const insertFileBlock = (path: string, content: string, truncated: boolean) => {
    const block = `[file: ${path}]\n${content}${truncated ? "\n...(truncated)" : ""}`;
    setInput((prev) => (prev ? `${prev}\n\n${block}` : block));
    setMentionActive(false);
    setMentionPath("");
    textareaRef.current?.focus();
  };

  const readAndInsert = async (filePath: string) => {
    try {
      const result = await api().readFile(filePath);
      insertFileBlock(result.path, result.content, result.truncated);
    } catch (err) {
      console.error("ChatTab: file read for @mention failed:", err);
    }
  };

  const handleMentionSubmit = () => {
    const path = mentionPath.trim();
    if (!path) {
      setMentionActive(false);
      return;
    }
    void readAndInsert(path);
  };

  const handleDragOver = (event: React.DragEvent<HTMLTextAreaElement>) => {
    // Accept intra-tree drags (custom MIME) and plain text drops.
    const types = Array.from(event.dataTransfer.types);
    if (types.includes(FILETREE_DRAG_MIME) || types.includes("text/plain")) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setIsDragOver(true);
    }
  };

  const handleDragLeave = () => setIsDragOver(false);

  const handleDrop = (event: React.DragEvent<HTMLTextAreaElement>) => {
    event.preventDefault();
    setIsDragOver(false);
    // Prefer the structured tree payload which carries the absolute path.
    // Fall back to the plain-text mirror for drops from other sources.
    const raw = event.dataTransfer.getData(FILETREE_DRAG_MIME);
    let filePath: string | null = null;
    if (raw) {
      try {
        const payloads = parseDragPayload(raw);
        filePath = payloads[0]?.absolutePath ?? null;
      } catch {
        filePath = null;
      }
    }
    if (!filePath) {
      filePath = event.dataTransfer.getData("text/plain").trim() || null;
    }
    if (filePath) {
      void readAndInsert(filePath);
    }
  };

  const handleAddRelatedDirectory = async () => {
    if (!chat.onAddAttachment) return;
    try {
      const root = await api().chooseLaneRoot();
      if (!root) return;
      setAttachmentDraftName(filenameFromPath(root));
      setPendingAttachmentRoot(root);
    } catch (error) {
      console.error("ChatTab: related directory chooser failed:", error);
    }
  };

  const keyMissing = !providerHasKey(chat.provider, chat.keyStatus);
  const inputDisabled = chat.busy || !chat.hasActiveLane;
  const elapsedMs = busyStart === null ? 0 : Math.max(0, now - busyStart);
  const lastToolNames = chat.busy ? summariseLastToolCalls(chat.messages) : null;
  const saveLanes = chat.activeLane ? [chat.activeLane] : [];
  const scopeEntries: ScopeHeaderEntry[] = chat.activeLane
    ? [
        {
          key: `${chat.activeLane.id}:root`,
          label: chat.activeLane.name,
          path: chat.activeLane.root,
          writable: chat.activeLane.writable !== false,
          onToggleWritable: chat.onSetLaneWritable
            ? () => chat.onSetLaneWritable!(chat.activeLane!.writable === false)
            : undefined,
        },
        ...(chat.activeLane.attachments ?? []).map((att) => ({
          key: `${chat.activeLane!.id}:att:${att.name}`,
          label: att.name,
          path: att.root,
          writable: att.mode === "write",
          onToggleWritable: chat.onSetAttachmentMode
            ? () =>
                chat.onSetAttachmentMode!(
                  att.name,
                  att.mode === "write" ? "read" : "write"
                )
            : undefined,
          onRemove: chat.onRemoveAttachment ? () => chat.onRemoveAttachment!(att.name) : undefined,
          removeLabel: `Remove "${att.name}" from scope`,
        })),
      ]
    : [];

  return (
    <div className="chat">
      <div className="chat-controls">
        {!chat.hasActiveLane ? (
          <span style={{ color: "#fbbf24" }}>
            Open a workspace and select a context to start a chat.
          </span>
        ) : keyMissing ? (
          <span style={{ color: "#fbbf24" }}>
            No API key configured for {chat.provider}. Open API Keys to add one.
          </span>
        ) : (
          <span style={{ color: "#9ca3af" }}>Provider: {chat.provider}</span>
        )}
        {chat.busy && (
          <span
            className="chat-busy-pill"
            title="The agent is working on your request"
            aria-live="polite"
          >
            <span className="chat-working-spinner" aria-hidden="true" />
            <span>
              {lastToolNames ? `Tools: ${lastToolNames}` : "Thinking"}
              <span className="muted"> · {formatElapsed(elapsedMs)}</span>
            </span>
          </span>
        )}
      </div>
      <ScopeHeader
        entries={scopeEntries}
        summary={describeScopeSummary(scopeEntries, "single")}
        extraAction={
          chat.onAddAttachment
            ? {
                label: "Add related directory...",
                onClick: () => void handleAddRelatedDirectory(),
                disabled: chat.busy || !chat.hasActiveLane,
              }
            : undefined
        }
      />
      <div className="chat-messages" ref={messagesRef}>
        {chat.messages.length === 0 && (
          <div style={{ color: "#6b7280", fontStyle: "italic" }}>
            {chat.hasActiveLane
              ? "No messages yet. This single-context chat can only use the AI scope listed above; add a related directory if the model needs more context."
              : "No active context."}
          </div>
        )}
        {chat.messages.map((msg, idx) => (
          <MessageRow
            key={idx}
            message={msg}
            saveLanes={saveLanes}
            saveable={chat.hasActiveLane}
            onAfterSave={onAfterSave}
          />
        ))}
        {chat.busy && (
          <div className="msg assistant chat-working" role="status" aria-live="polite">
            <span className="role">agent</span>
            <span className="chat-working-spinner" aria-hidden="true" />
            <span className="chat-working-text">
              {lastToolNames
                ? `Running tool${lastToolNames.includes(",") ? "s" : ""}: ${lastToolNames}`
                : "Thinking..."}
              <span className="chat-working-elapsed"> · {formatElapsed(elapsedMs)}</span>
            </span>
          </div>
        )}
      </div>
      <ApprovalPanel
        pendingApprovals={chat.pendingApprovals}
        busy={chat.busy}
        onApprove={chat.onApproveTools}
        onDeny={chat.onDenyTools}
      />
      {mentionActive && (
        <div className="chat-mention-picker">
          <input
            autoFocus
            type="text"
            className="chat-mention-input"
            placeholder="Type a file path and press Enter…"
            value={mentionPath}
            onChange={(e) => setMentionPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleMentionSubmit();
              }
              if (e.key === "Escape") {
                setMentionActive(false);
              }
            }}
          />
          <button
            type="button"
            className="chat-mention-cancel"
            onClick={() => setMentionActive(false)}
            title="Cancel"
          >
            ×
          </button>
        </div>
      )}
      {pendingAttachmentRoot && (
        <InputDialog
          title="Name related directory"
          message={pendingAttachmentRoot}
          defaultValue={attachmentDraftName}
          confirmLabel="Add to scope"
          onSubmit={(value) => {
            const name = value.trim();
            const root = pendingAttachmentRoot;
            setPendingAttachmentRoot(null);
            setAttachmentDraftName("");
            if (!name || !root || !chat.onAddAttachment) return;
            void Promise.resolve(chat.onAddAttachment(root, name)).catch((error) => {
              console.error("ChatTab: add related directory failed:", error);
            });
          }}
          onCancel={() => {
            setPendingAttachmentRoot(null);
            setAttachmentDraftName("");
          }}
        />
      )}
      <form
        className="chat-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={onKeyDown}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={isDragOver ? "drop-target" : undefined}
          placeholder={
            chat.hasActiveLane
              ? "Ask about your workspace… type @ to include a file"
              : "Open a workspace to enable chat..."
          }
          disabled={inputDisabled}
        />
        <div className="row">
          <button type="submit" disabled={inputDisabled || !input.trim()}>
            {chat.busy ? "Sending..." : "Send"}
          </button>
          <span className="chat-hint muted">
            Shift+Enter for new line · @ to include a file · drag a file here
          </span>
        </div>
        <ActiveModelFooter
          activeModel={chat.activeModel}
          modelIsDefault={chat.modelIsDefault}
        />
      </form>
    </div>
  );
}

/** Multi-lane comparison chat body. Comparison sessions share the same
 * scoped-directory access model as lane chat, plus optional comparison-local
 * attachments persisted per canonical lane-set session. */
function CompareChatBody({
  chat,
  onAfterSave,
}: {
  chat: CompareChatProps;
  onAfterSave?: (path: string) => void;
}): JSX.Element {
  const [input, setInput] = useState("");
  const messagesRef = useRef<HTMLDivElement>(null);
  const [busyStart, setBusyStart] = useState<number | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());
  const [pendingAttachmentRoot, setPendingAttachmentRoot] = useState<string | null>(null);
  const [attachmentDraftName, setAttachmentDraftName] = useState("");

  useEffect(() => {
    if (chat.busy) {
      setBusyStart((prev) => prev ?? Date.now());
    } else {
      setBusyStart(null);
    }
  }, [chat.busy]);

  useEffect(() => {
    if (busyStart === null) return;
    const interval = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(interval);
  }, [busyStart]);

  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [chat.session.messages, chat.session.pendingApprovals, chat.busy]);

  const submit = () => {
    const value = input.trim();
    if (!value) return;
    chat.onSend(value);
    setInput("");
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const keyMissing = !providerHasKey(chat.provider, chat.keyStatus);
  const laneNames = chat.session.lanes.map((l) => l.name).join(" ↔ ");
  const elapsedMs = busyStart === null ? 0 : Math.max(0, now - busyStart);
  const lastToolNames = chat.busy ? summariseLastToolCalls(chat.session.messages) : null;
  const pendingApprovals = chat.session.pendingApprovals ?? [];
  const scopeEntries: ScopeHeaderEntry[] = [
    ...chat.lanes.flatMap((lane) => [
      {
        key: `${lane.id}:root`,
        label: lane.name,
        path: lane.root,
        writable: lane.writable !== false,
        onToggleWritable: chat.onSetLaneWritable
          ? () => chat.onSetLaneWritable!(lane.id, lane.writable === false)
          : undefined,
      },
      ...(lane.attachments ?? []).map((att) => ({
        key: `${lane.id}:att:${att.name}`,
        label: `${lane.name} · ${att.name}`,
        path: att.root,
        writable: att.mode === "write",
        onToggleWritable: chat.onSetAttachmentMode
          ? () =>
              chat.onSetAttachmentMode!(
                lane.id,
                att.name,
                att.mode === "write" ? "read" : "write"
              )
          : undefined,
      })),
    ]),
    ...(chat.session.attachments ?? []).map((att) => ({
      key: `compare:att:${att.name}`,
      label: `Comparison · ${att.name}`,
      path: att.root,
      writable: att.mode === "write",
      onToggleWritable: chat.onUpdateAttachments
        ? () =>
            void chat.onUpdateAttachments!(
              chat.session.laneIds,
              (chat.session.attachments ?? []).map((entry) =>
                entry.name === att.name
                  ? {
                      name: entry.name,
                      root: entry.root,
                      mode: entry.mode === "write" ? "read" : "write",
                    }
                  : {
                      name: entry.name,
                      root: entry.root,
                      mode: entry.mode,
                    }
              )
            )
        : undefined,
      onRemove: chat.onUpdateAttachments
        ? () =>
            void chat.onUpdateAttachments!(
              chat.session.laneIds,
              (chat.session.attachments ?? [])
                .filter((entry) => entry.name !== att.name)
                .map((entry) => ({
                  name: entry.name,
                  root: entry.root,
                  mode: entry.mode,
                }))
            )
        : undefined,
      removeLabel: `Remove comparison attachment "${att.name}"`,
    })),
  ];
  const writableEntryCount = scopeEntries.filter((entry) => entry.writable).length;

  const handleAddAttachment = async () => {
    if (!chat.onUpdateAttachments) return;
    try {
      const root = await api().chooseLaneRoot();
      if (!root) return;
      const defaultName = filenameFromPath(root);
      setAttachmentDraftName(defaultName);
      setPendingAttachmentRoot(root);
    } catch (error) {
      console.error("Comparison attachment chooser failed:", error);
    }
  };

  return (
    <div className="chat">
      <div
        className="chat-controls"
        style={{ flexDirection: "column", alignItems: "flex-start", gap: 4 }}
      >
        <div style={{ display: "flex", gap: 8, alignItems: "center", width: "100%" }}>
          <strong style={{ color: "#a78bfa" }}>Multi-context chat:</strong>
          <span>{laneNames}</span>
          <button
            type="button"
            className="link-button"
            onClick={chat.onClose}
            style={{ marginLeft: "auto" }}
          >
            close
          </button>
        </div>
        <span style={{ color: "#9ca3af", fontSize: 12 }}>
          {writableEntryCount > 0
            ? `${writableEntryCount} scoped director${writableEntryCount === 1 ? "y is" : "ies are"} writable; write tools still require approval.`
            : `No writable scoped directories across ${chat.session.laneIds.length} contexts and comparison attachments.`}
        </span>
        {keyMissing && (
          <span style={{ color: "#fbbf24" }}>
            No API key configured for {chat.provider}. Open API Keys to add one.
          </span>
        )}
        {chat.busy && (
          <span
            className="chat-busy-pill"
            title="The agent is working on your request"
            aria-live="polite"
          >
            <span className="chat-working-spinner" aria-hidden="true" />
            <span>
              {lastToolNames ? `Tools: ${lastToolNames}` : "Thinking"}
              <span className="muted"> · {formatElapsed(elapsedMs)}</span>
            </span>
          </span>
        )}
      </div>
      <ScopeHeader
        entries={scopeEntries}
        summary={describeScopeSummary(scopeEntries, "multi")}
        extraAction={
          chat.onUpdateAttachments
            ? {
                label: "Add attachment...",
                onClick: () => void handleAddAttachment(),
                disabled: chat.busy,
              }
            : undefined
        }
      />
      <div className="chat-messages" ref={messagesRef}>
        {chat.session.messages.length === 0 && (
          <div style={{ color: "#6b7280", fontStyle: "italic" }}>
            Ask across these contexts. The AI can only use the scoped
            directories listed above; writable entries still require approval
            before changes are made.
          </div>
        )}
        {chat.session.messages.map((msg, idx) => (
          <MessageRow
            key={idx}
            message={msg}
            saveLanes={chat.lanes}
            saveable={chat.lanes.length > 0}
            onAfterSave={onAfterSave}
          />
        ))}
        {chat.busy && (
          <div className="msg assistant chat-working" role="status" aria-live="polite">
            <span className="role">agent</span>
            <span className="chat-working-spinner" aria-hidden="true" />
            <span className="chat-working-text">
              {lastToolNames
                ? `Running tool${lastToolNames.includes(",") ? "s" : ""}: ${lastToolNames}`
                : "Thinking..."}
              <span className="chat-working-elapsed"> · {formatElapsed(elapsedMs)}</span>
            </span>
          </div>
        )}
      </div>
      <ApprovalPanel
        pendingApprovals={pendingApprovals}
        busy={chat.busy}
        onApprove={chat.onApproveTools}
        onDeny={chat.onDenyTools}
      />
      <form
        className="chat-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask about these scoped workspaces..."
          disabled={chat.busy}
        />
        <div className="row">
          <button type="submit" disabled={chat.busy || !input.trim()}>
            {chat.busy ? "Sending..." : "Send"}
          </button>
          <span className="chat-hint muted">Shift+Enter for new line</span>
        </div>
        <ActiveModelFooter
          activeModel={chat.activeModel}
          modelIsDefault={chat.modelIsDefault}
        />
      </form>
      {pendingAttachmentRoot && (
        <InputDialog
          title="Name comparison attachment"
          message={pendingAttachmentRoot}
          defaultValue={attachmentDraftName}
          confirmLabel="Attach"
          onSubmit={(value) => {
            const name = value.trim();
            const root = pendingAttachmentRoot;
            setPendingAttachmentRoot(null);
            setAttachmentDraftName("");
            if (!name || !root || !chat.onUpdateAttachments) return;
            void chat.onUpdateAttachments(chat.session.laneIds, [
              ...(chat.session.attachments ?? [])
                .filter((entry) => entry.name !== name)
                .map((entry) => ({
                  name: entry.name,
                  root: entry.root,
                  mode: entry.mode,
                })),
              { name, root, mode: "write" },
            ]);
          }}
          onCancel={() => {
            setPendingAttachmentRoot(null);
            setAttachmentDraftName("");
          }}
        />
      )}
    </div>
  );
}

export function ChatTab({
  casefile,
  comparisonSessions,
  activeSessionId,
  onSelectSession,
  onCloseCompareSession,
  laneChat,
  compareChat,
  onAfterSaveOutput,
}: ChatTabProps): JSX.Element {
  // Resolve which body to render. A compare session is only active when
  // the id matches one we know about; otherwise we fall back to the
  // lane chat (e.g. on first render before the parent has chosen).
  const activeCompareSession = useMemo(() => {
    if (!activeSessionId || !activeSessionId.startsWith("compare:")) return null;
    const id = activeSessionId.slice("compare:".length);
    return comparisonSessions.find((s) => s.id === id) ?? null;
  }, [activeSessionId, comparisonSessions]);

  // Resolve compare-session lanes against the live casefile so renames
  // surface in the Save... picker rather than the snapshot stored at
  // open-time.
  const activeCompareLanes = useMemo(() => {
    if (!activeCompareSession || !casefile) return [];
    return activeCompareSession.laneIds
      .map((id) => casefile.lanes.find((lane) => lane.id === id))
      .filter((lane): lane is Lane => Boolean(lane));
  }, [activeCompareSession, casefile]);

  return (
    <div className="chat-tab">
      <ChatSessionList
        casefile={casefile}
        comparisonSessions={comparisonSessions}
        activeSessionId={activeSessionId}
        onSelectSession={onSelectSession}
        onCloseCompareSession={onCloseCompareSession}
      />
      {activeCompareSession ? (
        <CompareChatBody
          chat={{
            provider: compareChat.provider,
            keyStatus: compareChat.keyStatus,
            activeModel: compareChat.activeModel,
            modelIsDefault: compareChat.modelIsDefault,
            session: activeCompareSession,
            busy: compareChat.busy,
            lanes: activeCompareLanes,
            onSend: compareChat.onSend,
            onApproveTools: compareChat.onApproveTools,
            onDenyTools: compareChat.onDenyTools,
            onSetLaneWritable: compareChat.onSetLaneWritable,
            onSetAttachmentMode: compareChat.onSetAttachmentMode,
            onUpdateAttachments: compareChat.onUpdateAttachments,
            onClose: () => onCloseCompareSession(activeCompareSession.id),
          }}
          onAfterSave={onAfterSaveOutput}
        />
      ) : (
        <LaneChatBody chat={laneChat} onAfterSave={onAfterSaveOutput} />
      )}
    </div>
  );
}
