import type {
  ApiKeyStatus,
  CasefileSnapshot,
  ChatMessage,
  ComparisonSession,
  ContextManifestDto,
  InboxItemContent,
  InboxItemDto,
  InboxSourceDto,
  InboxSourceInput,
  Lane,
  LaneAttachmentInput,
  LaneUpdateInput,
  UpdateLaneResult,
  LaneComparisonDto,
  PromptDraftDto,
  PromptInputDto,
  PromptSummaryDto,
  Provider,
  RegisterLaneInput,
  ToolCall,
} from "../types";
import { ChatTab, type ChatSessionId } from "./ChatTab";
import { NotesTab } from "./NotesTab";
import { LanesTab } from "./LanesTab";
import { InboxTab } from "./InboxTab";
import { PromptsTab } from "./PromptsTab";

export type RightTabKey =
  | "chat"
  | "notes"
  | "lanes"
  | "prompts"
  | "inbox";

interface RightPanelProps {
  activeTab: RightTabKey;
  onTabChange: (tab: RightTabKey) => void;
  chat: {
    casefile: CasefileSnapshot | null;
    comparisonSessions: ComparisonSession[];
    activeSessionId: ChatSessionId | null;
    onSelectSession: (id: ChatSessionId) => void;
    onCloseCompareSession: (comparisonId: string) => void;
    laneChat: {
      provider: Provider;
      keyStatus: ApiKeyStatus;
      messages: ChatMessage[];
      pendingApprovals: ToolCall[];
      busy: boolean;
      hasActiveLane: boolean;
      activeLane: Lane | null;
      activePromptName: string | null;
      onClearActivePrompt: () => void;
      onSend: (text: string) => void;
      onApproveTools: () => void;
      onDenyTools: () => void;
    };
    compareChat: {
      provider: Provider;
      keyStatus: ApiKeyStatus;
      session: ComparisonSession | null;
      busy: boolean;
      onSend: (text: string) => void;
    };
    /** Optional: parent is told when SaveOutputPicker writes a chat
     * message to disk so it can refresh the file tree. */
    onAfterSaveOutput?: (path: string) => void;
  };
  notes: {
    value: string;
    hasActiveLane: boolean;
    loading: boolean;
    saving: boolean;
    error: string | null;
    onChange: (value: string) => void;
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
    // M4.6: lane CRUD + casefile reset.
    onUpdateLane: (
      laneId: string,
      update: LaneUpdateInput
    ) => Promise<UpdateLaneResult>;
    onRemoveLane: (laneId: string) => Promise<void>;
    onHardResetCasefile: () => Promise<void>;
    onSoftResetCasefile: (keepPrompts: boolean) => Promise<void>;
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
  inbox: {
    hasCasefile: boolean;
    sources: InboxSourceDto[];
    loading: boolean;
    error: string | null;
    onAddSource: (input: InboxSourceInput) => Promise<InboxSourceDto>;
    onRemoveSource: (sourceId: string) => Promise<void>;
    onChooseRoot: () => Promise<string | null>;
    onListItems: (sourceId: string) => Promise<InboxItemDto[]>;
    onReadItem: (sourceId: string, path: string) => Promise<InboxItemContent>;
  };
}

const TABS: { key: RightTabKey; label: string }[] = [
  { key: "chat", label: "Chat" },
  { key: "notes", label: "Notes" },
  { key: "lanes", label: "Lanes" },
  { key: "prompts", label: "Prompts" },
  { key: "inbox", label: "Inbox" },
];

export function RightPanel({
  activeTab,
  onTabChange,
  chat,
  notes,
  lanes,
  prompts,
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
            casefile={chat.casefile}
            comparisonSessions={chat.comparisonSessions}
            activeSessionId={chat.activeSessionId}
            onSelectSession={chat.onSelectSession}
            onCloseCompareSession={chat.onCloseCompareSession}
            laneChat={chat.laneChat}
            compareChat={chat.compareChat}
            onAfterSaveOutput={chat.onAfterSaveOutput}
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
            onUpdateLane={lanes.onUpdateLane}
            onRemoveLane={lanes.onRemoveLane}
            onHardResetCasefile={lanes.onHardResetCasefile}
            onSoftResetCasefile={lanes.onSoftResetCasefile}
          />
        )}
        {activeTab === "inbox" && (
          <InboxTab
            hasCasefile={inbox.hasCasefile}
            sources={inbox.sources}
            loading={inbox.loading}
            error={inbox.error}
            onAddSource={inbox.onAddSource}
            onRemoveSource={inbox.onRemoveSource}
            onChooseRoot={inbox.onChooseRoot}
            onListItems={inbox.onListItems}
            onReadItem={inbox.onReadItem}
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
