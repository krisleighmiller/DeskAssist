import {
  compareSessionId,
  contextSessionId,
  parseChatSessionId,
  type ChatSessionId,
} from "../components/ChatTab";
import type { AppShellProps } from "../components/AppShell";
import type { OpenTab } from "../components/EditorPane";
import type { TerminalContext } from "./useTerminalManager";
import type {
  ApiKeyStatus,
  CasefileSnapshot,
  ChatMessage,
  ComparisonSession,
  FileTreeNode,
  Context,
  ContextAttachmentInput,
  ContextUpdateInput,
  Provider,
  ProviderModels,
  RecentContext,
  ToolCall,
  UpdateContextResult,
} from "../types";
import { DEFAULT_PROVIDER_MODELS } from "../types";

interface ShellViewModelState {
  casefile: CasefileSnapshot | null;
  activeContext: Context | null;
  activeContextId: string | null;
  activeFilePath: string | null;
  provider: Provider;
  keyStatus: ApiKeyStatus;
  providerModels: ProviderModels;
  recentContexts: RecentContext[];
  tree: FileTreeNode | null;
  treeError: string | null;
  comparisonSessions: ComparisonSession[];
  focusedComparisonSession: ComparisonSession | null;
  sessionTabs: OpenTab[];
  sessionActiveTabKey: string | null;
  sessionMessages: ChatMessage[];
  sessionPendingApprovals: ToolCall[];
  chatBusy: boolean;
  comparisonChatBusy: boolean;
}

