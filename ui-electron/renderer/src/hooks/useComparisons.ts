import { useCallback, useMemo, useRef, useState } from "react";

import { api } from "../lib/api";
import { languageFromPath } from "../lib/language";
import {
  chatTurnDelta,
  diffTabKey,
  errorMessage,
  normalizeChatTurn,
  type LaneSessionState,
} from "./appModelTypes";
import type {
  CasefileSnapshot,
  ComparisonSession,
  LaneAttachmentInput,
  LaneComparisonDto,
  Provider,
  ProviderModels,
} from "../types";

function normalizeComparisonSession(session: ComparisonSession): ComparisonSession {
  return {
    ...session,
    attachments: Array.isArray(session.attachments) ? session.attachments : [],
    pendingApprovals: Array.isArray(session.pendingApprovals)
      ? session.pendingApprovals
      : [],
  };
}

interface UseComparisonsArgs {
  casefile: CasefileSnapshot | null;
  provider: Provider;
  providerModels: ProviderModels;
  session: LaneSessionState;
  updateSession: (updater: (prev: LaneSessionState) => LaneSessionState) => void;
  onError: (message: string) => void;
}

export function useComparisons({
  casefile,
  provider,
  providerModels,
  session,
  updateSession,
  onError,
}: UseComparisonsArgs) {
  const [comparison, setComparison] = useState<LaneComparisonDto | null>(null);
  const [comparisonBusy, setComparisonBusy] = useState(false);
  const [comparisonSessions, setComparisonSessions] = useState<ComparisonSession[]>([]);
  const [activeComparisonId, setActiveComparisonId] = useState<string | null>(null);
  // Per-comparison busy flags. Replaces the previous single boolean
  // which conflated all in-flight comparison chats. (Review item #4.)
  const [busyComparisonIds, setBusyComparisonIds] = useState<Set<string>>(() => new Set());

  // Cancellation token for `compareLanes`: a slow result for an
  // earlier (left, right) pair must not overwrite a fresher one
  // triggered by a rapid second click. (Review item #5.)
  const compareRequestRef = useRef(0);

  const focusedComparisonSession = useMemo<ComparisonSession | null>(
    () =>
      activeComparisonId
        ? comparisonSessions.find((entry) => entry.id === activeComparisonId) ?? null
        : null,
    [activeComparisonId, comparisonSessions]
  );

  const comparisonChatBusy = focusedComparisonSession
    ? busyComparisonIds.has(focusedComparisonSession.id)
    : false;

  const setComparisonBusyId = useCallback(
    (comparisonId: string, busy: boolean) => {
      setBusyComparisonIds((prev) => {
        const has = prev.has(comparisonId);
        if (busy === has) return prev;
        const next = new Set(prev);
        if (busy) next.add(comparisonId);
        else next.delete(comparisonId);
        return next;
      });
    },
    []
  );

  const replaceComparisonSession = useCallback(
    (
      comparisonId: string,
      produce: (prev: ComparisonSession) => ComparisonSession
    ) => {
      setComparisonSessions((prev) =>
        prev.map((entry) =>
          entry.id === comparisonId ? normalizeComparisonSession(produce(entry)) : entry
        )
      );
    },
    []
  );

  const handleCompareLanes = useCallback(
    async (leftLaneId: string, rightLaneId: string) => {
      if (!casefile) return;
      const token = ++compareRequestRef.current;
      setComparisonBusy(true);
      try {
        const result = await api().compareLanes(leftLaneId, rightLaneId);
        if (token !== compareRequestRef.current) return;
        setComparison(result);
      } catch (error) {
        if (token !== compareRequestRef.current) return;
        onError(errorMessage(error));
      } finally {
        if (token === compareRequestRef.current) {
          setComparisonBusy(false);
        }
      }
    },
    [casefile, onError]
  );

  const handleClearComparison = useCallback(() => setComparison(null), []);

  const handleOpenComparisonChat = useCallback(
    async (laneIds: string[]) => {
      if (!casefile || laneIds.length < 2) return;
      try {
        const opened = normalizeComparisonSession(await api().openComparison(laneIds));
        setComparisonSessions((prev) => {
          const existing = prev.findIndex((entry) => entry.id === opened.id);
          if (existing >= 0) {
            const next = prev.slice();
            next[existing] = opened;
            return next;
          }
          return [...prev, opened];
        });
        setActiveComparisonId(opened.id);
      } catch (error) {
        onError(errorMessage(error));
      }
    },
    [casefile, onError]
  );

  const handleUpdateComparisonAttachments = useCallback(
    async (laneIds: string[], attachments: LaneAttachmentInput[]) => {
      if (!casefile || laneIds.length < 2) return;
      try {
        const updated = await api().updateComparisonAttachments(laneIds, attachments);
        const normalized = normalizeComparisonSession({
          ...updated,
          messages:
            comparisonSessions.find((entry) => entry.id === updated.id)?.messages ?? [],
          pendingApprovals:
            comparisonSessions.find((entry) => entry.id === updated.id)?.pendingApprovals ?? [],
        });
        setComparisonSessions((prev) => {
          const existing = prev.findIndex((entry) => entry.id === normalized.id);
          if (existing >= 0) {
            const next = prev.slice();
            next[existing] = normalized;
            return next;
          }
          return [...prev, normalized];
        });
      } catch (error) {
        onError(errorMessage(error));
        throw error;
      }
    },
    [casefile, comparisonSessions, onError]
  );

  const handleCloseComparisonChat = useCallback((comparisonId: string) => {
    setComparisonSessions((prev) => prev.filter((entry) => entry.id !== comparisonId));
    setActiveComparisonId((prev) => (prev === comparisonId ? null : prev));
    setBusyComparisonIds((prev) => {
      if (!prev.has(comparisonId)) return prev;
      const next = new Set(prev);
      next.delete(comparisonId);
      return next;
    });
  }, []);

  const sendComparisonChat = useCallback(
    async (text: string) => {
      const value = text.trim();
      const target = focusedComparisonSession;
      if (!value || !target || !casefile) return;
      const targetId = target.id;
      // Per-session busy guard. Bail if this comparison already has
      // a request in flight; allow other comparisons to send freely.
      if (busyComparisonIds.has(targetId)) return;
      const historyBeforeTurn = target.messages;
      setComparisonBusyId(targetId, true);
      replaceComparisonSession(targetId, (prev) => ({
        ...prev,
        messages: [...prev.messages, { role: "user", content: value }],
        pendingApprovals: [],
      }));
      try {
        const response = await api().sendComparisonChat({
          laneIds: target.laneIds,
          provider,
          model: providerModels[provider] || null,
          messages: historyBeforeTurn,
          userMessage: value,
          allowWriteTools: false,
          resumePendingToolCalls: false,
        });
        const nextMessages = normalizeChatTurn(historyBeforeTurn, value, response);
        const nextPending = Array.isArray(response.pendingApprovals)
          ? response.pendingApprovals
          : [];
        replaceComparisonSession(targetId, (prev) => ({
          ...prev,
          laneIds: response.comparison?.laneIds ?? prev.laneIds,
          lanes: response.comparison?.lanes ?? prev.lanes,
          attachments: response.comparison?.attachments ?? prev.attachments,
          messages: nextMessages,
          pendingApprovals: nextPending,
        }));
      } catch (error) {
        const errMsg = errorMessage(error);
        replaceComparisonSession(targetId, (prev) => ({
          ...prev,
          messages: [
            ...historyBeforeTurn,
            { role: "user", content: value },
            { role: "assistant", content: `Error: ${errMsg}` },
          ],
          pendingApprovals: [],
        }));
      } finally {
        setComparisonBusyId(targetId, false);
      }
    },
    [
      busyComparisonIds,
      casefile,
      focusedComparisonSession,
      provider,
      providerModels,
      replaceComparisonSession,
      setComparisonBusyId,
    ]
  );

  const approveComparisonTools = useCallback(async () => {
    const target = focusedComparisonSession;
    if (!target || !casefile) return;
    const targetId = target.id;
    if (busyComparisonIds.has(targetId) || (target.pendingApprovals?.length ?? 0) === 0) return;
    const historyBeforeTurn = target.messages;
    setComparisonBusyId(targetId, true);
    try {
      const response = await api().sendComparisonChat({
        laneIds: target.laneIds,
        provider,
        model: providerModels[provider] || null,
        messages: historyBeforeTurn,
        userMessage: "",
        allowWriteTools: true,
        resumePendingToolCalls: true,
      });
      const delta = chatTurnDelta(response) ?? [];
      const nextPending = Array.isArray(response.pendingApprovals)
        ? response.pendingApprovals
        : [];
      replaceComparisonSession(targetId, (prev) => ({
        ...prev,
        laneIds: response.comparison?.laneIds ?? prev.laneIds,
        lanes: response.comparison?.lanes ?? prev.lanes,
        attachments: response.comparison?.attachments ?? prev.attachments,
        messages: [...historyBeforeTurn, ...delta],
        pendingApprovals: nextPending,
      }));
    } catch (error) {
      const errMsg = errorMessage(error);
      replaceComparisonSession(targetId, (prev) => ({
        ...prev,
        messages: [
          ...historyBeforeTurn,
          { role: "assistant", content: `Error: ${errMsg}` },
        ],
        pendingApprovals: [],
      }));
    } finally {
      setComparisonBusyId(targetId, false);
    }
  }, [
    busyComparisonIds,
    casefile,
    focusedComparisonSession,
    provider,
    providerModels,
    replaceComparisonSession,
    setComparisonBusyId,
  ]);

  const denyComparisonTools = useCallback(() => {
    const target = focusedComparisonSession;
    if (!target || (target.pendingApprovals?.length ?? 0) === 0) return;
    replaceComparisonSession(target.id, (prev) => ({
      ...prev,
      messages: [
        ...prev.messages,
        { role: "assistant", content: "Write operation request denied." },
      ],
      pendingApprovals: [],
    }));
  }, [focusedComparisonSession, replaceComparisonSession]);

  const handleOpenDiff = useCallback(
    async (path: string) => {
      if (!comparison || !casefile) return;
      const left = casefile.lanes.find((lane) => lane.id === comparison.leftLaneId);
      const right = casefile.lanes.find((lane) => lane.id === comparison.rightLaneId);
      if (!left || !right) return;
      const key = diffTabKey(comparison.leftLaneId, comparison.rightLaneId, path);
      if (session.tabs.some((tab) => tab.key === key)) {
        updateSession((prev) => ({ ...prev, activeTabKey: key }));
        return;
      }
      try {
        // Diff tabs are read-only snapshots of both sides at "open"
        // time. We deliberately do NOT subscribe them to workspace-
        // change refreshes (see refreshOpenTabsFromDisk in
        // useLaneWorkspace). If the user wants a fresh diff, they
        // can re-open it.
        const [leftRead, rightRead] = await Promise.all([
          api().readLaneFile(comparison.leftLaneId, path),
          api().readLaneFile(comparison.rightLaneId, path),
        ]);
        updateSession((prev) => {
          if (prev.tabs.some((tab) => tab.key === key)) {
            return { ...prev, activeTabKey: key };
          }
          return {
            ...prev,
            tabs: [
              ...prev.tabs,
              {
                kind: "diff",
                key,
                path,
                leftLaneId: comparison.leftLaneId,
                rightLaneId: comparison.rightLaneId,
                leftLaneName: left.name,
                rightLaneName: right.name,
                leftContent: leftRead.content,
                rightContent: rightRead.content,
                language: languageFromPath(path),
              },
            ],
            activeTabKey: key,
          };
        });
      } catch (error) {
        onError(errorMessage(error));
      }
    },
    [casefile, comparison, onError, session.tabs, updateSession]
  );

  const resetComparisonsForCasefile = useCallback(() => {
    setComparison(null);
    setComparisonSessions([]);
    setActiveComparisonId(null);
    setBusyComparisonIds(new Set());
  }, []);

  const clearActiveComparisonForLaneChat = useCallback(() => {
    setActiveComparisonId(null);
  }, []);

  return {
    comparison,
    comparisonBusy,
    comparisonSessions,
    activeComparisonId,
    setActiveComparisonId,
    comparisonChatBusy,
    focusedComparisonSession,
    handleCompareLanes,
    handleClearComparison,
    handleOpenComparisonChat,
    handleUpdateComparisonAttachments,
    handleCloseComparisonChat,
    sendComparisonChat,
    approveComparisonTools,
    denyComparisonTools,
    handleOpenDiff,
    resetComparisonsForCasefile,
    clearActiveComparisonForLaneChat,
  };
}
