import { useEffect, useMemo, useRef, useState } from "react";
import type { Lane } from "../types";
import { api } from "../lib/api";

/** Per-lane group of save destinations. The lane root itself is always
 * offered as the first row; each attachment is offered after that. The
 * caller may pass a single lane (single-lane chat) or multiple lanes
 * (comparison chat) — the picker renders a separate section per lane. */
interface LaneDestination {
  lane: Lane;
}

interface SaveOutputPickerProps {
  /** The lanes whose attachments + roots should be offered as save
   * destinations. Single-lane chats pass `[activeLane]`; comparison chats
   * pass every lane in the session. */
  lanes: Lane[];
  /** Default filename suggestion (already slugified, including the
   * extension). The picker still lets the user edit it before saving. */
  defaultFilename: string;
  /** Body to write to the chosen file. */
  body: string;
  /** Called after a successful save with the absolute path of the new
   * file. The parent uses it to render confirmation feedback. */
  onSaved: (path: string) => void;
  /** Called when the user dismisses the picker without saving. */
  onCancel: () => void;
}

interface PendingDestination {
  /** Absolute directory the file will be written to. */
  destinationDir: string;
  /** Human-friendly label shown above the filename prompt
   * (e.g. ``"Lane A · ash_notes"``). */
  label: string;
}

/** Inline picker rendered next to a chat message. Two-step UX:
 *
 * 1. Pick a destination directory: a row per attachment (or lane root)
 *    of every lane in `lanes`, plus a final ``Other...`` that opens the
 *    system folder dialog.
 * 2. Confirm the filename. The default is the slugified first line of
 *    the message; the user can change it.
 *
 * The actual write is performed by `chat:saveOutput` on the bridge,
 * which validates the destination + filename and refuses to overwrite. */
export function SaveOutputPicker({
  lanes,
  defaultFilename,
  body,
  onSaved,
  onCancel,
}: SaveOutputPickerProps): JSX.Element {
  // The picker is always rendered as an inline popover; group the
  // destinations by lane so a comparison chat shows one section per
  // lane. The lane root itself is always offered alongside attachments
  // because a lane may have no attachments at all.
  const groups: LaneDestination[] = useMemo(
    () => lanes.map((lane) => ({ lane })),
    [lanes]
  );

  const [pending, setPending] = useState<PendingDestination | null>(null);
  const [filename, setFilename] = useState(defaultFilename);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const filenameRef = useRef<HTMLInputElement>(null);

  // Auto-focus the filename input as soon as a destination is chosen so
  // the user can hit Enter immediately without reaching for the mouse.
  useEffect(() => {
    if (pending && filenameRef.current) {
      filenameRef.current.focus();
      filenameRef.current.select();
    }
  }, [pending]);

  const choose = (destinationDir: string, label: string) => {
    setPending({ destinationDir, label });
    setFilename(defaultFilename);
    setError(null);
  };

  const chooseOther = async () => {
    setError(null);
    try {
      const dir = await api().chooseLaneRoot();
      if (!dir) return;
      choose(dir, dir);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const submit = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (!pending || busy) return;
    const trimmed = filename.trim();
    if (!trimmed) {
      setError("Filename is required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api().saveChatOutput({
        destinationDir: pending.destinationDir,
        filename: trimmed,
        body,
      });
      onSaved(result.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="chat-save-output-picker"
      role="dialog"
      aria-label="Save chat message"
    >
      <div className="chat-save-output-header">
        <strong>Save message to...</strong>
        <button type="button" className="link-button" onClick={onCancel}>
          cancel
        </button>
      </div>
      {!pending && (
        <div className="chat-save-output-destinations">
          {groups.map(({ lane }) => {
            const attachments = lane.attachments ?? [];
            return (
              <div key={lane.id} className="chat-save-output-lane">
                <div className="chat-save-output-lane-header">{lane.name}</div>
                <button
                  type="button"
                  className="chat-save-output-row"
                  onClick={() => choose(lane.root, `${lane.name} · root`)}
                  title={lane.root}
                >
                  <span className="chat-save-output-row-name">context root</span>
                  <span className="chat-save-output-row-path">{lane.root}</span>
                </button>
                {attachments.map((att) => (
                  <button
                    key={`${lane.id}::${att.name}`}
                    type="button"
                    className="chat-save-output-row"
                    onClick={() => choose(att.root, `${lane.name} · ${att.name}`)}
                    title={att.root}
                  >
                    <span className="chat-save-output-row-name">{att.name}</span>
                    <span className="chat-save-output-row-path">{att.root}</span>
                  </button>
                ))}
                {attachments.length === 0 && (
                  <span className="chat-save-output-empty">
                    No attachments configured for this context.
                  </span>
                )}
              </div>
            );
          })}
          <button
            type="button"
            className="chat-save-output-row chat-save-output-other"
            onClick={() => void chooseOther()}
          >
            <span className="chat-save-output-row-name">Other...</span>
            <span className="chat-save-output-row-path">Pick a folder</span>
          </button>
          {error && <span className="chat-save-output-error">{error}</span>}
        </div>
      )}
      {pending && (
        <form className="chat-save-output-form" onSubmit={submit}>
          <div className="chat-save-output-target">
            <span className="muted">Saving to:</span>
            <code>{pending.destinationDir}</code>
            <button
              type="button"
              className="link-button"
              onClick={() => setPending(null)}
              disabled={busy}
            >
              change
            </button>
          </div>
          <input
            ref={filenameRef}
            type="text"
            value={filename}
            onChange={(event) => setFilename(event.target.value)}
            disabled={busy}
            spellCheck={false}
          />
          <div className="row">
            <button type="submit" disabled={busy || !filename.trim()}>
              {busy ? "Saving..." : "Save"}
            </button>
            <button
              type="button"
              className="link-button"
              onClick={onCancel}
              disabled={busy}
            >
              cancel
            </button>
          </div>
          {error && <span className="chat-save-output-error">{error}</span>}
        </form>
      )}
    </div>
  );
}

/** Slugify a chat message body's first line into a safe filename stub.
 * Falls back to a timestamp-only name if the body has no usable text. */
export function suggestSaveFilename(body: string): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .slice(0, 16); // YYYY-MM-DDTHH-mm
  const firstLine = (body.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return firstLine ? `${stamp}-${firstLine}.md` : `${stamp}.md`;
}
