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

export interface Lane {
  id: string;
  name: string;
  kind: LaneKind;
  root: string;
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

export interface AssistantApi {
  // Casefile + lanes
  chooseCasefile: () => Promise<CasefileSnapshot | null>;
  openCasefile: (root: string) => Promise<CasefileSnapshot>;
  chooseLaneRoot: () => Promise<string | null>;
  registerLane: (lane: RegisterLaneInput) => Promise<CasefileSnapshot>;
  switchLane: (laneId: string) => Promise<CasefileSnapshot>;
  listChat: (laneId: string) => Promise<ChatMessage[]>;

  // Lane-scoped filesystem
  listWorkspace: (maxDepth?: number) => Promise<FileTreeNode>;
  readFile: (path: string, maxChars?: number) => Promise<FileReadResult>;
  saveFile: (path: string, content: string) => Promise<FileSaveResult>;

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
