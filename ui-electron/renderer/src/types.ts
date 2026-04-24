export type Provider = "openai" | "anthropic" | "deepseek";

export type ChatRole = "user" | "assistant" | "tool" | "system";

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

export interface ChatSendPayload {
  provider: Provider;
  model?: string | null;
  messages: ChatMessage[];
  userMessage: string;
  allowWriteTools: boolean;
  resumePendingToolCalls: boolean;
  /**
   * M4.1: id of a casefile-level prompt draft to inject as a system message
   * before the user turn. Idempotent across resumed turns (the bridge
   * skips re-injection when the marker is already in `messages`).
   */
  systemPromptId?: string | null;
}

export interface ChatSendResponse {
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
  storageBackend: "keychain" | "file";
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

export interface FileReadResult {
  path: string;
  content: string;
  truncated: boolean;
}

export interface FileSaveResult {
  path: string;
  saved: boolean;
}

export type LaneKind = "repo" | "doc" | "rubric" | "review" | "other";

export const LANE_KINDS: readonly LaneKind[] = ["repo", "doc", "rubric", "review", "other"];

export type AttachmentMode = "read" | "write";

export interface LaneAttachmentDto {
  name: string;
  root: string;
  mode: AttachmentMode;
}

export interface Lane {
  id: string;
  /** Stable UUID for session identity; unlike `id`, this is not a structural path key. */
  sessionId: string;
  name: string;
  kind: LaneKind;
  root: string;
  /** M3.5: parent lane id; null/undefined means top-level. */
  parentId?: string | null;
  /** M3.5: sibling directories travelling with this lane. */
  attachments?: LaneAttachmentDto[];
  /** M2.5: whether the AI has write access to this lane's root directory.
   * Defaults to true. Set to false to make this lane a read-only reference context. */
  writable?: boolean;
}

export interface CasefileSnapshot {
  root: string;
  lanes: Lane[];
  activeLaneId: string | null;
}

export interface LaneAttachmentInput {
  name: string;
  root: string;
  mode?: AttachmentMode;
}

export interface RegisterLaneInput {
  name: string;
  kind: LaneKind;
  root: string;
  id?: string;
  parentId?: string | null;
  attachments?: LaneAttachmentInput[];
  writable?: boolean;
}

// M4.6: every field is independently optional. Omitting a field means
// "leave the existing value unchanged"; the bridge enforces this via
// JSON key presence.
export interface LaneUpdateInput {
  name?: string;
  kind?: LaneKind;
  root?: string;
  /** M2.5: toggle AI write access for this lane's root directory. */
  writable?: boolean;
}

// M4.6: `casefile:updateLane` may surface a non-blocking "another lane
// already references this directory" warning alongside the new
// snapshot. The renderer is responsible for displaying it.
export interface UpdateLaneResult {
  casefile: CasefileSnapshot;
  rootConflict: { conflictingLaneId: string } | null;
}

export interface ContextResolvedFileDto {
  path: string;
  absolutePath: string;
  sizeBytes: number;
}

export interface ContextManifestDto {
  files: string[];
  autoIncludeMaxBytes: number;
  resolved: ContextResolvedFileDto[];
}

export interface ScopedDirectoryDto {
  path: string;
  label: string;
  writable: boolean;
}

export interface ScopeDto {
  laneId: string;
  writeRoot: string;
  casefileRoot: string;
  directories: ScopedDirectoryDto[];
  contextFiles: ContextResolvedFileDto[];
  autoIncludeMaxBytes: number;
}

export interface OverlayTreeDto {
  prefix: string;
  label: string;
  root: string;
  tree: FileTreeNode | null;
  error?: string;
}

export interface ChangedFileDto {
  path: string;
  leftSha256: string;
  rightSha256: string;
  leftSize: number;
  rightSize: number;
}

export interface LaneComparisonDto {
  leftLaneId: string;
  rightLaneId: string;
  added: string[];
  removed: string[];
  changed: ChangedFileDto[];
}

export interface ComparisonLaneSummary {
  id: string;
  name: string;
  root: string;
}

export interface ComparisonSession {
  id: string;
  /** Stable UUID for this canonical comparison chat session. */
  sessionId: string;
  laneIds: string[];
  lanes: ComparisonLaneSummary[];
  attachments: LaneAttachmentDto[];
  messages: ChatMessage[];
  pendingApprovals?: ToolCall[];
  skippedCorruptLines?: number;
}

export interface ComparisonChatSendPayload {
  laneIds: string[];
  provider: Provider;
  model?: string | null;
  messages: ChatMessage[];
  userMessage: string;
  allowWriteTools?: boolean;
  resumePendingToolCalls?: boolean;
}

export interface ComparisonChatSendResponse {
  ok?: boolean;
  message?: ChatMessage;
  messages?: ChatMessage[];
  pendingApprovals?: ToolCall[];
  comparison?: Omit<ComparisonSession, "messages">;
  persistenceError?: string;
  error?: string;
}

// M4.3: external local-directory inboxes (read-only, casefile-scoped).

export interface InboxSourceDto {
  id: string;
  name: string;
  root: string;
}

export interface InboxItemDto {
  sourceId: string;
  path: string;
  sizeBytes: number;
}

export interface InboxItemContent {
  content: string;
  truncated: boolean;
  absolutePath: string;
}

export interface InboxSourceInput {
  name: string;
  root: string;
  sourceId?: string;
}

export interface InboxSourceUpdate {
  name?: string;
  root?: string;
}

// M4.1: prompt drafts (casefile-scoped, lightweight markdown bodies).

export interface PromptSummaryDto {
  id: string;
  name: string;
  sizeBytes: number;
  updatedAt: string;
}

export interface PromptDraftDto extends PromptSummaryDto {
  body: string;
  createdAt: string;
}

export interface PromptInputDto {
  name?: string;
  body?: string;
  id?: string;
}

/** Payload for `chat:saveOutput`. The destination is an *absolute* directory
 * the user picked (typically a lane attachment, optionally any other
 * directory via the system folder dialog). The bridge writes
 * `<destinationDir>/<filename>` and refuses to overwrite. */
export interface SaveChatOutputPayload {
  destinationDir: string;
  filename: string;
  body: string;
}

export interface SaveChatOutputResult {
  path: string;
}

export interface AssistantApi {
  // Casefile + lanes
  chooseCasefile: () => Promise<CasefileSnapshot | null>;
  openCasefile: (root: string) => Promise<CasefileSnapshot>;
  closeCasefile: () => Promise<true>;
  chooseLaneRoot: () => Promise<string | null>;
  registerLane: (lane: RegisterLaneInput) => Promise<CasefileSnapshot>;
  switchLane: (laneId: string) => Promise<CasefileSnapshot>;
  listChat: (laneId: string) => Promise<ChatMessage[]>;

