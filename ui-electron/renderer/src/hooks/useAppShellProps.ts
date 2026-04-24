import {
  compareSessionId,
  laneSessionId,
  parseChatSessionId,
  type ChatSessionId,
} from "../components/ChatTab";
import type { AppShellProps } from "../components/AppShell";
import type { OpenTab } from "../components/EditorPane";
import type { RightTabKey } from "../components/RightPanel";
import type { TerminalLaneContext } from "./useTerminalManager";
import type {
  ApiKeyStatus,
  CasefileSnapshot,
  ChatMessage,
  ComparisonSession,
  FileTreeNode,
  Lane,
  LaneAttachmentInput,
  LaneUpdateInput,
  Provider,
  ProviderModels,
  RegisterLaneInput,
  ToolCall,
  UpdateLaneResult,
} from "../types";

interface ShellViewModelState {
  casefile: CasefileSnapshot | null;
  activeLane: Lane | null;
  activeLaneId: string | null;
  activeFilePath: string | null;
  provider: Provider;
  keyStatus: ApiKeyStatus;
  providerModels: ProviderModels;
  tree: FileTreeNode | null;
  treeError: string | null;
  comparisonSessions: ComparisonSession[];
  focusedComparisonSession: ComparisonSession | null;
  sessionTabs: OpenTab[];
  sessionActiveTabKey: string | null;
  sessionMessages: ChatMessage[];
  sessionPendingApprovals: ToolCall[];
  chatBusy: boolean;
  activePromptName: string | null;
  comparisonChatBusy: boolean;
  activeRightTab: RightTabKey;
}

interface ShellViewModelActions {
  onProviderChange: (provider: Provider) => void;
  onChooseCasefile: () => void;
  onCloseCasefile: () => void;
  onSwitchLane: (laneId: string) => void | Promise<void>;
  onStatusChange: (status: ApiKeyStatus) => void;
  onModelsChange: (models: ProviderModels) => void;
  onOpenFile: (path: string) => void | Promise<void>;
  onAddToContext?: (path: string) => void;
  onRename?: (sourcePath: string, nextPath: string) => Promise<void>;
  onRefreshTree?: () => void;
  onDismissTreeError: () => void;
  onCreateFile?: (parentDir: string, name: string) => Promise<void>;
  onCreateFolder?: (parentDir: string, name: string) => Promise<void>;
  onMoveEntry?: (sourcePath: string, destinationPath: string) => Promise<void>;
  onTrashEntry?: (path: string) => Promise<void>;
  onCreateLaneFromPath?: (path: string, name: string) => Promise<void>;
  onAttachToLane?: (path: string, laneId: string, name: string) => Promise<void>;
  onActiveRightTabChange: (tab: RightTabKey) => void;
  onSelectTab: (key: string) => void;
  onCloseTab: (key: string) => void;
  onEditTab: (key: string, content: string) => void;
  onSaveTab: (key: string) => void;
  onSelectComparisonSession: (comparisonId: string) => void;
  onCloseComparisonChat: (comparisonId: string) => void;
  onClearActivePrompt: () => void;
  onSendMessage: (text: string) => void;
  onApproveTools: () => void;
  onDenyTools: () => void;
  onSendComparisonChat: (text: string) => void;
  onApproveComparisonTools: () => void;
  onDenyComparisonTools: () => void;
  onRegisterLane: (input: RegisterLaneInput) => Promise<void>;
  onChooseLaneRoot: () => Promise<string | null>;
  onCompareLanes: (leftLaneId: string, rightLaneId: string) => Promise<void>;
  onClearComparison: () => void;
  onOpenDiff: (path: string) => void;
  onOpenLaneFile: (laneId: string, path: string) => void;
  onOpenComparisonChat: (laneIds: string[]) => Promise<void>;
  onSaveContext: (manifest: { files: string[]; autoIncludeMaxBytes: number }) => Promise<void>;
  onSetLaneParent: (laneId: string, parentId: string | null) => Promise<void>;
  onUpdateLaneAttachments: (
    laneId: string,
    attachments: LaneAttachmentInput[]
  ) => Promise<void>;
  onUpdateComparisonAttachments: (
    laneIds: string[],
    attachments: LaneAttachmentInput[]
  ) => Promise<void>;
  onUpdateLane: (laneId: string, update: LaneUpdateInput) => Promise<UpdateLaneResult>;
  onRemoveLane: (laneId: string) => Promise<void>;
  onHardResetCasefile: () => Promise<void>;
  onSoftResetCasefile: (keepPrompts: boolean) => Promise<void>;
  onSelectPromptForChat: (promptId: string | null) => void;
  /** Called when the user renames a lane via the file tree context menu. */
  onUpdateLaneName?: (laneId: string, newName: string) => Promise<void>;
  /** M2.5: toggle AI write access for a lane. */
  onSetLaneWritable?: (laneId: string, writable: boolean) => Promise<void>;
  /** M2.5: remove an attachment from the active lane by its label name. */
  onRemoveAttachment?: (laneId: string, attName: string) => Promise<void>;
  /** M2.5: change an attachment's AI access mode. */
  onSetAttachmentMode?: (laneId: string, attName: string, mode: "read" | "write") => Promise<void>;
}

