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
 */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        onClose();
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
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

  // Clamp to viewport after first render: the menu's natural width may
  // overflow the right edge if the click landed near it.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (rect.right > vw) el.style.left = `${Math.max(0, vw - rect.width - 4)}px`;
    if (rect.bottom > vh) el.style.top = `${Math.max(0, vh - rect.height - 4)}px`;
  }, [x, y]);

  return (
    <div
      ref={ref}
      className="context-menu"
      style={{ left: x, top: y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, idx) => (
        <div key={idx}>
          <button
            type="button"
            className="context-menu-item"
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return;
              item.onSelect();
              onClose();
            }}
          >
            {item.label}
          </button>
          {item.separator && <div className="context-menu-separator" />}
        </div>
      ))}
    </div>
  );
}
