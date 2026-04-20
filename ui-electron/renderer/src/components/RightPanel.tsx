import type {
  ApiKeyStatus,
  CasefileSnapshot,
  ChatMessage,
  ComparisonSession,
  ContextManifestDto,
  ExportResult,
  FindingDraft,
  FindingDto,
  InboxItemContent,
  InboxItemDto,
  InboxSourceDto,
  InboxSourceInput,
  Lane,
  LaneAttachmentInput,
  LaneComparisonDto,
  PromptDraftDto,
  PromptInputDto,
  PromptSummaryDto,
  Provider,
  RegisterLaneInput,
  RunCommandPayload,
  RunRecordDto,
  RunSummaryDto,
  ToolCall,
} from "../types";
import { ChatTab } from "./ChatTab";
import { NotesTab } from "./NotesTab";
import { FindingsTab } from "./FindingsTab";
import { LanesTab } from "./LanesTab";
import { ComparisonChatTab } from "./ComparisonChatTab";
import { InboxTab } from "./InboxTab";
import { PromptsTab } from "./PromptsTab";
import { RunsTab, RUNS_ALLOWED_EXECUTABLES } from "./RunsTab";

export type RightTabKey =
  | "chat"
  | "notes"
  | "findings"
  | "lanes"
  | "compare"
  | "prompts"
  | "runs"
  | "inbox";

interface RightPanelProps {
  activeTab: RightTabKey;
  onTabChange: (tab: RightTabKey) => void;
  chat: {
    provider: Provider;
    keyStatus: ApiKeyStatus;
    messages: ChatMessage[];
    pendingApprovals: ToolCall[];
    busy: boolean;
    hasActiveLane: boolean;
    activePromptName: string | null;
    onClearActivePrompt: () => void;
    onSend: (text: string) => void;
    onApproveTools: () => void;
    onDenyTools: () => void;
  };
  notes: {
    value: string;
    hasActiveLane: boolean;
    loading: boolean;
    saving: boolean;
    error: string | null;
    onChange: (value: string) => void;
  };
  findings: {
    casefile: CasefileSnapshot | null;
    findings: FindingDto[];
    busy: boolean;
    lastExport: ExportResult | null;
    onCreate: (draft: FindingDraft) => Promise<void>;
    onUpdate: (id: string, draft: Partial<FindingDraft>) => Promise<void>;
    onDelete: (id: string) => Promise<void>;
    onExport: (laneIds: string[]) => Promise<void>;
  };
  lanes: {
    casefile: CasefileSnapshot | null;
    onSwitchLane: (laneId: string) => void;
    onRegisterLane: (lane: RegisterLaneInput) => Promise<void>;
    onChooseLaneRoot: () => Promise<string | null>;
    comparison: LaneComparisonDto | null;
    comparisonBusy: boolean;
    onCompare: (leftLaneId: string, rightLaneId: string) => Promise<void>;
    onClearComparison: () => void;
    onOpenDiff: (path: string) => void;
    onOpenLaneFile: (laneId: string, path: string) => void;
    onOpenComparisonChat: (laneIds: string[]) => Promise<void>;
    context: ContextManifestDto | null;
    contextBusy: boolean;
    contextError: string | null;
    onSaveContext: (manifest: { files: string[]; autoIncludeMaxBytes: number }) => Promise<void>;
    onSetLaneParent: (laneId: string, parentId: string | null) => Promise<void>;
    onUpdateLaneAttachments: (
      laneId: string,
      attachments: LaneAttachmentInput[]
    ) => Promise<void>;
  };
  compareChat: {
    provider: Provider;
    keyStatus: ApiKeyStatus;
    session: ComparisonSession | null;
    busy: boolean;
    onSend: (text: string) => void;
    onClose: () => void;
  };
  prompts: {
    hasCasefile: boolean;
    hasActiveLane: boolean;
    prompts: PromptSummaryDto[];
    loading: boolean;
    error: string | null;
    selectedPromptId: string | null;
    onSelectForChat: (promptId: string | null) => void;
    onCreate: (input: PromptInputDto) => Promise<PromptDraftDto>;
    onSave: (promptId: string, input: PromptInputDto) => Promise<PromptDraftDto>;
    onDelete: (promptId: string) => Promise<void>;
    onLoad: (promptId: string) => Promise<PromptDraftDto>;
  };
  runs: {
    hasCasefile: boolean;
    hasActiveLane: boolean;
    activeLaneId: string | null;
    lanes: Lane[];
    runs: RunSummaryDto[];
    loading: boolean;
    error: string | null;
    onRun: (payload: RunCommandPayload) => Promise<RunRecordDto>;
    onLoadRun: (runId: string) => Promise<RunRecordDto>;
    onDelete: (runId: string) => Promise<void>;
  };
  inbox: {
    hasCasefile: boolean;
    hasActiveLane: boolean;
    activeLaneId: string | null;
    activeLaneName: string | null;
    sources: InboxSourceDto[];
    loading: boolean;
    error: string | null;
    onAddSource: (input: InboxSourceInput) => Promise<InboxSourceDto>;
    onRemoveSource: (sourceId: string) => Promise<void>;
    onChooseRoot: () => Promise<string | null>;
    onListItems: (sourceId: string) => Promise<InboxItemDto[]>;
    onReadItem: (sourceId: string, path: string) => Promise<InboxItemContent>;
    onCreateFinding: (draft: FindingDraft) => Promise<void>;
  };
}

