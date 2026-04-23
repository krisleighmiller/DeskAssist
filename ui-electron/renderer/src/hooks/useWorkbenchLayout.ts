import { useCallback, useEffect, useRef, useState } from "react";

export const WORKBENCH_LEFT_DEFAULT = 260;
export const WORKBENCH_LEFT_MIN = 160;
export const WORKBENCH_LEFT_MAX = 600;
export const WORKBENCH_RIGHT_DEFAULT = 420;
export const WORKBENCH_RIGHT_MIN = 280;
export const WORKBENCH_RIGHT_MAX = 900;
export const TERMINAL_HEIGHT_DEFAULT = 240;
export const TERMINAL_HEIGHT_MIN = 120;
export const TERMINAL_HEIGHT_MAX = 800;

const LEFT_WIDTH_STORAGE_KEY = "deskassist:workbench:leftWidth";
const RIGHT_WIDTH_STORAGE_KEY = "deskassist:workbench:rightWidth";
const LEFT_COLLAPSED_STORAGE_KEY = "deskassist:workbench:leftCollapsed";
const RIGHT_COLLAPSED_STORAGE_KEY = "deskassist:workbench:rightCollapsed";
const TERMINAL_HEIGHT_STORAGE_KEY = "deskassist:terminal:height";
const TERMINAL_OPEN_STORAGE_KEY = "deskassist:terminal:open";
const WORKBENCH_EDITOR_MIN = 240;
const WORKBENCH_SPLITTER_SIZE = 6;
const WORKBENCH_COLLAPSED_RAIL = 36;
const WORKBENCH_CHROME_FUDGE = 4;

function readPersistedWidth(
  key: string,
  fallback: number,
  min: number,
  max: number
): number {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) {
      return Math.min(max, Math.max(min, parsed));
    }
  } catch {
    // localStorage can throw in private browsing / sandboxed contexts.
  }
  return fallback;
}

function readPersistedBoolean(key: string, fallback = false): boolean {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === "1") return true;
    if (raw === "0") return false;
  } catch {
    // localStorage can throw in private browsing / sandboxed contexts.
  }
  return fallback;
}

