import { useEffect, useMemo, useState } from "react";
import type { Lane, RunCommandPayload, RunRecordDto, RunSummaryDto } from "../types";

interface RunsTabProps {
  hasCasefile: boolean;
  hasActiveLane: boolean;
  activeLaneId: string | null;
  lanes: Lane[];
  runs: RunSummaryDto[];
  loading: boolean;
  error: string | null;
  // Commands available to the user. Comes from the backend allowlist (kept
  // mirrored in `system_exec.ALLOWED_EXECUTABLES`); see `runs.py`.
  allowedExecutables: readonly string[];
  onRun: (payload: RunCommandPayload) => Promise<RunRecordDto>;
  onLoadRun: (runId: string) => Promise<RunRecordDto>;
  onDelete: (runId: string) => Promise<void>;
}

interface PendingState {
  busy: boolean;
  error: string | null;
}

const EMPTY_PENDING: PendingState = { busy: false, error: null };

function formatStartedAt(iso: string): string {
  // Records use "YYYY-MM-DDTHH:MM:SSZ"; show in the local timezone for
  // operator convenience without pulling in a date library.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function statusLabel(run: RunSummaryDto): string {
  if (run.error) return "error";
  if (run.exitCode === null) return "?";
  return run.exitCode === 0 ? "ok" : `exit ${run.exitCode}`;
}

