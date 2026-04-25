import type { OpenTab } from "../components/EditorPane";
import type { ChatMessage, ToolCall } from "../types";

/**
 * Shape we accept from the bridge when it returns a chat turn. The
 * bridge has historically used two formats: a `messages` array of
 * deltas (preferred) and a single `message`. We normalize both here
 * with a clear warning if the legacy/empty path is taken.
 */
interface ChatTurnResponse {
  messages?: ChatMessage[] | null;
  message?: ChatMessage | null;
}

/**
 * Extract the assistant-side delta from a bridge response, accepting
 * both the preferred `messages` array and the legacy single `message`
 * format. Returns `null` if the bridge produced neither — callers
 * decide how to surface the empty case (resume flows treat it as a
 * silent no-op while a fresh user send shows an error).
 */
export function chatTurnDelta(response: ChatTurnResponse): ChatMessage[] | null {
  if (Array.isArray(response.messages) && response.messages.length > 0) {
    return response.messages;
  }
  if (response.message) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        "Bridge returned legacy single-message response; expected a `messages` array"
      );
    }
    return [response.message];
  }
  return null;
}

/**
 * Convert the bridge response into the next chat history. Centralized
 * so a future bridge contract change only needs one update, and so
 * the empty-response edge case logs a single, recognisable warning
 * instead of silently producing an "Error: empty bridge response"
 * message that looks like a user-facing bug. (Review item #8.)
 *
 * The legacy single-`message` path injects the user message manually
 * because the older bridge format omitted it from the response. Only
 * use this helper for fresh user sends; tool-resume/approval flows
 * have no new user message and should use `chatTurnDelta` directly.
 */
export function normalizeChatTurn(
  history: ChatMessage[],
  userMessage: string,
  response: ChatTurnResponse
): ChatMessage[] {
  if (Array.isArray(response.messages) && response.messages.length > 0) {
    return [...history, ...response.messages];
  }
  const delta = chatTurnDelta(response);
  if (delta) {
    return [...history, { role: "user", content: userMessage }, ...delta];
  }
  if (process.env.NODE_ENV !== "production") {
    console.warn("Bridge returned an empty chat response");
  }
  return [
    ...history,
    { role: "user", content: userMessage },
    { role: "assistant", content: "Error: empty bridge response" },
  ];
}

export interface ContextSessionState {
  /** Stable UUID assigned at session creation. Survives context switches
   * so the user (and future cross-session reference UI) can reference
   * "that specific conversation" by ID rather than by structural path. */
  id: string;
  messages: ChatMessage[];
  pendingApprovals: ToolCall[];
  tabs: OpenTab[];
  activeTabKey: string | null;
  /**
   * True while a chat send / tool-approval cycle for THIS context is
   * in flight. Tracked per-context (not globally) so switching contexts
   * mid-request doesn't show a stale spinner on the new context and
   * doesn't let the response's `setBusy(false)` cancel the new
   * context's spinner. See review item #4.
   */
  busy: boolean;
}

export const EMPTY_CONTEXT_SESSION: ContextSessionState = {
  id: "",
  messages: [],
  pendingApprovals: [],
  tabs: [],
  activeTabKey: null,
  busy: false,
};

/**
 * Generate a stable UUID for a new session.  Falls back to a timestamp
 * + random string on the rare chance `crypto.randomUUID` is unavailable.
 */
export function generateSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * NUL is illegal in POSIX paths and Windows filenames, so it can't
 * appear in either component of the (root, contextId) pair. Using a
 * non-printable separator means even creatively-named context ids or
 * paths that happen to contain `::` cannot collide.
 */
const SESSION_KEY_SEP = "\u0000";

export function sessionKeyFor(
  casefileRoot: string | null | undefined,
  sessionId: string | null | undefined
): string | null {
  if (!casefileRoot || !sessionId) return null;
  return `${casefileRoot}${SESSION_KEY_SEP}${sessionId}`;
}

/**
 * All file tabs are keyed by `(contextId, path)` rather than path alone.
 * This keeps the open-from-tree path and the open-from-contexts-panel
 * path producing the same tab key for the same file, instead of two
 * disconnected buffers. (Review item #3.)
 */
export function fileTabKey(contextId: string, path: string): string {
  return `context:${contextId}:${path}`;
}

/**
 * If a renamed file is open in any tab whose key encodes its path,
 * we need to rebuild the key. All of our tab keys end with `:<path>`,
 * so we can do this generically without parsing the prefix.
 */
export function rewriteTabKeyForRename(
  key: string,
  oldPath: string,
  newPath: string
): string {
  const suffix = `:${oldPath}`;
  if (!key.endsWith(suffix)) return key;
  return `${key.slice(0, key.length - suffix.length)}:${newPath}`;
}

/**
 * Detect the platform separator used in `samplePath` so the renderer
 * can compare paths without importing Node's `path` module. Falls back
 * to `/` (POSIX) when the path contains neither separator.  We only
 * need this for descendant-prefix checks; the bridge always returns
 * native paths, so a single sample is enough.
 */
function pathSeparatorOf(samplePath: string): "/" | "\\" {
  return samplePath.includes("\\") && !samplePath.includes("/") ? "\\" : "/";
}

/**
 * Return true if `candidate` equals `ancestor` or lives strictly under
 * it as a descendant (one or more separators deep). Used to decide
 * which open tabs to rewrite when a directory is moved or trashed.
 */
export function isPathOrDescendant(candidate: string, ancestor: string): boolean {
  if (candidate === ancestor) return true;
  const sep = pathSeparatorOf(ancestor);
  return candidate.startsWith(ancestor + sep);
}

/**
 * Replace an `ancestor` prefix in `candidate` with `newAncestor`. Used
 * when a directory move ripples through every descendant tab path.
 * Returns `candidate` unchanged when it neither equals nor descends
 * from `ancestor`.
 */
export function rewriteDescendantPath(
  candidate: string,
  ancestor: string,
  newAncestor: string
): string {
  if (candidate === ancestor) return newAncestor;
  const sep = pathSeparatorOf(ancestor);
  const prefix = ancestor + sep;
  if (!candidate.startsWith(prefix)) return candidate;
  return newAncestor + sep + candidate.slice(prefix.length);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