interface UseAppShellPropsArgs {
  state: ShellViewModelState;
  actions: ShellViewModelActions;
}

/**
 * Build the AppShell prop bundle.
 *
 * Note: this used to be wrapped in `useMemo([actions, state])` but
 * both `actions` and `state` are fresh objects every render of `App`,
 * so the memo never hit. Removed to avoid the false impression of
 * memoization. (Review item #14.)
 */
export function useAppShellProps({
  state,
  actions,
}: UseAppShellPropsArgs): AppShellProps {
  const onSelectSession = (id: ChatSessionId) => {
    const parsed = parseChatSessionId(id);
    if (!parsed) return;
    if (parsed.kind === "compare") actions.onSelectComparisonSession(parsed.id);
    else void actions.onSwitchLane(parsed.id);
  };

  // Build a structural TerminalLaneContext rather than casting the
  // full Lane shape. If `Lane` ever drops one of these fields we'll
  // get a real type error instead of a silent runtime undefined.
  // (Review item #30.)
  const terminalLane: TerminalLaneContext | null = state.activeLane
    ? {
        id: state.activeLane.id,
        name: state.activeLane.name,
        root: state.activeLane.root,
      }
    : null;

  return {
    toolbar: {
      casefile: state.casefile,
      provider: state.provider,
      onProviderChange: actions.onProviderChange,
      keyStatus: state.keyStatus,
      providerModels: state.providerModels,
      onChooseCasefile: actions.onChooseCasefile,
      onCloseCasefile: state.casefile ? actions.onCloseCasefile : undefined,
      onSwitchLane: actions.onSwitchLane,
      onUpdateLaneName: state.casefile ? actions.onUpdateLaneName : undefined,
      onRemoveLane: state.casefile ? actions.onRemoveLane : undefined,
      onSetLaneWritable: state.casefile ? actions.onSetLaneWritable : undefined,
      onSoftResetCasefile: state.casefile
        ? () => actions.onSoftResetCasefile(false)
        : undefined,
      onHardResetCasefile: state.casefile ? actions.onHardResetCasefile : undefined,
    },
    workbench: {
      workspaceTitle: state.activeLane ? state.activeLane.name : "Workspace",
      fileTree: {
        root: state.tree,
        activePath: state.activeFilePath,
        onOpenFile: actions.onOpenFile,
        error: state.treeError,
        onDismissError: actions.onDismissTreeError,
        // The file tree is the user's view of the casefile. Lanes
        // exist to scope what the chat agent sees — they are NOT a
        // gate on the user's ability to browse, open, or edit files.
        // (Cursor-style file tree behaviour: any file in the casefile
        // is fair game; the active lane only changes highlighting.)
        // So everything here keys off `state.casefile`. The one
        // exception is `onAttachToActiveLane`, which by definition
        // requires an active lane.
        hasWorkspace: Boolean(state.casefile),
        casefileRoot: state.casefile?.root ?? null,
        onAddToContext: state.casefile ? actions.onAddToContext : undefined,
        onRename: state.casefile ? actions.onRename : undefined,
        onRefresh: state.casefile ? actions.onRefreshTree : undefined,
        // Active lane drives highlighting / lane-scoped menu items
        // only — file ops below are casefile-wide.
        activeLaneRoot: state.activeLane?.root ?? null,
        // Roots beyond the lane's own write root that should still be
        // tinted as "in the active lane" — currently the lane's
        // read-only attachment roots. Empty when the lane has no
        // attachments or there's no active lane. The FileTree treats
        // this list together with `activeLaneRoot` for its colour cue.
        activeLaneScopeRoots: state.activeLane?.attachments
          ? state.activeLane.attachments
              .map((att) => att.root)
              .filter((root): root is string => Boolean(root))
          : undefined,
        activeLaneId: state.activeLaneId,
        lanes: state.casefile
          ? state.casefile.lanes.map((lane) => ({
              id: lane.id,
              name: lane.name,
              root: lane.root,
              writable: lane.writable,
            }))
          : undefined,
        onCreateFile: state.casefile ? actions.onCreateFile : undefined,
        onCreateFolder: state.casefile ? actions.onCreateFolder : undefined,
        onMoveEntry: state.casefile ? actions.onMoveEntry : undefined,
        onTrashEntry: state.casefile ? actions.onTrashEntry : undefined,
        onCreateLaneFromPath: state.casefile
          ? actions.onCreateLaneFromPath
          : undefined,
        onAttachToLane: state.casefile && (state.casefile.lanes.length > 0)
          ? actions.onAttachToLane
          : undefined,
        onOpenComparisonChat:
          state.casefile && state.casefile.lanes.length >= 2
            ? actions.onOpenComparisonChat
            : undefined,
        onSwitchLane: state.casefile ? actions.onSwitchLane : undefined,
        onUpdateLaneName: state.casefile ? actions.onUpdateLaneName : undefined,
        onRemoveLane: state.casefile ? actions.onRemoveLane : undefined,
        onSetLaneWritable: state.casefile ? actions.onSetLaneWritable : undefined,
        onSoftResetCasefile: state.casefile
          ? () => actions.onSoftResetCasefile(false)
          : undefined,
        onHardResetCasefile: state.casefile ? actions.onHardResetCasefile : undefined,
      },
      editor: {
        tabs: state.sessionTabs,
        activeKey: state.sessionActiveTabKey,
        onSelectTab: actions.onSelectTab,
        onCloseTab: actions.onCloseTab,
        onEdit: actions.onEditTab,
        onSave: actions.onSaveTab,
      },
      rightPanel: {
        chat: {
          casefile: state.casefile,
          comparisonSessions: state.comparisonSessions,
          activeSessionId: state.focusedComparisonSession
            ? compareSessionId(state.focusedComparisonSession.id)
            : state.activeLaneId
              ? laneSessionId(state.activeLaneId)
              : null,
          onSelectSession,
          onCloseCompareSession: actions.onCloseComparisonChat,
          laneChat: {
            provider: state.provider,
            keyStatus: state.keyStatus,
            messages: state.sessionMessages,
            pendingApprovals: state.sessionPendingApprovals,
            busy: state.chatBusy,
            hasActiveLane: Boolean(state.activeLane),
            activeLane: state.activeLane,
            activePromptName: state.activePromptName,
            onClearActivePrompt: actions.onClearActivePrompt,
            onSend: actions.onSendMessage,
            onApproveTools: actions.onApproveTools,
            onDenyTools: actions.onDenyTools,
            onSetLaneWritable: state.activeLane && actions.onSetLaneWritable
              ? (writable: boolean) => {
                  void actions.onSetLaneWritable!(state.activeLane!.id, writable);
                }
              : undefined,
            onRemoveAttachment: state.activeLane && actions.onRemoveAttachment
              ? (attName: string) => {
                  void actions.onRemoveAttachment!(state.activeLane!.id, attName);
                }
              : undefined,
            onSetAttachmentMode: state.activeLane && actions.onSetAttachmentMode
              ? (attName: string, mode: "read" | "write") => {
                  void actions.onSetAttachmentMode!(state.activeLane!.id, attName, mode);
                }
              : undefined,
          },
          compareChat: {
            provider: state.provider,
            keyStatus: state.keyStatus,
            session: state.focusedComparisonSession,
            busy: state.comparisonChatBusy,
            onSend: actions.onSendComparisonChat,
            onApproveTools: actions.onApproveComparisonTools,
            onDenyTools: actions.onDenyComparisonTools,
            onSetLaneWritable: actions.onSetLaneWritable,
            onSetAttachmentMode: actions.onSetAttachmentMode,
            onUpdateAttachments: actions.onUpdateComparisonAttachments,
          },
          // SaveOutputPicker writes the chat message into a lane
          // attachment / arbitrary directory, but the bridge call
          // bypasses our normal save-tab flow so the file tree
          // wouldn't otherwise re-list. Fire a refresh so the new
          // file appears immediately in the workspace pane.
          onAfterSaveOutput: actions.onRefreshTree,
        },
      },
    },
    apiKeysDialog: {
      status: state.keyStatus,
      onStatusChange: actions.onStatusChange,
      models: state.providerModels,
      onModelsChange: actions.onModelsChange,
    },
    activeLane: terminalLane,
    casefileRoot: state.casefile?.root ?? null,
    activeRightTab: state.activeRightTab,
    onActiveRightTabChange: actions.onActiveRightTabChange,
  };
}