interface ShellViewModelActions {
  onProviderChange: (provider: Provider) => void;
  onChooseCasefile: () => void;
  onCloseCasefile: () => void;
  onOpenRecentContext: (root: string, activeContextId: string | null) => void | Promise<void>;
  onSetRecentPinned: (root: string, pinned: boolean) => void;
  onSwitchContext: (contextId: string) => void | Promise<void>;
  onQuickCapture: () => void | Promise<void>;
  onStatusChange: (status: ApiKeyStatus) => void;
  onModelsChange: (models: ProviderModels) => void;
  onOpenFile: (path: string) => void | Promise<void>;
  onRename?: (sourcePath: string, newName: string) => Promise<void>;
  onRequestFileRename?: (path: string) => void;
  onRefreshTree?: () => void;
  onDismissTreeError: () => void;
  onCreateFile?: (parentDir: string, name: string) => Promise<void>;
  onCreateFolder?: (parentDir: string, name: string) => Promise<void>;
  onMoveEntry?: (sourcePath: string, destinationPath: string) => Promise<void>;
  onTrashEntry?: (path: string) => Promise<void>;
  onCreateContextFromPath?: (path: string, name: string) => Promise<void>;
  onAttachToContext?: (path: string, contextId: string, name: string) => Promise<void>;
  onSelectTab: (key: string) => void;
  onCloseTab: (key: string) => void;
  onEditTab: (key: string, content: string) => void;
  onSaveTab: (key: string) => void;
  onSelectComparisonSession: (comparisonId: string) => void;
  onCloseComparisonChat: (comparisonId: string) => void;
  onSendMessage: (text: string) => void;
  onApproveTools: () => void;
  onDenyTools: () => void;
  onSendComparisonChat: (text: string) => void;
  onApproveComparisonTools: () => void;
  onDenyComparisonTools: () => void;
  onOpenComparisonChat: (contextIds: string[]) => Promise<void>;
  onUpdateComparisonAttachments: (
    contextIds: string[],
    attachments: ContextAttachmentInput[]
  ) => Promise<void>;
  onUpdateContext: (contextId: string, update: ContextUpdateInput) => Promise<UpdateContextResult>;
  onRemoveContext: (contextId: string) => Promise<void>;
  onHardResetCasefile: () => Promise<void>;
  onSoftResetCasefile: () => Promise<void>;
  /** Called when the user renames a context via the file tree context menu. */
  onUpdateContextName?: (contextId: string, newName: string) => Promise<void>;
  /** M3: add another directory to the active context's AI scope. */
  onAddAttachment?: (path: string, contextId: string, name: string) => Promise<void>;
  /** M2.5: toggle AI write access for a context. */
  onSetContextWritable?: (contextId: string, writable: boolean) => Promise<void>;
  /** M2.5: remove an attachment from the active context by its label name. */
  onRemoveAttachment?: (contextId: string, attName: string) => Promise<void>;
  /** M2.5: change an attachment's AI access mode. */
  onSetAttachmentMode?: (contextId: string, attName: string, mode: "read" | "write") => Promise<void>;
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
    else void actions.onSwitchContext(parsed.id);
  };

  // Build a structural TerminalContext rather than casting the
  // full Context shape. If `Context` ever drops one of these fields we'll
  // get a real type error instead of a silent runtime undefined.
  // (Review item #30.)
  const terminalContext: TerminalContext | null = state.activeContext
    ? {
        id: state.activeContext.id,
        name: state.activeContext.name,
        root: state.activeContext.root,
      }
    : null;
  const activeModel =
    state.providerModels[state.provider]?.trim() || DEFAULT_PROVIDER_MODELS[state.provider];
  const modelIsDefault = !state.providerModels[state.provider]?.trim();

  return {
    toolbar: {
      casefile: state.casefile,
      recentContexts: state.recentContexts,
      onOpenRecentContext: actions.onOpenRecentContext,
      onSwitchContext: actions.onSwitchContext,
      onQuickCapture: state.casefile ? actions.onQuickCapture : undefined,
      onUpdateContextName: state.casefile ? actions.onUpdateContextName : undefined,
      onRemoveContext: state.casefile ? actions.onRemoveContext : undefined,
      onSetContextWritable: state.casefile ? actions.onSetContextWritable : undefined,
      onSoftResetCasefile: state.casefile ? actions.onSoftResetCasefile : undefined,
      onHardResetCasefile: state.casefile ? actions.onHardResetCasefile : undefined,
    },
    workbench: {
      home: {
        recentContexts: state.recentContexts,
        onChooseCasefile: actions.onChooseCasefile,
        onOpenRecentContext: actions.onOpenRecentContext,
        onSetRecentPinned: actions.onSetRecentPinned,
      },
      workspaceTitle: state.activeContext ? state.activeContext.name : "Workspace",
      fileTree: {
        root: state.tree,
        activePath: state.activeFilePath,
        onOpenFile: actions.onOpenFile,
        error: state.treeError,
        onDismissError: actions.onDismissTreeError,
        // The file tree is the user's view of the casefile. Contexts
        // exist to scope what the chat agent sees — they are NOT a
        // gate on the user's ability to browse, open, or edit files.
        // (Cursor-style file tree behaviour: any file in the casefile
        // is fair game; the active context only changes highlighting.)
        // So everything here keys off `state.casefile`. The one
        // exception is `onAttachToActiveContext`, which by definition
        // requires an active context.
        hasWorkspace: Boolean(state.casefile),
        casefileRoot: state.casefile?.root ?? null,
        onRename: state.casefile ? actions.onRename : undefined,
        onRefresh: state.casefile ? actions.onRefreshTree : undefined,
        // Active context drives highlighting / context-scoped menu items
        // only — file ops below are casefile-wide.
        activeContextRoot: state.activeContext?.root ?? null,
        // Roots beyond the context's own write root that should still be
        // tinted as "in the active context" — currently the context's
        // read-only related directory roots. Empty when the context has no
        // attachments or there's no active context. The FileTree treats
        // this list together with `activeContextRoot` for its colour cue.
        activeContextScopeRoots: state.activeContext?.attachments
          ? state.activeContext.attachments
              .map((att) => att.root)
              .filter((root): root is string => Boolean(root))
          : undefined,
        activeContextId: state.activeContextId,
        contexts: state.casefile
          ? state.casefile.contexts.map((context) => ({
              id: context.id,
              name: context.name,
              root: context.root,
              writable: context.writable,
            }))
          : undefined,
        onCreateFile: state.casefile ? actions.onCreateFile : undefined,
        onCreateFolder: state.casefile ? actions.onCreateFolder : undefined,
        onMoveEntry: state.casefile ? actions.onMoveEntry : undefined,
        onTrashEntry: state.casefile ? actions.onTrashEntry : undefined,
        onCreateContextFromPath: state.casefile
          ? actions.onCreateContextFromPath
          : undefined,
        onAttachToContext: state.casefile && (state.casefile.contexts.length > 0)
          ? actions.onAttachToContext
          : undefined,
        onOpenComparisonChat:
          state.casefile && state.casefile.contexts.length >= 2
            ? actions.onOpenComparisonChat
            : undefined,
        onSwitchContext: state.casefile ? actions.onSwitchContext : undefined,
        onUpdateContextName: state.casefile ? actions.onUpdateContextName : undefined,
        onRemoveContext: state.casefile ? actions.onRemoveContext : undefined,
        onSetContextWritable: state.casefile ? actions.onSetContextWritable : undefined,
        onSoftResetCasefile: state.casefile ? actions.onSoftResetCasefile : undefined,
        onHardResetCasefile: state.casefile ? actions.onHardResetCasefile : undefined,
      },
      editor: {
        tabs: state.sessionTabs,
        activeKey: state.sessionActiveTabKey,
        onSelectTab: actions.onSelectTab,
        onCloseTab: actions.onCloseTab,
        onEdit: actions.onEditTab,
        onSave: actions.onSaveTab,
        onRequestRename: state.casefile ? actions.onRequestFileRename : undefined,
      },
      rightPanel: {
        chat: {
          casefile: state.casefile,
          comparisonSessions: state.comparisonSessions,
          activeSessionId: state.focusedComparisonSession
            ? compareSessionId(state.focusedComparisonSession.id)
            : state.activeContextId
              ? contextSessionId(state.activeContextId)
              : null,
          onSelectSession,
          onCloseCompareSession: actions.onCloseComparisonChat,
          contextChat: {
            provider: state.provider,
            keyStatus: state.keyStatus,
            activeModel,
            modelIsDefault,
            messages: state.sessionMessages,
            pendingApprovals: state.sessionPendingApprovals,
            busy: state.chatBusy,
            hasActiveContext: Boolean(state.activeContext),
            activeContext: state.activeContext,
            onSend: actions.onSendMessage,
            onApproveTools: actions.onApproveTools,
            onDenyTools: actions.onDenyTools,
            onSetContextWritable: state.activeContext && actions.onSetContextWritable
              ? (writable: boolean) => {
                  void actions.onSetContextWritable!(state.activeContext!.id, writable);
                }
              : undefined,
            onAddAttachment: state.activeContext && actions.onAddAttachment
              ? (root: string, name: string) => {
                  return actions.onAddAttachment!(root, state.activeContext!.id, name);
                }
              : undefined,
            onRemoveAttachment: state.activeContext && actions.onRemoveAttachment
              ? (attName: string) => {
                  void actions.onRemoveAttachment!(state.activeContext!.id, attName);
                }
              : undefined,
            onSetAttachmentMode: state.activeContext && actions.onSetAttachmentMode
              ? (attName: string, mode: "read" | "write") => {
                  void actions.onSetAttachmentMode!(state.activeContext!.id, attName, mode);
                }
              : undefined,
          },
          compareChat: {
            provider: state.provider,
            keyStatus: state.keyStatus,
            activeModel,
            modelIsDefault,
            session: state.focusedComparisonSession,
            busy: state.comparisonChatBusy,
            onSend: actions.onSendComparisonChat,
            onApproveTools: actions.onApproveComparisonTools,
            onDenyTools: actions.onDenyComparisonTools,
            onSetContextWritable: actions.onSetContextWritable,
            onSetAttachmentMode: actions.onSetAttachmentMode,
            onUpdateAttachments: actions.onUpdateComparisonAttachments,
          },
          // SaveOutputPicker writes the chat message into a context
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
    activeContext: terminalContext,
    casefileRoot: state.casefile?.root ?? null,
  };
}
