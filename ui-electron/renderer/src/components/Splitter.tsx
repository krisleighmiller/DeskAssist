import { useEffect, useRef } from "react";

/** A vertical drag handle that sits between two panes in a horizontal
 * flex container. The parent owns the pane's pixel width and updates it
 * via `onResize` while the user drags.
 *
 * For a horizontal drag handle that resizes a *bottom-anchored* pane
 * vertically (e.g. the terminal pane below the workbench), see
 * `HorizontalSplitter` at the bottom of this file.
 *
 * Behavior:
 * - We capture the pointer on mouse-down so the drag continues even when
 *   the cursor leaves the splitter strip.
 * - Width updates are clamped to `[min, max]` so a user can't shrink a
 *   pane to zero (which would leave the splitter unreachable).
 * - Double-click resets to `defaultWidth`.
 *
 * `side` controls drag direction relative to the controlled pane:
 *   `"left"`  — splitter sits on the right edge of a left-anchored pane
 *               (drag right grows the pane).
 *   `"right"` — splitter sits on the left edge of a right-anchored pane
 *               (drag left grows the pane).
 */
interface SplitterProps {
  width: number;
  min: number;
  max: number;
  defaultWidth: number;
  side: "left" | "right";
  onResize: (next: number) => void;
  ariaLabel?: string;
}

export function Splitter({
  width,
  min,
  max,
  defaultWidth,
  side,
  onResize,
  ariaLabel,
}: SplitterProps): JSX.Element {
  const dragState = useRef<{
    startX: number;
    startWidth: number;
    pointerId: number;
  } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Keep the latest width visible to mouse handlers without re-binding
  // them every render. (The handler closure captures the value at
  // pointer-down time anyway, but this matches the value used by
  // double-click reset and keyboard handlers.)
  const widthRef = useRef(width);
  widthRef.current = width;

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    dragState.current = {
      startX: event.clientX,
      startWidth: widthRef.current,
      pointerId: event.pointerId,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragState.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const delta = event.clientX - drag.startX;
    const signed = side === "left" ? delta : -delta;
    const next = Math.min(max, Math.max(min, drag.startWidth + signed));
    onResize(next);
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragState.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer was already released (e.g. window lost focus); ignore.
    }
    dragState.current = null;
  };

  // Keyboard accessibility: ←/→ nudge by 16px, Home resets.
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 64 : 16;
    let next = widthRef.current;
    if (event.key === "ArrowLeft") {
      next = side === "left" ? next - step : next + step;
    } else if (event.key === "ArrowRight") {
      next = side === "left" ? next + step : next - step;
    } else if (event.key === "Home") {
      next = defaultWidth;
    } else {
      return;
    }
    event.preventDefault();
    onResize(Math.min(max, Math.max(min, next)));
  };

  // Cleanup: if the splitter unmounts mid-drag (route change, etc.),
  // make sure no zombie pointer-capture survives.
  useEffect(() => {
    return () => {
      dragState.current = null;
    };
  }, []);

  return (
    <div
      ref={rootRef}
      className="splitter"
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-label={ariaLabel ?? "Resize panel"}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => onResize(defaultWidth)}
      onKeyDown={onKeyDown}
    />
  );
}

/** Horizontal drag handle for a pane stacked vertically below another.
 *
 * The controlled pane is *bottom-anchored* (e.g. the integrated terminal
 * pane that sits under the workbench), so dragging the handle UP grows
 * the pane and dragging DOWN shrinks it. We mirror the keyboard /
 * double-click affordances from {@link Splitter} so both handles feel
 * the same. */
interface HorizontalSplitterProps {
  height: number;
  min: number;
  max: number;
  defaultHeight: number;
  onResize: (next: number) => void;
  ariaLabel?: string;
}

export function HorizontalSplitter({
  height,
  min,
  max,
  defaultHeight,
  onResize,
  ariaLabel,
}: HorizontalSplitterProps): JSX.Element {
  const dragState = useRef<{
    startY: number;
    startHeight: number;
    pointerId: number;
  } | null>(null);
  const heightRef = useRef(height);
  heightRef.current = height;

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    dragState.current = {
      startY: event.clientY,
      startHeight: heightRef.current,
      pointerId: event.pointerId,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragState.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const delta = event.clientY - drag.startY;
    // The pane is bottom-anchored: dragging UP (negative delta) grows
    // the pane, dragging DOWN shrinks it.
    const next = Math.min(max, Math.max(min, drag.startHeight - delta));
    onResize(next);
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragState.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer was already released; nothing to do.
    }
    dragState.current = null;
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 64 : 16;
    let next = heightRef.current;
    if (event.key === "ArrowUp") next += step;
    else if (event.key === "ArrowDown") next -= step;
    else if (event.key === "Home") next = defaultHeight;
    else return;
    event.preventDefault();
    onResize(Math.min(max, Math.max(min, next)));
  };

  useEffect(() => {
    return () => {
      dragState.current = null;
    };
  }, []);

  return (
    <div
      className="splitter splitter-horizontal"
      role="separator"
      aria-orientation="horizontal"
      aria-valuenow={height}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-label={ariaLabel ?? "Resize panel"}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => onResize(defaultHeight)}
      onKeyDown={onKeyDown}
    />
  );
}
