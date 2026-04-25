export type Provider = "openai" | "anthropic" | "deepseek";

type ChatRole = "user" | "assistant" | "tool" | "system";

export interface ToolCall {
  id?: string;
  name: string;
  input?: Record<string, unknown>;
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface ChatSendPayload {
  provider: Provider;
  model?: string | null;
  messages: ChatMessage[];
  userMessage: string;
  /**
   * SECURITY (H1): retained on the type for backward compatibility with
   * older call sites, but main IGNORES this flag on `sendChat`. Use
   * `approveAndResumeChat` to enable write tools server-side after a
   * pending approval has been minted.
   */
  allowWriteTools?: boolean;
  /**
   * SECURITY (H1): same as `allowWriteTools` — ignored by main on
   * `sendChat`. Use `approveAndResumeChat` instead.
   */
  resumePendingToolCalls?: boolean;
}

/**
 * SECURITY (H1): payload for `approveAndResumeChat` /
 * `approveAndResumeComparisonChat`. The renderer never sets
 * `allowWriteTools` here either; it is forced to true server-side and
 * gated on a freshly-minted approval token stored in main.
 */
interface ApproveAndResumePayload {
  provider: Provider;
  model?: string | null;
  messages: ChatMessage[];
}

interface ChatSendResponse {
  ok?: boolean;
  messages?: ChatMessage[];
  message?: ChatMessage;
  pendingApprovals?: ToolCall[];
  error?: string;
}

export interface ApiKeyStatus {
  openaiConfigured: boolean;
  anthropicConfigured: boolean;
  deepseekConfigured: boolean;
  /**
   * SECURITY (C2): identifies the at-rest storage backend currently in
   * use for API keys.
   * - `keychain`        — node-keytar / OS credential store
   * - `encrypted-file`  — Electron safeStorage-encrypted file (OS-bound key)
   * - `unavailable`     — neither backend is usable; saving will throw.
   *                       The renderer should surface this prominently so
   *                       the user fixes their keyring before relying on
   *                       the app, rather than silently downgrading to
   *                       plaintext.
   */
  storageBackend: "keychain" | "encrypted-file" | "unavailable";
}

/** Per-provider preferred model id. Empty string means "use the backend
 * default" — the renderer should display the default as a placeholder so
 * the user knows what they'd get without overriding. Stored separately
 * from `ApiKeyStatus` because model ids are not secret and live in plain
 * user-data, while keys are kept in the system keychain when available. */
export interface ProviderModels {
  openai: string;
  anthropic: string;
  deepseek: string;
}

/** Backend defaults, mirrored here for placeholder display in the API
 * keys / models dialog and the toolbar model picker. Keep in sync with
 * `ChatService._default_models` in `assistant_app/chat_service.py`. */
export const DEFAULT_PROVIDER_MODELS: ProviderModels = {
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5",
  deepseek: "deepseek-chat",
};

export interface FileTreeNode {
  name: string;
  path: string;
  type: "file" | "dir";
  children?: FileTreeNode[];
}

interface FileReadResult {
  path: string;
  content: string;
  truncated: boolean;
}

interface FileSaveResult {
  path: string;
  saved: boolean;
}

type ContextKind = "repo" | "doc" | "rubric" | "review" | "other";

export type AttachmentMode = "read" | "write";

interface ContextAttachmentDto {
  name: string;
  root: string;
  mode: AttachmentMode;
}

export interface Context {
  id: string;
  /** Stable UUID for session identity; unlike `id`, this is not a structural path key. */
  sessionId: string;
  name: string;
  kind: ContextKind;
  root: string;
  /** M3.5: parent context id; null/undefined means top-level. */
  parentId?: string | null;
  /** M3.5: sibling directories travelling with this context. */
  attachments?: ContextAttachmentDto[];
  /** M2.5: whether the AI has write access to this context's root directory.
   * Defaults to true. Set to false to make this context a read-only reference context. */
  writable?: boolean;
}

export interface CasefileSnapshot {
  root: string;
  contexts: Context[];
  activeContextId: string | null;
}

export interface RecentContext {
  root: string;
  activeContextId: string | null;
  activeContextName: string | null;
  updatedAt: string;
  pinned?: boolean;
}

export interface ContextAttachmentInput {
  name: string;
  root: string;
  mode?: AttachmentMode;
}

interface RegisterContextInput {
  name: string;
  kind: ContextKind;
  root: string;
  id?: string;
  parentId?: string | null;
  attachments?: ContextAttachmentInput[];
  writable?: boolean;
}

// M4.6: every field is independently optional. Omitting a field means
// "leave the existing value unchanged"; the bridge enforces this via
// JSON key presence.
export interface ContextUpdateInput {
  name?: string;
  kind?: ContextKind;
  root?: string;
  /** M2.5: toggle AI write access for this context's root directory. */
  writable?: boolean;
}

// M4.6: `casefile:updateContext` may surface a non-blocking "another context
// already references this directory" warning alongside the new
// snapshot. The renderer is responsible for displaying it.
export interface UpdateContextResult {
  casefile: CasefileSnapshot;
  rootConflict: { conflictingContextId: string } | null;
}

interface ComparisonContextSummary {
  id: string;
  name: string;
  root: string;
}

export interface ComparisonSession {
  id: string;
  /** Stable UUID for this canonical comparison chat session. */
  sessionId: string;
  contextIds: string[];
  contexts: ComparisonContextSummary[];
  attachments: ContextAttachmentDto[];
  messages: ChatMessage[];
  pendingApprovals?: ToolCall[];
  skippedCorruptLines?: number;
}

interface ComparisonChatSendPayload {
  contextIds: string[];
  provider: Provider;
  model?: string | null;
  messages: ChatMessage[];
  userMessage: string;
  /** SECURITY (H1): ignored by main; see `ChatSendPayload`. */
  allowWriteTools?: boolean;
  /** SECURITY (H1): ignored by main; see `ChatSendPayload`. */
  resumePendingToolCalls?: boolean;
}

/** SECURITY (H1): payload for `approveAndResumeComparisonChat`. */
interface ApproveAndResumeComparisonPayload {
  contextIds: string[];
  provider: Provider;
  model?: string | null;
  messages: ChatMessage[];
}

interface ComparisonChatSendResponse {
  ok?: boolean;
  message?: ChatMessage;
  messages?: ChatMessage[];
  pendingApprovals?: ToolCall[];
  comparison?: Omit<ComparisonSession, "messages">;
  persistenceError?: string;
  error?: string;
}

/** Payload for `chat:saveOutput`. The destination is an *absolute* directory
 * the user picked (typically a context attachment, optionally any other
 * directory via the system folder dialog). The bridge writes
 * `<destinationDir>/<filename>` and refuses to overwrite. */
interface SaveChatOutputPayload {
  destinationDir: string;
  filename: string;
  body: string;
}

interface SaveChatOutputResult {
  path: string;
}

interface ListChatResult {
  messages: ChatMessage[];
  skippedCorruptLines: number;
}

export interface AssistantApi {
  // Casefile + contexts
  chooseCasefile: () => Promise<CasefileSnapshot | null>;
  openCasefile: (root: string) => Promise<CasefileSnapshot>;
  closeCasefile: () => Promise<true>;
  chooseContextRoot: () => Promise<string | null>;
  registerContext: (context: RegisterContextInput) => Promise<CasefileSnapshot>;
  switchContext: (contextId: string) => Promise<CasefileSnapshot>;
  listChat: (contextId: string) => Promise<ListChatResult>;

