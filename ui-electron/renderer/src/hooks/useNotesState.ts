import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../lib/api";
import {
  EMPTY_NOTE_STATE,
  errorMessage,
  type NoteState,
} from "./appModelTypes";

const NOTES_DEBOUNCE_MS = 600;

interface UseNotesStateArgs {
  casefileRoot: string | null;
  activeLaneId: string | null;
  sessionKey: string | null;
}

interface PendingSave {
  laneId: string;
  content: string;
  handle: number;
}

export function useNotesState({
  casefileRoot,
  activeLaneId,
  sessionKey,
}: UseNotesStateArgs) {
  const [notesByLane, setNotesByLane] = useState<Map<string, NoteState>>(() => new Map());
  const noteState = sessionKey ? notesByLane.get(sessionKey) ?? EMPTY_NOTE_STATE : EMPTY_NOTE_STATE;

  const updateNote = useCallback((key: string, updater: (prev: NoteState) => NoteState) => {
    setNotesByLane((prev) => {
      const next = new Map(prev);
      const current = next.get(key) ?? EMPTY_NOTE_STATE;
      next.set(key, updater(current));
      return next;
    });
  }, []);

  // Map of session key -> pending debounced save metadata. We track
  // the laneId/content alongside the timer handle so that a flush
  // (on lane switch / unmount) can re-issue the same save without
  // having to wait for the original timeout. (#6)
  const pendingSavesRef = useRef<Map<string, PendingSave>>(new Map());

  // Per-load token, so a slow `getNote` for an old lane can't clobber
  // newly-typed content for the same lane after the user re-opens it.
  // (#6 race fix.)
  const loadTokensRef = useRef<Map<string, number>>(new Map());

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
          error: errorMessage(error),
        }));
      }
    },
    [updateNote]
  );

  const flushPendingSave = useCallback(
    (key: string) => {
      const pending = pendingSavesRef.current.get(key);
      if (!pending) return;
      window.clearTimeout(pending.handle);
      pendingSavesRef.current.delete(key);
      void flushNoteSave(key, pending.laneId, pending.content);
    },
    [flushNoteSave]
  );

  const scheduleNoteSave = useCallback(
    (key: string, laneId: string, content: string) => {
      const pending = pendingSavesRef.current.get(key);
      if (pending !== undefined) {
        window.clearTimeout(pending.handle);
      }
      const handle = window.setTimeout(() => {
        pendingSavesRef.current.delete(key);
        void flushNoteSave(key, laneId, content);
      }, NOTES_DEBOUNCE_MS);
      pendingSavesRef.current.set(key, { laneId, content, handle });
    },
    [flushNoteSave]
  );

  const handleNoteChange = useCallback(
    (next: string) => {
      if (!sessionKey || !activeLaneId) return;
      updateNote(sessionKey, (prev) => ({ ...prev, content: next }));
      scheduleNoteSave(sessionKey, activeLaneId, next);
    },
    [activeLaneId, scheduleNoteSave, sessionKey, updateNote]
  );

  const loadLaneNotes = useCallback(async (laneId: string, key: string) => {
    const token = (loadTokensRef.current.get(key) ?? 0) + 1;
    loadTokensRef.current.set(key, token);
    setNotesByLane((prev) => {
      if (prev.has(key)) return prev;
      const next = new Map(prev);
      next.set(key, { ...EMPTY_NOTE_STATE, loading: true });
      return next;
    });
    try {
      const content = await api().getNote(laneId);
      if (loadTokensRef.current.get(key) !== token) return;
      setNotesByLane((prev) => {
        const current = prev.get(key);
        // If the user has already typed something locally before this
        // load resolved, do NOT overwrite their content. We only
        // hydrate when the buffer is still in its loading state with
        // an empty baseline. (#6 race fix.)
        if (current && (current.content !== "" || current.baseline !== "")) {
          // Just clear the loading flag; preserve user edits.
          const next = new Map(prev);
          next.set(key, { ...current, loading: false });
          return next;
        }
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
      if (loadTokensRef.current.get(key) !== token) return;
      const errMsg = errorMessage(error);
      setNotesByLane((prev) => {
        const next = new Map(prev);
        const current = next.get(key) ?? EMPTY_NOTE_STATE;
        next.set(key, { ...current, loading: false, error: errMsg });
        return next;
      });
    }
  }, []);

  useEffect(() => {
    if (!casefileRoot || !activeLaneId) return;
    const key = `${casefileRoot}\u0000${activeLaneId}`;
    void loadLaneNotes(activeLaneId, key);
  }, [activeLaneId, casefileRoot, loadLaneNotes]);

  // Flush any pending debounced save when the user switches lanes or
  // casefiles. Without this, "type → switch lane → quit" loses the
  // last 600ms of typing. (#6)
  const lastSessionKeyRef = useRef<string | null>(sessionKey);
  useEffect(() => {
    const previous = lastSessionKeyRef.current;
    if (previous && previous !== sessionKey) {
      flushPendingSave(previous);
    }
    lastSessionKeyRef.current = sessionKey;
  }, [flushPendingSave, sessionKey]);

  // Flush every pending save on unmount and on a best-effort
  // `beforeunload` (e.g. window close). The async save may not
  // complete before the renderer is torn down, but at least we make
  // the request. (#6)
  useEffect(() => {
    const flushAll = () => {
      const keys = Array.from(pendingSavesRef.current.keys());
      for (const key of keys) flushPendingSave(key);
    };
    window.addEventListener("beforeunload", flushAll);
    return () => {
      window.removeEventListener("beforeunload", flushAll);
      flushAll();
    };
  }, [flushPendingSave]);

  return {
    noteState,
    handleNoteChange,
  };
}
