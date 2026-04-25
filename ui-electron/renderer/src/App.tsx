import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AttachmentMode,
  CasefileSnapshot,
  ChatMessage,
  ContextAttachmentInput,
  RecentContext,
} from "./types";
import { api } from "./lib/api";
import {
  loadRecentContexts,
  setRecentContextPinned,
  upsertRecentContext,
} from "./lib/recentContexts";
import { AppShell } from "./components/AppShell";
import { InputDialog } from "./components/InputDialog";
import {
  EMPTY_CONTEXT_SESSION,
  chatTurnDelta,
  errorMessage,
  normalizeChatTurn,
  sessionKeyFor,
  type ContextSessionState,
} from "./hooks/appModelTypes";
import { useAppShellProps } from "./hooks/useAppShellProps";
import { useComparisons } from "./hooks/useComparisons";
import { useContextAndOverlays } from "./hooks/useContextAndOverlays";
import { useContextWorkspace } from "./hooks/useContextWorkspace";
import { useProviderSettings } from "./hooks/useProviderSettings";

function isPlainEntryName(name: string): boolean {
  return !name.includes("/") && !name.includes("\\");
}

function basenameFromPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function renameSelection(name: string): { start: number; end: number } {
  const dot = name.lastIndexOf(".");
  return { start: 0, end: dot > 0 ? dot : name.length };
}

