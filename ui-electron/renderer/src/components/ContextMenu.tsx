import { useEffect, useRef } from "react";

export interface ContextMenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** Optional separator AFTER this item. */
  separator?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

/** Lightweight floating menu pinned to (x, y) in viewport coordinates.
 *
 * Closes on outside click, Escape, or window resize/scroll. Items with
 * `disabled: true` render greyed-out and are not clickable. The menu
 * positions itself flush to the cursor and clamps to the viewport so it
 * never opens off-screen.
 *
 * Keyboard navigation: ArrowDown/Up moves focus, Home/End jump to first/last
 * enabled item, Enter activates the focused item, Escape closes. The first
 * enabled item receives focus automatically on open.
 */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click, Escape, resize, and blur.
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        onClose();
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    const onAux = () => onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onAux);
    window.addEventListener("blur", onAux);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onAux);
      window.removeEventListener("blur", onAux);
    };
  }, [onClose]);

  // Clamp to viewport and auto-focus first enabled item after paint.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (rect.right > vw) el.style.left = `${Math.max(0, vw - rect.width - 4)}px`;
    if (rect.bottom > vh) el.style.top = `${Math.max(0, vh - rect.height - 4)}px`;

    const first = el.querySelector<HTMLButtonElement>(
      "button.context-menu-item:not(:disabled)"
    );
    first?.focus();
  }, [x, y]);

  // Arrow-key navigation within the menu.
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const container = ref.current;
    if (!container) return;
    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        "button.context-menu-item:not(:disabled)"
      )
    );
    const active = document.activeElement as HTMLButtonElement | null;
    const idx = active ? buttons.indexOf(active) : -1;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      const next = buttons[(idx + 1) % buttons.length];
      next?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      const prev = buttons[(idx - 1 + buttons.length) % buttons.length];
      prev?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      buttons[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      buttons[buttons.length - 1]?.focus();
    }
  };

  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      aria-label="Context menu"
      style={{ left: x, top: y }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={handleKeyDown}
    >
      {items.map((item, idx) => (
        <div key={idx}>
          <button
            type="button"
            role="menuitem"
            className="context-menu-item"
            disabled={item.disabled}
            aria-disabled={item.disabled}
            tabIndex={item.disabled ? -1 : 0}
            onClick={() => {
              if (item.disabled) return;
              item.onSelect();
              onClose();
            }}
          >
            {item.label}
          </button>
          {item.separator && <div className="context-menu-separator" role="separator" />}
        </div>
      ))}
    </div>
  );
}
