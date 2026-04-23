import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../lib/api";
import type {
  CasefileSnapshot,
  ContextManifestDto,
  LaneAttachmentInput,
  LaneUpdateInput,
  UpdateLaneResult,
} from "../types";
import { DEFAULT_AUTO_INCLUDE_MAX_BYTES, errorMessage } from "./appModelTypes";

interface UseContextAndOverlaysArgs {
  casefile: CasefileSnapshot | null;
  activeLaneId: string | null;
  onCasefileChange: (casefile: CasefileSnapshot) => void;
  onError: (message: string) => void;
}

// NOTE: this hook used to also fetch and expose ancestor / attachment /
// context overlay trees for the FileTree UI. The tree no longer
// renders those overlays as separate sections (the user-facing
// "Inherited context" panel was confusing), so the hook now only
// covers the casefile-context manifest and lane management actions.
// Scope resolution for AI chat is unaffected — that lives entirely in
// `src/assistant_app/casefile/scope.py` and the bridge.
export function useContextAndOverlays({
  casefile,
  activeLaneId: _activeLaneId,
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

  // Cancellation token for in-flight context fetch. Without it, an
  // older request resolving after a newer one (e.g. because the user
  // switched lanes during a slow read) would clobber fresh state with
  // stale data. (#5)
  const contextRequestRef = useRef(0);

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

  // The FileTree no longer subscribes to overlay roots, so the
  // workspace-watch registration shrinks to "register no extra
  // roots". Kept as a single best-effort call when the casefile
  // changes so a previously-active overlay watcher is cleared.
  useEffect(() => {
    void (async () => {
      try {
        await api().registerWatchRoots([]);
      } catch (error) {
        console.warn("registerWatchRoots(empty) failed", error);
      }
    })();
  }, [casefileRoot]);

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
  };
}
