import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ApiKeyStatus,
  CasefileSnapshot,
  ChatMessage,
  ComparisonSession,
  ContextManifestDto,
  ExportResult,
  FindingDraft,
  FindingDto,
  FileTreeNode,
  LaneAttachmentInput,
  LaneComparisonDto,
  OverlayTreeDto,
  Provider,
  RegisterLaneInput,
  ToolCall,
} from "./types";
import { api } from "./lib/api";
import { Toolbar } from "./components/Toolbar";
import { FileTree } from "./components/FileTree";
import { EditorPane, type OpenTab } from "./components/EditorPane";
import { RightPanel, type RightTabKey } from "./components/RightPanel";
import { ApiKeysDialog } from "./components/ApiKeysDialog";
import { languageFromPath } from "./lib/language";

const PROVIDER_STORAGE_KEY = "deskassist.selectedProvider";
const NOTES_DEBOUNCE_MS = 600;

const DEFAULT_KEY_STATUS: ApiKeyStatus = {
  openaiConfigured: false,
  anthropicConfigured: false,
  deepseekConfigured: false,
  storageBackend: "file",
};

interface LaneSessionState {
  messages: ChatMessage[];
  pendingApprovals: ToolCall[];
  tabs: OpenTab[];
  activeTabKey: string | null;
}

const EMPTY_LANE_SESSION: LaneSessionState = {
  messages: [],
  pendingApprovals: [],
  tabs: [],
  activeTabKey: null,
};

interface NoteState {
  content: string;
  loading: boolean;
  saving: boolean;
  error: string | null;
  // Original fetched value, used to skip empty saves and to detect dirty.
  baseline: string;
}

const EMPTY_NOTE_STATE: NoteState = {
  content: "",
  loading: false,
  saving: false,
  error: null,
  baseline: "",
};

function diffTabKey(leftId: string, rightId: string, path: string): string {
  return `diff:${leftId}\u21D4${rightId}:${path}`;
}