export function useWorkbenchLayout() {
  const [leftPaneWidth, setLeftPaneWidth] = useState<number>(() =>
    readPersistedWidth(
      LEFT_WIDTH_STORAGE_KEY,
      WORKBENCH_LEFT_DEFAULT,
      WORKBENCH_LEFT_MIN,
      WORKBENCH_LEFT_MAX
    )
  );
  const [rightPaneWidth, setRightPaneWidth] = useState<number>(() =>
    readPersistedWidth(
      RIGHT_WIDTH_STORAGE_KEY,
      WORKBENCH_RIGHT_DEFAULT,
      WORKBENCH_RIGHT_MIN,
      WORKBENCH_RIGHT_MAX
    )
  );
  const [leftPaneCollapsed, setLeftPaneCollapsed] = useState<boolean>(() =>
    readPersistedBoolean(LEFT_COLLAPSED_STORAGE_KEY)
  );
  const [rightPaneCollapsed, setRightPaneCollapsed] = useState<boolean>(() =>
    readPersistedBoolean(RIGHT_COLLAPSED_STORAGE_KEY)
  );
  const [terminalOpen, setTerminalOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(TERMINAL_OPEN_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [terminalHeight, setTerminalHeight] = useState<number>(() =>
    readPersistedWidth(
      TERMINAL_HEIGHT_STORAGE_KEY,
      TERMINAL_HEIGHT_DEFAULT,
      TERMINAL_HEIGHT_MIN,
      TERMINAL_HEIGHT_MAX
    )
  );

  useEffect(() => {
    try {
      window.localStorage.setItem(LEFT_WIDTH_STORAGE_KEY, String(leftPaneWidth));
    } catch {
      // ignore
    }
  }, [leftPaneWidth]);

  useEffect(() => {
    try {
      window.localStorage.setItem(RIGHT_WIDTH_STORAGE_KEY, String(rightPaneWidth));
    } catch {
      // ignore
    }
  }, [rightPaneWidth]);

  useEffect(() => {
    try {
      window.localStorage.setItem(LEFT_COLLAPSED_STORAGE_KEY, leftPaneCollapsed ? "1" : "0");
    } catch {
      // ignore
    }
  }, [leftPaneCollapsed]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        RIGHT_COLLAPSED_STORAGE_KEY,
        rightPaneCollapsed ? "1" : "0"
      );
    } catch {
      // ignore
    }
  }, [rightPaneCollapsed]);

  useEffect(() => {
    try {
      window.localStorage.setItem(TERMINAL_HEIGHT_STORAGE_KEY, String(terminalHeight));
    } catch {
      // ignore
    }
  }, [terminalHeight]);

  useEffect(() => {
    try {
      window.localStorage.setItem(TERMINAL_OPEN_STORAGE_KEY, terminalOpen ? "1" : "0");
    } catch {
      // ignore
    }
  }, [terminalOpen]);

  const leftPaneWidthRef = useRef(leftPaneWidth);
  leftPaneWidthRef.current = leftPaneWidth;
  const rightPaneWidthRef = useRef(rightPaneWidth);
  rightPaneWidthRef.current = rightPaneWidth;
  const terminalHeightRef = useRef(terminalHeight);
  terminalHeightRef.current = terminalHeight;
  const terminalOpenRef = useRef(terminalOpen);
  terminalOpenRef.current = terminalOpen;

  // Approximate vertical chrome (toolbar + horizontal splitter), used
  // when computing how tall the terminal is allowed to be.
  const VERTICAL_CHROME = 48;
  const EDITOR_MIN_HEIGHT = 160;

  useEffect(() => {
    if (typeof window === "undefined") return;
    const reflow = () => {
      // Horizontal layout.
      const vw = window.innerWidth;
      const shellChrome =
        WORKBENCH_CHROME_FUDGE +
        (leftPaneCollapsed ? WORKBENCH_COLLAPSED_RAIL : WORKBENCH_SPLITTER_SIZE) +
        (rightPaneCollapsed ? WORKBENCH_COLLAPSED_RAIL : WORKBENCH_SPLITTER_SIZE);
      const available = vw - shellChrome - WORKBENCH_EDITOR_MIN;
      const leftFloor = leftPaneCollapsed ? 0 : WORKBENCH_LEFT_MIN;
      let rightLive = rightPaneCollapsed ? 0 : rightPaneWidthRef.current;
      if (!rightPaneCollapsed) {
        const cap = Math.max(WORKBENCH_RIGHT_MIN, available - leftFloor);
        if (rightLive > cap) {
          rightLive = cap;
          setRightPaneWidth((prev) => (prev > cap ? cap : prev));
        }
      }
      if (!leftPaneCollapsed) {
        const cap = Math.max(WORKBENCH_LEFT_MIN, available - rightLive);
        if (leftPaneWidthRef.current > cap) {
          setLeftPaneWidth((prev) => (prev > cap ? cap : prev));
        }
      }
      // Vertical layout: clamp terminal height so the editor never
      // shrinks below its minimum when the user resizes the window.
      // (Review item #17.)
      if (terminalOpenRef.current) {
        const vh = window.innerHeight;
        const verticalCap = Math.max(
          TERMINAL_HEIGHT_MIN,
          vh - VERTICAL_CHROME - EDITOR_MIN_HEIGHT
        );
        if (terminalHeightRef.current > verticalCap) {
          setTerminalHeight((prev) => (prev > verticalCap ? verticalCap : prev));
        }
      }
    };
    reflow();
    window.addEventListener("resize", reflow);
    return () => window.removeEventListener("resize", reflow);
  }, [leftPaneCollapsed, rightPaneCollapsed]);

  const toggleLeftPane = useCallback(() => {
    setLeftPaneCollapsed((prev) => !prev);
  }, []);

  const toggleRightPane = useCallback(() => {
    setRightPaneCollapsed((prev) => !prev);
  }, []);

  return {
    leftPaneWidth,
    setLeftPaneWidth,
    rightPaneWidth,
    setRightPaneWidth,
    leftPaneCollapsed,
    setLeftPaneCollapsed,
    rightPaneCollapsed,
    setRightPaneCollapsed,
    toggleLeftPane,
    toggleRightPane,
    terminalOpen,
    setTerminalOpen,
    terminalHeight,
    setTerminalHeight,
  };
}
