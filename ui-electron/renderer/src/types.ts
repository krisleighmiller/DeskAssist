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

export interface RegisterLaneInput {
  name: string;
  kind: LaneKind;
  root: string;
  id?: string;
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

  // Chat
  sendChat: (payload: ChatSendPayload) => Promise<ChatSendResponse>;

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