export function RunsTab({
  hasCasefile,
  hasActiveLane,
  activeLaneId,
  lanes,
  runs,
  loading,
  error,
  allowedExecutables,
  onRun,
  onLoadRun,
  onDelete,
}: RunsTabProps): JSX.Element {
  const [commandLine, setCommandLine] = useState("");
  // The user can scope a run to the active lane (default), to no lane
  // (= casefile root cwd), or to any other registered lane. We keep this
  // local — the parent's "active lane" doesn't have to move because the
  // user wants to run something against a different one.
  const [scopeLaneId, setScopeLaneId] = useState<string | null>(activeLaneId);
  useEffect(() => {
    setScopeLaneId(activeLaneId);
  }, [activeLaneId]);

  const [pending, setPending] = useState<PendingState>(EMPTY_PENDING);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<RunRecordDto | null>(null);
  const [selectedRunLoading, setSelectedRunLoading] = useState(false);
  const [selectedRunError, setSelectedRunError] = useState<string | null>(null);

  // Whenever the casefile flips away (or the run we were viewing is
  // deleted), drop the detail pane.
  useEffect(() => {
    if (!hasCasefile) {
      setSelectedRunId(null);
      setSelectedRun(null);
    }
  }, [hasCasefile]);

  useEffect(() => {
    if (selectedRunId !== null && !runs.some((r) => r.id === selectedRunId)) {
      setSelectedRunId(null);
      setSelectedRun(null);
    }
  }, [runs, selectedRunId]);

  const lanesById = useMemo(() => {
    const m = new Map<string, Lane>();
    for (const l of lanes) m.set(l.id, l);
    return m;
  }, [lanes]);

  const openRun = async (runId: string) => {
    setSelectedRunId(runId);
    setSelectedRun(null);
    setSelectedRunError(null);
    setSelectedRunLoading(true);
    try {
      const full = await onLoadRun(runId);
      setSelectedRun(full);
    } catch (err) {
      setSelectedRunError(err instanceof Error ? err.message : String(err));
    } finally {
      setSelectedRunLoading(false);
    }
  };

  const submit = async () => {
    const value = commandLine.trim();
    if (!value || pending.busy) return;
    setPending({ busy: true, error: null });
    try {
      const created = await onRun({ commandLine: value, laneId: scopeLaneId });
      setCommandLine("");
      setSelectedRunId(created.id);
      setSelectedRun(created);
    } catch (err) {
      setPending({
        busy: false,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    setPending(EMPTY_PENDING);
  };

  const remove = async (runId: string) => {
    if (!window.confirm("Delete this run record? This cannot be undone.")) return;
    try {
      await onDelete(runId);
    } catch (err) {
      setSelectedRunError(err instanceof Error ? err.message : String(err));
    }
  };

  if (!hasCasefile) {
    return (
      <div className="runs-tab">
        <span className="hint">Open a casefile to launch and review command runs.</span>
      </div>
    );
  }

  return (
    <div className="runs-tab">
      <form
        className="runs-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="runs-form-row">
          <select
            value={scopeLaneId ?? ""}
            onChange={(event) =>
              setScopeLaneId(event.target.value === "" ? null : event.target.value)
            }
            disabled={pending.busy}
          >
            <option value="">cwd: casefile root</option>
            {lanes.map((lane) => (
              <option key={lane.id} value={lane.id}>
                cwd: lane "{lane.name}"
              </option>
            ))}
          </select>
          <input
            type="text"
            value={commandLine}
            onChange={(event) => setCommandLine(event.target.value)}
            placeholder={`Allowed: ${allowedExecutables.join(", ")}`}
            disabled={pending.busy}
            spellCheck={false}
          />
          <button type="submit" disabled={pending.busy || !commandLine.trim()}>
            {pending.busy ? "Running..." : "Run"}
          </button>
        </div>
        {pending.error && <span className="runs-error">{pending.error}</span>}
        <span className="hint">
          Stored under <code>.casefile/runs/&lt;id&gt;.json</code>. Output is bounded
          (8 KB stdout / stderr; 30 s timeout) and the executable allowlist is enforced.
          {!hasActiveLane && " (No active lane: runs will use the casefile root unless you pick a lane above.)"}
        </span>
      </form>
      <div className="runs-body">
        <ul className="runs-list">
          {runs.length === 0 && !loading && (
            <li className="runs-empty">No runs yet.</li>
          )}
          {loading && <li className="runs-empty">Loading...</li>}
          {error && <li className="runs-error">{error}</li>}
          {runs.map((run) => {
            const isOpen = run.id === selectedRunId;
            const lane = run.laneId ? lanesById.get(run.laneId) ?? null : null;
            return (
              <li
                key={run.id}
                className={`runs-list-item${isOpen ? " open" : ""}${
                  run.error || (run.exitCode !== null && run.exitCode !== 0)
                    ? " failed"
                    : ""
                }`}
              >
                <button
                  type="button"
                  className="runs-list-button"
                  onClick={() => void openRun(run.id)}
                >
                  <span className="runs-list-cmd">{run.command}</span>
                  <span className="runs-list-meta">
                    {statusLabel(run)} ·{" "}
                    {lane ? `lane "${lane.name}"` : run.laneId ?? "casefile"} ·{" "}
                    {formatStartedAt(run.startedAt)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="runs-detail">
          {selectedRunId === null ? (
            <span className="hint">Select a run to see its full output.</span>
          ) : selectedRunLoading ? (
            <span className="hint">Loading...</span>
          ) : selectedRunError ? (
            <span className="runs-error">{selectedRunError}</span>
          ) : selectedRun ? (
            <RunDetail run={selectedRun} onDelete={() => void remove(selectedRun.id)} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

interface RunDetailProps {
  run: RunRecordDto;
  onDelete: () => void;
}

function RunDetail({ run, onDelete }: RunDetailProps): JSX.Element {
  return (
    <div className="run-detail">
      <header>
        <span className="run-detail-cmd">$ {run.command}</span>
        <span className="run-detail-meta">
          {run.error ? "error" : `exit ${run.exitCode}`} · {formatStartedAt(run.startedAt)}
          {run.cwd ? ` · cwd ${run.cwd}` : ""}
        </span>
      </header>
      {run.error && (
        <div className="run-detail-error">
          <strong>Error:</strong> {run.error}
        </div>
      )}
      <section>
        <h4>
          stdout{run.stdoutTruncated ? " (truncated)" : ""}
        </h4>
        <pre>{run.stdout || <em>(empty)</em>}</pre>
      </section>
      <section>
        <h4>
          stderr{run.stderrTruncated ? " (truncated)" : ""}
        </h4>
        <pre>{run.stderr || <em>(empty)</em>}</pre>
      </section>
      <div className="run-detail-actions">
        <button type="button" className="danger" onClick={onDelete}>
          Delete record
        </button>
      </div>
    </div>
  );
}
