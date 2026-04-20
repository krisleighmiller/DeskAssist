import type {
  ApiKeyStatus,
  CasefileSnapshot,
  ChatMessage,
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
    onChange: (value: string) => void;
  };
  lanes: {
    casefile: CasefileSnapshot | null;
    onSwitchLane: (laneId: string) => void;
    onRegisterLane: (lane: RegisterLaneInput) => Promise<void>;
    onChooseLaneRoot: () => Promise<string | null>;
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
        {activeTab === "notes" && <NotesTab value={notes.value} onChange={notes.onChange} />}
        {activeTab === "findings" && <FindingsTab />}
        {activeTab === "lanes" && (
          <LanesTab
            casefile={lanes.casefile}
            onSwitchLane={lanes.onSwitchLane}
            onRegisterLane={lanes.onRegisterLane}
            onChooseLaneRoot={lanes.onChooseLaneRoot}
          />
        )}
      </div>
    </>
  );
}