  // Lane-scoped filesystem (active lane).
  listWorkspace: (maxDepth?: number) => Promise<FileTreeNode>;
  readFile: (path: string, maxChars?: number) => Promise<FileReadResult>;
  saveFile: (path: string, content: string) => Promise<FileSaveResult>;
  /** Rename a single file or directory inside the active lane.
   * `newName` is a basename only (no path separators); the bridge
   * refuses to overwrite an existing entry. */
  renameFile: (
    path: string,
    newName: string
  ) => Promise<{ oldPath: string; newPath: string; renamed: boolean }>;
  /** Create a new (empty) file at `<parentDir>/<name>` inside the
   * active lane.  Refuses to clobber an existing entry. */
  createFile: (
    parentDir: string,
    name: string
  ) => Promise<{ path: string; created: boolean }>;
  /** Create a new directory at `<parentDir>/<name>` inside the active
   * lane.  Refuses to clobber an existing entry. */
  createFolder: (
    parentDir: string,
    name: string
  ) => Promise<{ path: string; created: boolean }>;
  /** Move (or rename) a file or directory inside the active lane.
   * Both paths must resolve inside the lane root; the bridge refuses
   * to overwrite an existing destination. */
  moveEntry: (
    sourcePath: string,
    destinationPath: string
  ) => Promise<{ sourcePath: string; destinationPath: string; moved: boolean }>;
  /** Move a file or directory inside the active lane to the OS trash
   * via Electron's shell.trashItem (recoverable). The lane root itself
   * cannot be trashed; lane removal is a separate flow. The bridge
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

  // Notes (M3).
  getNote: (laneId: string) => Promise<string>;
  saveNote: (laneId: string, content: string) => Promise<true>;

  // Compare + lane-scoped read (M3).
  compareLanes: (leftLaneId: string, rightLaneId: string) => Promise<LaneComparisonDto>;
  // Save a chat message body to a user-chosen directory.
  saveChatOutput: (payload: SaveChatOutputPayload) => Promise<SaveChatOutputResult>;
  readLaneFile: (
    laneId: string,
    path: string,
    maxChars?: number
  ) => Promise<FileReadResult>;

  // M3.5: hierarchical scope, attachments, context manifest, overlay reads.
  setLaneParent: (laneId: string, parentId: string | null) => Promise<CasefileSnapshot>;
  updateLaneAttachments: (
    laneId: string,
    attachments: LaneAttachmentInput[]
  ) => Promise<CasefileSnapshot>;

  // M4.6: lane CRUD (edit/remove) + casefile reset (hard/soft).
  updateLane: (
    laneId: string,
    update: LaneUpdateInput
  ) => Promise<UpdateLaneResult>;
  removeLane: (laneId: string) => Promise<CasefileSnapshot>;
  hardResetCasefile: () => Promise<CasefileSnapshot>;
  softResetCasefile: (keepPrompts: boolean) => Promise<CasefileSnapshot>;
  getContext: () => Promise<ContextManifestDto>;
  saveContext: (manifest: { files: string[]; autoIncludeMaxBytes: number }) =>
    Promise<ContextManifestDto>;
  resolveScope: (laneId: string) => Promise<ScopeDto>;
  listOverlayTrees: (laneId: string, maxDepth?: number) => Promise<OverlayTreeDto[]>;
  readOverlayFile: (
    laneId: string,
    path: string,
    maxChars?: number
  ) => Promise<FileReadResult>;

  // M4.1: prompt drafts (casefile-scoped).
  listPrompts: () => Promise<PromptSummaryDto[]>;
  getPrompt: (promptId: string) => Promise<PromptDraftDto>;
  createPrompt: (prompt: PromptInputDto) => Promise<PromptDraftDto>;
  savePrompt: (promptId: string, prompt: PromptInputDto) => Promise<PromptDraftDto>;
  deletePrompt: (promptId: string) => Promise<true>;

  // M4.3: inbox sources + item access (read-only).
  listInboxSources: () => Promise<InboxSourceDto[]>;
  addInboxSource: (input: InboxSourceInput) => Promise<InboxSourceDto>;
  updateInboxSource: (
    sourceId: string,
    update: InboxSourceUpdate
  ) => Promise<InboxSourceDto>;
  removeInboxSource: (sourceId: string) => Promise<true>;
  listInboxItems: (sourceId: string, maxDepth?: number) => Promise<InboxItemDto[]>;
  readInboxItem: (
    sourceId: string,
    path: string,
    maxChars?: number
  ) => Promise<InboxItemContent>;
  chooseInboxRoot: () => Promise<string | null>;

  // Chat
  sendChat: (payload: ChatSendPayload) => Promise<ChatSendResponse>;

  // M3.5c: comparison-chat sessions (multi-lane scoped chat).
  openComparison: (laneIds: string[]) => Promise<ComparisonSession>;
  updateComparisonAttachments: (
    laneIds: string[],
    attachments: LaneAttachmentInput[]
  ) => Promise<Omit<ComparisonSession, "messages">>;
  sendComparisonChat: (
    payload: ComparisonChatSendPayload
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
  /** Subscribe to "toggle integrated terminal" events from the main
   * process menu (View → Toggle Integrated Terminal, accelerator
   * `CmdOrCtrl+\``). Returns an unsubscribe function. */
  onToggleTerminal: (handler: () => void) => () => void;

  /** Menu-bar → renderer: Lane management triggers. Each returns an
   * unsubscribe function for use in useEffect teardowns. */
  onOpenCasefile: (handler: () => void) => () => void;
  onCloseCasefile: (handler: () => void) => () => void;
  onLaneCreate: (handler: () => void) => () => void;
  onLaneAttach: (handler: () => void) => () => void;
  onLaneRename: (handler: () => void) => () => void;
  onLaneToggleAccess: (handler: () => void) => () => void;
  onLaneRemove: (handler: () => void) => () => void;
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
   * lane id) and consumes streaming output via `onTerminalData`. */
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

export interface TerminalSpawnOptions {
  id: string;
  cwd?: string | null;
  cols?: number;
  rows?: number;
  laneId?: string | null;
}

export interface TerminalSpawnResult {
  id: string;
  cwd: string;
  shell: string;
  pid: number;
}

export interface TerminalSessionDescriptor {
  id: string;
  cwd: string;
  shell: string;
  laneId: string | null;
  pid: number;
}

declare global {
  interface Window {
    assistantApi: AssistantApi;
  }
}
