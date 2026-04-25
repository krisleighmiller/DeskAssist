import type {
  ApiKeyStatus,
  CasefileSnapshot,
  ChatMessage,
  ComparisonSession,
  LaneAttachmentInput,
  Lane,
  Provider,
  ToolCall,
} from "../types";
import { ChatTab, type ChatSessionId } from "./ChatTab";

interface RightPanelProps {
  onCollapse?: () => void;
  chat: {
    casefile: CasefileSnapshot | null;
    comparisonSessions: ComparisonSession[];
    activeSessionId: ChatSessionId | null;
    onSelectSession: (id: ChatSessionId) => void;
    onCloseCompareSession: (comparisonId: string) => void;
    laneChat: {
      provider: Provider;
      keyStatus: ApiKeyStatus;
      activeModel: string;
      modelIsDefault: boolean;
      messages: ChatMessage[];
      pendingApprovals: ToolCall[];
      busy: boolean;
      hasActiveLane: boolean;
      activeLane: Lane | null;
      onSend: (text: string) => void;
      onApproveTools: () => void;
      onDenyTools: () => void;
      /** M2.5: Toggle AI write access for the active lane. */
      onSetLaneWritable?: (writable: boolean) => void;
      /** M3: Add another directory to the active lane's AI scope. */
      onAddAttachment?: (root: string, name: string) => Promise<void> | void;
      /** M2.5: Remove an attachment from the active lane by its label. */
      onRemoveAttachment?: (attName: string) => void;
      /** M2.5: Change an attachment's AI access mode. */
      onSetAttachmentMode?: (attName: string, mode: "read" | "write") => void;
    };
    compareChat: {
      provider: Provider;
      keyStatus: ApiKeyStatus;
      activeModel: string;
      modelIsDefault: boolean;
      session: ComparisonSession | null;
      busy: boolean;
      onSend: (text: string) => void;
      onApproveTools: () => void;
      onDenyTools: () => void;
      onSetLaneWritable?: (laneId: string, writable: boolean) => void;
      onSetAttachmentMode?: (laneId: string, attName: string, mode: "read" | "write") => void;
      onUpdateAttachments?: (
        laneIds: string[],
        attachments: LaneAttachmentInput[]
      ) => Promise<void>;
    };
    onAfterSaveOutput?: (path: string) => void;
  };
}

export function RightPanel({
  onCollapse,
  chat,
}: RightPanelProps): JSX.Element {
  return (
    <div className="right-panel">
      {onCollapse && (
        <div className="right-tabs">
          <div className="right-tabs-list" />
          <button
            type="button"
            className="right-tab-action"
            onClick={onCollapse}
            aria-label="Hide side panel"
            title="Hide side panel"
          >
            Hide
          </button>
        </div>
      )}
      <div className="right-body">
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
      </div>
    </div>
  );
}
