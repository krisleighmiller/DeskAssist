import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ApiKeyStatus,
  ProviderModels,
  CasefileSnapshot,
  ChatMessage,
  ComparisonSession,
  ContextManifestDto,
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
  ToolCall,
} from "./types";
import { api } from "./lib/api";
import { Toolbar } from "./components/Toolbar";
import { FileTree } from "./components/FileTree";
import { EditorPane, type OpenTab } from "./components/EditorPane";
import { RightPanel, type RightTabKey } from "./components/RightPanel";
import { compareSessionId, laneSessionId } from "./components/ChatTab";
import { ApiKeysDialog } from "./components/ApiKeysDialog";
import { Splitter, HorizontalSplitter } from "./components/Splitter";
import {
  TerminalsPanel,
  disposeTerminalSession,
  type TerminalSession,
} from "./components/TerminalsPanel";
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
const TERMINAL_HEIGHT_STORAGE_KEY = "deskassist:terminal:height";
const TERMINAL_OPEN_STORAGE_KEY = "deskassist:terminal:open";
const TERMINAL_HEIGHT_DEFAULT = 240;
const TERMINAL_HEIGHT_MIN = 120;
const TERMINAL_HEIGHT_MAX = 800;
// Reserve at least this many pixels for the center editor pane so the
// side panes can never push the editor to zero width when the window
// is narrow (or when a previously persisted width was captured on a
// wider monitor and is now too large for the current viewport).
const WORKBENCH_EDITOR_MIN = 240;
// Splitters + workbench horizontal padding budget. Two splitters at 6px
// each plus a small fudge factor to keep one pixel of headroom — this
// matches the `.splitter { flex: 0 0 6px }` size in styles.css.
const WORKBENCH_GUTTER = 16;

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

  // ----- Integrated terminal (M4.8) -----
  //
  // State here only tracks what the renderer knows about each session;
  // the actual shell process lives in the Electron main process and
  // outlives both tab switches and (intentionally) full toggles of the
  // terminal pane visibility.
  const [terminalSessions, setTerminalSessions] = useState<TerminalSession[]>([]);
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);
  const [terminalOpen, setTerminalOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(TERMINAL_OPEN_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [terminalHeight, setTerminalHeight] = useState<number>(() =>
    readPersistedWidth(
      TERMINAL_HEIGHT_STORAGE_KEY,
      TERMINAL_HEIGHT_DEFAULT,
      TERMINAL_HEIGHT_MIN,
      TERMINAL_HEIGHT_MAX
    )
  );
  useEffect(() => {
    try {
      window.localStorage.setItem(
        TERMINAL_HEIGHT_STORAGE_KEY,
        String(terminalHeight)
      );
    } catch {
      // ignore
    }
  }, [terminalHeight]);
  useEffect(() => {
    try {
      window.localStorage.setItem(TERMINAL_OPEN_STORAGE_KEY, terminalOpen ? "1" : "0");
    } catch {
      // ignore
    }
  }, [terminalOpen]);

  // Viewport-aware clamp: previously the side pane widths were only
  // bounded by their own min/max, so a width persisted on a 1920px
  // monitor (e.g. right pane = 700px) would silently push the editor
  // off-screen on a 1024px laptop, and the right-pane content (lane
  // edit form, compare controls) ended up clipped at the window edge.
  // We now subtract the splitter + editor budget from the live
  // viewport and shrink either pane that no longer fits, in priority
  // order: shrink the right pane first, then the left.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const reflow = () => {
      const vw = window.innerWidth;
      const available = vw - WORKBENCH_GUTTER - WORKBENCH_EDITOR_MIN;
      // Each pane gets at least its own minimum, even if that means
      // the editor falls below WORKBENCH_EDITOR_MIN — that case only
      // happens on absurdly narrow windows and is preferable to
      // collapsing a pane below the legibility floor.
      setRightPaneWidth((prev) => {
        const cap = Math.max(WORKBENCH_RIGHT_MIN, available - WORKBENCH_LEFT_MIN);
        return prev > cap ? cap : prev;
      });
      setLeftPaneWidth((prev) => {
        // Read the (possibly just-clamped) right width via state from
        // the next reflow tick; for the synchronous path we re-read
        // the persisted value from localStorage as a best-effort.
        const rightLive = readPersistedWidth(
          RIGHT_WIDTH_STORAGE_KEY,
          WORKBENCH_RIGHT_DEFAULT,
          WORKBENCH_RIGHT_MIN,
          WORKBENCH_RIGHT_MAX
        );
        const cap = Math.max(WORKBENCH_LEFT_MIN, available - rightLive);
        return prev > cap ? cap : prev;
      });
    };
    reflow();
    window.addEventListener("resize", reflow);
    return () => window.removeEventListener("resize", reflow);
  }, []);

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

  // ----- M3.5c: comparison chat sessions (read-only multi-lane) -----
  // We allow multiple comparison sessions to coexist. The unified Chat
  // tab lists them alongside lane chats; the user clicks a session in
  // the list (or "Open compare chat" in Lanes) to focus it.
  const [comparisonSessions, setComparisonSessions] = useState<
    ComparisonSession[]
  >([]);
  /** id of the comparison session driving the Chat tab, or null when
   * a lane chat is in focus. */
  const [activeComparisonId, setActiveComparisonId] = useState<string | null>(
    null
  );
  const [comparisonChatBusy, setComparisonChatBusy] = useState(false);

  const focusedComparisonSession = useMemo<ComparisonSession | null>(
    () =>
      activeComparisonId
        ? comparisonSessions.find((s) => s.id === activeComparisonId) ?? null
        : null,
    [activeComparisonId, comparisonSessions]
  );

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
      // No overlays visible → tell main it can drop any extra watch
      // roots it had registered for them. Safe to ignore failures.
      try {
        await api().registerWatchRoots?.([]);
      } catch {
        // ignore
      }
      return;
    }
    setOverlaysLoading(true);
    try {
      const overlays = await api().listOverlayTrees(activeLaneId, 4);
      setOverlayTrees(overlays);
      setOverlaysError(null);
      // Forward overlay roots to main so its fs.watch covers any
      // attachment / context root that lives outside the casefile.
      // Roots inside the casefile are deduped main-side.
      const roots = overlays
        .map((o) => o.root)
        .filter((r): r is string => typeof r === "string" && r.length > 0);
      try {
        await api().registerWatchRoots?.(roots);
      } catch {
        // ignore — watching is a nice-to-have, manual refresh works.
      }
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

  // Bridge the main-process menu's "Toggle Integrated Terminal" command
  // (and its CmdOrCtrl+` accelerator) into the same handler used by the
  // toolbar button and the renderer-side keyboard shortcut. Wired here
  // rather than near `toggleTerminalOpen` because the function is
  // declared further below; we read it from a ref captured by the
  // dedicated effect that follows.
  const toggleTerminalRef = useRef<() => void>(() => {});

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

  // Reload context manifest whenever the casefile changes.
  useEffect(() => {
    void reloadContext();
  }, [reloadContext]);

  // Reload prompts whenever the casefile changes.
  useEffect(() => {
    void reloadPrompts();
  }, [reloadPrompts]);

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
        // Switching casefile invalidates any prior comparison + open
        // comparison-chat sessions (their lane ids are scoped to the
        // previous casefile).
        setComparison(null);
        setComparisonSessions([]);
        setActiveComparisonId(null);
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
        // Switching to a lane chat is the explicit "leave the
        // comparison view" gesture inside the unified Chat tab.
        setActiveComparisonId(null);
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

  // External-change watcher: main.js installs an fs.watch on the active
  // casefile root and emits `workspace:changed` whenever something
  // inside it is created / renamed / deleted / modified. The renderer
  // reacts by re-listing the file tree, the overlay trees, and any
  // open tabs that match their on-disk content (so an external
  // `git pull` shows up without requiring a manual refresh). We
  // deliberately skip `refreshOpenTabsFromDisk` for *dirty* tabs —
  // that's already handled upstream — to avoid clobbering the user's
  // in-progress edits.
  useEffect(() => {
    const subscribe = api().onWorkspaceChanged;
    if (typeof subscribe !== "function") return;
    return subscribe(() => {
      void refreshTree();
      // Overlays are loaded from a separate IPC; if we don't refresh
      // them here, an external rename in an `_ancestors/...` or
      // `_attachments/...` directory leaves the inherited-context
      // pane showing stale names (the bug from the user's screenshot
      // where Ratings.md still appeared under its original chat
      // filename).
      void reloadOverlays();
      void refreshOpenTabsFromDisk();
    });
  }, [refreshTree, reloadOverlays, refreshOpenTabsFromDisk]);

  // Rename a file from the file-tree right-click menu. We perform the
  // bridge call, then re-list the tree so the new name is visible, then
  // patch any open tabs that pointed at the old path so the editor
  // doesn't keep a "dirty" tab attached to a non-existent file.
  const handleRenameFile = useCallback(
    async (oldPath: string, newName: string) => {
      const result = await api().renameFile(oldPath, newName);
      const newPath = result.newPath;
      // Patch open tabs in every lane session, not just the active one,
      // so a rename done while looking at lane A doesn't surface a
      // stale path the next time the user switches to lane B.
      setLaneSessions((prev) => {
        const next = new Map(prev);
        let mutated = false;
        for (const [key, sess] of prev.entries()) {
          let touched = false;
          const tabs = sess.tabs.map((t) => {
            if (t.kind === "file" && t.path === oldPath) {
              touched = true;
              return { ...t, path: newPath, key: newPath };
            }
            return t;
          });
          if (touched) {
            mutated = true;
            const activeTabKey =
              sess.activeTabKey === oldPath ? newPath : sess.activeTabKey;
            next.set(key, { ...sess, tabs, activeTabKey });
          }
        }
        return mutated ? next : prev;
      });
      await refreshTree();
      // Also rebuild overlays — the renamed file may live inside an
      // ancestor / attachment overlay, in which case refreshTree alone
      // wouldn't update its display.
      await reloadOverlays();
    },
    [refreshTree, reloadOverlays]
  );

  // ----- Integrated terminal handlers (M4.8) -----
  //
  // The "id" of each session is independent from the lane id so a single
  // lane can host multiple shells (`<lane>-<n>`). This keeps the IPC
  // channel name unique even when the user opens several terminals
  // pointed at the same lane root.
  const handleNewTerminal = useCallback(() => {
    const lane = activeLane;
    const cwd = lane?.root || casefile?.root || null;
    const stamp = Date.now().toString(36);
    const baseLabel = lane?.name || "shell";
    const id = lane ? `lane:${lane.id}:${stamp}` : `shell:${stamp}`;
    setTerminalSessions((prev) => {
      // De-duplicate label numbering so two consecutive "main" tabs
      // become "main", "main 2", etc., matching what's familiar from
      // VS Code / iTerm.
      const sameBase = prev.filter((s) => s.label.startsWith(baseLabel));
      const label = sameBase.length === 0 ? baseLabel : `${baseLabel} ${sameBase.length + 1}`;
      return [
        ...prev,
        {
          id,
          label,
          cwd: cwd || "",
          laneId: lane?.id ?? null,
        },
      ];
    });
    setActiveTerminalId(id);
    setTerminalOpen(true);
  }, [activeLane, casefile]);

  const handleSelectTerminal = useCallback((id: string) => {
    setActiveTerminalId(id);
  }, []);

  const handleCloseTerminal = useCallback(
    (id: string) => {
      // Order matters: kill the PTY first so any final exit chunk lands
      // before we tear down the xterm instance, then dispose the
      // renderer-side state.
      void api()
        .terminalKill(id)
        .catch(() => {
          // The PTY may have already exited; nothing to do.
        });
      disposeTerminalSession(id);
      setTerminalSessions((prev) => {
        const next = prev.filter((s) => s.id !== id);
        if (activeTerminalId === id) {
          // Snap to the previously-adjacent tab if there is one,
          // otherwise leave the active id null and let the empty-state
          // view take over.
          const fallback = next[next.length - 1] ?? null;
          setActiveTerminalId(fallback ? fallback.id : null);
        }
        return next;
      });
    },
    [activeTerminalId]
  );

  const toggleTerminalOpen = useCallback(() => {
    setTerminalOpen((prev) => {
      const next = !prev;
      if (next && terminalSessions.length === 0) {
        // First-open ergonomics: spawn a default shell so the user
        // doesn't have to click "+" before they can type anything.
        // Defer to a microtask so React doesn't bail out on calling
        // another setState inside this updater.
        queueMicrotask(() => handleNewTerminal());
      }
      return next;
    });
  }, [handleNewTerminal, terminalSessions.length]);

  // Keep the ref in sync so the menu-driven IPC subscription below
  // (registered exactly once) can always call the *current* toggle
  // closure without re-subscribing on every keystroke / state change.
  useEffect(() => {
    toggleTerminalRef.current = toggleTerminalOpen;
  }, [toggleTerminalOpen]);

  // Bridge the main-process menu accelerator (CmdOrCtrl+`) into the
  // same toggle action used by the toolbar button. The accelerator
  // works even when focus is in the integrated terminal, because
  // Electron consumes the keystroke at the menu layer before xterm
  // sees it.
  useEffect(() => {
    const remove = api().onToggleTerminal(() => {
      toggleTerminalRef.current();
    });
    return () => {
      remove();
    };
  }, []);

  // Renderer-side fallback for the same shortcut. Useful when the
  // application menu is hidden (some Linux WMs auto-hide it) or when a
  // future build ships without the menu accelerator. The terminal
  // itself still receives the keystroke first because we bail out when
  // focus is inside `.terminal-view`.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "`") return;
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;
      const target = event.target as HTMLElement | null;
      if (target && target.closest && target.closest(".terminal-view")) return;
      event.preventDefault();
      toggleTerminalOpen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleTerminalOpen]);

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
  // Comparison chats live in the unified Chat tab as a separate session
  // type; the user picks them from the session list at the top. Opening
  // a comparison both registers the session (so it appears in the list)
  // *and* focuses it (so the chat body switches over).

  const handleOpenComparisonChat = useCallback(
    async (laneIds: string[]) => {
      if (!casefile || laneIds.length < 2) return;
      try {
        const session = await api().openComparison(laneIds);
        setComparisonSessions((prev) => {
          // Replace by id so re-opening a comparison rehydrates its
          // persisted messages instead of pushing a duplicate row.
          const existing = prev.findIndex((s) => s.id === session.id);
          if (existing >= 0) {
            const next = prev.slice();
            next[existing] = session;
            return next;
          }
          return [...prev, session];
        });
        setActiveComparisonId(session.id);
        // The comparison chat lives inside the unified Chat tab now.
        setRightTab("chat");
      } catch (error) {
        setTreeError(error instanceof Error ? error.message : String(error));
      }
    },
    [casefile]
  );

  const handleCloseComparisonChat = useCallback((comparisonId: string) => {
    setComparisonSessions((prev) => prev.filter((s) => s.id !== comparisonId));
    setActiveComparisonId((prev) => (prev === comparisonId ? null : prev));
  }, []);

  const sendComparisonChat = useCallback(
    async (text: string) => {
      const value = text.trim();
      const target = focusedComparisonSession;
      if (!value || comparisonChatBusy || !target || !casefile) return;
      setComparisonChatBusy(true);
      const historyBeforeTurn = target.messages;
      // Optimistically render the user's message; the bridge will replace
      // history with the canonical delta on success.
      const targetId = target.id;
      const replaceMessages = (
        produce: (prev: ComparisonSession) => ComparisonSession
      ) => {
        setComparisonSessions((prev) =>
          prev.map((s) => (s.id === targetId ? produce(s) : s))
        );
      };
      replaceMessages((prev) => ({
        ...prev,
        messages: [...prev.messages, { role: "user", content: value }],
      }));
      try {
        const response = await api().sendComparisonChat({
          laneIds: target.laneIds,
          provider,
          model: providerModels[provider] || null,
          messages: historyBeforeTurn,
          userMessage: value,
          resumePendingToolCalls: false,
        });
        const delta = Array.isArray(response.messages) ? response.messages : [];
        replaceMessages((prev) => ({
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
        }));
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        replaceMessages((prev) => ({
          ...prev,
          messages: [
            ...historyBeforeTurn,
            { role: "user", content: value },
            { role: "assistant", content: `Error: ${errMsg}` },
          ],
        }));
      } finally {
        setComparisonChatBusy(false);
      }
    },
    [casefile, comparisonChatBusy, focusedComparisonSession, provider, providerModels]
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
        onToggleTerminal={toggleTerminalOpen}
        terminalOpen={terminalOpen}
      />
      <div className="workbench-column">
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
              onRename={activeLane ? handleRenameFile : undefined}
              onRefresh={
                activeLane
                  ? () => {
                      void refreshTree();
                      void reloadOverlays();
                    }
                  : undefined
              }
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
              casefile,
              comparisonSessions,
              activeSessionId: focusedComparisonSession
                ? compareSessionId(focusedComparisonSession.id)
                : activeLaneId
                  ? laneSessionId(activeLaneId)
                  : null,
              onSelectSession: (id) => {
                if (id.startsWith("compare:")) {
                  setActiveComparisonId(id.slice("compare:".length));
                } else if (id.startsWith("lane:")) {
                  void handleSwitchLane(id.slice("lane:".length));
                }
              },
              onCloseCompareSession: handleCloseComparisonChat,
              laneChat: {
                provider,
                keyStatus,
                messages: session.messages,
                pendingApprovals: session.pendingApprovals,
                busy: chatBusy,
                hasActiveLane: Boolean(activeLane),
                activeLane,
                activePromptName,
                onClearActivePrompt: () => handleSelectPromptForChat(null),
                onSend: sendMessage,
                onApproveTools: approveTools,
                onDenyTools: denyTools,
              },
              compareChat: {
                provider,
                keyStatus,
                session: focusedComparisonSession,
                busy: comparisonChatBusy,
                onSend: sendComparisonChat,
              },
              // SaveOutputPicker writes the chat message into a lane
              // attachment / arbitrary directory, but the bridge call
              // bypasses our normal save-tab flow so the file tree
              // wouldn't otherwise re-list. Fire a refresh so the new
              // file appears immediately in the workspace pane.
              // Reload overlays too: the destination is often an
              // ancestor lane's attachment (e.g. the chat picker's
              // "ash_notes" row), which is rendered in the inherited-
              // context section, not the main lane tree.
              onAfterSaveOutput: () => {
                void refreshTree();
                void reloadOverlays();
              },
            }}
            notes={{
              value: noteState.content,
              hasActiveLane: Boolean(activeLane),
              loading: noteState.loading,
              saving: noteState.saving,
              error: noteState.error,
              onChange: handleNoteChange,
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
            inbox={{
              hasCasefile: Boolean(casefile),
              sources: inboxSources,
              loading: inboxLoading,
              error: inboxError,
              onAddSource: handleAddInboxSource,
              onRemoveSource: handleRemoveInboxSource,
              onChooseRoot: handleChooseInboxRoot,
              onListItems: handleListInboxItems,
              onReadItem: handleReadInboxItem,
            }}
          />
        </section>
      </div>
      {terminalOpen && (
        <>
          <HorizontalSplitter
            height={terminalHeight}
            min={TERMINAL_HEIGHT_MIN}
            max={TERMINAL_HEIGHT_MAX}
            defaultHeight={TERMINAL_HEIGHT_DEFAULT}
            onResize={setTerminalHeight}
            ariaLabel="Resize terminal pane"
          />
          <div className="terminal-pane" style={{ height: terminalHeight }}>
            <TerminalsPanel
              sessions={terminalSessions}
              activeSessionId={activeTerminalId}
              onSelect={handleSelectTerminal}
              onNew={handleNewTerminal}
              onClose={handleCloseTerminal}
              onClear={() => setTerminalOpen(false)}
            />
          </div>
        </>
      )}
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
