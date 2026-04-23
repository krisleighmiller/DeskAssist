import {
  compareSessionId,
  laneSessionId,
  parseChatSessionId,
  type ChatSessionId,
} from "../components/ChatTab";
import type { AppShellProps } from "../components/AppShell";
import type { OpenTab } from "../components/EditorPane";
import type { TerminalLaneContext } from "./useTerminalManager";
import type {
  ApiKeyStatus,
  CasefileSnapshot,
  ChatMessage,
  ComparisonSession,
  ContextManifestDto,
  FileTreeNode,
  InboxItemContent,
  InboxItemDto,
  InboxSourceDto,
  InboxSourceInput,
  Lane,
  LaneAttachmentInput,
  LaneComparisonDto,
  LaneUpdateInput,
  OverlayTreeDto,
  PromptDraftDto,
  PromptInputDto,
  PromptSummaryDto,
  Provider,
  ProviderModels,
  RegisterLaneInput,
  ToolCall,
  UpdateLaneResult,
} from "../types";

interface NoteViewState {
  content: string;
  loading: boolean;
  saving: boolean;
  error: string | null;
}

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
  overlayTrees: OverlayTreeDto[];
  overlaysLoading: boolean;
  overlaysError: string | null;
  showOverlays: boolean;
  comparisonSessions: ComparisonSession[];
  focusedComparisonSession: ComparisonSession | null;
  sessionTabs: OpenTab[];
  sessionActiveTabKey: string | null;
  sessionMessages: ChatMessage[];
  sessionPendingApprovals: ToolCall[];
  chatBusy: boolean;
  activePromptName: string | null;
  comparisonChatBusy: boolean;
  noteState: NoteViewState;
  comparison: LaneComparisonDto | null;
  comparisonBusy: boolean;
  contextManifest: ContextManifestDto | null;
  contextBusy: boolean;
  contextError: string | null;
  prompts: PromptSummaryDto[];
  promptsLoading: boolean;
  promptsError: string | null;
  selectedPromptId: string | null;
  inboxSources: InboxSourceDto[];
  inboxLoading: boolean;
  inboxError: string | null;
}

