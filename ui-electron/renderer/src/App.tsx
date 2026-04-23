import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AttachmentMode,
  CasefileSnapshot,
  ChatMessage,
  LaneAttachmentInput,
  RegisterLaneInput,
} from "./types";
import { api } from "./lib/api";
import { AppShell } from "./components/AppShell";
import { InputDialog } from "./components/InputDialog";
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
import { useLaneWorkspace } from "./hooks/useLaneWorkspace";
import { usePromptDrafts } from "./hooks/usePromptDrafts";
import { useProviderSettings } from "./hooks/useProviderSettings";

export function App(): JSX.Element {
  // ----- Casefile + active lane -----
  const [casefile, setCasefile] = useState<CasefileSnapshot | null>(null);
  const activeLaneId = casefile?.activeLaneId ?? null;
  const activeLane = activeLaneId
    ? casefile?.lanes.find((lane) => lane.id === activeLaneId) ?? null
    : null;

  // ----- Global dialog (for menu-bar triggered prompts that need text input) -----
  const [globalDialog, setGlobalDialog] = useState<{
    title: string;
    message?: string;
    defaultValue: string;
    confirmLabel?: string;
    resolve: (value: string | null) => void;
  } | null>(null);

  /** Promise-based text-input prompt rendered at App level so menu-bar
   * IPC handlers (which run outside the FileTree component) can ask the
   * user for a name/label without reaching into a child component's state. */
  const promptGlobalRef = useRef<(opts: {
    title: string;
    message?: string;
    defaultValue?: string;
    confirmLabel?: string;
  }) => Promise<string | null>>();
  promptGlobalRef.current = (opts) =>
    new Promise<string | null>((resolve) => {
      setGlobalDialog({
        title: opts.title,
        message: opts.message,
        defaultValue: opts.defaultValue ?? "",
        confirmLabel: opts.confirmLabel,
        resolve,
      });
    });

  const promptGlobal = useCallback(
    (opts: { title: string; message?: string; defaultValue?: string; confirmLabel?: string }) =>
      promptGlobalRef.current!(opts),
    []
  );
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
  const {
    selectedPromptId,
    activePromptName,
    handleSelectPromptForChat,
  } = usePromptDrafts(casefile, sessionKey);

  // ----- Lane comparison -----
  const {
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

  const handleCreateLaneFromPath = useCallback(
    async (path: string, name: string) => {
      try {
        const snapshot = await api().registerLane({
          name,
          kind: "repo",
          root: path,
        });
        setCasefile(snapshot);
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
  const handleAttachToLane = useCallback(
    async (path: string, laneId: string, name: string) => {
      const lane = casefile?.lanes.find((l) => l.id === laneId);
      if (!lane) return;
      const existing: LaneAttachmentInput[] = (lane.attachments ?? []).map(
        (a) => ({ name: a.name, root: a.root })
      );
      if (existing.some((a) => a.name === name)) {
        setTreeError(
          `Lane "${lane.name}" already has an attachment named "${name}".`
        );
        return;
      }
      try {
        await handleUpdateLaneAttachments(laneId, [
          ...existing,
          { name, root: path },
        ]);
      } catch {
        // handleUpdateLaneAttachments already surfaces via setTreeError.
      }
    },
    [casefile, handleUpdateLaneAttachments]
  );

  const handleRemoveAttachment = useCallback(
    async (laneId: string, attName: string) => {
      const lane = casefile?.lanes.find((l) => l.id === laneId);
      if (!lane) return;
      const updated: LaneAttachmentInput[] = (lane.attachments ?? [])
        .filter((a) => a.name !== attName)
        .map((a) => ({ name: a.name, root: a.root, mode: a.mode }));
      try {
        await handleUpdateLaneAttachments(laneId, updated);
      } catch {
        // Error surfaces via setTreeError in handleUpdateLaneAttachments.
      }
    },
    [casefile, handleUpdateLaneAttachments]
  );

  const handleSetAttachmentMode = useCallback(
    async (laneId: string, attName: string, mode: AttachmentMode) => {
      const lane = casefile?.lanes.find((l) => l.id === laneId);
      if (!lane) return;
      const updated: LaneAttachmentInput[] = (lane.attachments ?? []).map((a) =>
        a.name === attName ? { name: a.name, root: a.root, mode } : { name: a.name, root: a.root, mode: a.mode }
      );
      try {
        await handleUpdateLaneAttachments(laneId, updated);
      } catch {
        // Error surfaces via setTreeError in handleUpdateLaneAttachments.
      }
    },
    [casefile, handleUpdateLaneAttachments]
  );

  // ----- Menu-bar IPC handlers -----
  // The Lane menu (main.js) sends IPC messages. Each handler carries out
  // the full dialog flow (directory picker → name prompt → register/update).
  // `promptGlobal` renders a global InputDialog in the App's JSX since
  // FileTree's promptForInput is not accessible here.

  useEffect(() => {
    const unsub = api().onOpenCasefile(handleChooseCasefile);
    return unsub;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const unsub = api().onLaneCreate(async () => {
      if (!casefile) return;
      const root = await handleChooseLaneRoot();
      if (!root) return;
      const defaultName = root.split(/[\\/]/).pop() ?? "lane";
      const name = await promptGlobal({
        title: "Create lane",
        message: "Name for the new lane.",
        defaultValue: defaultName,
        confirmLabel: "Create lane",
      });
      if (!name?.trim()) return;
      try {
        await handleCreateLaneFromPath(root, name.trim());
      } catch {
        // surfaced via setTreeError
      }
    });
    return unsub;
  // handleChooseLaneRoot and handleCreateLaneFromPath are stable useCallback refs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [casefile, promptGlobal]);

  useEffect(() => {
    const unsub = api().onLaneAttach(async () => {
      if (!casefile || casefile.lanes.length === 0) return;
      const root = await handleChooseLaneRoot();
      if (!root) return;
      // Ask which lane to attach to.
      const laneNames = casefile.lanes.map((l) => l.name).join(" / ");
      const laneName = await promptGlobal({
        title: "Attach to lane",
        message: `Enter the lane name to attach to (${laneNames}):`,
        defaultValue: casefile.lanes[0]?.name ?? "",
        confirmLabel: "Next",
      });
      if (!laneName?.trim()) return;
      const targetLane = casefile.lanes.find(
        (l) => l.name.toLowerCase() === laneName.trim().toLowerCase()
      );
      if (!targetLane) {
        setTreeError(`No lane named "${laneName.trim()}".`);
        return;
      }
      const defaultLabel = root.split(/[\\/]/).pop() ?? "attachment";
      const label = await promptGlobal({
        title: `Attach to "${targetLane.name}"`,
        message: "Attachment label — how this directory will be referenced in scope.",
        defaultValue: defaultLabel,
        confirmLabel: "Attach",
      });
      if (!label?.trim()) return;
      try {
        await handleAttachToLane(root, targetLane.id, label.trim());
      } catch {
        // surfaced via setTreeError
      }
    });
    return unsub;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [casefile, promptGlobal]);

  useEffect(() => {
    const unsub = api().onLaneRename(async () => {
      if (!activeLane) return;
      const name = await promptGlobal({
        title: "Rename lane",
        message: "Enter the new lane name.",
        defaultValue: activeLane.name,
        confirmLabel: "Rename",
      });
      if (!name?.trim() || name.trim() === activeLane.name) return;
      try {
        await handleUpdateLane(activeLane.id, { name: name.trim() });
      } catch {
        // surfaced via setTreeError
      }
    });
    return unsub;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLane, promptGlobal]);

  useEffect(() => {
    const unsub = api().onLaneToggleAccess(() => {
      if (!activeLane) return;
      const isWritable = activeLane.writable !== false;
      void handleUpdateLane(activeLane.id, { writable: !isWritable });
    });
    return unsub;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLane]);

  useEffect(() => {
    const unsub = api().onLaneRemove(() => {
      if (!activeLane) return;
      const ok = window.confirm(
        `Remove lane "${activeLane.name}"?\n\nThis removes it from the casefile but does not delete any files.`
      );
      if (!ok) return;
      void handleRemoveLane(activeLane.id);
    });
    return unsub;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLane]);

  useEffect(() => {
    const unsub = api().onCasefileSoftReset(() => {
      if (!casefile) return;
      const ok = window.confirm(
        "Soft reset clears lane registrations and chat history metadata. Files on disk are preserved."
      );
      if (!ok) return;
      void handleSoftResetCasefile(false);
    });
    return unsub;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [casefile]);

  useEffect(() => {
    const unsub = api().onCasefileHardReset(() => {
      if (!casefile) return;
      const ok = window.confirm(
        "Hard reset deletes the entire .casefile metadata folder.\n\nConversation history, lane registrations, and settings will be permanently removed. Files on disk are preserved.\n\nThis cannot be undone. Continue?"
      );
      if (!ok) return;
      void handleHardResetCasefile();
    });
    return unsub;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [casefile]);

  const handleStartLaneComparisonFromTree = useCallback(
    async (selfLaneId: string, otherLaneId: string) => {
      try {
        await handleCompareLanes(selfLaneId, otherLaneId);
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
        allowWriteTools: activeLane?.writable !== false,
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
      onAttachToLane: handleAttachToLane,
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
      onUpdateLaneName: async (laneId: string, newName: string) => {
        await handleUpdateLane(laneId, { name: newName });
      },
      onSetLaneWritable: async (laneId: string, writable: boolean) => {
        await handleUpdateLane(laneId, { writable });
      },
      onRemoveAttachment: handleRemoveAttachment,
      onSetAttachmentMode: handleSetAttachmentMode,
    },
  });

  return (
    <>
      <AppShell {...shellProps} />
      {globalDialog && (
        <InputDialog
          title={globalDialog.title}
          message={globalDialog.message}
          defaultValue={globalDialog.defaultValue}
          confirmLabel={globalDialog.confirmLabel}
          onSubmit={(value) => {
            const resolve = globalDialog.resolve;
            setGlobalDialog(null);
            resolve(value);
          }}
          onCancel={() => {
            const resolve = globalDialog.resolve;
            setGlobalDialog(null);
            resolve(null);
          }}
        />
      )}
    </>
  );
}
