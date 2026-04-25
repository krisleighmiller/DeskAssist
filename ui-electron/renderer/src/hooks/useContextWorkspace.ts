import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

import type { OpenTab } from "../components/EditorPane";
import { api } from "../lib/api";
import type { CasefileSnapshot, FileTreeNode, Context } from "../types";
import {
  EMPTY_CONTEXT_SESSION,
  errorMessage,
  fileTabKey,
  generateSessionId,
  isPathOrDescendant,
  rewriteDescendantPath,
  rewriteTabKeyForRename,
  type ContextSessionState,
} from "./appModelTypes";

interface UseContextWorkspaceArgs {
  casefile: CasefileSnapshot | null;
  activeContext: Context | null;
  activeContextId: string | null;
  session: ContextSessionState;
  updateSession: (updater: (prev: ContextSessionState) => ContextSessionState) => void;
  setContextSessions: React.Dispatch<React.SetStateAction<Map<string, ContextSessionState>>>;
  setTreeError: Dispatch<SetStateAction<string | null>>;
}

export function useContextWorkspace({
  casefile: _casefile,
  activeContext,
  activeContextId,
  session,
  updateSession,
  setContextSessions,
  setTreeError,
}: UseContextWorkspaceArgs) {
  const [tree, setTree] = useState<FileTreeNode | null>(null);

  // Token for the in-flight `listWorkspace` request. We bump this on
  // every refresh and only apply a response if the latest token still
  // matches; otherwise a slow response from a previously-active context
  // could clobber the freshly-switched context's tree. (Review item #5.)
  const treeRequestRef = useRef(0);

  const refreshTree = useCallback(async () => {
    if (!activeContext) {
      setTree(null);
      return;
    }
    const token = ++treeRequestRef.current;
    try {
      // Depth 6 matches what the bridge caps to (8) minus a little
      // headroom; the tree now starts at the casefile root rather than
      // the active context root, so we need a couple of extra levels for
      // typical "casefile → context → src → …" hierarchies to render.
      const next = await api().listWorkspace(6);
      if (token !== treeRequestRef.current) return;
      setTree(next);
      setTreeError(null);
    } catch (error) {
      if (token !== treeRequestRef.current) return;
      setTreeError(errorMessage(error));
    }
  }, [activeContext, setTreeError]);

  // Cache of session keys whose persisted chat history has already
  // been loaded. Avoids the wasted IPC roundtrip in the original
  // implementation, which always called `listChat` before checking
  // whether the key was cached. (Review item #13.)
  const loadedChatKeysRef = useRef<Set<string>>(new Set());

  const loadContextChatHistory = useCallback(
    async (contextId: string, key: string) => {
      if (loadedChatKeysRef.current.has(key)) return;
      loadedChatKeysRef.current.add(key);
      try {
        const persisted = await api().listChat(contextId);
        if (persisted.skippedCorruptLines > 0) {
          setTreeError(
            `Loaded chat history, but skipped ${persisted.skippedCorruptLines} corrupt line(s).`
          );
        }
        setContextSessions((prev) => {
          if (prev.has(key)) return prev;
          const next = new Map(prev);
          next.set(key, {
            ...EMPTY_CONTEXT_SESSION,
            id: generateSessionId(),
            messages: persisted.messages,
          });
          return next;
        });
      } catch (error) {
        // Allow a retry on the next context visit.
        loadedChatKeysRef.current.delete(key);
        setTreeError(`Could not load chat history: ${errorMessage(error)}`);
      }
    },
    [setContextSessions, setTreeError]
  );

  const handleOpenFile = useCallback(
    async (filePath: string) => {
      if (!activeContextId) return;
      const key = fileTabKey(activeContextId, filePath);
      if (session.tabs.some((tab) => tab.key === key)) {
        updateSession((prev) => ({ ...prev, activeTabKey: key }));
        return;
      }
      try {
        const result = await api().readFile(filePath);
        // The bridge may normalize the path (e.g. resolve symlinks),
        // so always derive the final tab key from `result.path` to
        // match a future open of the canonical path.
        const finalKey = fileTabKey(activeContextId, result.path);
        updateSession((prev) => {
          if (prev.tabs.some((tab) => tab.key === finalKey)) {
            return { ...prev, activeTabKey: finalKey };
          }
          return {
            ...prev,
            tabs: [
              ...prev.tabs,
              {
                kind: "file",
                key: finalKey,
                path: result.path,
                content: result.content,
                savedContent: result.content,
                truncated: result.truncated,
              },
            ],
            activeTabKey: finalKey,
          };
        });
      } catch (error) {
        setTreeError(errorMessage(error));
      }
    },
    [activeContextId, session.tabs, setTreeError, updateSession]
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
        const closedIndex = prev.tabs.findIndex((tab) => tab.key === key);
        const remainingTabs = prev.tabs.filter((tab) => tab.key !== key);
        let nextActive: string | null = prev.activeTabKey;
        if (prev.activeTabKey === key) {
          if (remainingTabs.length === 0) {
            nextActive = null;
          } else {
            // Match VS Code / iTerm: prefer the tab that was to the
            // right of the closed one (now occupying the same
            // position), falling back to the new last tab. Guard
            // against `closedIndex === -1` (key not actually in tabs)
            // so we don't index by a negative number.
            const fallbackIndex =
              closedIndex < 0
                ? remainingTabs.length - 1
                : Math.min(closedIndex, remainingTabs.length - 1);
            nextActive = remainingTabs[fallbackIndex].key;
          }
        }
        return { ...prev, tabs: remainingTabs, activeTabKey: nextActive };
      });
    },
    [updateSession]
  );

  const handleEditTab = useCallback(
    (key: string, content: string) => {
      updateSession((prev) => ({
        ...prev,
        tabs: prev.tabs.map((tab) =>
          tab.kind === "file" && tab.key === key ? { ...tab, content } : tab
        ),
      }));
    },
    [updateSession]
  );

  const handleSaveTab = useCallback(
    async (key: string) => {
      const tab = session.tabs.find((entry) => entry.key === key);
      if (!tab || tab.kind !== "file") return;
      try {
        await api().saveFile(tab.path, tab.content);
        updateSession((prev) => ({
          ...prev,
          tabs: prev.tabs.map((entry) =>
            entry.kind === "file" && entry.key === key
              ? { ...entry, savedContent: entry.content, truncated: false }
              : entry
          ),
        }));
        void refreshTree();
      } catch (error) {
        setTreeError(errorMessage(error));
      }
    },
    [refreshTree, session.tabs, setTreeError, updateSession]
  );

  const refreshOpenTabsFromDisk = useCallback(async () => {
    const snapshot = session.tabs;
    if (snapshot.length === 0) return;
    // Read disk content per-tab. We later apply against the *current*
    // session (not the snapshot) so a user typing in flight is never
    // overwritten — the original implementation here was a real
    // data-loss bug. (Review item #1.)
    type FreshEntry = { content: string; truncated: boolean };
    const fresh = new Map<string, FreshEntry>();
    await Promise.all(
      snapshot.map(async (tab) => {
        if (tab.kind !== "file") return;
        if (tab.content !== tab.savedContent || tab.truncated) return;
        try {
          const result = await api().readFile(tab.path);
          fresh.set(tab.key, {
            content: result.content,
            truncated: result.truncated,
          });
        } catch {
          // Per-tab read failures are intentionally swallowed: the
          // file may have been deleted out of band, in which case the
          // user keeps the buffer until they explicitly close the
          // tab. Surfacing every failure here would be too noisy.
        }
      })
    );
    if (fresh.size === 0) return;
    updateSession((prev) => ({
      ...prev,
      tabs: prev.tabs.map((tab) => {
        if (tab.kind !== "file") return tab;
        const next = fresh.get(tab.key);
        if (!next) return tab;
        // Re-check dirty state against the *current* tab. The user
        // may have started typing while the read was in flight.
        if (tab.content !== tab.savedContent || tab.truncated) return tab;
        if (
          tab.content === next.content &&
          tab.savedContent === next.content &&
          tab.truncated === next.truncated
        ) {
          // No-op: avoid cloning the tab when nothing actually changed.
          return tab;
        }
        return {
          ...tab,
          content: next.content,
          savedContent: next.content,
          truncated: next.truncated,
        } satisfies OpenTab;
      }),
    }));
  }, [session.tabs, updateSession]);

  useEffect(() => {
    const apiRef = api();
    if (typeof apiRef.onWorkspaceChanged !== "function") return;
    // Call through `apiRef` (rather than destructuring) to preserve
    // the implicit `this` binding in case the bridge is class-based.
    return apiRef.onWorkspaceChanged(() => {
      void refreshTree();
      void refreshOpenTabsFromDisk();
    });
  }, [refreshOpenTabsFromDisk, refreshTree]);

  // Rewrite open tabs after a path rename or move. Handles both
  // single-file moves and directory renames where every descendant tab
  // also needs its path updated. Pure helper — no IPC, no setState.
  const applyPathChangeToSessions = useCallback(
    (
      sessions: Map<string, ContextSessionState>,
      oldPath: string,
      newPath: string
    ): Map<string, ContextSessionState> => {
      const next = new Map(sessions);
      let mutated = false;
      for (const [key, sessionState] of sessions.entries()) {
        let touched = false;
        const tabs = sessionState.tabs.map((tab) => {
          if (tab.kind === "file" && isPathOrDescendant(tab.path, oldPath)) {
            touched = true;
            const rewrittenPath = rewriteDescendantPath(tab.path, oldPath, newPath);
            return {
              ...tab,
              path: rewrittenPath,
              key: rewriteTabKeyForRename(tab.key, tab.path, rewrittenPath),
            };
          }
          return tab;
        });
        if (touched) {
          mutated = true;
          // The active tab's key may itself be one of the moved tabs;
          // recompute it the same way so the session keeps focus on
          // the same buffer after the move.
          let activeTabKey = sessionState.activeTabKey;
          if (activeTabKey) {
            const activeTab = sessionState.tabs.find(
              (tab) => tab.key === activeTabKey
            );
            if (activeTab && isPathOrDescendant(activeTab.path, oldPath)) {
              const rewrittenPath = rewriteDescendantPath(
                activeTab.path,
                oldPath,
                newPath
              );
              activeTabKey = rewriteTabKeyForRename(
                activeTab.key,
                activeTab.path,
                rewrittenPath
              );
            }
          }
          next.set(key, { ...sessionState, tabs, activeTabKey });
        }
      }
      return mutated ? next : sessions;
    },
    []
  );

  const handleRenameFile = useCallback(
    async (oldPath: string, newName: string) => {
      try {
        const result = await api().renameFile(oldPath, newName);
        const newPath = result.newPath;
        setContextSessions((prev) => applyPathChangeToSessions(prev, oldPath, newPath));
        await refreshTree();
      } catch (error) {
        setTreeError(errorMessage(error));
        throw error;
      }
    },
    [applyPathChangeToSessions, refreshTree, setContextSessions, setTreeError]
  );

  // M2: cross-directory move/rename. The destination is a full context-
  // absolute path (the FileTree composes it from the typed sub-path or
  // the drag-and-drop target row). Tabs whose path equals or descends
  // from the source are rewritten so dirty buffers do not orphan.
  const handleMoveEntry = useCallback(
    async (sourcePath: string, destinationPath: string) => {
      try {
        const result = await api().moveEntry(sourcePath, destinationPath);
        if (result.moved) {
          setContextSessions((prev) =>
            applyPathChangeToSessions(prev, result.sourcePath, result.destinationPath)
          );
        }
        await refreshTree();
      } catch (error) {
        setTreeError(errorMessage(error));
        throw error;
      }
    },
    [applyPathChangeToSessions, refreshTree, setContextSessions, setTreeError]
  );

  // M2: trash an entry to the OS trash and prune any open tabs that
  // pointed at the trashed path or its descendants. We don't try to
  // preserve dirty edits here — the user explicitly asked for the
  // delete; surfacing a "you have unsaved changes" prompt belongs in
  // the FileTree's confirmation step, not here.
  const handleTrashEntry = useCallback(
    async (targetPath: string) => {
      try {
        await api().trashEntry(targetPath);
        setContextSessions((prev) => {
          const next = new Map(prev);
          let mutated = false;
          for (const [key, sessionState] of prev.entries()) {
            const remaining = sessionState.tabs.filter(
              (tab) => !isPathOrDescendant(tab.path, targetPath)
            );
            if (remaining.length === sessionState.tabs.length) continue;
            mutated = true;
            // If the active tab was just removed, fall back to the new
            // last tab (or null if nothing remains). Mirrors the close-
            // tab snap-to-neighbour behaviour.
            let activeTabKey = sessionState.activeTabKey;
            const activeStillThere = remaining.some(
              (tab) => tab.key === activeTabKey
            );
            if (!activeStillThere) {
              activeTabKey = remaining.length > 0 ? remaining[remaining.length - 1].key : null;
            }
            next.set(key, { ...sessionState, tabs: remaining, activeTabKey });
          }
          return mutated ? next : prev;
        });
        await refreshTree();
      } catch (error) {
        setTreeError(errorMessage(error));
        throw error;
      }
    },
    [refreshTree, setContextSessions, setTreeError]
  );

  // M2: create a new (empty) file inside the active casefile and open it
  // in the editor. We open the file proactively so the user can start
  // typing immediately — the watcher will refresh the tree but we
  // don't want to wait for that round-trip.
  const handleCreateFile = useCallback(
    async (parentDir: string, name: string) => {
      try {
        const result = await api().createFile(parentDir, name);
        await refreshTree();
        await handleOpenFile(result.path);
      } catch (error) {
        setTreeError(errorMessage(error));
        throw error;
      }
    },
    [handleOpenFile, refreshTree, setTreeError]
  );

  const handleCreateFolder = useCallback(
    async (parentDir: string, name: string) => {
      try {
        await api().createFolder(parentDir, name);
        await refreshTree();
      } catch (error) {
        setTreeError(errorMessage(error));
        throw error;
      }
    },
    [refreshTree, setTreeError]
  );

  return {
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
  };
}
