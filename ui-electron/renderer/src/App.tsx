import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ApiKeyStatus,
  ChatMessage,
  FileTreeNode,
  Provider,
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

export function App(): JSX.Element {
  // Workspace + file tree
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  const [tree, setTree] = useState<FileTreeNode | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);

  // Editor tabs
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [activeTabPath, setActiveTabPath] = useState<string | null>(null);

  // Right panel
  const [rightTab, setRightTab] = useState<RightTabKey>("chat");

  // Chat state
  const [provider, setProvider] = useState<Provider>(() => {
    const saved = localStorage.getItem(PROVIDER_STORAGE_KEY) as Provider | null;
    return saved ?? "openai";
  });
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<ToolCall[]>([]);
  const [chatBusy, setChatBusy] = useState(false);

  // Notes state (persisted to localStorage; durable per-lane storage comes in M2/M3)
  const [notes, setNotes] = useState<string>(() => localStorage.getItem(NOTES_STORAGE_KEY) ?? "");
  useEffect(() => {
    localStorage.setItem(NOTES_STORAGE_KEY, notes);
  }, [notes]);

  // API keys
  const [keyStatus, setKeyStatus] = useState<ApiKeyStatus>(DEFAULT_KEY_STATUS);
  const [keysOpen, setKeysOpen] = useState(false);

  // Persist provider selection.
  useEffect(() => {
    localStorage.setItem(PROVIDER_STORAGE_KEY, provider);
  }, [provider]);

  const refreshKeyStatus = useCallback(async () => {
    try {
      const status = await api().getApiKeyStatus();
      setKeyStatus(status);
      // If the saved provider no longer has a key but exactly one provider is
      // configured, auto-switch to it. Mirrors the previous behavior.
      const configured: Provider[] = [];
      if (status.openaiConfigured) configured.push("openai");
      if (status.anthropicConfigured) configured.push("anthropic");
      if (status.deepseekConfigured) configured.push("deepseek");
      if (configured.length === 1 && !configured.includes(provider)) {
        setProvider(configured[0]);
      }
    } catch (error) {
      // Non-fatal: leave status as default.
      console.warn("getApiKeyStatus failed", error);
    }
  }, [provider]);

  useEffect(() => {
    void refreshKeyStatus();
    const remove = api().onOpenApiKeys(() => setKeysOpen(true));
    return () => {
      remove();
    };
    // refreshKeyStatus has its own deps; the effect should run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshTree = useCallback(async () => {
    if (!workspaceRoot) {
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
  }, [workspaceRoot]);

  useEffect(() => {
    void refreshTree();
  }, [refreshTree]);

  const handleChooseWorkspace = useCallback(async () => {
    try {
      const chosen = await api().chooseWorkspace();
      if (chosen) {
        setWorkspaceRoot(chosen);
        setTabs([]);
        setActiveTabPath(null);
      }
    } catch (error) {
      setTreeError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const handleOpenFile = useCallback(
    async (filePath: string) => {
      // Already open: just focus the existing tab.
      if (tabs.some((t) => t.path === filePath)) {
        setActiveTabPath(filePath);
        return;
      }
      try {
        const result = await api().readFile(filePath);
        setTabs((prev) => [
          ...prev,
          {
            path: result.path,
            content: result.content,
            savedContent: result.content,
            truncated: result.truncated,
          },
        ]);
        setActiveTabPath(result.path);
      } catch (error) {
        setTreeError(error instanceof Error ? error.message : String(error));
      }
    },
    [tabs]
  );

  const handleCloseTab = useCallback(
    (filePath: string) => {
      setTabs((prev) => {
        const next = prev.filter((t) => t.path !== filePath);
        if (activeTabPath === filePath) {
          setActiveTabPath(next.length > 0 ? next[next.length - 1].path : null);
        }
        return next;
      });
    },
    [activeTabPath]
  );

  const handleEditTab = useCallback((filePath: string, content: string) => {
    setTabs((prev) => prev.map((t) => (t.path === filePath ? { ...t, content } : t)));
  }, []);

  const handleSaveTab = useCallback(
    async (filePath: string) => {
      const tab = tabs.find((t) => t.path === filePath);
      if (!tab) return;
      try {
        await api().saveFile(filePath, tab.content);
        setTabs((prev) =>
          prev.map((t) =>
            t.path === filePath ? { ...t, savedContent: t.content, truncated: false } : t
          )
        );
        // The save may have changed which files the tree should display.
        void refreshTree();
      } catch (error) {
        setTreeError(error instanceof Error ? error.message : String(error));
      }
    },
    [tabs, refreshTree]
  );

  const refreshOpenTabsFromDisk = useCallback(async () => {
    // Re-read every non-dirty, non-truncated tab. Dirty tabs keep user edits.
    const fresh = await Promise.all(
      tabs.map(async (t) => {
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
    setTabs(fresh);
  }, [tabs]);

  // ----- Chat -----

  const lastSentRef = useRef<string>("");

  const sendMessage = useCallback(
    async (text: string) => {
      const value = text.trim();
      if (!value || chatBusy) return;
      lastSentRef.current = value;
      setChatBusy(true);
      setPendingApprovals([]);
      const historyBeforeTurn = messages;
      // Optimistically render the user message.
      setMessages([...historyBeforeTurn, { role: "user", content: value }]);
      try {
        const response = await api().sendChat({
          provider,
          messages: historyBeforeTurn,
          userMessage: value,
          allowWriteTools: false,
          resumePendingToolCalls: false,
        });
        if (Array.isArray(response.messages) && response.messages.length > 0) {
          setMessages([...historyBeforeTurn, ...response.messages]);
        } else if (response.message) {
          setMessages([
            ...historyBeforeTurn,
            { role: "user", content: value },
            response.message,
          ]);
        } else {
          setMessages([
            ...historyBeforeTurn,
            { role: "user", content: value },
            { role: "assistant", content: "Error: empty bridge response" },
          ]);
        }
        if (Array.isArray(response.pendingApprovals) && response.pendingApprovals.length > 0) {
          setPendingApprovals(response.pendingApprovals);
        }
        await refreshTree();
        await refreshOpenTabsFromDisk();
      } catch (error) {
        setMessages([
          ...historyBeforeTurn,
          { role: "user", content: value },
          {
            role: "assistant",
            content: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ]);
      } finally {
        setChatBusy(false);
      }
    },
    [chatBusy, messages, provider, refreshTree, refreshOpenTabsFromDisk]
  );

  const approveTools = useCallback(async () => {
    if (pendingApprovals.length === 0) return;
    setChatBusy(true);
    try {
      const response = await api().sendChat({
        provider,
        messages,
        userMessage: "",
        allowWriteTools: true,
        resumePendingToolCalls: true,
      });
      if (Array.isArray(response.messages) && response.messages.length > 0) {
        setMessages((prev) => [...prev, ...response.messages!]);
      }
      setPendingApprovals([]);
      await refreshTree();
      await refreshOpenTabsFromDisk();
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ]);
      setPendingApprovals([]);
    } finally {
      setChatBusy(false);
    }
  }, [pendingApprovals, provider, messages, refreshTree, refreshOpenTabsFromDisk]);

  const denyTools = useCallback(() => {
    if (pendingApprovals.length === 0) return;
    setMessages((prev) => [
      ...prev,
      { role: "assistant", content: "Write operation request denied." },
    ]);
    setPendingApprovals([]);
  }, [pendingApprovals]);

  return (
    <div className="app">
      <Toolbar
        workspaceRoot={workspaceRoot}
        provider={provider}
        onProviderChange={setProvider}
        keyStatus={keyStatus}
        onChooseWorkspace={handleChooseWorkspace}
        onOpenKeys={() => setKeysOpen(true)}
      />
      <div className="workbench">
        <section className="pane">
          <header className="pane-header">Workspace</header>
          <div className="pane-body">
            <FileTree
              root={tree}
              activePath={activeTabPath}
              onOpenFile={handleOpenFile}
              error={treeError}
              hasWorkspace={Boolean(workspaceRoot)}
            />
          </div>
        </section>
        <section className="pane editor-pane">
          <EditorPane
            tabs={tabs}
            activePath={activeTabPath}
            onSelectTab={setActiveTabPath}
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
              messages,
              pendingApprovals,
              busy: chatBusy,
              onSend: sendMessage,
              onApproveTools: approveTools,
              onDenyTools: denyTools,
            }}
            notes={{
              value: notes,
              onChange: setNotes,
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