export function App(): JSX.Element {
  // ----- Casefile + active lane -----

  const [casefile, setCasefile] = useState<CasefileSnapshot | null>(null);
  const activeLaneId = casefile?.activeLaneId ?? null;
  const activeLane = activeLaneId
    ? casefile?.lanes.find((lane) => lane.id === activeLaneId) ?? null
    : null;

  // ----- File tree -----

  const [tree, setTree] = useState<FileTreeNode | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);

  // ----- Per-lane in-memory session state -----
  // Keyed by `${casefileRoot}::${laneId}` so multiple casefiles opened in the
  // same session don't bleed into each other.

  const [laneSessions, setLaneSessions] = useState<Map<string, LaneSessionState>>(
    () => new Map()
  );

  const sessionKey = casefile && activeLaneId ? `${casefile.root}::${activeLaneId}` : null;
  const session: LaneSessionState =
    (sessionKey ? laneSessions.get(sessionKey) : null) ?? EMPTY_LANE_SESSION;

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

  // ----- Right panel + chat busy + provider selection -----

  const [rightTab, setRightTab] = useState<RightTabKey>("chat");
  const [chatBusy, setChatBusy] = useState(false);

  const [provider, setProvider] = useState<Provider>(() => {
    const saved = localStorage.getItem(PROVIDER_STORAGE_KEY) as Provider | null;
    return saved ?? "openai";
  });
  useEffect(() => {
    localStorage.setItem(PROVIDER_STORAGE_KEY, provider);
  }, [provider]);

  // ----- Notes (per-lane, disk-backed) -----

  const [notesByLane, setNotesByLane] = useState<Map<string, NoteState>>(() => new Map());
  const noteState = sessionKey ? notesByLane.get(sessionKey) ?? EMPTY_NOTE_STATE : EMPTY_NOTE_STATE;
  const updateNote = useCallback(
    (key: string, updater: (prev: NoteState) => NoteState) => {
      setNotesByLane((prev) => {
        const next = new Map(prev);
        const current = next.get(key) ?? EMPTY_NOTE_STATE;
        next.set(key, updater(current));
        return next;
      });
    },
    []
  );

  // Debounced save: each keystroke schedules a save NOTES_DEBOUNCE_MS in the
  // future; if another keystroke lands first, the prior timer is cancelled.
  // This avoids hammering the disk on every character without losing data
  // because (a) the timer is short and (b) we also save on lane switch.
  const noteSaveTimers = useRef<Map<string, number>>(new Map());

  const flushNoteSave = useCallback(
    async (key: string, laneId: string, content: string) => {
      updateNote(key, (prev) => ({ ...prev, saving: true, error: null }));
      try {
        await api().saveNote(laneId, content);
        updateNote(key, (prev) => ({
          ...prev,
          saving: false,
          baseline: content,
        }));
      } catch (error) {
        updateNote(key, (prev) => ({
          ...prev,
          saving: false,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    },
    [updateNote]
  );

  const scheduleNoteSave = useCallback(
    (key: string, laneId: string, content: string) => {
      const timers = noteSaveTimers.current;
      const existing = timers.get(key);
      if (existing) window.clearTimeout(existing);
      const handle = window.setTimeout(() => {
        timers.delete(key);
        void flushNoteSave(key, laneId, content);
      }, NOTES_DEBOUNCE_MS);
      timers.set(key, handle);
    },
    [flushNoteSave]
  );

  const handleNoteChange = useCallback(
    (next: string) => {
      if (!sessionKey || !activeLaneId) return;
      updateNote(sessionKey, (prev) => ({ ...prev, content: next }));
      scheduleNoteSave(sessionKey, activeLaneId, next);
    },
    [activeLaneId, sessionKey, scheduleNoteSave, updateNote]
  );

  // ----- Findings (per-casefile) -----

  const [findings, setFindings] = useState<FindingDto[]>([]);
  const [findingsBusy, setFindingsBusy] = useState(false);
  const [lastExport, setLastExport] = useState<ExportResult | null>(null);

  const reloadFindings = useCallback(async () => {
    if (!casefile) {
      setFindings([]);
      return;
    }
    try {
      // Pull all findings; the FindingsTab does its own client-side filter.
      const list = await api().listFindings();
      setFindings(list);
    } catch (error) {
      console.warn("listFindings failed", error);
    }
  }, [casefile]);

  // ----- Lane comparison -----

  const [comparison, setComparison] = useState<LaneComparisonDto | null>(null);
  const [comparisonBusy, setComparisonBusy] = useState(false);

  // ----- M3.5c: comparison chat session (read-only multi-lane) -----
  const [comparisonSession, setComparisonSession] =
    useState<ComparisonSession | null>(null);
  const [comparisonChatBusy, setComparisonChatBusy] = useState(false);

  // ----- M3.5: casefile context manifest + ancestor-files overlays -----

  const [contextManifest, setContextManifest] = useState<ContextManifestDto | null>(null);
  const [contextBusy, setContextBusy] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);

  const reloadContext = useCallback(async () => {
    if (!casefile) {
      setContextManifest(null);
      return;
    }
    try {
      const next = await api().getContext();
      setContextManifest(next);
      setContextError(null);
    } catch (error) {
      setContextError(error instanceof Error ? error.message : String(error));
    }
  }, [casefile]);

  const handleSaveContext = useCallback(
    async (manifest: { files: string[]; autoIncludeMaxBytes: number }) => {
      setContextBusy(true);
      try {
        const saved = await api().saveContext(manifest);
        setContextManifest(saved);
        setContextError(null);
      } catch (error) {
        setContextError(error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        setContextBusy(false);
      }
    },
    []
  );

  const handleSetLaneParent = useCallback(
    async (laneId: string, parentId: string | null) => {
      try {
        const snapshot = await api().setLaneParent(laneId, parentId);
        setCasefile(snapshot);
      } catch (error) {
        setTreeError(error instanceof Error ? error.message : String(error));
        throw error;
      }
    },
    []
  );

  const handleUpdateLaneAttachments = useCallback(
    async (laneId: string, attachments: LaneAttachmentInput[]) => {
      try {
        const snapshot = await api().updateLaneAttachments(laneId, attachments);
        setCasefile(snapshot);
      } catch (error) {
        setTreeError(error instanceof Error ? error.message : String(error));
        throw error;
      }
    },
    []
  );

  const [showOverlays, setShowOverlays] = useState(false);
  const [overlayTrees, setOverlayTrees] = useState<OverlayTreeDto[]>([]);
  const [overlaysLoading, setOverlaysLoading] = useState(false);
  const [overlaysError, setOverlaysError] = useState<string | null>(null);

  const reloadOverlays = useCallback(async () => {
    if (!casefile || !activeLaneId || !showOverlays) {
      setOverlayTrees([]);
      return;
    }
    setOverlaysLoading(true);
    try {
      const overlays = await api().listOverlayTrees(activeLaneId, 4);
      setOverlayTrees(overlays);
      setOverlaysError(null);
    } catch (error) {
      setOverlaysError(error instanceof Error ? error.message : String(error));
    } finally {
      setOverlaysLoading(false);
    }
  }, [casefile, activeLaneId, showOverlays]);

  // ----- API keys -----

  const [keyStatus, setKeyStatus] = useState<ApiKeyStatus>(DEFAULT_KEY_STATUS);
  const [keysOpen, setKeysOpen] = useState(false);

  const refreshKeyStatus = useCallback(async () => {
    try {
      const status = await api().getApiKeyStatus();
      setKeyStatus(status);
      const configured: Provider[] = [];
      if (status.openaiConfigured) configured.push("openai");
      if (status.anthropicConfigured) configured.push("anthropic");
      if (status.deepseekConfigured) configured.push("deepseek");
      if (configured.length === 1 && !configured.includes(provider)) {
        setProvider(configured[0]);
      }
    } catch (error) {
      console.warn("getApiKeyStatus failed", error);
    }
  }, [provider]);

  useEffect(() => {
    void refreshKeyStatus();
    const remove = api().onOpenApiKeys(() => setKeysOpen(true));
    return () => {
      remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ----- File tree -----

  const refreshTree = useCallback(async () => {
    if (!activeLane) {
      setTree(null);
      return;
    }
    try {
      const next = await api().listWorkspace(4);
      setTree(next);
      setTreeError(null);
    } catch (error) {
      setTreeError(error instanceof Error ? error.message : String(error));
    }
  }, [activeLane]);

  // ----- Lane chat history loader -----

  const loadLaneChatHistory = useCallback(async (laneId: string, key: string) => {
    try {
      const persisted = await api().listChat(laneId);
      // Only seed the in-memory history for a lane the *first* time we see it
      // in this session; otherwise the user's optimistic state would clobber.
      setLaneSessions((prev) => {
        if (prev.has(key)) return prev;
        const next = new Map(prev);
        next.set(key, { ...EMPTY_LANE_SESSION, messages: persisted });
        return next;
      });
    } catch (error) {
      console.warn("listChat failed", error);
    }
  }, []);

  // ----- Notes loader -----

  const loadLaneNotes = useCallback(async (laneId: string, key: string) => {
    setNotesByLane((prev) => {
      if (prev.has(key)) return prev;
      const next = new Map(prev);
      next.set(key, { ...EMPTY_NOTE_STATE, loading: true });
      return next;
    });
    try {
      const content = await api().getNote(laneId);
      setNotesByLane((prev) => {
        const next = new Map(prev);
        next.set(key, {
          content,
          baseline: content,
          loading: false,
          saving: false,
          error: null,
        });
        return next;
      });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      setNotesByLane((prev) => {
        const next = new Map(prev);
        const current = next.get(key) ?? EMPTY_NOTE_STATE;
        next.set(key, { ...current, loading: false, error: errMsg });
        return next;
      });
    }
  }, []);

  // Whenever the active lane changes, refresh tree, seed chat history, load notes.
  useEffect(() => {
    if (!casefile || !activeLaneId) {
      setTree(null);
      return;
    }
    void refreshTree();
    const key = `${casefile.root}::${activeLaneId}`;
    void loadLaneChatHistory(activeLaneId, key);
    void loadLaneNotes(activeLaneId, key);
  }, [casefile, activeLaneId, refreshTree, loadLaneChatHistory, loadLaneNotes]);

  // Reload findings whenever the casefile changes.
  useEffect(() => {
    void reloadFindings();
  }, [reloadFindings]);

  // Reload context manifest whenever the casefile changes.
  useEffect(() => {
    void reloadContext();
  }, [reloadContext]);

  // Reload overlay trees whenever the active lane changes (or the toggle
  // flips on); refresh is also implicit after registerLane / setParent /
  // updateAttachments because those replace the casefile snapshot.
  useEffect(() => {
    void reloadOverlays();
  }, [reloadOverlays]);

  // ----- Casefile ops -----

  const handleChooseCasefile = useCallback(async () => {
    try {
      const snapshot = await api().chooseCasefile();
      if (snapshot) {
        setCasefile(snapshot);
        // Switching casefile invalidates any prior comparison.
        setComparison(null);
      }
    } catch (error) {
      setTreeError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const handleSwitchLane = useCallback(
    async (laneId: string) => {
      if (!casefile || laneId === casefile.activeLaneId) return;
      try {
        const snapshot = await api().switchLane(laneId);
        setCasefile(snapshot);
      } catch (error) {
        setTreeError(error instanceof Error ? error.message : String(error));
      }
    },
    [casefile]
  );

  const handleRegisterLane = useCallback(async (input: RegisterLaneInput) => {
    try {
      const snapshot = await api().registerLane(input);
      setCasefile(snapshot);
    } catch (error) {
      setTreeError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }, []);

  const handleChooseLaneRoot = useCallback(async () => {
    return api().chooseLaneRoot();
  }, []);

  // ----- Editor tabs (per-lane) -----

  const handleOpenFile = useCallback(
    async (filePath: string) => {
      // For the active lane, file tabs use `path` as the key.
      if (session.tabs.some((t) => t.kind === "file" && t.path === filePath)) {
        updateSession((prev) => ({ ...prev, activeTabKey: filePath }));
        return;
      }
      try {
        const result = await api().readFile(filePath);
        updateSession((prev) => ({
          ...prev,
          tabs: [
            ...prev.tabs,
            {
              kind: "file",
              key: result.path,
              path: result.path,
              content: result.content,
              savedContent: result.content,
              truncated: result.truncated,
            },
          ],
          activeTabKey: result.path,
        }));
      } catch (error) {
        setTreeError(error instanceof Error ? error.message : String(error));
      }
    },
    [session.tabs, updateSession]
  );

  const handleSelectTab = useCallback(
    (key: string) => {
      updateSession((prev) => ({ ...prev, activeTabKey: key }));
    },
    [updateSession]
  );

  const handleCloseTab = useCallback(
    (key: string) => {
      updateSession((prev) => {
        const remainingTabs = prev.tabs.filter((t) => t.key !== key);
        const nextActive =
          prev.activeTabKey === key
            ? remainingTabs.length > 0
              ? remainingTabs[remainingTabs.length - 1].key
              : null
            : prev.activeTabKey;
        return { ...prev, tabs: remainingTabs, activeTabKey: nextActive };
      });
    },
    [updateSession]
  );

  const handleEditTab = useCallback(
    (key: string, content: string) => {
      updateSession((prev) => ({
        ...prev,
        tabs: prev.tabs.map((t) =>
          t.kind === "file" && t.key === key ? { ...t, content } : t
        ),
      }));
    },
    [updateSession]
  );

  const handleSaveTab = useCallback(
    async (key: string) => {
      const tab = session.tabs.find((t) => t.key === key);
      if (!tab || tab.kind !== "file") return;
      try {
        await api().saveFile(tab.path, tab.content);
        updateSession((prev) => ({
          ...prev,
          tabs: prev.tabs.map((t) =>
            t.kind === "file" && t.key === key
              ? { ...t, savedContent: t.content, truncated: false }
              : t
          ),
        }));
        void refreshTree();
      } catch (error) {
        setTreeError(error instanceof Error ? error.message : String(error));
      }
    },
    [session.tabs, updateSession, refreshTree]
  );

  const refreshOpenTabsFromDisk = useCallback(async () => {
    if (session.tabs.length === 0) return;
    const fresh = await Promise.all(
      session.tabs.map(async (t) => {
        if (t.kind !== "file") return t;
        if (t.content !== t.savedContent || t.truncated) return t;
        try {
          const result = await api().readFile(t.path);
          return {
            ...t,
            content: result.content,
            savedContent: result.content,
            truncated: result.truncated,
          };
        } catch {
          return t;
        }
      })
    );
    updateSession((prev) => ({ ...prev, tabs: fresh }));
  }, [session.tabs, updateSession]);

  // ----- Compare flow -----

  const handleCompareLanes = useCallback(
    async (leftLaneId: string, rightLaneId: string) => {
      if (!casefile) return;
      setComparisonBusy(true);
      try {
        const result = await api().compareLanes(leftLaneId, rightLaneId);
        setComparison(result);
      } catch (error) {
        setTreeError(error instanceof Error ? error.message : String(error));
      } finally {
        setComparisonBusy(false);
      }
    },
    [casefile]
  );

  const handleClearComparison = useCallback(() => setComparison(null), []);

  // ----- Comparison chat (M3.5c) -----

  const handleOpenComparisonChat = useCallback(
    async (laneIds: string[]) => {
      if (!casefile || laneIds.length < 2) return;
      try {
        const session = await api().openComparison(laneIds);
        setComparisonSession(session);
        setRightTab("compare");
      } catch (error) {
        setTreeError(error instanceof Error ? error.message : String(error));
      }
    },
    [casefile]
  );

  const handleCloseComparisonChat = useCallback(() => {
    setComparisonSession(null);
  }, []);

  const sendComparisonChat = useCallback(
    async (text: string) => {
      const value = text.trim();
      if (!value || comparisonChatBusy || !comparisonSession || !casefile) return;
      setComparisonChatBusy(true);
      const historyBeforeTurn = comparisonSession.messages;
      // Optimistically render the user's message; the bridge will replace
      // history with the canonical delta on success.
      setComparisonSession((prev) =>
        prev
          ? { ...prev, messages: [...prev.messages, { role: "user", content: value }] }
          : prev
      );
      try {
        const response = await api().sendComparisonChat({
          laneIds: comparisonSession.laneIds,
          provider,
          messages: historyBeforeTurn,
          userMessage: value,
          resumePendingToolCalls: false,
        });
        const delta = Array.isArray(response.messages) ? response.messages : [];
        setComparisonSession((prev) =>
          prev
            ? {
                ...prev,
                messages:
                  delta.length > 0
                    ? [...historyBeforeTurn, ...delta]
                    : response.message
                      ? [
                          ...historyBeforeTurn,
                          { role: "user", content: value },
                          response.message,
                        ]
                      : prev.messages,
              }
            : prev
        );
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        setComparisonSession((prev) =>
          prev
            ? {
                ...prev,
                messages: [
                  ...historyBeforeTurn,
                  { role: "user", content: value },
                  { role: "assistant", content: `Error: ${errMsg}` },
                ],
              }
            : prev
        );
      } finally {
        setComparisonChatBusy(false);
      }
    },
    [casefile, comparisonChatBusy, comparisonSession, provider]
  );

  const handleOpenDiff = useCallback(
    async (path: string) => {
      if (!comparison || !casefile) return;
      const left = casefile.lanes.find((l) => l.id === comparison.leftLaneId);
      const right = casefile.lanes.find((l) => l.id === comparison.rightLaneId);
      if (!left || !right) return;
      const key = diffTabKey(comparison.leftLaneId, comparison.rightLaneId, path);
      // Already open? Just focus it.
      if (session.tabs.some((t) => t.key === key)) {
        updateSession((prev) => ({ ...prev, activeTabKey: key }));
        return;
      }
      try {
        const [leftRead, rightRead] = await Promise.all([
          api().readLaneFile(comparison.leftLaneId, path),
          api().readLaneFile(comparison.rightLaneId, path),
        ]);
        updateSession((prev) => ({
          ...prev,
          tabs: [
            ...prev.tabs,
            {
              kind: "diff",
              key,
              path,
              leftLaneId: comparison.leftLaneId,
              rightLaneId: comparison.rightLaneId,
              leftLaneName: left.name,
              rightLaneName: right.name,
              leftContent: leftRead.content,
              rightContent: rightRead.content,
              language: languageFromPath(path),
            },
          ],
          activeTabKey: key,
        }));
      } catch (error) {
        setTreeError(error instanceof Error ? error.message : String(error));
      }
    },
    [casefile, comparison, session.tabs, updateSession]
  );

  const handleOpenOverlayFile = useCallback(
    async (virtualPath: string) => {
      // Overlay files (`_ancestors/...`, `_attachments/...`, `_context/...`)
      // are read-only views; they're opened as a regular tab keyed by their
      // virtual path, with savedContent === content so the editor treats
      // them as clean. Saves still go through the active lane only.
      if (!casefile || !activeLaneId) return;
      const key = `overlay:${virtualPath}`;
      if (session.tabs.some((t) => t.key === key)) {
        updateSession((prev) => ({ ...prev, activeTabKey: key }));
        return;
      }
      try {
        const result = await api().readOverlayFile(activeLaneId, virtualPath);
        updateSession((prev) => ({
          ...prev,
          tabs: [
            ...prev.tabs,
            {
              kind: "file",
              key,
              path: virtualPath,
              content: result.content,
              savedContent: result.content,
              truncated: result.truncated,
            },
          ],
          activeTabKey: key,
        }));
      } catch (error) {
        setTreeError(error instanceof Error ? error.message : String(error));
      }
    },
    [casefile, activeLaneId, session.tabs, updateSession]
  );

  const handleOpenLaneFile = useCallback(
    async (laneId: string, path: string) => {
      // For files in lanes other than the active one, we open as a read-only
      // file tab keyed by `lane:<id>:<path>`. Switching lanes is a richer UX
      // step; this just lets the user inspect the file in place.
      if (!casefile) return;
      const lane = casefile.lanes.find((l) => l.id === laneId);
      if (!lane) return;
      const key = `lane:${laneId}:${path}`;
      if (session.tabs.some((t) => t.key === key)) {
        updateSession((prev) => ({ ...prev, activeTabKey: key }));
        return;
      }
      try {
        const result = await api().readLaneFile(laneId, path);
        updateSession((prev) => ({
          ...prev,
          tabs: [
            ...prev.tabs,
            {
              kind: "file",
              key,
              path: result.path,
              content: result.content,
              // savedContent === content keeps it "clean"; this view is for
              // inspection, not editing (saves go through the active lane).
              savedContent: result.content,
              truncated: result.truncated,
            },
          ],
          activeTabKey: key,
        }));
      } catch (error) {
        setTreeError(error instanceof Error ? error.message : String(error));
      }
    },
    [casefile, session.tabs, updateSession]
  );

  // ----- Findings ops -----

  const handleCreateFinding = useCallback(
    async (draft: FindingDraft) => {
      setFindingsBusy(true);
      try {
        await api().createFinding(draft);
        await reloadFindings();
      } finally {
        setFindingsBusy(false);
      }
    },
    [reloadFindings]
  );

  const handleUpdateFinding = useCallback(
    async (id: string, draft: Partial<FindingDraft>) => {
      setFindingsBusy(true);
      try {
        await api().updateFinding(id, draft);
        await reloadFindings();
      } finally {
        setFindingsBusy(false);
      }
    },
    [reloadFindings]
  );

  const handleDeleteFinding = useCallback(
    async (id: string) => {
      setFindingsBusy(true);
      try {
        await api().deleteFinding(id);
        await reloadFindings();
      } finally {
        setFindingsBusy(false);
      }
    },
    [reloadFindings]
  );

  const handleExportFindings = useCallback(async (laneIds: string[]) => {
    setFindingsBusy(true);
    try {
      const result = await api().exportFindings(laneIds);
      setLastExport(result);
    } catch (error) {
      setTreeError(error instanceof Error ? error.message : String(error));
    } finally {
      setFindingsBusy(false);
    }
  }, []);

  // ----- Chat -----

  // We keep the latest user-typed text outside of state to make sendMessage
  // stable across renders without being re-bound when messages change.
  const lastSentRef = useRef<string>("");

  const sendMessage = useCallback(
    async (text: string) => {
      const value = text.trim();
      if (!value || chatBusy) return;
      if (!casefile || !activeLaneId) return;
      lastSentRef.current = value;
      setChatBusy(true);
      const historyBeforeTurn = session.messages;
      updateSession((prev) => ({
        ...prev,
        messages: [...prev.messages, { role: "user", content: value }],
        pendingApprovals: [],
      }));
      try {
        const response = await api().sendChat({
          provider,
          messages: historyBeforeTurn,
          userMessage: value,
          allowWriteTools: false,
          resumePendingToolCalls: false,
        });
        const delta = Array.isArray(response.messages) ? response.messages : [];
        const nextMessages =
          delta.length > 0
            ? [...historyBeforeTurn, ...delta]
            : response.message
              ? [...historyBeforeTurn, { role: "user" as const, content: value }, response.message]
              : [
                  ...historyBeforeTurn,
                  { role: "user" as const, content: value },
                  { role: "assistant" as const, content: "Error: empty bridge response" },
                ];
        const nextPending = Array.isArray(response.pendingApprovals)
          ? response.pendingApprovals
          : [];
        updateSession((prev) => ({
          ...prev,
          messages: nextMessages,
          pendingApprovals: nextPending,
        }));
        await refreshTree();
        await refreshOpenTabsFromDisk();
        // The model may have created findings via a write tool we don't
        // expose yet, but findings_list/_read are read-only — refresh to
        // catch any out-of-band changes (e.g. user editing a JSON file
        // directly under .casefile/findings/).
        await reloadFindings();
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        updateSession((prev) => ({
          ...prev,
          messages: [
            ...historyBeforeTurn,
            { role: "user", content: value },
            { role: "assistant", content: `Error: ${errMsg}` },
          ],
        }));
      } finally {
        setChatBusy(false);
      }
    },
    [
      chatBusy,
      casefile,
      activeLaneId,
      session.messages,
      updateSession,
      provider,
      refreshTree,
      refreshOpenTabsFromDisk,
      reloadFindings,
    ]
  );

  const approveTools = useCallback(async () => {
    if (session.pendingApprovals.length === 0 || !casefile || !activeLaneId) return;
    setChatBusy(true);
    const historyBeforeTurn = session.messages;
    try {
      const response = await api().sendChat({
        provider,
        messages: historyBeforeTurn,
        userMessage: "",
        allowWriteTools: true,
        resumePendingToolCalls: true,
      });
      const delta = Array.isArray(response.messages) ? response.messages : [];
      updateSession((prev) => ({
        ...prev,
        messages: [...historyBeforeTurn, ...delta],
        pendingApprovals: [],
      }));
      await refreshTree();
      await refreshOpenTabsFromDisk();
      await reloadFindings();
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      updateSession((prev) => ({
        ...prev,
        messages: [
          ...prev.messages,
          { role: "assistant", content: `Error: ${errMsg}` },
        ],
        pendingApprovals: [],
      }));
    } finally {
      setChatBusy(false);
    }
  }, [
    session.pendingApprovals,
    session.messages,
    casefile,
    activeLaneId,
    provider,
    updateSession,
    refreshTree,
    refreshOpenTabsFromDisk,
    reloadFindings,
  ]);

  const denyTools = useCallback(() => {
    if (session.pendingApprovals.length === 0) return;
    updateSession((prev) => ({
      ...prev,
      messages: [
        ...prev.messages,
        { role: "assistant", content: "Write operation request denied." },
      ],
      pendingApprovals: [],
    }));
  }, [session.pendingApprovals, updateSession]);

  // FileTree highlighting only makes sense for file tabs (not diff tabs).
  const activeFilePath =
    session.tabs.find((t) => t.key === session.activeTabKey && t.kind === "file")?.path ?? null;

  return (
    <div className="app">
      <Toolbar
        casefile={casefile}
        provider={provider}
        onProviderChange={setProvider}
        keyStatus={keyStatus}
        onChooseCasefile={handleChooseCasefile}
        onOpenKeys={() => setKeysOpen(true)}
        onSwitchLane={handleSwitchLane}
      />
      <div className="workbench">
        <section className="pane">
          <header className="pane-header">{activeLane ? activeLane.name : "Workspace"}</header>
          <div className="pane-body">
            <FileTree
              root={tree}
              activePath={activeFilePath}
              onOpenFile={handleOpenFile}
              error={treeError}
              hasWorkspace={Boolean(activeLane)}
              overlays={overlayTrees}
              overlaysLoading={overlaysLoading}
              overlaysError={overlaysError}
              showOverlays={showOverlays}
              canShowOverlays={Boolean(activeLane)}
              onToggleOverlays={() => setShowOverlays((v) => !v)}
              onOpenOverlayFile={handleOpenOverlayFile}
            />
          </div>
        </section>
        <section className="pane editor-pane">
          <EditorPane
            tabs={session.tabs}
            activeKey={session.activeTabKey}
            onSelectTab={handleSelectTab}
            onCloseTab={handleCloseTab}
            onEdit={handleEditTab}
            onSave={handleSaveTab}
          />
        </section>
        <section className="pane">
          <RightPanel
            activeTab={rightTab}
            onTabChange={setRightTab}
            chat={{
              provider,
              keyStatus,
              messages: session.messages,
              pendingApprovals: session.pendingApprovals,
              busy: chatBusy,
              hasActiveLane: Boolean(activeLane),
              onSend: sendMessage,
              onApproveTools: approveTools,
              onDenyTools: denyTools,
            }}
            notes={{
              value: noteState.content,
              hasActiveLane: Boolean(activeLane),
              loading: noteState.loading,
              saving: noteState.saving,
              error: noteState.error,
              onChange: handleNoteChange,
            }}
            findings={{
              casefile,
              findings,
              busy: findingsBusy,
              lastExport,
              onCreate: handleCreateFinding,
              onUpdate: handleUpdateFinding,
              onDelete: handleDeleteFinding,
              onExport: handleExportFindings,
            }}
            lanes={{
              casefile,
              onSwitchLane: handleSwitchLane,
              onRegisterLane: handleRegisterLane,
              onChooseLaneRoot: handleChooseLaneRoot,
              comparison,
              comparisonBusy,
              onCompare: handleCompareLanes,
              onClearComparison: handleClearComparison,
              onOpenDiff: handleOpenDiff,
              onOpenLaneFile: handleOpenLaneFile,
              onOpenComparisonChat: handleOpenComparisonChat,
              context: contextManifest,
              contextBusy,
              contextError,
              onSaveContext: handleSaveContext,
              onSetLaneParent: handleSetLaneParent,
              onUpdateLaneAttachments: handleUpdateLaneAttachments,
            }}
            compareChat={{
              provider,
              keyStatus,
              session: comparisonSession,
              busy: comparisonChatBusy,
              onSend: sendComparisonChat,
              onClose: handleCloseComparisonChat,
            }}
          />
        </section>
      </div>
      {keysOpen && (
        <ApiKeysDialog
          status={keyStatus}
          onClose={() => setKeysOpen(false)}
          onStatusChange={setKeyStatus}
        />
      )}
    </div>
  );
}