const TABS: { key: RightTabKey; label: string }[] = [
  { key: "chat", label: "Chat" },
  { key: "notes", label: "Notes" },
  { key: "findings", label: "Findings" },
  { key: "lanes", label: "Lanes" },
  { key: "compare", label: "Compare" },
  { key: "prompts", label: "Prompts" },
  { key: "runs", label: "Runs" },
  { key: "inbox", label: "Inbox" },
];

export function RightPanel({
  activeTab,
  onTabChange,
  chat,
  notes,
  findings,
  lanes,
  compareChat,
  prompts,
  runs,
  inbox,
}: RightPanelProps): JSX.Element {
  return (
    <>
      <div className="right-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`right-tab${t.key === activeTab ? " active" : ""}`}
            onClick={() => onTabChange(t.key)}
            type="button"
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="right-body">
        {activeTab === "chat" && (
          <ChatTab
            provider={chat.provider}
            keyStatus={chat.keyStatus}
            messages={chat.messages}
            pendingApprovals={chat.pendingApprovals}
            busy={chat.busy}
            hasActiveLane={chat.hasActiveLane}
            activePromptName={chat.activePromptName}
            onClearActivePrompt={chat.onClearActivePrompt}
            onSend={chat.onSend}
            onApproveTools={chat.onApproveTools}
            onDenyTools={chat.onDenyTools}
          />
        )}
        {activeTab === "notes" && (
          <NotesTab
            value={notes.value}
            hasActiveLane={notes.hasActiveLane}
            loading={notes.loading}
            saving={notes.saving}
            error={notes.error}
            onChange={notes.onChange}
          />
        )}
        {activeTab === "findings" && (
          <FindingsTab
            casefile={findings.casefile}
            findings={findings.findings}
            busy={findings.busy}
            lastExport={findings.lastExport}
            onCreate={findings.onCreate}
            onUpdate={findings.onUpdate}
            onDelete={findings.onDelete}
            onExport={findings.onExport}
          />
        )}
        {activeTab === "lanes" && (
          <LanesTab
            casefile={lanes.casefile}
            onSwitchLane={lanes.onSwitchLane}
            onRegisterLane={lanes.onRegisterLane}
            onChooseLaneRoot={lanes.onChooseLaneRoot}
            comparison={lanes.comparison}
            comparisonBusy={lanes.comparisonBusy}
            onCompare={lanes.onCompare}
            onClearComparison={lanes.onClearComparison}
            onOpenDiff={lanes.onOpenDiff}
            onOpenLaneFile={lanes.onOpenLaneFile}
            onOpenComparisonChat={lanes.onOpenComparisonChat}
            context={lanes.context}
            contextBusy={lanes.contextBusy}
            contextError={lanes.contextError}
            onSaveContext={lanes.onSaveContext}
            onSetLaneParent={lanes.onSetLaneParent}
            onUpdateLaneAttachments={lanes.onUpdateLaneAttachments}
          />
        )}
        {activeTab === "compare" && (
          <ComparisonChatTab
            provider={compareChat.provider}
            keyStatus={compareChat.keyStatus}
            session={compareChat.session}
            busy={compareChat.busy}
            onSend={compareChat.onSend}
            onClose={compareChat.onClose}
          />
        )}
        {activeTab === "runs" && (
          <RunsTab
            hasCasefile={runs.hasCasefile}
            hasActiveLane={runs.hasActiveLane}
            activeLaneId={runs.activeLaneId}
            lanes={runs.lanes}
            runs={runs.runs}
            loading={runs.loading}
            error={runs.error}
            allowedExecutables={RUNS_ALLOWED_EXECUTABLES}
            onRun={runs.onRun}
            onLoadRun={runs.onLoadRun}
            onDelete={runs.onDelete}
          />
        )}
        {activeTab === "inbox" && (
          <InboxTab
            hasCasefile={inbox.hasCasefile}
            hasActiveLane={inbox.hasActiveLane}
            activeLaneId={inbox.activeLaneId}
            activeLaneName={inbox.activeLaneName}
            sources={inbox.sources}
            loading={inbox.loading}
            error={inbox.error}
            onAddSource={inbox.onAddSource}
            onRemoveSource={inbox.onRemoveSource}
            onChooseRoot={inbox.onChooseRoot}
            onListItems={inbox.onListItems}
            onReadItem={inbox.onReadItem}
            onCreateFinding={inbox.onCreateFinding}
          />
        )}
        {activeTab === "prompts" && (
          <PromptsTab
            hasCasefile={prompts.hasCasefile}
            hasActiveLane={prompts.hasActiveLane}
            prompts={prompts.prompts}
            loading={prompts.loading}
            error={prompts.error}
            selectedPromptId={prompts.selectedPromptId}
            onSelectForChat={prompts.onSelectForChat}
            onCreate={prompts.onCreate}
            onSave={prompts.onSave}
            onDelete={prompts.onDelete}
            onLoad={prompts.onLoad}
          />
        )}
      </div>
    </>
  );
}