  // Casefile-scoped filesystem.
  listWorkspace: (maxDepth?: number) => Promise<FileTreeNode>;
  readFile: (path: string, maxChars?: number) => Promise<FileReadResult>;
  saveFile: (path: string, content: string) => Promise<FileSaveResult>;
  /** Rename a single file or directory inside the active casefile.
   * `newName` is a basename only (no path separators); the bridge
   * refuses to overwrite an existing entry. */
  renameFile: (
    path: string,
    newName: string
  ) => Promise<{ oldPath: string; newPath: string; renamed: boolean }>;
  /** Create a new (empty) file at `<parentDir>/<name>` inside the
   * active casefile.  Refuses to clobber an existing entry. */
  createFile: (
    parentDir: string,
    name: string
  ) => Promise<{ path: string; created: boolean }>;
  /** Create a new directory at `<parentDir>/<name>` inside the active
   * casefile.  Refuses to clobber an existing entry. */
  createFolder: (
    parentDir: string,
    name: string
  ) => Promise<{ path: string; created: boolean }>;
  /** Move (or rename) a file or directory inside the active casefile.
   * Both paths must resolve inside the casefile root; the bridge refuses
   * to overwrite an existing destination. */
  moveEntry: (
    sourcePath: string,
    destinationPath: string
  ) => Promise<{ sourcePath: string; destinationPath: string; moved: boolean }>;
  /** Move a file or directory inside the active casefile to the OS trash
   * via Electron's shell.trashItem (recoverable). The context root itself
   * cannot be trashed; context removal is a separate flow. The bridge
   * snapshots the target into a session-private staging directory
   * before the trash so `undoLastTrash` can restore it. */
  trashEntry: (
    path: string
  ) => Promise<{ path: string; trashed: boolean; undoId?: string }>;
  /** Restore the most recently trashed entry from the session-local
   * undo stack. Resolves with `{ restored: false }` when the stack is
   * empty so the keyboard binding can stay silent. May reject when the
   * target path now belongs to a different casefile, when something
   * already exists at that path, or when the parent directory has been
   * removed in the meantime. */
  undoLastTrash: () => Promise<
    | { restored: false }
    | { restored: true; path: string; type: "file" | "dir" }
  >;
  /** How many trash-undo entries are restorable for the active casefile.
   * The renderer uses this to decide whether to render an "undo" hint
   * in the file-tree toolbar. */
  trashUndoStatus: () => Promise<{ restorable: number }>;

