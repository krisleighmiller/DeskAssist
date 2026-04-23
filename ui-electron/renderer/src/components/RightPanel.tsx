import type {
  ApiKeyStatus,
  CasefileSnapshot,
  ChatMessage,
  ComparisonSession,
  Lane,
  Provider,
  ToolCall,
} from "../types";
import { ChatTab, type ChatSessionId } from "./ChatTab";

/** M2.5: the right panel now has only one surface — the chat view.
 * `RightTabKey` is kept as a single-value union so existing call sites
 * that pass `activeTab`/`onTabChange` still type-check without requiring
 * a cascade of refactors.  The tab bar itself is gone; the collapse button
 * is the only control that remains in the panel header. */
export type RightTabKey = "chat";

interface RightPanelProps {
  /** Always "chat"; kept for backward-compat with AppShell/WorkbenchShell. */
  activeTab: RightTabKey;
  onTabChange: (tab: RightTabKey) => void;
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
      /** M2.5: Toggle AI write access for the active lane. */
      onSetLaneWritable?: (writable: boolean) => void;
      /** M2.5: Remove an attachment from the active lane by its label. */
      onRemoveAttachment?: (attName: string) => void;
      /** M2.5: Change an attachment's AI access mode. */
      onSetAttachmentMode?: (attName: string, mode: "read" | "write") => void;
    };
    compareChat: {
      provider: Provider;
      keyStatus: ApiKeyStatus;
      session: ComparisonSession | null;
      busy: boolean;
      onSend: (text: string) => void;
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
