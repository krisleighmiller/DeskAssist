import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ApiKeyStatus,
  CasefileSnapshot,
  ChatMessage,
  FileTreeNode,
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

const PROVIDER_STORAGE_KEY = "deskassist.selectedProvider";
const NOTES_STORAGE_KEY = "deskassist.notes";

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
  activeTabPath: string | null;
}

const EMPTY_LANE_SESSION: LaneSessionState = {
  messages: [],
  pendingApprovals: [],
  tabs: [],
  activeTabPath: null,
};

export function App(): JSX.Element {
  // Casefile + active lane
  const [casefile, setCasefile] = useState<CasefileSnapshot | null>(null);
  const activeLaneId = casefile?.activeLaneId ?? null;
  const activeLane = activeLaneId
    ? casefile?.lanes.find((lane) => lane.id === activeLaneId) ?? null
    : null;

  // File tree (re-fetched whenever the active lane changes)
  const [tree, setTree] = useState<FileTreeNode | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);

  // Per-lane session state. Keyed by `${casefileRoot}::${laneId}` so multiple
  // casefiles opened in the same session don't bleed into each other.
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

  // Right panel
  const [rightTab, setRightTab] = useState<RightTabKey>("chat");

  // Provider selection
  const [provider, setProvider] = useState<Provider>(() => {
    const saved = localStorage.getItem(PROVIDER_STORAGE_KEY) as Provider | null;
    return saved ?? "openai";
  });
  const [chatBusy, setChatBusy] = useState(false);

  // Notes (local-device only until M3 promotes them to the casefile)
  const [notes, setNotes] = useState<string>(() => localStorage.getItem(NOTES_STORAGE_KEY) ?? "");
  useEffect(() => {
    localStorage.setItem(NOTES_STORAGE_KEY, notes);
  }, [notes]);

  // API keys
  const [keyStatus, setKeyStatus] = useState<ApiKeyStatus>(DEFAULT_KEY_STATUS);
  const [keysOpen, setKeysOpen] = useState(false);

  useEffect(() => {
    localStorage.setItem(PROVIDER_STORAGE_KEY, provider);
  }, [provider]);

  // ----- API key bootstrap -----

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

  const loadLaneChatHistory = useCallback(
    async (laneId: string, key: string) => {
      try {
        const persisted = await api().listChat(laneId);
        // Only seed the in-memory history for a lane the *first* time we see it
        // in this session; otherwise the user's optimistic state would clobber.
        setLaneSessions((prev) => {
          if (prev.has(key)) return prev;
          const next = new Map(prev);
          next.set(key, {
            ...EMPTY_LANE_SESSION,
            messages: persisted,
          });
          return next;
        });
      } catch (error) {
        console.warn("listChat failed", error);
      }
    },
    []
  );

  // Whenever the active lane changes, refresh the tree and seed its chat
  // history from disk if we haven't seen it before.
  useEffect(() => {
    if (!casefile || !activeLaneId) {
      setTree(null);
      return;
    }
    void refreshTree();
    const key = `${casefile.root}::${activeLaneId}`;
    void loadLaneChatHistory(activeLaneId, key);
  }, [casefile, activeLaneId, refreshTree, loadLaneChatHistory]);

  // ----- Casefile ops -----

  const handleChooseCasefile = useCallback(async () => {
    try {
      const snapshot = await api().chooseCasefile();
      if (snapshot) {
        setCasefile(snapshot);
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

  const handleRegisterLane = useCallback(
    async (input: RegisterLaneInput) => {
      try {
        const snapshot = await api().registerLane(input);
        setCasefile(snapshot);
      } catch (error) {
        setTreeError(error instanceof Error ? error.message : String(error));
        throw error;
      }
    },
    []
  );

  const handleChooseLaneRoot = useCallback(async () => {
    return api().chooseLaneRoot();
  }, []);

  // ----- Editor tabs (per-lane) -----

  const handleOpenFile = useCallback(
    async (filePath: string) => {
      if (session.tabs.some((t) => t.path === filePath)) {
        updateSession((prev) => ({ ...prev, activeTabPath: filePath }));
        return;
      }
      try {
        const result = await api().readFile(filePath);
        updateSession((prev) => ({
          ...prev,
          tabs: [
            ...prev.tabs,
            {
              path: result.path,
              content: result.content,
              savedContent: result.content,
              truncated: result.truncated,
            },
          ],
          activeTabPath: result.path,
        }));
      } catch (error) {
        setTreeError(error instanceof Error ? error.message : String(error));
      }
    },
    [session.tabs, updateSession]
  );

  const handleSelectTab = useCallback(
    (filePath: string) => {
      updateSession((prev) => ({ ...prev, activeTabPath: filePath }));
    },
    [updateSession]
  );

  const handleCloseTab = useCallback(
    (filePath: string) => {
      updateSession((prev) => {
        const remainingTabs = prev.tabs.filter((t) => t.path !== filePath);
        const nextActive =
          prev.activeTabPath === filePath
            ? remainingTabs.length > 0
              ? remainingTabs[remainingTabs.length - 1].path
              : null
            : prev.activeTabPath;
        return { ...prev, tabs: remainingTabs, activeTabPath: nextActive };
      });
    },
    [updateSession]
  );

  const handleEditTab = useCallback(
    (filePath: string, content: string) => {
      updateSession((prev) => ({
        ...prev,
        tabs: prev.tabs.map((t) => (t.path === filePath ? { ...t, content } : t)),
      }));
    },
    [updateSession]
  );

  const handleSaveTab = useCallback(
    async (filePath: string) => {
      const tab = session.tabs.find((t) => t.path === filePath);
      if (!tab) return;
      try {
        await api().saveFile(filePath, tab.content);
        updateSession((prev) => ({
          ...prev,
          tabs: prev.tabs.map((t) =>
            t.path === filePath ? { ...t, savedContent: t.content, truncated: false } : t
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
        if (t.content !== t.savedContent || t.truncated) {
          return t;
        }
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
      // Optimistic user message.
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

  return (
    <div className="app">
      <Toolbar
        casefile={casefile}
        provider={provider}
        onProviderChange={setProvider}
        keyStatus={keyStatus}
        onChooseCasefile={handleChooseCasefile}
        onOpenKeys={() => setKeysOpen(true)}
      />
      <div className="workbench">
        <section className="pane">
          <header className="pane-header">
            {activeLane ? activeLane.name : "Workspace"}
          </header>
          <div className="pane-body">
            <FileTree
              root={tree}
              activePath={session.activeTabPath}
              onOpenFile={handleOpenFile}
              error={treeError}
              hasWorkspace={Boolean(activeLane)}
            />
          </div>
        </section>
        <section className="pane editor-pane">
          <EditorPane
            tabs={session.tabs}
            activePath={session.activeTabPath}
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
              value: notes,
              onChange: setNotes,
            }}
            lanes={{
              casefile,
              onSwitchLane: handleSwitchLane,
              onRegisterLane: handleRegisterLane,
              onChooseLaneRoot: handleChooseLaneRoot,
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
