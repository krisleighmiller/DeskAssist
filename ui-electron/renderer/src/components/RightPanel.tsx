import type {
  ApiKeyStatus,
  CasefileSnapshot,
  ChatMessage,
  ContextManifestDto,
  ExportResult,
  FindingDraft,
  FindingDto,
  LaneAttachmentInput,
  LaneComparisonDto,
  Provider,
  RegisterLaneInput,
  ToolCall,
} from "../types";
import { ChatTab } from "./ChatTab";
import { NotesTab } from "./NotesTab";
import { FindingsTab } from "./FindingsTab";
import { LanesTab } from "./LanesTab";

export type RightTabKey = "chat" | "notes" | "findings" | "lanes";

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
}

const TABS: { key: RightTabKey; label: string }[] = [
  { key: "chat", label: "Chat" },
  { key: "notes", label: "Notes" },
  { key: "findings", label: "Findings" },
  { key: "lanes", label: "Lanes" },
];

export function RightPanel({
  activeTab,
  onTabChange,
  chat,
  notes,
  findings,
  lanes,
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
            context={lanes.context}
            contextBusy={lanes.contextBusy}
            contextError={lanes.contextError}
            onSaveContext={lanes.onSaveContext}
            onSetLaneParent={lanes.onSetLaneParent}
            onUpdateLaneAttachments={lanes.onUpdateLaneAttachments}
          />
        )}
      </div>
    </>
  );
}
