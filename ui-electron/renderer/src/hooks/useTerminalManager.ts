import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

import {
  disposeTerminalSession,
  type TerminalSession,
} from "../components/TerminalsPanel";
import { api } from "../lib/api";

export interface TerminalLaneContext {
  id: string;
  name: string;
  root: string;
}

interface UseTerminalManagerOptions {
  activeLane: TerminalLaneContext | null;
  casefileRoot: string | null;
  setTerminalOpen: Dispatch<SetStateAction<boolean>>;
}

interface UseTerminalManagerResult {
  terminalSessions: TerminalSession[];
  activeTerminalId: string | null;
  handleNewTerminal: () => void;
  handleSelectTerminal: (id: string) => void;
  handleCloseTerminal: (id: string) => void;
  toggleTerminalOpen: () => void;
}

/**
 * Pick the next free integer suffix for a base label.
 *
 * The previous implementation used `sameBase.length + 1` which produced
 * duplicate labels after a close: opening "main", "main 2", closing
 * "main", then opening another would yield "main 2" again. Walking
 * upward from 1 guarantees uniqueness without depending on insertion
 * order. (Review item #12.)
 */
function nextLabel(existing: TerminalSession[], base: string): string {
  const taken = new Set<string>();
  for (const session of existing) {
    if (session.label === base) {
      taken.add(base);
    } else if (
      session.label.startsWith(`${base} `) &&
      /^\d+$/.test(session.label.slice(base.length + 1))
    ) {
      taken.add(session.label);
    }
  }
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1024; i++) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Fallback for the (extremely unlikely) case where the user has
  // 1023 terminals open with the same base name.
  return `${base} ${Date.now().toString(36)}`;
}

export function useTerminalManager({
  activeLane,
  casefileRoot,
  setTerminalOpen,
}: UseTerminalManagerOptions): UseTerminalManagerResult {
  const [terminalSessions, setTerminalSessions] = useState<TerminalSession[]>([]);
  const [activeTerminalIdState, setActiveTerminalIdState] = useState<string | null>(null);

  // Mirror the active terminal id into a ref so the close handler
  // doesn't need to depend on it (avoids re-creating the callback on
  // every selection change).
  const activeTerminalIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeTerminalIdRef.current = activeTerminalIdState;
  }, [activeTerminalIdState]);

  const setActiveTerminalId = useCallback((id: string | null) => {
    activeTerminalIdRef.current = id;
    setActiveTerminalIdState(id);
  }, []);

  // Track whether a terminal should be auto-spawned on the next
  // commit. We can't safely call another setState inside a setState
  // updater, so we set this flag and let an effect handle it.
  // (Review item #25.)
  const pendingAutoSpawnRef = useRef(false);

  const handleNewTerminal = useCallback(() => {
    const cwd = activeLane?.root || casefileRoot || null;
    const stamp = Date.now().toString(36);
    const baseLabel = activeLane?.name || "shell";
    const id = activeLane ? `lane:${activeLane.id}:${stamp}` : `shell:${stamp}`;
    setTerminalSessions((prev) => [
      ...prev,
      {
        id,
        label: nextLabel(prev, baseLabel),
        cwd: cwd || "",
        laneId: activeLane?.id ?? null,
      },
    ]);
    setActiveTerminalId(id);
    setTerminalOpen(true);
  }, [activeLane, casefileRoot, setActiveTerminalId, setTerminalOpen]);

  const handleSelectTerminal = useCallback(
    (id: string) => {
      setActiveTerminalId(id);
    },
    [setActiveTerminalId]
  );

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
        const closedIndex = prev.findIndex((session) => session.id === id);
        const next = prev.filter((session) => session.id !== id);
        if (activeTerminalIdRef.current === id) {
          if (next.length === 0) {
            setActiveTerminalId(null);
          } else {
            // Snap to the right-neighbour of the closed tab (mirrors
            // VS Code / iTerm), falling back to the new last tab.
            const fallbackIndex =
              closedIndex < 0
                ? next.length - 1
                : Math.min(closedIndex, next.length - 1);
            setActiveTerminalId(next[fallbackIndex].id);
          }
        }
        return next;
      });
    },
    [setActiveTerminalId]
  );

  const toggleTerminalOpen = useCallback(() => {
    setTerminalOpen((prev) => {
      const next = !prev;
      if (next && terminalSessions.length === 0) {
        // Defer to a real effect (rather than setState-inside-setState)
        // so React owns the timing and we don't capture a stale
        // `handleNewTerminal` closure. (Review item #25.)
        pendingAutoSpawnRef.current = true;
      }
      return next;
    });
  }, [setTerminalOpen, terminalSessions.length]);

  // Service the pending auto-spawn after the toggle has committed.
  useEffect(() => {
    if (!pendingAutoSpawnRef.current) return;
    if (terminalSessions.length > 0) {
      pendingAutoSpawnRef.current = false;
      return;
    }
    pendingAutoSpawnRef.current = false;
    handleNewTerminal();
  }, [handleNewTerminal, terminalSessions.length]);

  // Keep the ref in sync so the menu-driven IPC subscription below
  // (registered exactly once) can always call the current toggle
  // closure without re-subscribing on every keystroke / state change.
  const toggleTerminalRef = useRef<() => void>(() => {});
  useEffect(() => {
    toggleTerminalRef.current = toggleTerminalOpen;
  }, [toggleTerminalOpen]);

  // Bridge the main-process menu accelerator (CmdOrCtrl+`) into the
  // same toggle action used by the toolbar button. The accelerator
  // works even when focus is in the integrated terminal, because
  // Electron consumes the keystroke at the menu layer before xterm
  // sees it.
  useEffect(() => {
    // Call through `apiRef` (rather than destructuring) to preserve
    // the implicit `this` binding in case the bridge is class-based.
    // (Review item #29.)
    const apiRef = api();
    const remove = apiRef.onToggleTerminal(() => {
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
  // focus is inside `.terminal-view`. We also bail when focus is in a
  // text field so users editing a note / chat input don't toggle the
  // terminal accidentally. (Review item #26.)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "`") return;
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.(".terminal-view")) return;
      if (isTextEntryTarget(target)) return;
      event.preventDefault();
      toggleTerminalOpen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleTerminalOpen]);

  return {
    terminalSessions,
    activeTerminalId: activeTerminalIdState,
    handleNewTerminal,
    handleSelectTerminal,
    handleCloseTerminal,
    toggleTerminalOpen,
  };
}

function isTextEntryTarget(target: HTMLElement | null): boolean {
  if (!target) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}