  // Save a chat message body to a user-chosen directory.
  saveChatOutput: (payload: SaveChatOutputPayload) => Promise<SaveChatOutputResult>;

  // M3.5: context attachments.
  updateContextAttachments: (
    contextId: string,
    attachments: ContextAttachmentInput[]
  ) => Promise<CasefileSnapshot>;

  // M4.6: context CRUD (edit/remove) + casefile reset (hard/soft).
  updateContext: (
    contextId: string,
    update: ContextUpdateInput
  ) => Promise<UpdateContextResult>;
  removeContext: (contextId: string) => Promise<CasefileSnapshot>;
  hardResetCasefile: () => Promise<CasefileSnapshot>;
  softResetCasefile: () => Promise<CasefileSnapshot>;

  // Chat
  sendChat: (payload: ChatSendPayload) => Promise<ChatSendResponse>;
  /**
   * SECURITY (H1): explicit approval IPC for write tools. Only succeeds
   * when main has a fresh (≤5 min) bridge-issued approval record for
   * the active context. Throws otherwise — the renderer should treat that
   * as "tell the user the model didn't ask for any writes recently."
   */
  approveAndResumeChat: (
    payload: ApproveAndResumePayload
  ) => Promise<ChatSendResponse>;

  // M3.5c: comparison-chat sessions (multi-context scoped chat).
  openComparison: (contextIds: string[]) => Promise<ComparisonSession>;
  updateComparisonAttachments: (
    contextIds: string[],
    attachments: ContextAttachmentInput[]
  ) => Promise<Omit<ComparisonSession, "messages">>;
  sendComparisonChat: (
    payload: ComparisonChatSendPayload
  ) => Promise<ComparisonChatSendResponse>;
  /** SECURITY (H1): comparison-chat counterpart of `approveAndResumeChat`. */
  approveAndResumeComparisonChat: (
    payload: ApproveAndResumeComparisonPayload
  ) => Promise<ComparisonChatSendResponse>;

