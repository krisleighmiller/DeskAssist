import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

import type { OpenTab } from "../components/EditorPane";
import { api } from "../lib/api";
import type { CasefileSnapshot, FileTreeNode, Lane } from "../types";
import {
  EMPTY_LANE_SESSION,
  errorMessage,
  fileTabKey,
  overlayTabKey,
  rewriteTabKeyForRename,
  type LaneSessionState,
} from "./appModelTypes";

interface UseLaneWorkspaceArgs {
  casefile: CasefileSnapshot | null;
  activeLane: Lane | null;
  activeLaneId: string | null;
  session: LaneSessionState;
  updateSession: (updater: (prev: LaneSessionState) => LaneSessionState) => void;
  setLaneSessions: React.Dispatch<React.SetStateAction<Map<string, LaneSessionState>>>;
  setTreeError: Dispatch<SetStateAction<string | null>>;
  reloadOverlays: () => Promise<void>;
}

export function useLaneWorkspace({
  casefile,
  activeLane,
  activeLaneId,
  session,
  updateSession,
  setLaneSessions,
  setTreeError,
  reloadOverlays,
}: UseLaneWorkspaceArgs) {
  const [tree, setTree] = useState<FileTreeNode | null>(null);

  // Token for the in-flight `listWorkspace` request. We bump this on
  // every refresh and only apply a response if the latest token still
  // matches; otherwise a slow response from a previously-active lane
  // could clobber the freshly-switched lane's tree. (Review item #5.)
  const treeRequestRef = useRef(0);

  const refreshTree = useCallback(async () => {
    if (!activeLane) {
      setTree(null);
      return;
    }
    const token = ++treeRequestRef.current;
    try {
      const next = await api().listWorkspace(4);
      if (token !== treeRequestRef.current) return;
      setTree(next);
      setTreeError(null);
    } catch (error) {
      if (token !== treeRequestRef.current) return;
      setTreeError(errorMessage(error));
    }
  }, [activeLane, setTreeError]);

  // Cache of session keys whose persisted chat history has already
  // been loaded. Avoids the wasted IPC roundtrip in the original
  // implementation, which always called `listChat` before checking
  // whether the key was cached. (Review item #13.)
  const loadedChatKeysRef = useRef<Set<string>>(new Set());

  const loadLaneChatHistory = useCallback(
    async (laneId: string, key: string) => {
      if (loadedChatKeysRef.current.has(key)) return;
      loadedChatKeysRef.current.add(key);
      try {
        const persisted = await api().listChat(laneId);
        setLaneSessions((prev) => {
          if (prev.has(key)) return prev;
          const next = new Map(prev);
          next.set(key, { ...EMPTY_LANE_SESSION, messages: persisted });
          return next;
        });
      } catch (error) {
        // Allow a retry on the next lane visit.
        loadedChatKeysRef.current.delete(key);
        setTreeError(`Could not load chat history: ${errorMessage(error)}`);
      }
    },
    [setLaneSessions, setTreeError]
  );

  const handleOpenFile = useCallback(
    async (filePath: string) => {
      if (!activeLaneId) return;
      const key = fileTabKey(activeLaneId, filePath);
      if (session.tabs.some((tab) => tab.key === key)) {
        updateSession((prev) => ({ ...prev, activeTabKey: key }));
        return;
      }
      try {
        const result = await api().readFile(filePath);
        // The bridge may normalize the path (e.g. resolve symlinks),
        // so always derive the final tab key from `result.path` to
        // match a future open of the canonical path.
        const finalKey = fileTabKey(activeLaneId, result.path);
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
    [activeLaneId, session.tabs, setTreeError, updateSession]
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
      void reloadOverlays();
      void refreshOpenTabsFromDisk();
    });
  }, [refreshOpenTabsFromDisk, refreshTree, reloadOverlays]);

  const handleRenameFile = useCallback(
    async (oldPath: string, newName: string) => {
      try {
        const result = await api().renameFile(oldPath, newName);
        const newPath = result.newPath;
        setLaneSessions((prev) => {
          const next = new Map(prev);
          let mutated = false;
          for (const [key, sessionState] of prev.entries()) {
            let touched = false;
            const tabs = sessionState.tabs.map((tab) => {
              if (tab.kind === "file" && tab.path === oldPath) {
                touched = true;
                return {
                  ...tab,
                  path: newPath,
                  key: rewriteTabKeyForRename(tab.key, oldPath, newPath),
                };
              }
              if (tab.kind === "diff" && tab.path === oldPath) {
                // Diff tabs are read-only snapshots, but the displayed
                // path label and the tab key both encode the old name
                // and would be misleading after a rename.
                touched = true;
                return {
                  ...tab,
                  path: newPath,
                  key: rewriteTabKeyForRename(tab.key, oldPath, newPath),
                };
              }
              return tab;
            });
            if (touched) {
              mutated = true;
              const activeTabKey =
                sessionState.activeTabKey && sessionState.activeTabKey.endsWith(`:${oldPath}`)
                  ? rewriteTabKeyForRename(sessionState.activeTabKey, oldPath, newPath)
                  : sessionState.activeTabKey;
              next.set(key, { ...sessionState, tabs, activeTabKey });
            }
          }
          return mutated ? next : prev;
        });
        await refreshTree();
        await reloadOverlays();
      } catch (error) {
        setTreeError(errorMessage(error));
        throw error;
      }
    },
    [refreshTree, reloadOverlays, setLaneSessions, setTreeError]
  );

  const handleOpenOverlayFile = useCallback(
    async (virtualPath: string) => {
      if (!casefile || !activeLaneId) return;
      // Include the lane id so the same `virtualPath` viewed from two
      // different lanes does not collide on a single tab. (Review #3.)
      const key = overlayTabKey(activeLaneId, virtualPath);
      if (session.tabs.some((tab) => tab.key === key)) {
        updateSession((prev) => ({ ...prev, activeTabKey: key }));
        return;
      }
      try {
        const result = await api().readOverlayFile(activeLaneId, virtualPath);
        updateSession((prev) => {
          if (prev.tabs.some((tab) => tab.key === key)) {
            return { ...prev, activeTabKey: key };
          }
          return {
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
          };
        });
      } catch (error) {
        setTreeError(errorMessage(error));
      }
    },
    [activeLaneId, casefile, session.tabs, setTreeError, updateSession]
  );

  const handleOpenLaneFile = useCallback(
    async (laneId: string, path: string) => {
      if (!casefile) return;
      const lane = casefile.lanes.find((entry) => entry.id === laneId);
      if (!lane) return;
      const key = fileTabKey(laneId, path);
      if (session.tabs.some((tab) => tab.key === key)) {
        updateSession((prev) => ({ ...prev, activeTabKey: key }));
        return;
      }
      try {
        const result = await api().readLaneFile(laneId, path);
        const finalKey = fileTabKey(laneId, result.path);
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
    [casefile, session.tabs, setTreeError, updateSession]
  );

  return {
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
    handleOpenOverlayFile,
    handleOpenLaneFile,
  };
}
