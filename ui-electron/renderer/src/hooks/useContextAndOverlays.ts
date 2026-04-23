import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../lib/api";
import type {
  CasefileSnapshot,
  ContextManifestDto,
  LaneAttachmentInput,
  LaneUpdateInput,
  OverlayTreeDto,
  UpdateLaneResult,
} from "../types";
import { DEFAULT_AUTO_INCLUDE_MAX_BYTES, errorMessage } from "./appModelTypes";

interface UseContextAndOverlaysArgs {
  casefile: CasefileSnapshot | null;
  activeLaneId: string | null;
  onCasefileChange: (casefile: CasefileSnapshot) => void;
  onError: (message: string) => void;
}

export function useContextAndOverlays({
  casefile,
  activeLaneId,
  onCasefileChange,
  onError,
}: UseContextAndOverlaysArgs) {
  // Depend on the root rather than the entire casefile snapshot. The
  // snapshot is replaced on every lane switch / lane edit, which made
  // the original effect re-fetch the manifest gratuitously. (#19)
  const casefileRoot = casefile?.root ?? null;

  const [contextManifest, setContextManifest] = useState<ContextManifestDto | null>(null);
  const [contextBusy, setContextBusy] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);
  const [showOverlays, setShowOverlays] = useState(false);
  const [overlayTrees, setOverlayTrees] = useState<OverlayTreeDto[]>([]);
  const [overlaysLoading, setOverlaysLoading] = useState(false);
  const [overlaysError, setOverlaysError] = useState<string | null>(null);

  // Cancellation tokens for the in-flight context / overlay fetches.
  // Without these, an older request resolving after a newer one (e.g.
  // because the user switched lanes during a slow read) would clobber
  // fresh state with stale data. (#5)
  const contextRequestRef = useRef(0);
  const overlayRequestRef = useRef(0);

  const reloadContext = useCallback(async () => {
    if (!casefileRoot) {
      setContextManifest(null);
      return;
    }
    const token = ++contextRequestRef.current;
    try {
      const next = await api().getContext();
      if (token !== contextRequestRef.current) return;
      setContextManifest(next);
      setContextError(null);
    } catch (error) {
      if (token !== contextRequestRef.current) return;
      setContextError(errorMessage(error));
    }
  }, [casefileRoot]);

  useEffect(() => {
    void reloadContext();
  }, [reloadContext]);

  const handleSaveContext = useCallback(
    async (manifest: { files: string[]; autoIncludeMaxBytes: number }) => {
      setContextBusy(true);
      try {
        const saved = await api().saveContext(manifest);
        setContextManifest(saved);
        setContextError(null);
      } catch (error) {
        setContextError(errorMessage(error));
        throw error;
      } finally {
        setContextBusy(false);
      }
    },
    []
  );

  const handleAddToContext = useCallback(
    async (pattern: string) => {
      const trimmed = pattern.trim();
      if (!trimmed) return;
      // Try to refresh the manifest first to avoid clobbering changes
      // made elsewhere. If the refresh fails AND we have nothing in
      // state to fall back on, we MUST bail — otherwise we would
      // persist a manifest containing only `[trimmed]`, silently
      // wiping the user's existing context. (#2)
      let base: ContextManifestDto | null = contextManifest;
      try {
        base = await api().getContext();
      } catch (error) {
        if (!base) {
          setContextError(
            `Could not load casefile context: ${errorMessage(error)}`
          );
          return;
        }
      }
      const baseFiles = base?.files ?? [];
      if (baseFiles.includes(trimmed)) {
        setContextError(`Pattern "${trimmed}" is already in the casefile context.`);
        return;
      }
      const cap = base?.autoIncludeMaxBytes ?? DEFAULT_AUTO_INCLUDE_MAX_BYTES;
      await handleSaveContext({ files: [...baseFiles, trimmed], autoIncludeMaxBytes: cap });
    },
    [contextManifest, handleSaveContext]
  );

  const handleSetLaneParent = useCallback(
    async (laneId: string, parentId: string | null) => {
      try {
        const snapshot = await api().setLaneParent(laneId, parentId);
        onCasefileChange(snapshot);
      } catch (error) {
        const message = errorMessage(error);
        onError(message);
        throw error;
      }
    },
    [onCasefileChange, onError]
  );

  const handleUpdateLaneAttachments = useCallback(
    async (laneId: string, attachments: LaneAttachmentInput[]) => {
      try {
        const snapshot = await api().updateLaneAttachments(laneId, attachments);
        onCasefileChange(snapshot);
      } catch (error) {
        const message = errorMessage(error);
        onError(message);
        throw error;
      }
    },
    [onCasefileChange, onError]
  );

  const handleUpdateLane = useCallback(
    async (laneId: string, update: LaneUpdateInput): Promise<UpdateLaneResult> => {
      try {
        const result = await api().updateLane(laneId, update);
        onCasefileChange(result.casefile);
        return result;
      } catch (error) {
        const message = errorMessage(error);
        onError(message);
        throw error;
      }
    },
    [onCasefileChange, onError]
  );

  const handleRemoveLane = useCallback(
    async (laneId: string) => {
      try {
        const snapshot = await api().removeLane(laneId);
        onCasefileChange(snapshot);
      } catch (error) {
        const message = errorMessage(error);
        onError(message);
        throw error;
      }
    },
    [onCasefileChange, onError]
  );

  const handleHardResetCasefile = useCallback(async () => {
    try {
      const snapshot = await api().hardResetCasefile();
      onCasefileChange(snapshot);
    } catch (error) {
      const message = errorMessage(error);
      onError(message);
      throw error;
    }
  }, [onCasefileChange, onError]);

  const handleSoftResetCasefile = useCallback(
    async (keepPrompts: boolean) => {
      try {
        const snapshot = await api().softResetCasefile(keepPrompts);
        onCasefileChange(snapshot);
      } catch (error) {
        const message = errorMessage(error);
        onError(message);
        throw error;
      }
    },
    [onCasefileChange, onError]
  );

  const reloadOverlays = useCallback(async () => {
    if (!casefileRoot || !activeLaneId || !showOverlays) {
      setOverlayTrees([]);
      try {
        // `registerWatchRoots` is part of the required AssistantApi
        // surface (see types.ts). The previous `?.` here masked real
        // bugs (e.g. preload script not exposing it). If it's truly
        // missing, we want a clear error in the console. (#18)
        await api().registerWatchRoots([]);
      } catch (error) {
        console.warn("registerWatchRoots(empty) failed", error);
      }
      return;
    }
    const token = ++overlayRequestRef.current;
    setOverlaysLoading(true);
    try {
      const overlays = await api().listOverlayTrees(activeLaneId, 4);
      if (token !== overlayRequestRef.current) return;
      setOverlayTrees(overlays);
      setOverlaysError(null);
      const roots = overlays
        .map((overlay) => overlay.root)
        .filter((root): root is string => typeof root === "string" && root.length > 0);
      try {
        await api().registerWatchRoots(roots);
      } catch (error) {
        // Watch registration is best-effort — the UI will still
        // render, just without filesystem-change notifications.
        console.warn("registerWatchRoots failed", error);
      }
    } catch (error) {
      if (token !== overlayRequestRef.current) return;
      setOverlaysError(errorMessage(error));
    } finally {
      if (token === overlayRequestRef.current) {
        setOverlaysLoading(false);
      }
    }
  }, [activeLaneId, casefileRoot, showOverlays]);

  useEffect(() => {
    void reloadOverlays();
  }, [reloadOverlays]);

  return {
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
    showOverlays,
    setShowOverlays,
    overlayTrees,
    overlaysLoading,
    overlaysError,
    reloadOverlays,
  };
}
