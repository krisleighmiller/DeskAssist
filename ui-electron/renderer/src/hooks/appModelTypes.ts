import type { OpenTab } from "../components/EditorPane";
import type { ChatMessage, ToolCall } from "../types";

/**
 * Shape we accept from the bridge when it returns a chat turn. The
 * bridge has historically used two formats: a `messages` array of
 * deltas (preferred) and a single `message`. We normalize both here
 * with a clear warning if the legacy/empty path is taken.
 */
export interface ChatTurnResponse {
  messages?: ChatMessage[] | null;
  message?: ChatMessage | null;
}

/**
 * Convert the bridge response into the next chat history. Centralized
 * so a future bridge contract change only needs one update, and so
 * the empty-response edge case logs a single, recognisable warning
 * instead of silently producing an "Error: empty bridge response"
 * message that looks like a user-facing bug. (Review item #8.)
 */
export function normalizeChatTurn(
  history: ChatMessage[],
  userMessage: string,
  response: ChatTurnResponse
): ChatMessage[] {
  const delta = Array.isArray(response.messages) ? response.messages : [];
  if (delta.length > 0) {
    return [...history, ...delta];
  }
  if (response.message) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        "Bridge returned legacy single-message response; expected a `messages` array"
      );
    }
    return [...history, { role: "user", content: userMessage }, response.message];
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

export interface LaneSessionState {
  messages: ChatMessage[];
  pendingApprovals: ToolCall[];
  tabs: OpenTab[];
  activeTabKey: string | null;
  /**
   * True while a chat send / tool-approval cycle for THIS lane is
   * in flight. Tracked per-lane (not globally) so switching lanes
   * mid-request doesn't show a stale spinner on the new lane and
   * doesn't let the response's `setBusy(false)` cancel the new
   * lane's spinner. See review item #4.
   */
  busy: boolean;
}

export const EMPTY_LANE_SESSION: LaneSessionState = {
  messages: [],
  pendingApprovals: [],
  tabs: [],
  activeTabKey: null,
  busy: false,
};

export interface NoteState {
  content: string;
  loading: boolean;
  saving: boolean;
  error: string | null;
  baseline: string;
}

export const EMPTY_NOTE_STATE: NoteState = {
  content: "",
  loading: false,
  saving: false,
  error: null,
  baseline: "",
};

/**
 * Backend default for the auto-include byte cap. Kept here as a single
 * source of truth so the renderer doesn't silently re-introduce a
 * different default if the user's manifest fails to load. If the
 * backend default ever changes, update this constant too.
 */
export const DEFAULT_AUTO_INCLUDE_MAX_BYTES = 32 * 1024;

/**
 * NUL is illegal in POSIX paths and Windows filenames, so it can't
 * appear in either component of the (root, laneId) pair. Using a
 * non-printable separator means even creatively-named lane ids or
 * paths that happen to contain `::` cannot collide.
 */
const SESSION_KEY_SEP = "\u0000";

export function sessionKeyFor(
  casefileRoot: string | null | undefined,
  laneId: string | null | undefined
): string | null {
  if (!casefileRoot || !laneId) return null;
  return `${casefileRoot}${SESSION_KEY_SEP}${laneId}`;
}

/**
 * All file tabs are keyed by `(laneId, path)` rather than path alone.
 * This keeps the open-from-tree path and the open-from-lanes-panel
 * path producing the same tab key for the same file, instead of two
 * disconnected buffers. (Review item #3.)
 */
export function fileTabKey(laneId: string, path: string): string {
  return `lane:${laneId}:${path}`;
}

export function overlayTabKey(laneId: string, virtualPath: string): string {
  return `overlay:${laneId}:${virtualPath}`;
}

export function diffTabKey(leftId: string, rightId: string, path: string): string {
  return `diff:${leftId}\u21D4${rightId}:${path}`;
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

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
