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

export type AttachmentMode = "read";

export interface LaneAttachmentDto {
  name: string;
  root: string;
  mode: AttachmentMode;
}

export interface Lane {
  id: string;
  name: string;
  kind: LaneKind;
  root: string;
  /** M3.5: parent lane id; null/undefined means top-level. */
  parentId?: string | null;
  /** M3.5: read-only sibling directories travelling with this lane. */
  attachments?: LaneAttachmentDto[];
}

export interface CasefileSnapshot {
  root: string;
  lanes: Lane[];
  activeLaneId: string | null;
}

export interface LaneAttachmentInput {
  name: string;
  root: string;
}

export interface RegisterLaneInput {
  name: string;
  kind: LaneKind;
  root: string;
  id?: string;
  parentId?: string | null;
  attachments?: LaneAttachmentInput[];
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

export interface ReadOverlayDto {
  prefix: string;
  root: string;
  label: string;
}

export interface ScopeDto {
  laneId: string;
  writeRoot: string;
  casefileRoot: string;
  readOverlays: ReadOverlayDto[];
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

export type Severity = "info" | "low" | "medium" | "high" | "critical";

export const SEVERITIES: readonly Severity[] = ["info", "low", "medium", "high", "critical"];

export interface SourceRefDto {
  laneId: string;
  path: string;
  lineStart: number | null;
  lineEnd: number | null;
}

export interface FindingDto {
  id: string;
  title: string;
  body: string;
  severity: Severity;
  createdAt: string;
  updatedAt: string;
  laneIds: string[];
  sourceRefs: SourceRefDto[];
}

export interface FindingDraft {
  title: string;
  body: string;
  severity: Severity;
  laneIds: string[];
  sourceRefs?: { laneId: string; path: string; lineStart?: number; lineEnd?: number }[];
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
  laneIds: string[];
  lanes: ComparisonLaneSummary[];
  messages: ChatMessage[];
  skippedCorruptLines?: number;
}

export interface ComparisonChatSendPayload {
  laneIds: string[];
  provider: Provider;
  model?: string | null;
  messages: ChatMessage[];
  userMessage: string;
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

// M4.2: command runs (user-initiated, persisted under .casefile/runs).

export interface RunSummaryDto {
  id: string;
  command: string;
  laneId: string | null;
  startedAt: string;
  exitCode: number | null;
  error: string | null;
}

export interface RunRecordDto extends RunSummaryDto {
  cwd: string;
  finishedAt: string;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timeoutSeconds: number;
  maxOutputChars: number;
}

export interface RunCommandPayload {
  commandLine: string;
  laneId?: string | null;
  timeoutSeconds?: number;
  maxOutputChars?: number;
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

export interface ExportResult {
  path: string;
  markdown: string;
}

export interface AssistantApi {
  // Casefile + lanes
  chooseCasefile: () => Promise<CasefileSnapshot | null>;
  openCasefile: (root: string) => Promise<CasefileSnapshot>;
  chooseLaneRoot: () => Promise<string | null>;
  registerLane: (lane: RegisterLaneInput) => Promise<CasefileSnapshot>;
  switchLane: (laneId: string) => Promise<CasefileSnapshot>;
  listChat: (laneId: string) => Promise<ChatMessage[]>;

  // Lane-scoped filesystem (active lane).
  listWorkspace: (maxDepth?: number) => Promise<FileTreeNode>;
  readFile: (path: string, maxChars?: number) => Promise<FileReadResult>;
  saveFile: (path: string, content: string) => Promise<FileSaveResult>;

  // Findings (M3).
  listFindings: (laneId?: string) => Promise<FindingDto[]>;
  getFinding: (findingId: string) => Promise<FindingDto>;
  createFinding: (finding: FindingDraft) => Promise<FindingDto>;
  updateFinding: (findingId: string, finding: Partial<FindingDraft>) => Promise<FindingDto>;
  deleteFinding: (findingId: string) => Promise<true>;

  // Notes (M3).
  getNote: (laneId: string) => Promise<string>;
  saveNote: (laneId: string, content: string) => Promise<true>;

  // Compare + export + lane-scoped read (M3).
  compareLanes: (leftLaneId: string, rightLaneId: string) => Promise<LaneComparisonDto>;
  exportFindings: (laneIds: string[]) => Promise<ExportResult>;
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

  // M4.2: command runs (casefile-scoped, optionally lane-scoped).
  listRuns: (laneId?: string | null) => Promise<RunSummaryDto[]>;
  getRun: (runId: string) => Promise<RunRecordDto>;
  runCommand: (payload: RunCommandPayload) => Promise<RunRecordDto>;
  deleteRun: (runId: string) => Promise<true>;

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

  // M3.5c: comparison-chat sessions (multi-lane, read-only).
  openComparison: (laneIds: string[]) => Promise<ComparisonSession>;
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
  onOpenApiKeys: (handler: () => void) => () => void;
}

declare global {
  interface Window {
    assistantApi: AssistantApi;
  }
}
