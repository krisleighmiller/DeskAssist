import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ApiKeyStatus,
  ProviderModels,
  CasefileSnapshot,
  ChatMessage,
  ComparisonSession,
  ContextManifestDto,
  ExportResult,
  FindingDraft,
  FindingDto,
  FileTreeNode,
  InboxSourceDto,
  InboxSourceInput,
  LaneAttachmentInput,
  LaneUpdateInput,
  UpdateLaneResult,
  LaneComparisonDto,
  OverlayTreeDto,
  PromptDraftDto,
  PromptInputDto,
  PromptSummaryDto,
  Provider,
  RegisterLaneInput,
  RunCommandPayload,
  RunRecordDto,
  RunSummaryDto,
  ToolCall,
} from "./types";
import { api } from "./lib/api";
import { Toolbar } from "./components/Toolbar";
import { FileTree } from "./components/FileTree";
import { EditorPane, type OpenTab } from "./components/EditorPane";
import { RightPanel, type RightTabKey } from "./components/RightPanel";
import { ApiKeysDialog } from "./components/ApiKeysDialog";
import { Splitter } from "./components/Splitter";
import { languageFromPath } from "./lib/language";

const PROVIDER_STORAGE_KEY = "deskassist.selectedProvider";
const NOTES_DEBOUNCE_MS = 600;

const DEFAULT_KEY_STATUS: ApiKeyStatus = {
  openaiConfigured: false,
  anthropicConfigured: false,
  deepseekConfigured: false,
  storageBackend: "file",
};

const EMPTY_PROVIDER_MODELS: ProviderModels = {
  openai: "",
  anthropic: "",
  deepseek: "",
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

// Workbench column-width defaults + persistence (M4.7).
//
// The three-column workbench (file tree | editor | right panel) used to
// be a CSS grid with hard-coded `260px 1fr 420px`. That made the right
// panel's tab strip overflow off-screen on narrower displays. We now
// own the side-pane widths in React state, persisted to localStorage,
// with drag handles between the panes. The center pane stays `flex: 1`.
const WORKBENCH_LEFT_DEFAULT = 260;
const WORKBENCH_LEFT_MIN = 160;
const WORKBENCH_LEFT_MAX = 600;
const WORKBENCH_RIGHT_DEFAULT = 420;
const WORKBENCH_RIGHT_MIN = 280;
const WORKBENCH_RIGHT_MAX = 900;
const LEFT_WIDTH_STORAGE_KEY = "deskassist:workbench:leftWidth";
const RIGHT_WIDTH_STORAGE_KEY = "deskassist:workbench:rightWidth";

function readPersistedWidth(
  key: string,
  fallback: number,
  min: number,
  max: number
): number {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) {
      return Math.min(max, Math.max(min, parsed));
    }
  } catch {
    // localStorage can throw in private browsing / sandboxed contexts.
  }
  return fallback;
}