  // API keys
  getApiKeyStatus: () => Promise<ApiKeyStatus>;
  saveApiKeys: (payload: {
    openai?: string;
    anthropic?: string;
    deepseek?: string;
  }) => Promise<ApiKeyStatus>;
  clearApiKey: (provider: Provider) => Promise<ApiKeyStatus>;

  // Per-provider preferred model. Empty string means "use backend default".
  getProviderModels: () => Promise<ProviderModels>;
  saveProviderModels: (payload: Partial<ProviderModels>) => Promise<ProviderModels>;
  onOpenApiKeys: (handler: () => void) => () => void;
  onOpenPreferences: (handler: () => void) => () => void;
  onOpenRecent: (handler: () => void) => () => void;
  /** Subscribe to "toggle integrated terminal" events from the main
   * process menu (View → Toggle Integrated Terminal, accelerator
   * `CmdOrCtrl+\``). Returns an unsubscribe function. */
  onToggleTerminal: (handler: () => void) => () => void;
  onToggleLeftPanel: (handler: () => void) => () => void;
  onToggleRightPanel: (handler: () => void) => () => void;

  /** Menu-bar → renderer: Context management triggers. Each returns an
   * unsubscribe function for use in useEffect teardowns. */
  onOpenCasefile: (handler: () => void) => () => void;
  onCloseCasefile: (handler: () => void) => () => void;
  onNewFile: (handler: () => void) => () => void;
  onNewFolder: (handler: () => void) => () => void;
  onContextCreate: (handler: () => void) => () => void;
  onContextAttach: (handler: () => void) => () => void;
  onContextRename: (handler: () => void) => () => void;
  onContextToggleAccess: (handler: () => void) => () => void;
  onContextRemove: (handler: () => void) => () => void;
  onContextCompare: (handler: () => void) => () => void;
  onCasefileSoftReset: (handler: () => void) => () => void;
  onCasefileHardReset: (handler: () => void) => () => void;

  /** Subscribe to filesystem-change notifications for the active
   * casefile root and any overlay roots registered via
   * `registerWatchRoots`. Handler is invoked (debounced) on any
   * create/rename/delete/modify within those directories. Returns an
   * unsubscribe function. */
  onWorkspaceChanged: (handler: () => void) => () => void;
  /** Tell main about overlay roots that live outside the casefile so
   * their changes also fire `workspace:changed`. Safe to include
   * roots that are already inside the casefile — main dedupes. */
  registerWatchRoots: (roots: string[]) => Promise<{ watching: string[] }>;

  /** Integrated terminal API. Each session corresponds to one PTY-backed
   * shell process owned by the main process. The renderer addresses
   * sessions by an opaque id of its choosing (typically derived from a
   * context id) and consumes streaming output via `onTerminalData`. */
  terminalAvailable: () => Promise<{ available: boolean; error: string | null }>;
  terminalSpawn: (opts: TerminalSpawnOptions) => Promise<TerminalSpawnResult>;
  terminalWrite: (id: string, data: string) => Promise<boolean>;
  terminalResize: (id: string, cols: number, rows: number) => Promise<boolean>;
  terminalKill: (id: string) => Promise<boolean>;
  terminalList: () => Promise<TerminalSessionDescriptor[]>;
  onTerminalData: (id: string, handler: (data: string) => void) => () => void;
  onTerminalExit: (
    id: string,
    handler: (payload: { exitCode: number; signal: number | null }) => void
  ) => () => void;
}

interface TerminalSpawnOptions {
  id: string;
  cwd?: string | null;
  cols?: number;
  rows?: number;
  contextId?: string | null;
}

interface TerminalSpawnResult {
  id: string;
  cwd: string;
  shell: string;
  pid: number;
}

interface TerminalSessionDescriptor {
  id: string;
  cwd: string;
  shell: string;
  contextId: string | null;
  pid: number;
}

declare global {
  interface Window {
    assistantApi: AssistantApi;
  }
}
