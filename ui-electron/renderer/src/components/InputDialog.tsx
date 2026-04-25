import { useEffect, useRef, useState } from "react";

/** Props for a single-field text-input modal. The dialog renders a
 * backdrop, a labelled prompt, an autofocused text input, and OK / Cancel
 * buttons. Submit fires `onSubmit(value)` with the trimmed final value;
 * Cancel / Esc / backdrop-click fire `onCancel()`.
 *
 * We rolled our own instead of using `window.prompt` because Chromium-
 * embedded apps (Electron in particular, since v8) suppress the native
 * `window.prompt` modal — the call returns null without showing any UI,
 * which made the FileTree's right-click prompts (Rename…, Move…, New
 * file…, etc.) silently no-op. This component is the in-app replacement
 * those callers route through.
 */
interface InputDialogProps {
  title: string;
  /** Optional secondary line of context shown under the title. */
  message?: string;
  /** Pre-filled value. Selected on open so the user can immediately type
   * to replace, or arrow-key to edit. */
  defaultValue?: string;
  /** Label for the primary action button. Defaults to "OK". */
  confirmLabel?: string;
  /** Selection range applied to the input on mount. Useful for things
   * like rename where we want to pre-select just the basename without
   * the file extension. Pass `undefined` to select the whole value. */
  selection?: { start: number; end: number };
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

export function InputDialog({
  title,
  message,
  defaultValue = "",
  confirmLabel = "OK",
  selection,
  onSubmit,
  onCancel,
}: InputDialogProps): JSX.Element {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);

  // Autofocus + select on mount so the dialog behaves like a native
  // prompt: open, type, hit Enter. We deliberately don't put `selection`
  // in the deps — re-selecting on every prop change would yank the
  // cursor out from under the user mid-edit.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    if (selection) {
      el.setSelectionRange(selection.start, selection.end);
    } else {
      el.select();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Esc anywhere in the dialog cancels. The OK / Cancel buttons own
  // their own clicks; the form's onSubmit handles Enter.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const submit = (event?: React.FormEvent) => {
    if (event) event.preventDefault();
    onSubmit(value);
  };

  return (
    <div
      className="dialog-backdrop"
      onClick={onCancel}
      // Capture the right-click that opened the prompt so the FileTree
      // doesn't re-open its context menu underneath when the user dismisses
      // by right-clicking the backdrop.
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="dialog input-dialog" onClick={(event) => event.stopPropagation()}>
        <h3>{title}</h3>
        {message && <p className="muted">{message}</p>}
        <form onSubmit={submit}>
          <input
            ref={inputRef}
            type="text"
            className="input-dialog-field"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <div className="actions">
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit">{confirmLabel}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
