import { useCallback, useEffect, useState } from "react";
import type {
  CasefileSnapshot,
  ChatMessage,
  LaneAttachmentInput,
  RegisterLaneInput,
} from "./types";
import { api } from "./lib/api";
import { AppShell } from "./components/AppShell";
import type { RightTabKey } from "./components/RightPanel";
import {
  EMPTY_LANE_SESSION,
  chatTurnDelta,
  errorMessage,
  normalizeChatTurn,
  sessionKeyFor,
  type LaneSessionState,
} from "./hooks/appModelTypes";
import { useAppShellProps } from "./hooks/useAppShellProps";
import { useComparisons } from "./hooks/useComparisons";
import { useContextAndOverlays } from "./hooks/useContextAndOverlays";
import { useInboxSources } from "./hooks/useInboxSources";
import { useLaneWorkspace } from "./hooks/useLaneWorkspace";
import { useNotesState } from "./hooks/useNotesState";
import { usePromptDrafts } from "./hooks/usePromptDrafts";
import { useProviderSettings } from "./hooks/useProviderSettings";

export function App(): JSX.Element {
  // ----- Casefile + active lane -----
  const [casefile, setCasefile] = useState<CasefileSnapshot | null>(null);
  const activeLaneId = casefile?.activeLaneId ?? null;
  const activeLane = activeLaneId
    ? casefile?.lanes.find((lane) => lane.id === activeLaneId) ?? null
    : null;
  const [treeError, setTreeError] = useState<string | null>(null);

  // ----- Per-lane in-memory session state -----
  // Keyed by `sessionKeyFor(root, laneId)` (NUL-separated) so multiple
  // casefiles opened in the same session can't bleed into each other,
  // even on exotic paths.
  const [laneSessions, setLaneSessions] = useState<Map<string, LaneSessionState>>(
    () => new Map()
  );

  const sessionKey = sessionKeyFor(casefile?.root, activeLaneId);
  const session: LaneSessionState =
    (sessionKey ? laneSessions.get(sessionKey) : null) ?? EMPTY_LANE_SESSION;
  // Per-lane busy flag, sourced directly from session state so that
  // switching lanes mid-request shows the correct spinner on each
  // lane and doesn't let one lane's response cancel another lane's
  // in-flight indicator. (Review item #4.)
  const chatBusy = session.busy;

  const updateSession = useCallback(
    (updater: (prev: LaneSessionState) => LaneSessionState) => {
      if (!sessionKey) return;
      setLaneSessions((prev) => {
        const next = new Map(prev);
        const current = next.get(sessionKey) ?? EMPTY_LANE_SESSION;
        next.set(sessionKey, updater(current));
        return next;
      });
    },
    [sessionKey]
  );

  // ----- Right panel + provider selection -----

  const {
    provider,
    setProvider,
    keyStatus,
    setKeyStatus,
    providerModels,
    setProviderModels,
  } = useProviderSettings();
  const { noteState, handleNoteChange } = useNotesState({
    casefileRoot: casefile?.root ?? null,
    activeLaneId,
    sessionKey,
  });
  const {
    prompts,
    promptsLoading,
    promptsError,
    selectedPromptId,
    activePromptName,
    handleCreatePrompt,
    handleSavePrompt,
    handleDeletePrompt,
    handleLoadPrompt,
    handleSelectPromptForChat,
  } = usePromptDrafts(casefile, sessionKey);
  const {
    inboxSources,
    inboxLoading,
    inboxError,
    handleAddInboxSource,
    handleRemoveInboxSource,
    handleChooseInboxRoot,
    handleListInboxItems,
    handleReadInboxItem,
  } = useInboxSources(casefile);

  // ----- Lane comparison -----
  const {
    comparison,
    comparisonBusy,
    comparisonSessions,
    setActiveComparisonId,
    comparisonChatBusy,
    focusedComparisonSession,
    handleCompareLanes,
    handleClearComparison,
    handleOpenComparisonChat,
    handleCloseComparisonChat,
    sendComparisonChat,
    handleOpenDiff,
    resetComparisonsForCasefile,
    clearActiveComparisonForLaneChat,
  } = useComparisons({
    casefile,
    provider,
    providerModels,
    session,
    updateSession,
    onError: (message) => setTreeError(message),
  });

  const {
    contextManifest,
    contextBusy,
    contextError,
    handleSaveContext,
    handleAddToContext,
    handleSetLaneParent,
    handleUpdateLaneAttachments,
    handleUpdateLane,
    handleRemoveLane,
    handleHardResetCasefile,
    handleSoftResetCasefile,
  } = useContextAndOverlays({
    casefile,
    activeLaneId,
    onCasefileChange: setCasefile,
    onError: (message) => setTreeError(message),
  });

  const {
    tree,
    setTree,
    refreshTree,
    loadLaneChatHistory,
    handleOpenFile,
    handleSelectTab,
    handleCloseTab,
    handleEditTab,
    handleSaveTab,
    refreshOpenTabsFromDisk,
    handleRenameFile,
    handleMoveEntry,
    handleTrashEntry,
    handleCreateFile,
    handleCreateFolder,
    handleOpenLaneFile,
  } = useLaneWorkspace({
    casefile,
    activeLane,
    activeLaneId,
    session,
    updateSession,
    setLaneSessions,
    setTreeError,
  });

  // Two unrelated concerns split into two effects so we re-fetch only
  // what changed. (Review item #20.)
  useEffect(() => {
    if (!activeLaneId) {
      setTree(null);
      return;
    }
    void refreshTree();
  }, [activeLaneId, refreshTree, setTree]);

  useEffect(() => {
    if (!sessionKey || !activeLaneId) return;
    void loadLaneChatHistory(activeLaneId, sessionKey);
  }, [activeLaneId, sessionKey, loadLaneChatHistory]);

  // Global Ctrl/Cmd+Z handler that restores the most recently trashed
  // entry. We intentionally let the keystroke fall through when the
  // user is focused inside an editable element (Monaco editor, text
  // inputs, contenteditable) so the local undo stack stays intact.
  // Monaco swallows Ctrl+Z itself before it reaches window, so the
  // editable check just guards plain HTML inputs / textareas.
  useEffect(() => {
    if (!casefile) return;
    const handler = (event: KeyboardEvent) => {
      const isUndo =
        (event.ctrlKey || event.metaKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "z";
      if (!isUndo) return;
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          target.isContentEditable ||
          // Monaco renders inside `.monaco-editor` and surfaces its own
          // undo for in-buffer text edits. Defer to it when the focus
          // is inside the editor surface.
          target.closest(".monaco-editor") ||
          // Same for our xterm-based terminals — Ctrl+Z is meaningful
          // there as a process-suspend signal and should not be
          // intercepted by the renderer-level file undo.
          target.closest(".xterm")
        ) {
          return;
        }
      }
      event.preventDefault();
      void (async () => {
        try {
          const result = await api().undoLastTrash();
          if (result.restored) {
            await refreshTree();
          }
        } catch (err) {
          setTreeError(errorMessage(err));
        }
      })();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [casefile, refreshTree, setTreeError]);

  // ----- Casefile ops -----

  const handleChooseCasefile = useCallback(async () => {
    try {
      const snapshot = await api().chooseCasefile();
      if (snapshot) {
        setCasefile(snapshot);
        resetComparisonsForCasefile();
      }
    } catch (error) {
      setTreeError(errorMessage(error));
    }
  }, [resetComparisonsForCasefile]);

  const handleSwitchLane = useCallback(
    async (laneId: string) => {
      if (!casefile || laneId === casefile.activeLaneId) return;
      try {
        const snapshot = await api().switchLane(laneId);
        setCasefile(snapshot);
        clearActiveComparisonForLaneChat();
      } catch (error) {
        setTreeError(errorMessage(error));
      }
    },
    [casefile, clearActiveComparisonForLaneChat]
  );

  const handleRegisterLane = useCallback(async (input: RegisterLaneInput) => {
    try {
      const snapshot = await api().registerLane(input);
      setCasefile(snapshot);
    } catch (error) {
      setTreeError(errorMessage(error));
      throw error;
    }
  }, []);

  const handleChooseLaneRoot = useCallback(async () => {
    return api().chooseLaneRoot();
  }, []);

  // ----- M2: right-panel tab + browser-driven lane actions -----

  const [activeRightTab, setActiveRightTab] = useState<RightTabKey>("chat");

  // Promote a tree directory into a new lane in the current casefile.
  // Defaults to `kind: "repo"` because that's by far the dominant case
  // for "I dragged this folder over from the file tree" — non-repo
  // lanes are usually created up-front via the LanesTab, where the
  // full kind picker is exposed. Users can change kind later.
  const handleCreateLaneFromPath = useCallback(
    async (path: string, name: string) => {
      try {
        const snapshot = await api().registerLane({
          name,
          kind: "repo",
          root: path,
        });
        setCasefile(snapshot);
        // Jump to the Lanes tab so the user sees the newly-registered
        // lane and can edit kind / parent / attachments without
        // hunting for it.
        setActiveRightTab("lanes");
      } catch (error) {
        setTreeError(errorMessage(error));
        throw error;
      }
    },
    []
  );

  // Append a new read-only attachment to the active lane. The bridge's
  // `updateLaneAttachments` is a full-replacement contract, so we
  // re-derive the existing list from the current snapshot instead of
  // assuming caller-side state is fresh.
  const handleAttachToActiveLane = useCallback(
    async (path: string, name: string) => {
      if (!casefile || !activeLaneId) return;
      const lane = casefile.lanes.find((l) => l.id === activeLaneId);
      if (!lane) return;
      const existing: LaneAttachmentInput[] = (lane.attachments ?? []).map(
        (a) => ({ name: a.name, root: a.root })
      );
      // Reject duplicates client-side with a clear message instead of
      // letting the bridge's "duplicate attachment name" error surface
      // through the generic catch — gives the user a chance to retry
      // with a different prefix without losing context.
      if (existing.some((a) => a.name === name)) {
        setTreeError(
          `Lane "${lane.name}" already has an attachment named "${name}".`
        );
        return;
      }
      try {
        await handleUpdateLaneAttachments(activeLaneId, [
          ...existing,
          { name, root: path },
        ]);
      } catch {
        // handleUpdateLaneAttachments already surfaces via setTreeError.
      }
    },
    [activeLaneId, casefile, handleUpdateLaneAttachments]
  );

  // Trigger a comparison from the FileTree's "Compare with…" picker.
  // Switches to the Lanes tab so the user sees the diff result; the
  // existing AppShell auto-switch effect will then route them back to
  // the chat tab as soon as they open the comparison-chat session.
  const handleStartLaneComparisonFromTree = useCallback(
    async (selfLaneId: string, otherLaneId: string) => {
      try {
        await handleCompareLanes(selfLaneId, otherLaneId);
        setActiveRightTab("lanes");
      } catch (error) {
        setTreeError(errorMessage(error));
        throw error;
      }
    },
    [handleCompareLanes]
  );

  // ----- Chat -----

  const sendMessage = useCallback(
    async (text: string) => {
      const value = text.trim();
      if (!value) return;
      if (!casefile || !activeLaneId) return;
      // Race-safe begin: if another send for THIS lane is already in
      // flight (rapid clicks), bail without doing anything. The check
      // happens inside the updater so it sees the freshest `prev`.
      // (Review item #4.)
      let started = false;
      let historyBeforeTurn: ChatMessage[] = [];
      updateSession((prev) => {
        if (prev.busy) return prev;
        started = true;
        historyBeforeTurn = prev.messages;
        return {
          ...prev,
          busy: true,
          messages: [...prev.messages, { role: "user", content: value }],
          pendingApprovals: [],
        };
      });
      if (!started) return;
      try {
        const response = await api().sendChat({
          provider,
          model: providerModels[provider] || null,
          messages: historyBeforeTurn,
          userMessage: value,
          allowWriteTools: false,
          resumePendingToolCalls: false,
          systemPromptId: selectedPromptId,
        });
        const nextMessages = normalizeChatTurn(historyBeforeTurn, value, response);
        const nextPending = Array.isArray(response.pendingApprovals)
          ? response.pendingApprovals
          : [];
        updateSession((prev) => ({
          ...prev,
          messages: nextMessages,
          pendingApprovals: nextPending,
          busy: false,
        }));
        await refreshTree();
        await refreshOpenTabsFromDisk();
      } catch (error) {
        const errMsg = errorMessage(error);
        updateSession((prev) => ({
          ...prev,
          messages: [
            ...historyBeforeTurn,
            { role: "user", content: value },
            { role: "assistant", content: `Error: ${errMsg}` },
          ],
          // Match the success-path behaviour: a failed send always
          // clears any prior pending approvals so the UI doesn't
          // strand the user with stale "approve / deny" buttons that
          // refer to a request that never reached the server.
          // (Review item #7.)
          pendingApprovals: [],
          busy: false,
        }));
      }
    },
    [
      casefile,
      activeLaneId,
      updateSession,
      provider,
      providerModels,
      selectedPromptId,
      refreshTree,
      refreshOpenTabsFromDisk,
    ]
  );

  const approveTools = useCallback(async () => {
    if (!casefile || !activeLaneId) return;
    let started = false;
    let historyBeforeTurn: ChatMessage[] = [];
    updateSession((prev) => {
      if (prev.busy || prev.pendingApprovals.length === 0) return prev;
      started = true;
      historyBeforeTurn = prev.messages;
      return { ...prev, busy: true };
    });
    if (!started) return;
    try {
      const response = await api().sendChat({
        provider,
        model: providerModels[provider] || null,
        messages: historyBeforeTurn,
        userMessage: "",
        allowWriteTools: true,
        resumePendingToolCalls: true,
        systemPromptId: selectedPromptId,
      });
      // Accept both the preferred `messages` array and the legacy
      // single `message` form. Without this fallback, a bridge that
      // returns only `response.message` after a tool resume would
      // silently drop the assistant's reply on the floor — the chat
      // would just spin down with no visible response. Matches the
      // handling in `sendMessage` and `sendComparisonChat`.
      const delta = chatTurnDelta(response) ?? [];
      const nextPending = Array.isArray(response.pendingApprovals)
        ? response.pendingApprovals
        : [];
      updateSession((prev) => ({
        ...prev,
        messages: [...historyBeforeTurn, ...delta],
        pendingApprovals: nextPending,
        busy: false,
      }));
      await refreshTree();
      await refreshOpenTabsFromDisk();
    } catch (error) {
      const errMsg = errorMessage(error);
      updateSession((prev) => ({
        ...prev,
        messages: [
          ...prev.messages,
          { role: "assistant", content: `Error: ${errMsg}` },
        ],
        pendingApprovals: [],
        busy: false,
      }));
    }
  }, [
    casefile,
    activeLaneId,
    provider,
    providerModels,
    selectedPromptId,
    updateSession,
    refreshTree,
    refreshOpenTabsFromDisk,
  ]);

  const denyTools = useCallback(() => {
    updateSession((prev) => {
      if (prev.pendingApprovals.length === 0) return prev;
      return {
        ...prev,
        messages: [
          ...prev.messages,
          { role: "assistant", content: "Write operation request denied." },
        ],
        pendingApprovals: [],
      };
    });
  }, [updateSession]);

  // FileTree highlighting only makes sense for file tabs (not diff tabs).
  const activeFilePath =
    session.tabs.find((t) => t.key === session.activeTabKey && t.kind === "file")?.path ?? null;
  const refreshTreeAction = useCallback(() => {
    void refreshTree();
  }, [refreshTree]);

  const shellProps = useAppShellProps({
    state: {
      casefile,
      activeLane,
      activeLaneId,
      activeFilePath,
      provider,
      keyStatus,
      providerModels,
      tree,
      treeError,
      comparisonSessions,
      focusedComparisonSession,
      sessionTabs: session.tabs,
      sessionActiveTabKey: session.activeTabKey,
      sessionMessages: session.messages,
      sessionPendingApprovals: session.pendingApprovals,
      chatBusy,
      activePromptName,
      comparisonChatBusy,
      noteState: {
        content: noteState.content,
        loading: noteState.loading,
        saving: noteState.saving,
        error: noteState.error,
      },
      comparison,
      comparisonBusy,
      contextManifest,
      contextBusy,
      contextError,
      prompts,
      promptsLoading,
      promptsError,
      selectedPromptId,
      inboxSources,
      inboxLoading,
      inboxError,
      activeRightTab,
    },
    actions: {
      onProviderChange: setProvider,
      onChooseCasefile: handleChooseCasefile,
      onSwitchLane: handleSwitchLane,
      onStatusChange: setKeyStatus,
      onModelsChange: setProviderModels,
      onOpenFile: handleOpenFile,
      onAddToContext: handleAddToContext,
      onRename: handleRenameFile,
      onRefreshTree: refreshTreeAction,
      onDismissTreeError: () => setTreeError(null),
      onCreateFile: handleCreateFile,
      onCreateFolder: handleCreateFolder,
      onMoveEntry: handleMoveEntry,
      onTrashEntry: handleTrashEntry,
      onCreateLaneFromPath: handleCreateLaneFromPath,
      onAttachToActiveLane: handleAttachToActiveLane,
      onStartLaneComparison: handleStartLaneComparisonFromTree,
      onActiveRightTabChange: setActiveRightTab,
      onSelectTab: handleSelectTab,
      onCloseTab: handleCloseTab,
      onEditTab: handleEditTab,
      onSaveTab: handleSaveTab,
      onSelectComparisonSession: setActiveComparisonId,
      onCloseComparisonChat: handleCloseComparisonChat,
      onClearActivePrompt: () => handleSelectPromptForChat(null),
      onSendMessage: sendMessage,
      onApproveTools: approveTools,
      onDenyTools: denyTools,
      onSendComparisonChat: sendComparisonChat,
      onNoteChange: handleNoteChange,
      onRegisterLane: handleRegisterLane,
      onChooseLaneRoot: handleChooseLaneRoot,
      onCompareLanes: handleCompareLanes,
      onClearComparison: handleClearComparison,
      onOpenDiff: handleOpenDiff,
      onOpenLaneFile: handleOpenLaneFile,
      onOpenComparisonChat: handleOpenComparisonChat,
      onSaveContext: handleSaveContext,
      onSetLaneParent: handleSetLaneParent,
      onUpdateLaneAttachments: handleUpdateLaneAttachments,
      onUpdateLane: handleUpdateLane,
      onRemoveLane: handleRemoveLane,
      onHardResetCasefile: handleHardResetCasefile,
      onSoftResetCasefile: handleSoftResetCasefile,
      onSelectPromptForChat: handleSelectPromptForChat,
      onCreatePrompt: handleCreatePrompt,
      onSavePrompt: handleSavePrompt,
      onDeletePrompt: handleDeletePrompt,
      onLoadPrompt: handleLoadPrompt,
      onAddInboxSource: handleAddInboxSource,
      onRemoveInboxSource: handleRemoveInboxSource,
      onChooseInboxRoot: handleChooseInboxRoot,
      onListInboxItems: handleListInboxItems,
      onReadInboxItem: handleReadInboxItem,
    },
  });

  return <AppShell {...shellProps} />;
}
