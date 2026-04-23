import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../lib/api";
import type {
  CasefileSnapshot,
  InboxItemContent,
  InboxItemDto,
  InboxSourceDto,
  InboxSourceInput,
} from "../types";
import { errorMessage } from "./appModelTypes";

export function useInboxSources(casefile: CasefileSnapshot | null) {
  // Depend on the root rather than the entire snapshot. (#19)
  const casefileRoot = casefile?.root ?? null;

  const [inboxSources, setInboxSources] = useState<InboxSourceDto[]>([]);
  const [inboxLoading, setInboxLoading] = useState(false);
  const [inboxError, setInboxError] = useState<string | null>(null);

  // Cancellation token for in-flight `listInboxSources`. (#5)
  const reloadRequestRef = useRef(0);

  const reloadInboxSources = useCallback(async () => {
    if (!casefileRoot) {
      setInboxSources([]);
      return;
    }
    const token = ++reloadRequestRef.current;
    setInboxLoading(true);
    try {
      const list = await api().listInboxSources();
      if (token !== reloadRequestRef.current) return;
      setInboxSources(list);
      setInboxError(null);
    } catch (error) {
      if (token !== reloadRequestRef.current) return;
      setInboxError(errorMessage(error));
    } finally {
      if (token === reloadRequestRef.current) {
        setInboxLoading(false);
      }
    }
  }, [casefileRoot]);

  useEffect(() => {
    void reloadInboxSources();
  }, [reloadInboxSources]);

  // Route mutating-handler failures through `inboxError` for
  // consistency with the loader, while still re-throwing so the form
  // call site can react. (Review item #24.)
  const handleAddInboxSource = useCallback(
    async (input: InboxSourceInput): Promise<InboxSourceDto> => {
      try {
        const created = await api().addInboxSource(input);
        setInboxError(null);
        await reloadInboxSources();
        return created;
      } catch (error) {
        setInboxError(errorMessage(error));
        throw error;
      }
    },
    [reloadInboxSources]
  );

  const handleRemoveInboxSource = useCallback(
    async (sourceId: string) => {
      try {
        await api().removeInboxSource(sourceId);
        setInboxError(null);
        await reloadInboxSources();
      } catch (error) {
        setInboxError(errorMessage(error));
        throw error;
      }
    },
    [reloadInboxSources]
  );

  const handleChooseInboxRoot = useCallback(async () => api().chooseInboxRoot(), []);
  const handleListInboxItems = useCallback(
    async (sourceId: string): Promise<InboxItemDto[]> => api().listInboxItems(sourceId),
    []
  );
  const handleReadInboxItem = useCallback(
    async (sourceId: string, path: string): Promise<InboxItemContent> =>
      api().readInboxItem(sourceId, path),
    []
  );

  return {
    inboxSources,
    inboxLoading,
    inboxError,
    handleAddInboxSource,
    handleRemoveInboxSource,
    handleChooseInboxRoot,
    handleListInboxItems,
    handleReadInboxItem,
  };
}
