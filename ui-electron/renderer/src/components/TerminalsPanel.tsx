import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import { api } from "../lib/api";

/**
 * Description of one live terminal session known to the renderer.
 *
 * The actual shell process lives in the Electron main process; this
 * record only carries enough metadata to render the tab strip and route
 * input/output to the right session.
 */
export interface TerminalSession {
  /** Stable id used for IPC channels (`terminal:data:<id>`, etc.). */
  id: string;
  /** Human-readable label shown in the tab strip. */
  label: string;
  /** cwd the shell was spawned in (informational). */
  cwd: string;
  /** Optional lane id this terminal was associated with at spawn. */
  laneId: string | null;
  /** True once the underlying PTY has exited. */
  exited?: boolean;
}

interface TerminalsPanelProps {
  sessions: TerminalSession[];
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onClear: () => void;
}

interface XtermBundle {
  term: Terminal;
  fit: FitAddon;
  unsubData: () => void;
  unsubExit: () => void;
  /** True once we've successfully called `terminal:spawn` on the main side. */
  spawned: boolean;
}

/**
 * Persistent registry of xterm.js `Terminal` instances, keyed by
 * session id. Lives at module scope so unmount/remount of the panel
 * (e.g. when the user toggles it closed/open) does NOT destroy the
 * scrollback or kill the shell. Cleanup happens in `disposeBundle`.
 */
const xtermRegistry = new Map<string, XtermBundle>();

function disposeBundle(id: string): void {
  const bundle = xtermRegistry.get(id);
  if (!bundle) return;
  xtermRegistry.delete(id);
  try {
    bundle.unsubData();
  } catch {
    // listener already detached; the preload bridge tolerates
    // double-removal but we still don't want a crash here.
  }
  try {
    bundle.unsubExit();
  } catch {
    // see above
  }
  try {
    bundle.term.dispose();
  } catch {
    // xterm sometimes throws on double-dispose; harmless.
  }
}

export function disposeTerminalSession(id: string): void {
  // Exposed so the parent App can clean up the xterm instance when it
  // removes a session from `sessions`. Killing the PTY itself is a
  // separate IPC call (`api().terminalKill(id)`).
  disposeBundle(id);
}

/**
 * One xterm-backed view of a single PTY session. Re-mounted whenever
 * the active tab changes, but the underlying `Terminal` instance is
 * pulled from the registry so scrollback survives the unmount.
 */
