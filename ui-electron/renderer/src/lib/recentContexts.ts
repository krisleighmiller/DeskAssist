import type { CasefileSnapshot, RecentContext } from "../types";

export const RECENT_CONTEXTS_STORAGE_KEY = "deskassist:recentContexts";
export const MAX_RECENT_CONTEXTS = 8;

function pinnedFirst(a: RecentContext, b: RecentContext): number {
  if (Boolean(a.pinned) !== Boolean(b.pinned)) {
    return a.pinned ? -1 : 1;
  }
  return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
}

export function sortRecentContexts(contexts: RecentContext[]): RecentContext[] {
  return contexts.slice().sort(pinnedFirst);
}

export function loadRecentContexts(): RecentContext[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENT_CONTEXTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return sortRecentContexts(
      parsed.filter((item): item is RecentContext => (
        item &&
        typeof item === "object" &&
        typeof item.root === "string" &&
        (typeof item.activeLaneId === "string" || item.activeLaneId === null) &&
        (typeof item.activeLaneName === "string" || item.activeLaneName === null) &&
        typeof item.updatedAt === "string" &&
        (typeof item.pinned === "boolean" || typeof item.pinned === "undefined")
      ))
    ).slice(0, MAX_RECENT_CONTEXTS);
  } catch {
    return [];
  }
}

export function persistRecentContexts(contexts: RecentContext[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      RECENT_CONTEXTS_STORAGE_KEY,
      JSON.stringify(sortRecentContexts(contexts).slice(0, MAX_RECENT_CONTEXTS))
    );
  } catch {
    // localStorage may be unavailable in restricted renderer contexts.
  }
}

export function upsertRecentContext(
  prev: RecentContext[],
  snapshot: CasefileSnapshot,
  now: Date = new Date()
): RecentContext[] {
  const activeLane = snapshot.activeLaneId
    ? snapshot.lanes.find((lane) => lane.id === snapshot.activeLaneId) ?? null
    : null;
  const previous = prev.find((entry) => entry.root === snapshot.root);
  const nextEntry: RecentContext = {
    root: snapshot.root,
    activeLaneId: activeLane?.id ?? snapshot.activeLaneId ?? null,
    activeLaneName: activeLane?.name ?? null,
    updatedAt: now.toISOString(),
    pinned: previous?.pinned,
  };
  const next = sortRecentContexts([
    nextEntry,
    ...prev.filter((entry) => entry.root !== snapshot.root),
  ]).slice(0, MAX_RECENT_CONTEXTS);
  persistRecentContexts(next);
  return next;
}

export function setRecentContextPinned(
  prev: RecentContext[],
  root: string,
  pinned: boolean
): RecentContext[] {
  const next = sortRecentContexts(
    prev.map((entry) => (entry.root === root ? { ...entry, pinned } : entry))
  ).slice(0, MAX_RECENT_CONTEXTS);
  persistRecentContexts(next);
  return next;
}