interface ShellViewModelActions {
  onProviderChange: (provider: Provider) => void;
  onChooseCasefile: () => void;
  onSwitchLane: (laneId: string) => void | Promise<void>;
  onStatusChange: (status: ApiKeyStatus) => void;
  onModelsChange: (models: ProviderModels) => void;
  onToggleOverlays: () => void;
  onOpenFile: (path: string) => void | Promise<void>;
  onOpenOverlayFile: (path: string) => void | Promise<void>;
  onAddToContext?: (path: string) => void;
  onRename?: (sourcePath: string, nextPath: string) => Promise<void>;
  onRefreshTreeAndOverlays?: () => void;
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
  onNoteChange: (value: string) => void;
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
  onUpdateLane: (laneId: string, update: LaneUpdateInput) => Promise<UpdateLaneResult>;
  onRemoveLane: (laneId: string) => Promise<void>;
  onHardResetCasefile: () => Promise<void>;
  onSoftResetCasefile: (keepPrompts: boolean) => Promise<void>;
  onSelectPromptForChat: (promptId: string | null) => void;
  onCreatePrompt: (input: PromptInputDto) => Promise<PromptDraftDto>;
  onSavePrompt: (promptId: string, input: PromptInputDto) => Promise<PromptDraftDto>;
  onDeletePrompt: (promptId: string) => Promise<void>;
  onLoadPrompt: (promptId: string) => Promise<PromptDraftDto>;
  onAddInboxSource: (input: InboxSourceInput) => Promise<InboxSourceDto>;
  onRemoveInboxSource: (sourceId: string) => Promise<void>;
  onChooseInboxRoot: () => Promise<string | null>;
  onListInboxItems: (sourceId: string) => Promise<InboxItemDto[]>;
  onReadInboxItem: (sourceId: string, path: string) => Promise<InboxItemContent>;
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
      onSwitchLane: actions.onSwitchLane,
    },
    workbench: {
      workspaceTitle: state.activeLane ? state.activeLane.name : "Workspace",
      fileTree: {
        root: state.tree,
        activePath: state.activeFilePath,
        onOpenFile: actions.onOpenFile,
        error: state.treeError,
        hasWorkspace: Boolean(state.activeLane),
        overlays: state.overlayTrees,
        overlaysLoading: state.overlaysLoading,
        overlaysError: state.overlaysError,
        showOverlays: state.showOverlays,
        canShowOverlays: Boolean(state.activeLane),
        onToggleOverlays: actions.onToggleOverlays,
        onOpenOverlayFile: actions.onOpenOverlayFile,
        casefileRoot: state.casefile?.root ?? null,
        onAddToContext: state.casefile ? actions.onAddToContext : undefined,
        onRename: state.activeLane ? actions.onRename : undefined,
        onRefresh: state.activeLane ? actions.onRefreshTreeAndOverlays : undefined,
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
          },
          compareChat: {
            provider: state.provider,
            keyStatus: state.keyStatus,
            session: state.focusedComparisonSession,
            busy: state.comparisonChatBusy,
            onSend: actions.onSendComparisonChat,
          },
          // SaveOutputPicker writes the chat message into a lane
          // attachment / arbitrary directory, but the bridge call
          // bypasses our normal save-tab flow so the file tree
          // wouldn't otherwise re-list. Fire a refresh so the new
          // file appears immediately in the workspace pane. Reload
          // overlays too: the destination is often an ancestor lane's
          // attachment (e.g. the chat picker's "ash_notes" row),
          // which is rendered in the inherited-context section, not
          // the main lane tree.
          onAfterSaveOutput: actions.onRefreshTreeAndOverlays,
        },
        notes: {
          value: state.noteState.content,
          hasActiveLane: Boolean(state.activeLane),
          loading: state.noteState.loading,
          saving: state.noteState.saving,
          error: state.noteState.error,
          onChange: actions.onNoteChange,
        },
        lanes: {
          casefile: state.casefile,
          onSwitchLane: actions.onSwitchLane,
          onRegisterLane: actions.onRegisterLane,
          onChooseLaneRoot: actions.onChooseLaneRoot,
          comparison: state.comparison,
          comparisonBusy: state.comparisonBusy,
          onCompare: actions.onCompareLanes,
          onClearComparison: actions.onClearComparison,
          onOpenDiff: actions.onOpenDiff,
          onOpenLaneFile: actions.onOpenLaneFile,
          onOpenComparisonChat: actions.onOpenComparisonChat,
          context: state.contextManifest,
          contextBusy: state.contextBusy,
          contextError: state.contextError,
          onSaveContext: actions.onSaveContext,
          onSetLaneParent: actions.onSetLaneParent,
          onUpdateLaneAttachments: actions.onUpdateLaneAttachments,
          onUpdateLane: actions.onUpdateLane,
          onRemoveLane: actions.onRemoveLane,
          onHardResetCasefile: actions.onHardResetCasefile,
          onSoftResetCasefile: actions.onSoftResetCasefile,
        },
        prompts: {
          hasCasefile: Boolean(state.casefile),
          hasActiveLane: Boolean(state.activeLane),
          prompts: state.prompts,
          loading: state.promptsLoading,
          error: state.promptsError,
          selectedPromptId: state.selectedPromptId,
          onSelectForChat: actions.onSelectPromptForChat,
          onCreate: actions.onCreatePrompt,
          onSave: actions.onSavePrompt,
          onDelete: actions.onDeletePrompt,
          onLoad: actions.onLoadPrompt,
        },
        inbox: {
          hasCasefile: Boolean(state.casefile),
          sources: state.inboxSources,
          loading: state.inboxLoading,
          error: state.inboxError,
          onAddSource: actions.onAddInboxSource,
          onRemoveSource: actions.onRemoveInboxSource,
          onChooseRoot: actions.onChooseInboxRoot,
          onListItems: actions.onListInboxItems,
          onReadItem: actions.onReadInboxItem,
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
  };
}