export function App(): JSX.Element {
  // ----- Casefile + active lane -----

  // ----- Workbench column widths (M4.7) -----
  const [leftPaneWidth, setLeftPaneWidth] = useState<number>(() =>
    readPersistedWidth(
      LEFT_WIDTH_STORAGE_KEY,
      WORKBENCH_LEFT_DEFAULT,
      WORKBENCH_LEFT_MIN,
      WORKBENCH_LEFT_MAX
    )
  );
  const [rightPaneWidth, setRightPaneWidth] = useState<number>(() =>
    readPersistedWidth(
      RIGHT_WIDTH_STORAGE_KEY,
      WORKBENCH_RIGHT_DEFAULT,
      WORKBENCH_RIGHT_MIN,
      WORKBENCH_RIGHT_MAX
    )
  );
  // Persist on every change. Splitter drags are coalesced by React's
  // batching so we won't write more than once per frame in practice.
  useEffect(() => {
    try {
      window.localStorage.setItem(LEFT_WIDTH_STORAGE_KEY, String(leftPaneWidth));
    } catch {
      // ignore
    }
  }, [leftPaneWidth]);
  useEffect(() => {
    try {
      window.localStorage.setItem(RIGHT_WIDTH_STORAGE_KEY, String(rightPaneWidth));
    } catch {
      // ignore
    }
  }, [rightPaneWidth]);

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

  // ----- M4.1: prompt drafts (casefile-scoped) + per-lane selection -----
  // The list itself is stored once per casefile; the "which prompt is
  // currently injected into chat" selection is per-lane (so lane A can
  // use the reviewer prompt while lane B runs without one).

  const [prompts, setPrompts] = useState<PromptSummaryDto[]>([]);
  const [promptsLoading, setPromptsLoading] = useState(false);
  const [promptsError, setPromptsError] = useState<string | null>(null);
  const [selectedPromptByLane, setSelectedPromptByLane] = useState<
    Map<string, string | null>
  >(() => new Map());

  const reloadPrompts = useCallback(async () => {
    if (!casefile) {
      setPrompts([]);
      return;
    }
    setPromptsLoading(true);
    try {
      const list = await api().listPrompts();
      setPrompts(list);
      setPromptsError(null);
    } catch (error) {
      setPromptsError(error instanceof Error ? error.message : String(error));
    } finally {
      setPromptsLoading(false);
    }
  }, [casefile]);

  const handleCreatePrompt = useCallback(
    async (input: PromptInputDto): Promise<PromptDraftDto> => {
      const created = await api().createPrompt(input);
      await reloadPrompts();
      return created;
    },
    [reloadPrompts]
  );

  const handleSavePrompt = useCallback(
    async (promptId: string, input: PromptInputDto): Promise<PromptDraftDto> => {
      const saved = await api().savePrompt(promptId, input);
      await reloadPrompts();
      return saved;
    },
    [reloadPrompts]
  );

  const handleDeletePrompt = useCallback(
    async (promptId: string) => {
      await api().deletePrompt(promptId);
      // A deleted prompt cannot remain selected on any lane: silently drop
      // the selection so chat doesn't keep trying to inject a missing id.
      setSelectedPromptByLane((prev) => {
        const next = new Map(prev);
        for (const [key, value] of prev) {
          if (value === promptId) next.set(key, null);
        }
        return next;
      });
      await reloadPrompts();
    },
    [reloadPrompts]
  );

  const handleLoadPrompt = useCallback(async (promptId: string) => {
    return api().getPrompt(promptId);
  }, []);

  const selectedPromptId = sessionKey
    ? selectedPromptByLane.get(sessionKey) ?? null
    : null;

  const handleSelectPromptForChat = useCallback(
    (promptId: string | null) => {
      if (!sessionKey) return;
      setSelectedPromptByLane((prev) => {
        const next = new Map(prev);
        next.set(sessionKey, promptId);
        return next;
      });
    },
    [sessionKey]
  );

  const activePromptName = selectedPromptId
    ? prompts.find((p) => p.id === selectedPromptId)?.name ?? null
    : null;

  // ----- M4.2: command runs (casefile-scoped) -----

  const [runs, setRuns] = useState<RunSummaryDto[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState<string | null>(null);
  // Allowlist comes from the backend (`system_exec.ALLOWED_EXECUTABLES`)
  // rather than a hard-coded mirror in the renderer. Fetched once at
  // mount; the set is small and effectively immutable across a session.
  const [allowedExecutables, setAllowedExecutables] = useState<readonly string[]>([]);
  useEffect(() => {
    let cancelled = false;
    api()
      .getAllowedExecutables()
      .then((list) => {
        if (!cancelled) setAllowedExecutables(list);
      })
      .catch(() => {
        // Non-fatal: the placeholder hint just won't list commands.
        if (!cancelled) setAllowedExecutables([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const reloadRuns = useCallback(async () => {
    if (!casefile) {
      setRuns([]);
      return;
    }
    setRunsLoading(true);
    try {
      const list = await api().listRuns();
      setRuns(list);
      setRunsError(null);
    } catch (error) {
      setRunsError(error instanceof Error ? error.message : String(error));
    } finally {
      setRunsLoading(false);
    }
  }, [casefile]);

  const handleRunCommand = useCallback(
    async (payload: RunCommandPayload): Promise<RunRecordDto> => {
      const created = await api().runCommand(payload);
      await reloadRuns();
      return created;
    },
    [reloadRuns]
  );

  const handleLoadRun = useCallback(
    async (runId: string) => api().getRun(runId),
    []
  );

  const handleDeleteRun = useCallback(
    async (runId: string) => {
      await api().deleteRun(runId);
      await reloadRuns();
    },
    [reloadRuns]
  );

  // ----- M4.3: external inbox sources (casefile-scoped) -----
  // Source list lives at the App level so the badge / future cross-tab
  // surfaces can read it without wiring a context. Items + content are
  // fetched on-demand inside `InboxTab` itself.

  const [inboxSources, setInboxSources] = useState<InboxSourceDto[]>([]);
  const [inboxLoading, setInboxLoading] = useState(false);
  const [inboxError, setInboxError] = useState<string | null>(null);

  const reloadInboxSources = useCallback(async () => {
    if (!casefile) {
      setInboxSources([]);
      return;
    }
    setInboxLoading(true);
    try {
      const list = await api().listInboxSources();
      setInboxSources(list);
      setInboxError(null);
    } catch (error) {
      setInboxError(error instanceof Error ? error.message : String(error));
    } finally {
      setInboxLoading(false);
    }
  }, [casefile]);

  const handleAddInboxSource = useCallback(
    async (input: InboxSourceInput): Promise<InboxSourceDto> => {
      const created = await api().addInboxSource(input);
      await reloadInboxSources();
      return created;
    },
    [reloadInboxSources]
  );

  const handleRemoveInboxSource = useCallback(
    async (sourceId: string) => {
      await api().removeInboxSource(sourceId);
      await reloadInboxSources();
    },
    [reloadInboxSources]
  );

  const handleChooseInboxRoot = useCallback(
    async () => api().chooseInboxRoot(),
    []
  );

  const handleListInboxItems = useCallback(
    async (sourceId: string) => api().listInboxItems(sourceId),
    []
  );

  const handleReadInboxItem = useCallback(
    async (sourceId: string, path: string) => api().readInboxItem(sourceId, path),
    []
  );

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

  // M3.5c+: invoked by the file-tree right-click menu. We persist the
  // pattern immediately rather than only updating the editor's draft —
  // the user clicked "Add to context" with intent and may not even have
  // the Lanes tab + context section open. We base the merge on the
  // freshest manifest fetched from disk to avoid clobbering concurrent
  // edits made via the ContextEditor itself.
  const handleAddToContext = useCallback(
    async (pattern: string) => {
      const trimmed = pattern.trim();
      if (!trimmed) return;
      let base = contextManifest;
      try {
        base = await api().getContext();
      } catch {
        // Fall back to the last manifest we held in state — better than
        // nothing if the bridge is momentarily unhappy.
      }
      const existing = new Set(base?.files ?? []);
      if (existing.has(trimmed)) {
        setContextError(`Pattern "${trimmed}" is already in the casefile context.`);
        return;
      }
      const nextFiles = [...(base?.files ?? []), trimmed];
      const cap = base?.autoIncludeMaxBytes ?? 32 * 1024;
      await handleSaveContext({ files: nextFiles, autoIncludeMaxBytes: cap });
    },
    [contextManifest, handleSaveContext]
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

  // M4.6: lane CRUD + casefile reset.
  const handleUpdateLane = useCallback(
    async (
      laneId: string,
      update: LaneUpdateInput
    ): Promise<UpdateLaneResult> => {
      try {
        const result = await api().updateLane(laneId, update);
        setCasefile(result.casefile);
        // The component that called us is responsible for surfacing the
        // root-conflict warning; we just propagate it back.
        return result;
      } catch (error) {
        setTreeError(error instanceof Error ? error.message : String(error));
        throw error;
      }
    },
    []
  );

  const handleRemoveLane = useCallback(
    async (laneId: string) => {
      try {
        const snapshot = await api().removeLane(laneId);
        setCasefile(snapshot);
      } catch (error) {
        setTreeError(error instanceof Error ? error.message : String(error));
        throw error;
      }
    },
    []
  );

  const handleHardResetCasefile = useCallback(async () => {
    try {
      const snapshot = await api().hardResetCasefile();
      setCasefile(snapshot);
    } catch (error) {
      setTreeError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }, []);

  const handleSoftResetCasefile = useCallback(
    async (keepPrompts: boolean) => {
      try {
        const snapshot = await api().softResetCasefile(keepPrompts);
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
  // Per-provider model overrides. Empty string = "use backend default".
  // Loaded from main.js (plain user-data file) on startup; the
  // ApiKeysDialog edits and persists this via the bridge.
  const [providerModels, setProviderModels] =
    useState<ProviderModels>(EMPTY_PROVIDER_MODELS);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await api().getProviderModels();
        if (!cancelled) setProviderModels(next);
      } catch (error) {
        console.warn("getProviderModels failed", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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

  // Reload prompts whenever the casefile changes.
  useEffect(() => {
    void reloadPrompts();
  }, [reloadPrompts]);

  // Reload runs whenever the casefile changes. (Per-lane filtering happens
  // client-side: the list is small, and refetching on every lane switch
  // is unnecessary churn.)
  useEffect(() => {
    void reloadRuns();
  }, [reloadRuns]);

  // Reload inbox sources whenever the casefile changes.
  useEffect(() => {
    void reloadInboxSources();
    // reloadInboxSources is declared below; the dependency array picks it
    // up from the lexical scope at render time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [casefile]);

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
          model: providerModels[provider] || null,
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
    [casefile, comparisonChatBusy, comparisonSession, provider, providerModels]
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
          model: providerModels[provider] || null,
          messages: historyBeforeTurn,
          userMessage: value,
          allowWriteTools: false,
          resumePendingToolCalls: false,
          systemPromptId: selectedPromptId,
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
      providerModels,
      selectedPromptId,
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
        model: providerModels[provider] || null,
        messages: historyBeforeTurn,
        userMessage: "",
        allowWriteTools: true,
        resumePendingToolCalls: true,
        systemPromptId: selectedPromptId,
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
    providerModels,
    selectedPromptId,
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
        providerModels={providerModels}
        onChooseCasefile={handleChooseCasefile}
        onOpenKeys={() => setKeysOpen(true)}
        onSwitchLane={handleSwitchLane}
      />
      <div className="workbench">
        <section className="pane" style={{ width: leftPaneWidth }}>
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
              casefileRoot={casefile?.root ?? null}
              onAddToContext={casefile ? handleAddToContext : undefined}
            />
          </div>
        </section>
        <Splitter
          width={leftPaneWidth}
          min={WORKBENCH_LEFT_MIN}
          max={WORKBENCH_LEFT_MAX}
          defaultWidth={WORKBENCH_LEFT_DEFAULT}
          side="left"
          onResize={setLeftPaneWidth}
          ariaLabel="Resize workspace panel"
        />
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
        <Splitter
          width={rightPaneWidth}
          min={WORKBENCH_RIGHT_MIN}
          max={WORKBENCH_RIGHT_MAX}
          defaultWidth={WORKBENCH_RIGHT_DEFAULT}
          side="right"
          onResize={setRightPaneWidth}
          ariaLabel="Resize side panel"
        />
        <section className="pane" style={{ width: rightPaneWidth }}>
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
              activePromptName,
              onClearActivePrompt: () => handleSelectPromptForChat(null),
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
              onUpdateLane: handleUpdateLane,
              onRemoveLane: handleRemoveLane,
              onHardResetCasefile: handleHardResetCasefile,
              onSoftResetCasefile: handleSoftResetCasefile,
            }}
            compareChat={{
              provider,
              keyStatus,
              session: comparisonSession,
              busy: comparisonChatBusy,
              onSend: sendComparisonChat,
              onClose: handleCloseComparisonChat,
            }}
            prompts={{
              hasCasefile: Boolean(casefile),
              hasActiveLane: Boolean(activeLane),
              prompts,
              loading: promptsLoading,
              error: promptsError,
              selectedPromptId,
              onSelectForChat: handleSelectPromptForChat,
              onCreate: handleCreatePrompt,
              onSave: handleSavePrompt,
              onDelete: handleDeletePrompt,
              onLoad: handleLoadPrompt,
            }}
            runs={{
              hasCasefile: Boolean(casefile),
              hasActiveLane: Boolean(activeLane),
              activeLaneId,
              lanes: casefile?.lanes ?? [],
              runs,
              loading: runsLoading,
              error: runsError,
              allowedExecutables,
              onRun: handleRunCommand,
              onLoadRun: handleLoadRun,
              onDelete: handleDeleteRun,
            }}
            inbox={{
              hasCasefile: Boolean(casefile),
              hasActiveLane: Boolean(activeLane),
              activeLaneId,
              activeLaneName: activeLane?.name ?? null,
              sources: inboxSources,
              loading: inboxLoading,
              error: inboxError,
              onAddSource: handleAddInboxSource,
              onRemoveSource: handleRemoveInboxSource,
              onChooseRoot: handleChooseInboxRoot,
              onListItems: handleListInboxItems,
              onReadItem: handleReadInboxItem,
              onCreateFinding: handleCreateFinding,
            }}
          />
        </section>
      </div>
      {keysOpen && (
        <ApiKeysDialog
          status={keyStatus}
          onClose={() => setKeysOpen(false)}
          onStatusChange={setKeyStatus}
          models={providerModels}
          onModelsChange={setProviderModels}
        />
      )}
    </div>
  );
}
