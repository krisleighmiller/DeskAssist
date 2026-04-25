import { useCallback, useEffect } from "react";

import { api } from "../lib/api";
import type {
  CasefileSnapshot,
  LaneAttachmentInput,
  LaneUpdateInput,
  UpdateLaneResult,
} from "../types";
import { errorMessage } from "./appModelTypes";

interface UseContextAndOverlaysArgs {
  casefile: CasefileSnapshot | null;
  activeLaneId: string | null;
  onCasefileChange: (casefile: CasefileSnapshot) => void;
  onError: (message: string) => void;
}

// NOTE: this hook used to also fetch and expose ancestor / attachment /
// context overlay trees for the FileTree UI. The tree no longer renders those
// overlays or the casefile-context manifest as user-facing controls. Scope
// resolution for AI chat lives entirely in `src/assistant_app/casefile/scope.py`
// and the bridge; this hook now only keeps lane management actions together.
export function useContextAndOverlays({
  casefile,
  activeLaneId: _activeLaneId,
  onCasefileChange,
  onError,
}: UseContextAndOverlaysArgs) {
  const casefileRoot = casefile?.root ?? null;

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
    async () => {
      try {
        const snapshot = await api().softResetCasefile();
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
    handleUpdateLaneAttachments,
    handleUpdateLane,
    handleRemoveLane,
    handleHardResetCasefile,
    handleSoftResetCasefile,
  };
}