function joinChildPath(root: string, child: string): string {
  const separator = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${separator}${child}`;
}

export function App(): JSX.Element {
  // ----- Casefile + active context -----
  const [casefile, setCasefile] = useState<CasefileSnapshot | null>(null);
  const [recentContexts, setRecentContexts] = useState<RecentContext[]>(
    () => loadRecentContexts()
  );
  const activeContextId = casefile?.activeContextId ?? null;
  const activeContext = activeContextId
    ? casefile?.contexts.find((context) => context.id === activeContextId) ?? null
    : null;
  // SECURITY (H1): formerly used to gate `allowWriteTools` on the
  // renderer side. With the new approval flow main is the gate, so we
  // no longer need to compute this — kept removed intentionally rather
  // than reintroducing client-side authorisation logic.

  // ----- Global dialog (for menu-bar triggered prompts that need text input) -----
  const [globalDialog, setGlobalDialog] = useState<{
    title: string;
    message?: string;
    defaultValue: string;
    confirmLabel?: string;
    selection?: { start: number; end: number };
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
    selection?: { start: number; end: number };
  }) => Promise<string | null>>();
  promptGlobalRef.current = (opts) =>
    new Promise<string | null>((resolve) => {
      setGlobalDialog({
        title: opts.title,
        message: opts.message,
        defaultValue: opts.defaultValue ?? "",
        confirmLabel: opts.confirmLabel,
        selection: opts.selection,
        resolve,
      });
    });

  const promptGlobal = useCallback(
    (opts: {
      title: string;
      message?: string;
      defaultValue?: string;
      confirmLabel?: string;
      selection?: { start: number; end: number };
    }) =>
      promptGlobalRef.current!(opts),
    []
  );
  const [treeError, setTreeError] = useState<string | null>(null);

  // ----- Per-context in-memory session state -----
  // Keyed by `sessionKeyFor(root, contextId)` (NUL-separated) so multiple
  // casefiles opened in the same session can't bleed into each other,
  // even on exotic paths.
  const [contextSessions, setContextSessions] = useState<Map<string, ContextSessionState>>(
    () => new Map()
  );

  const sessionKey = sessionKeyFor(casefile?.root, activeContext?.sessionId);
  const session: ContextSessionState =
    (sessionKey ? contextSessions.get(sessionKey) : null) ?? EMPTY_CONTEXT_SESSION;
  // Per-context busy flag, sourced directly from session state so that
  // switching contexts mid-request shows the correct spinner on each
  // context and doesn't let one context's response cancel another context's
  // in-flight indicator. (Review item #4.)
  const chatBusy = session.busy;

  const updateSession = useCallback(
    (updater: (prev: ContextSessionState) => ContextSessionState) => {
      if (!sessionKey) return;
      setContextSessions((prev) => {
        const next = new Map(prev);
        const current = next.get(sessionKey) ?? EMPTY_CONTEXT_SESSION;
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
  // ----- Context comparison -----
  const {
    comparisonSessions,
    setActiveComparisonId,
    comparisonChatBusy,
    focusedComparisonSession,
    handleOpenComparisonChat,
    handleUpdateComparisonAttachments,
    handleCloseComparisonChat,
    sendComparisonChat,
    approveComparisonTools,
    denyComparisonTools,
    resetComparisonsForCasefile,
    clearActiveComparisonForContextChat,
  } = useComparisons({
    casefile,
    provider,
    providerModels,
    onError: (message) => setTreeError(message),
  });

  const {
    handleUpdateContextAttachments,
    handleUpdateContext,
    handleRemoveContext,
    handleHardResetCasefile,
    handleSoftResetCasefile,
  } = useContextAndOverlays({
    casefile,
    activeContextId,
    onCasefileChange: setCasefile,
    onError: (message) => setTreeError(message),
  });

  const {
    tree,
    setTree,
    refreshTree,
    loadContextChatHistory,
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
  } = useContextWorkspace({
    casefile,
    activeContext,
    activeContextId,
    session,
    updateSession,
    setContextSessions,
    setTreeError,
  });

  // Two unrelated concerns split into two effects so we re-fetch only
  // what changed. (Review item #20.)
  useEffect(() => {
    if (!activeContextId) {
      setTree(null);
      return;
    }
    void refreshTree();
  }, [activeContextId, refreshTree, setTree]);

  useEffect(() => {
    if (!sessionKey || !activeContextId) return;
    void loadContextChatHistory(activeContextId, sessionKey);
  }, [activeContextId, sessionKey, loadContextChatHistory]);

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

  const handleOpenRecentContext = useCallback(
    async (root: string, preferredContextId: string | null) => {
      try {
        const opened = await api().openCasefile(root);
        let nextSnapshot = opened;
        if (
          preferredContextId &&
          opened.activeContextId !== preferredContextId &&
          opened.contexts.some((context) => context.id === preferredContextId)
        ) {
          nextSnapshot = await api().switchContext(preferredContextId);
        }
        setCasefile(nextSnapshot);
        resetComparisonsForCasefile();
      } catch (error) {
        setTreeError(errorMessage(error));
      }
    },
    [resetComparisonsForCasefile]
  );

  const handleSwitchContext = useCallback(
    async (contextId: string) => {
      if (!casefile || contextId === casefile.activeContextId) return;
      try {
        const snapshot = await api().switchContext(contextId);
        setCasefile(snapshot);
        clearActiveComparisonForContextChat();
      } catch (error) {
        setTreeError(errorMessage(error));
      }
    },
    [casefile, clearActiveComparisonForContextChat]
  );

  useEffect(() => {
    if (!casefile) return;
    setRecentContexts((prev) => upsertRecentContext(prev, casefile));
  }, [casefile]);

  const handleSetRecentPinned = useCallback((root: string, pinned: boolean) => {
    setRecentContexts((prev) => setRecentContextPinned(prev, root, pinned));
  }, []);

  const handleChooseContextRoot = useCallback(async () => {
    return api().chooseContextRoot();
  }, []);

  const handleQuickCapture = useCallback(async () => {
    if (!casefile) return;
    const filename = "quick-capture.md";
    const target = joinChildPath(casefile.root, filename);
    try {
      await api().readFile(target);
      await handleOpenFile(target);
      return;
    } catch {
      // Missing file is the normal first-use path; create it below.
    }
    try {
      const result = await api().createFile(casefile.root, filename);
      await refreshTree();
      await handleOpenFile(result.path);
    } catch (error) {
      setTreeError(errorMessage(error));
    }
  }, [casefile, handleOpenFile, refreshTree]);

  const handleRequestFileRename = useCallback(
    async (path: string) => {
      const currentName = basenameFromPath(path);
      const proposed = await promptGlobal({
        title: "Rename file",
        message: "Enter the new name (no path separators).",
        defaultValue: currentName,
        confirmLabel: "Rename",
        selection: renameSelection(currentName),
      });
      if (proposed == null) return;
      const trimmed = proposed.trim();
      if (!trimmed || trimmed === currentName) return;
      if (!isPlainEntryName(trimmed)) {
        window.alert("Name must not contain path separators ('/' or '\\').");
        return;
      }
      try {
        await handleRenameFile(path, trimmed);
      } catch {
        // handleRenameFile surfaces the error in the workspace banner.
      }
    },
    [handleRenameFile, promptGlobal]
  );

  // ----- Browser-driven context actions -----

  const resetCasefileState = useCallback(() => {
    setCasefile(null);
    setTree(null);
    setTreeError(null);
    setContextSessions(new Map());
    resetComparisonsForCasefile();
  }, [resetComparisonsForCasefile, setTree]);

  const handleCloseCasefile = useCallback(async () => {
    if (!casefile) return;
    try {
      await api().closeCasefile();
      resetCasefileState();
    } catch (error) {
      setTreeError(errorMessage(error));
    }
  }, [casefile, resetCasefileState]);

  const handleCreateContextFromPath = useCallback(
    async (path: string, name: string) => {
      try {
        const snapshot = await api().registerContext({
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

  // Append a new read-only related directory to the active context. The bridge's
  // `updateContextAttachments` is a full-replacement contract, so we
  // re-derive the existing list from the current snapshot instead of
  // assuming caller-side state is fresh.
  const handleAttachToContext = useCallback(
    async (path: string, contextId: string, name: string) => {
      const context = casefile?.contexts.find((l) => l.id === contextId);
      if (!context) return;
      const existing: ContextAttachmentInput[] = (context.attachments ?? []).map(
        (a) => ({ name: a.name, root: a.root, mode: a.mode })
      );
      if (existing.some((a) => a.name === name)) {
        setTreeError(
          `Context "${context.name}" already has an attachment named "${name}".`
        );
        return;
      }
      try {
        await handleUpdateContextAttachments(contextId, [
          ...existing,
          { name, root: path },
        ]);
      } catch {
        // handleUpdateContextAttachments already surfaces via setTreeError.
      }
    },
    [casefile, handleUpdateContextAttachments]
  );

  const handleRemoveAttachment = useCallback(
    async (contextId: string, attName: string) => {
      const context = casefile?.contexts.find((l) => l.id === contextId);
      if (!context) return;
      const updated: ContextAttachmentInput[] = (context.attachments ?? [])
        .filter((a) => a.name !== attName)
        .map((a) => ({ name: a.name, root: a.root, mode: a.mode }));
      try {
        await handleUpdateContextAttachments(contextId, updated);
      } catch {
        // Error surfaces via setTreeError in handleUpdateContextAttachments.
      }
    },
    [casefile, handleUpdateContextAttachments]
  );

  const handleSetAttachmentMode = useCallback(
    async (contextId: string, attName: string, mode: AttachmentMode) => {
      const context = casefile?.contexts.find((l) => l.id === contextId);
      if (!context) return;
      const updated: ContextAttachmentInput[] = (context.attachments ?? []).map((a) =>
        a.name === attName ? { name: a.name, root: a.root, mode } : { name: a.name, root: a.root, mode: a.mode }
      );
      try {
        await handleUpdateContextAttachments(contextId, updated);
      } catch {
        // Error surfaces via setTreeError in handleUpdateContextAttachments.
      }
    },
    [casefile, handleUpdateContextAttachments]
  );

  // ----- Menu-bar IPC handlers -----
  // The Context menu (main.js) sends IPC messages. Each handler carries out
  // the full dialog flow (directory picker → name prompt → register/update).
  // `promptGlobal` renders a global InputDialog in the App's JSX since
  // FileTree's promptForInput is not accessible here.

  useEffect(() => {
    const unsub = api().onOpenCasefile(handleChooseCasefile);
    return unsub;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const unsub = api().onCloseCasefile(() => {
      void handleCloseCasefile();
    });
    return unsub;
  }, [handleCloseCasefile]);

  useEffect(() => {
    const unsub = api().onOpenRecent(() => {
      window.dispatchEvent(new Event("deskassist:open-recent-menu"));
    });
    return unsub;
  }, []);

  useEffect(() => {
    const unsub = api().onNewFile(async () => {
      if (!casefile) return;
      const name = await promptGlobal({
        title: "New file",
        message: "Create a file at the casefile root.",
        defaultValue: "untitled.txt",
        confirmLabel: "Create",
      });
      if (!name?.trim()) return;
      const trimmed = name.trim();
      if (!isPlainEntryName(trimmed)) {
        window.alert("Name must not contain path separators ('/' or '\\').");
        return;
      }
      try {
        await handleCreateFile(casefile.root, trimmed);
      } catch {
        // surfaced via setTreeError
      }
    });
    return unsub;
  }, [casefile, handleCreateFile, promptGlobal]);

  useEffect(() => {
    const unsub = api().onNewFolder(async () => {
      if (!casefile) return;
      const name = await promptGlobal({
        title: "New folder",
        message: "Create a folder at the casefile root.",
        defaultValue: "new-folder",
        confirmLabel: "Create",
      });
      if (!name?.trim()) return;
      const trimmed = name.trim();
      if (!isPlainEntryName(trimmed)) {
        window.alert("Name must not contain path separators ('/' or '\\').");
        return;
      }
      try {
        await handleCreateFolder(casefile.root, trimmed);
      } catch {
        // surfaced via setTreeError
      }
    });
    return unsub;
  }, [casefile, handleCreateFolder, promptGlobal]);

  useEffect(() => {
    const unsub = api().onContextCreate(async () => {
      if (!casefile) return;
      const root = await handleChooseContextRoot();
      if (!root) return;
      const defaultName = root.split(/[\\/]/).pop() ?? "context";
      const name = await promptGlobal({
        title: "Create context",
        message: "Name for the new context.",
        defaultValue: defaultName,
        confirmLabel: "Create context",
      });
      if (!name?.trim()) return;
      try {
        await handleCreateContextFromPath(root, name.trim());
      } catch {
        // surfaced via setTreeError
      }
    });
    return unsub;
  // handleChooseContextRoot and handleCreateContextFromPath are stable useCallback refs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [casefile, promptGlobal]);

  useEffect(() => {
    const unsub = api().onContextAttach(async () => {
      if (!casefile || casefile.contexts.length === 0) return;
      const root = await handleChooseContextRoot();
      if (!root) return;
      // Ask which context to attach to.
      const contextNames = casefile.contexts.map((l) => l.name).join(" / ");
      const contextName = await promptGlobal({
        title: "Attach to context",
        message: `Enter the context name to attach to (${contextNames}):`,
        defaultValue: casefile.contexts[0]?.name ?? "",
        confirmLabel: "Next",
      });
      if (!contextName?.trim()) return;
      const targetContext = casefile.contexts.find(
        (l) => l.name.toLowerCase() === contextName.trim().toLowerCase()
      );
      if (!targetContext) {
        setTreeError(`No context named "${contextName.trim()}".`);
        return;
      }
      const defaultLabel = root.split(/[\\/]/).pop() ?? "attachment";
      const label = await promptGlobal({
        title: `Attach to "${targetContext.name}"`,
        message: "Attachment label — how this directory will be referenced in scope.",
        defaultValue: defaultLabel,
        confirmLabel: "Attach",
      });
      if (!label?.trim()) return;
      try {
        await handleAttachToContext(root, targetContext.id, label.trim());
      } catch {
        // surfaced via setTreeError
      }
    });
    return unsub;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [casefile, promptGlobal]);

  useEffect(() => {
    const unsub = api().onContextRename(async () => {
      if (!activeContext) return;
      const name = await promptGlobal({
        title: "Rename context",
        message: "Enter the new context name.",
        defaultValue: activeContext.name,
        confirmLabel: "Rename",
      });
      if (!name?.trim() || name.trim() === activeContext.name) return;
      try {
        await handleUpdateContext(activeContext.id, { name: name.trim() });
      } catch {
        // surfaced via setTreeError
      }
    });
    return unsub;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeContext, promptGlobal]);

  useEffect(() => {
    const unsub = api().onContextToggleAccess(() => {
      if (!activeContext) return;
      const isWritable = activeContext.writable !== false;
      void handleUpdateContext(activeContext.id, { writable: !isWritable });
    });
    return unsub;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeContext]);

  useEffect(() => {
    const unsub = api().onContextCompare(async () => {
      if (!casefile || !activeContext) return;
      const others = casefile.contexts.filter((context) => context.id !== activeContext.id);
      if (others.length === 0) return;
      if (others.length === 1) {
        await handleOpenComparisonChat([activeContext.id, others[0].id]);
        return;
      }
      const contextNames = others.map((context) => context.name).join(" / ");
      const selected = await promptGlobal({
        title: "Compare contexts",
        message: `Enter context names, separated by commas, to compare with "${activeContext.name}" (${contextNames}).`,
        defaultValue: others[0]?.name ?? "",
        confirmLabel: "Compare",
      });
      if (!selected?.trim()) return;
      const selectedNames = selected
        .split(",")
        .map((name) => name.trim().toLowerCase())
        .filter(Boolean);
      const selectedIds = others
        .filter((context) => selectedNames.includes(context.name.toLowerCase()))
        .map((context) => context.id);
      if (selectedIds.length === 0) {
        setTreeError(`No matching context named "${selected.trim()}".`);
        return;
      }
      await handleOpenComparisonChat([activeContext.id, ...selectedIds]);
    });
    return unsub;
  }, [activeContext, casefile, handleOpenComparisonChat, promptGlobal]);

  useEffect(() => {
    const unsub = api().onContextRemove(() => {
      if (!activeContext) return;
      const ok = window.confirm(
        `Remove context "${activeContext.name}"?\n\nThis removes it from the workspace but does not delete any files.`
      );
      if (!ok) return;
      void handleRemoveContext(activeContext.id);
    });
    return unsub;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeContext]);

  useEffect(() => {
    const unsub = api().onCasefileSoftReset(() => {
      if (!casefile) return;
      const ok = window.confirm(
        "Soft reset clears context registrations and chat history metadata. Files on disk are preserved."
      );
      if (!ok) return;
      void handleSoftResetCasefile();
    });
    return unsub;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [casefile]);

  useEffect(() => {
    const unsub = api().onCasefileHardReset(() => {
      if (!casefile) return;
      const ok = window.confirm(
        "Hard reset deletes the workspace metadata folder (.casefile).\n\nConversation history, context registrations, and settings will be permanently removed. Files on disk are preserved.\n\nThis cannot be undone. Continue?"
      );
      if (!ok) return;
      void handleHardResetCasefile();
    });
    return unsub;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [casefile]);

  // ----- Chat -----

  const sendMessage = useCallback(
    async (text: string) => {
      const value = text.trim();
      if (!value) return;
      if (!casefile || !activeContextId) return;
      // Race-safe begin: if another send for THIS context is already in
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
      activeContextId,
      updateSession,
      provider,
      providerModels,
      refreshTree,
      refreshOpenTabsFromDisk,
    ]
  );

  const approveTools = useCallback(async () => {
    if (!casefile || !activeContextId) return;
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
      // SECURITY (H1): use the dedicated approval IPC rather than
      // overloading `sendChat` with `allowWriteTools=true`. Main gates
      // this call on a stored, bridge-issued approval token, so a
      // future renderer compromise can no longer execute write tools
      // by setting a flag on a regular send.
      const response = await api().approveAndResumeChat({
        provider,
        model: providerModels[provider] || null,
        messages: historyBeforeTurn,
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
    activeContextId,
    provider,
    providerModels,
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
      activeContext,
      activeContextId,
      activeFilePath,
      provider,
      keyStatus,
      providerModels,
      recentContexts,
      tree,
      treeError,
      comparisonSessions,
      focusedComparisonSession,
      sessionTabs: session.tabs,
      sessionActiveTabKey: session.activeTabKey,
      sessionMessages: session.messages,
      sessionPendingApprovals: session.pendingApprovals,
      chatBusy,
      comparisonChatBusy,
    },
    actions: {
      onProviderChange: setProvider,
      onChooseCasefile: handleChooseCasefile,
      onCloseCasefile: handleCloseCasefile,
      onOpenRecentContext: handleOpenRecentContext,
      onSetRecentPinned: handleSetRecentPinned,
      onSwitchContext: handleSwitchContext,
      onQuickCapture: handleQuickCapture,
      onStatusChange: setKeyStatus,
      onModelsChange: setProviderModels,
      onOpenFile: handleOpenFile,
      onRename: handleRenameFile,
      onRequestFileRename: handleRequestFileRename,
      onRefreshTree: refreshTreeAction,
      onDismissTreeError: () => setTreeError(null),
      onCreateFile: handleCreateFile,
      onCreateFolder: handleCreateFolder,
      onMoveEntry: handleMoveEntry,
      onTrashEntry: handleTrashEntry,
      onCreateContextFromPath: handleCreateContextFromPath,
      onAttachToContext: handleAttachToContext,
      onAddAttachment: handleAttachToContext,
      onSelectTab: handleSelectTab,
      onCloseTab: handleCloseTab,
      onEditTab: handleEditTab,
      onSaveTab: handleSaveTab,
      onSelectComparisonSession: setActiveComparisonId,
      onCloseComparisonChat: handleCloseComparisonChat,
      onSendMessage: sendMessage,
      onApproveTools: approveTools,
      onDenyTools: denyTools,
      onSendComparisonChat: sendComparisonChat,
      onApproveComparisonTools: approveComparisonTools,
      onDenyComparisonTools: denyComparisonTools,
      onOpenComparisonChat: handleOpenComparisonChat,
      onUpdateComparisonAttachments: handleUpdateComparisonAttachments,
      onUpdateContext: handleUpdateContext,
      onRemoveContext: handleRemoveContext,
      onHardResetCasefile: handleHardResetCasefile,
      onSoftResetCasefile: handleSoftResetCasefile,
      onUpdateContextName: async (contextId: string, newName: string) => {
        await handleUpdateContext(contextId, { name: newName });
      },
      onSetContextWritable: async (contextId: string, writable: boolean) => {
        await handleUpdateContext(contextId, { writable });
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
          selection={globalDialog.selection}
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