function TerminalView({
  session,
  isActive,
}: {
  session: TerminalSession;
  isActive: boolean;
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // We attach via useLayoutEffect so the container has measurable
  // dimensions before xterm's first `fit()` call. Otherwise the
  // initial spawn resize uses the default 80x24 even if the actual
  // container is much wider, leading to a rewrap on first interaction.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let bundle = xtermRegistry.get(session.id);
    if (!bundle) {
      const term = new Terminal({
        cursorBlink: true,
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
        fontSize: 13,
        theme: {
          background: "#0b1220",
          foreground: "#e5e7eb",
          cursor: "#e5e7eb",
          selectionBackground: "#374151",
        },
        convertEol: true,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      // Forward typed input to the shell.
      term.onData((data) => {
        void api().terminalWrite(session.id, data);
      });
      const unsubData = api().onTerminalData(session.id, (chunk) => {
        term.write(chunk);
      });
      const unsubExit = api().onTerminalExit(session.id, ({ exitCode }) => {
        term.write(`\r\n\x1b[2m[process exited with code ${exitCode}]\x1b[0m\r\n`);
      });
      bundle = { term, fit, unsubData, unsubExit, spawned: false };
      xtermRegistry.set(session.id, bundle);
    }

    const localBundle = bundle;
    localBundle.term.open(container);
    // Run fit on next tick once the DOM has laid out, then spawn the
    // shell with the actual dimensions if we haven't yet.
    const initId = window.setTimeout(() => {
      try {
        localBundle.fit.fit();
      } catch {
        // fit() throws if the container is unmounted between scheduling
        // and firing — tolerate it.
      }
      if (!localBundle.spawned) {
        localBundle.spawned = true;
        const cols = localBundle.term.cols;
        const rows = localBundle.term.rows;
        api()
          .terminalSpawn({
            id: session.id,
            cwd: session.cwd || null,
            laneId: session.laneId,
            cols,
            rows,
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            localBundle.term.write(
              `\r\n\x1b[31m[terminal failed to start: ${msg}]\x1b[0m\r\n`
            );
          });
      } else {
        // Existing session re-attached — push the new dimensions in
        // case the container resized while the view was hidden.
        void api().terminalResize(
          session.id,
          localBundle.term.cols,
          localBundle.term.rows
        );
      }
    }, 0);

    // Resize observer: when the container changes size, re-fit and
    // tell the PTY about the new viewport so child processes (vim,
    // less, etc.) get accurate WINSZ signals.
    const resizeObserver = new ResizeObserver(() => {
      try {
        localBundle.fit.fit();
        void api().terminalResize(
          session.id,
          localBundle.term.cols,
          localBundle.term.rows
        );
      } catch {
        // ignore; the container may have detached mid-observe
      }
    });
    resizeObserver.observe(container);

    return () => {
      window.clearTimeout(initId);
      resizeObserver.disconnect();
      // We deliberately do NOT dispose the xterm instance here — the
      // session may be hidden but should keep its scrollback. The
      // parent decides when to dispose by calling disposeTerminalSession
      // on real session close.
    };
  }, [session.id, session.cwd, session.laneId]);

  // Refocus when the tab becomes active so the user can immediately
  // start typing without an extra click.
  useEffect(() => {
    if (!isActive) return;
    const bundle = xtermRegistry.get(session.id);
    if (!bundle) return;
    // Defer to allow the DOM to update visibility before focusing,
    // otherwise xterm's textarea hasn't been laid out yet.
    const id = window.setTimeout(() => {
      try {
        bundle.term.focus();
        bundle.fit.fit();
      } catch {
        // pane may have unmounted between the activation and the
        // animation frame; nothing to do.
      }
    }, 0);
    return () => window.clearTimeout(id);
  }, [isActive, session.id]);

  return (
    <div
      ref={containerRef}
      className="terminal-view"
      style={{ display: isActive ? "block" : "none" }}
    />
  );
}

export function TerminalsPanel({
  sessions,
  activeSessionId,
  onSelect,
  onClose,
  onNew,
  onClear,
}: TerminalsPanelProps): JSX.Element {
  const [available, setAvailable] = useState<{ ok: boolean; error: string | null } | null>(
    null
  );
  useEffect(() => {
    let cancelled = false;
    api()
      .terminalAvailable()
      .then((result) => {
        if (cancelled) return;
        setAvailable({ ok: result.available, error: result.error });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setAvailable({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // We sort by id so the tab strip order is stable across renders;
  // sessions arrive from the parent already in insertion order, but
  // multi-tab apps where a parent recomputes the array can otherwise
  // shuffle the visible order on every keystroke.
  const orderedSessions = useMemo(() => sessions.slice(), [sessions]);

  if (available && !available.ok) {
    return (
      <div className="terminal-panel terminal-panel-error">
        <div className="terminal-panel-error-body">
          <div>Terminal unavailable.</div>
          {available.error && <div className="hint">{available.error}</div>}
          <div className="hint">
            Run <code>npm run rebuild:native</code> in <code>ui-electron/</code>{" "}
            to recompile <code>node-pty</code> against your Electron version.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="terminal-panel">
      <div className="terminal-tabs">
        {orderedSessions.map((s) => (
          <div
            key={s.id}
            className={`terminal-tab${s.id === activeSessionId ? " active" : ""}${
              s.exited ? " exited" : ""
            }`}
            onClick={() => onSelect(s.id)}
            title={s.cwd}
          >
            <span className="terminal-tab-label">{s.label}</span>
            <button
              type="button"
              className="terminal-tab-close"
              aria-label={`Close terminal ${s.label}`}
              onClick={(e) => {
                e.stopPropagation();
                onClose(s.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          className="terminal-tab-new"
          onClick={onNew}
          aria-label="New terminal"
          title="New terminal in active lane"
        >
          +
        </button>
        <div className="terminal-tabs-spacer" />
        <button
          type="button"
          className="terminal-panel-action"
          onClick={onClear}
          title="Hide terminal panel"
          aria-label="Hide terminal panel"
        >
          ⌄
        </button>
      </div>
      <div className="terminal-views">
        {orderedSessions.length === 0 ? (
          <div className="terminal-empty">
            <div>No terminals open.</div>
            <button type="button" className="terminal-empty-new" onClick={onNew}>
              Open a terminal
            </button>
          </div>
        ) : (
          orderedSessions.map((s) => (
            <TerminalView
              key={s.id}
              session={s}
              isActive={s.id === activeSessionId}
            />
          ))
        )}
      </div>
    </div>
  );
}
