import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ApiKeyStatus,
  CasefileSnapshot,
  ChatMessage,
  ComparisonSession,
  Lane,
  Provider,
  ToolCall,
} from "../types";
import { SaveOutputPicker, suggestSaveFilename } from "./SaveOutputPicker";

/** Identifier for a single chat session entry in the session list. Lane
 * sessions are scoped by lane id; comparison sessions get a stable
 * `compare:<id>` prefix so the two namespaces never collide. */
export type ChatSessionId = `lane:${string}` | `compare:${string}`;

export function laneSessionId(laneId: string): ChatSessionId {
  return `lane:${laneId}`;
}

export function compareSessionId(comparisonId: string): ChatSessionId {
  return `compare:${comparisonId}`;
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
  messages: ChatMessage[];
  pendingApprovals: ToolCall[];
  busy: boolean;
  hasActiveLane: boolean;
  /** Lane currently driving this chat (used for the Save... picker
   * destinations and as the Send target). */
  activeLane: Lane | null;
  /** M4.1: name of the system prompt currently injected into this lane's
   * chat (or null if none). Shown as a small badge in the controls strip. */
  activePromptName: string | null;
  onClearActivePrompt: () => void;
  onSend: (text: string) => void;
  onApproveTools: () => void;
  onDenyTools: () => void;
}

interface CompareChatProps {
  provider: Provider;
  keyStatus: ApiKeyStatus;
  session: ComparisonSession;
  busy: boolean;
  /** Resolved lanes participating in this comparison (used by the Save...
   * picker so each lane's attachments + root are offered). May be a
   * subset of `session.laneIds` if a lane was renamed/removed since the
   * comparison opened — we still surface what we know. */
  lanes: Lane[];
  onSend: (text: string) => void;
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
            title={`Lane chat for ${lane.name}`}
          >
            <span className="chat-session-kind">lane</span>
            <span className="chat-session-label">{lane.name}</span>
          </button>
        );
      })}
      {comparisonSessions.map((session) => {
        const id = compareSessionId(session.id);
        const active = id === activeSessionId;
        const label = session.lanes.map((l) => l.name).join(" ↔ ");
        return (
          <span
            key={id}
            className={`chat-session compare${active ? " active" : ""}`}
          >
            <button
              type="button"
              role="tab"
              aria-selected={active}
              className="chat-session-main"
              onClick={() => onSelectSession(id)}
              title={`Comparison chat: ${label}`}
            >
              <span className="chat-session-kind">compare</span>
              <span className="chat-session-label">{label}</span>
            </button>
            <button
              type="button"
              className="chat-session-close"
              aria-label={`Close comparison ${label}`}
              onClick={(event) => {
                event.stopPropagation();
                onCloseCompareSession(session.id);
              }}
              title="Close this comparison chat"
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

/** Single-lane chat body: provider/key/badge strip, message list with
 * per-message Save..., approval panel for write-tool requests, send
 * form. Mirrors the prior dedicated `ChatTab` body. */
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
  };

  const keyMissing = !providerHasKey(chat.provider, chat.keyStatus);
  const inputDisabled = chat.busy || !chat.hasActiveLane;
  const elapsedMs = busyStart === null ? 0 : Math.max(0, now - busyStart);
  const lastToolNames = chat.busy ? summariseLastToolCalls(chat.messages) : null;
  const saveLanes = chat.activeLane ? [chat.activeLane] : [];

  return (
    <div className="chat">
      <div className="chat-controls">
        {!chat.hasActiveLane ? (
          <span style={{ color: "#fbbf24" }}>
            Open a casefile and select a lane to start a chat.
          </span>
        ) : keyMissing ? (
          <span style={{ color: "#fbbf24" }}>
            No API key configured for {chat.provider}. Open API Keys to add one.
          </span>
        ) : (
          <span style={{ color: "#9ca3af" }}>Provider: {chat.provider}</span>
        )}
        {chat.activePromptName && (
          <span className="chat-prompt-badge" title="System prompt injected this turn">
            Prompt: {chat.activePromptName}
            <button
              type="button"
              className="chat-prompt-clear"
              onClick={chat.onClearActivePrompt}
              disabled={chat.busy}
              title="Clear system prompt"
            >
              ×
            </button>
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
      <div className="chat-messages" ref={messagesRef}>
        {chat.messages.length === 0 && (
          <div style={{ color: "#6b7280", fontStyle: "italic" }}>
            {chat.hasActiveLane
              ? "No messages yet for this lane. Ask about your workspace."
              : "No active lane."}
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
      {chat.pendingApprovals.length > 0 && (
        <div className="approval-panel">
          <div className="summary">
            {`Approval required for write tools:\n` +
              chat.pendingApprovals
                .map((call) => {
                  const input =
                    call && typeof call.input === "object"
                      ? JSON.stringify(call.input)
                      : "{}";
                  const compactInput = input.length > 240 ? `${input.slice(0, 240)}...` : input;
                  return `- ${call.name}: ${compactInput}`;
                })
                .join("\n")}
          </div>
          <div className="approval-actions">
            <button type="button" onClick={chat.onApproveTools} disabled={chat.busy}>
              Approve and Continue
            </button>
            <button type="button" onClick={chat.onDenyTools} disabled={chat.busy}>
              Deny
            </button>
          </div>
        </div>
      )}
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
          placeholder={
            chat.hasActiveLane ? "Ask about your workspace..." : "Open a casefile to enable chat..."
          }
          disabled={inputDisabled}
        />
        <div className="row">
          <button type="submit" disabled={inputDisabled || !input.trim()}>
            {chat.busy ? "Sending..." : "Send"}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Multi-lane comparison chat body: read-only across every lane in the
 * session, no write-tool approval flow, Save... picker offers all
 * lanes' attachments + roots. */
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
  }, [chat.session.messages, chat.busy]);

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

  return (
    <div className="chat">
      <div
        className="chat-controls"
        style={{ flexDirection: "column", alignItems: "flex-start", gap: 4 }}
      >
        <div style={{ display: "flex", gap: 8, alignItems: "center", width: "100%" }}>
          <strong style={{ color: "#a78bfa" }}>Compare:</strong>
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
          Read-only across {chat.session.laneIds.length} lanes; no write tools
          available.
        </span>
        {keyMissing && (
          <span style={{ color: "#fbbf24" }}>
            No API key configured for {chat.provider}. Open API Keys to add one.
          </span>
        )}
      </div>
      <div className="chat-messages" ref={messagesRef}>
        {chat.session.messages.length === 0 && (
          <div style={{ color: "#6b7280", fontStyle: "italic" }}>
            Ask the model to compare these lanes. It can read every file
            under <code>_lanes/&lt;id&gt;/</code> for each lane.
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
              Thinking...
              <span className="chat-working-elapsed"> · {formatElapsed(elapsedMs)}</span>
            </span>
          </div>
        )}
      </div>
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
          placeholder="Ask about the differences between these lanes..."
          disabled={chat.busy}
        />
        <div className="row">
          <button type="submit" disabled={chat.busy || !input.trim()}>
            {chat.busy ? "Sending..." : "Send"}
          </button>
        </div>
      </form>
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
            session: activeCompareSession,
            busy: compareChat.busy,
            lanes: activeCompareLanes,
            onSend: compareChat.onSend,
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
