import { useCallback, useEffect } from "react";

import { api } from "../lib/api";
import type {
  CasefileSnapshot,
  ContextAttachmentInput,
  ContextUpdateInput,
  UpdateContextResult,
} from "../types";
import { errorMessage } from "./appModelTypes";

interface UseContextAndOverlaysArgs {
  casefile: CasefileSnapshot | null;
  activeContextId: string | null;
  onCasefileChange: (casefile: CasefileSnapshot) => void;
  onError: (message: string) => void;
}

// NOTE: this hook used to also fetch and expose ancestor / attachment /
// context overlay trees for the FileTree UI. The tree no longer renders those
// overlays or the casefile-context manifest as user-facing controls. Scope
// resolution for AI chat lives entirely in `src/assistant_app/casefile/scope.py`
// and the bridge; this hook now only keeps context management actions together.
export function useContextAndOverlays({
  casefile,
  activeContextId: _activeContextId,
  onCasefileChange,
  onError,
}: UseContextAndOverlaysArgs) {
  const casefileRoot = casefile?.root ?? null;

  const handleUpdateContextAttachments = useCallback(
    async (contextId: string, attachments: ContextAttachmentInput[]) => {
      try {
        const snapshot = await api().updateContextAttachments(contextId, attachments);
        onCasefileChange(snapshot);
      } catch (error) {
        const message = errorMessage(error);
        onError(message);
        throw error;
      }
    },
    [onCasefileChange, onError]
  );

  const handleUpdateContext = useCallback(
    async (contextId: string, update: ContextUpdateInput): Promise<UpdateContextResult> => {
      try {
        const result = await api().updateContext(contextId, update);
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

  const handleRemoveContext = useCallback(
    async (contextId: string) => {
      try {
        const snapshot = await api().removeContext(contextId);
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
    handleUpdateContextAttachments,
    handleUpdateContext,
    handleRemoveContext,
    handleHardResetCasefile,
    handleSoftResetCasefile,
  };
}
