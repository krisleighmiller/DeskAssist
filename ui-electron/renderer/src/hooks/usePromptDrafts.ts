import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../lib/api";
import type {
  CasefileSnapshot,
  PromptDraftDto,
  PromptInputDto,
  PromptSummaryDto,
} from "../types";
import { errorMessage } from "./appModelTypes";

export function usePromptDrafts(
  casefile: CasefileSnapshot | null,
  sessionKey: string | null
) {
  // Depend on the root rather than the entire snapshot — the snapshot
  // is replaced on every lane edit which made the original effect
  // re-fetch the prompt list gratuitously. (Review item #19.)
  const casefileRoot = casefile?.root ?? null;

  const [prompts, setPrompts] = useState<PromptSummaryDto[]>([]);
  const [promptsLoading, setPromptsLoading] = useState(false);
  const [promptsError, setPromptsError] = useState<string | null>(null);
  const [selectedPromptByLane, setSelectedPromptByLane] = useState<
    Map<string, string | null>
  >(() => new Map());

  // Cancellation token for in-flight `listPrompts`. (Review item #5.)
  const reloadRequestRef = useRef(0);

  const reloadPrompts = useCallback(async () => {
    if (!casefileRoot) {
      setPrompts([]);
      return;
    }
    const token = ++reloadRequestRef.current;
    setPromptsLoading(true);
    try {
      const list = await api().listPrompts();
      if (token !== reloadRequestRef.current) return;
      setPrompts(list);
      setPromptsError(null);
    } catch (error) {
      if (token !== reloadRequestRef.current) return;
      setPromptsError(errorMessage(error));
    } finally {
      if (token === reloadRequestRef.current) {
        setPromptsLoading(false);
      }
    }
  }, [casefileRoot]);

  useEffect(() => {
    void reloadPrompts();
  }, [reloadPrompts]);

  // Wrap mutating handlers so failures are routed through `promptsError`
  // for consistency with `reloadPrompts`. We still re-throw so the
  // calling component can react (e.g. keep its form open). (Review #24.)
  const handleCreatePrompt = useCallback(
    async (input: PromptInputDto): Promise<PromptDraftDto> => {
      try {
        const created = await api().createPrompt(input);
        setPromptsError(null);
        await reloadPrompts();
        return created;
      } catch (error) {
        setPromptsError(errorMessage(error));
        throw error;
      }
    },
    [reloadPrompts]
  );

  const handleSavePrompt = useCallback(
    async (promptId: string, input: PromptInputDto): Promise<PromptDraftDto> => {
      try {
        const saved = await api().savePrompt(promptId, input);
        setPromptsError(null);
        await reloadPrompts();
        return saved;
      } catch (error) {
        setPromptsError(errorMessage(error));
        throw error;
      }
    },
    [reloadPrompts]
  );

  const handleDeletePrompt = useCallback(
    async (promptId: string) => {
      try {
        await api().deletePrompt(promptId);
        setPromptsError(null);
      } catch (error) {
        setPromptsError(errorMessage(error));
        throw error;
      }
      // Only allocate a new map if at least one lane was actually
      // pointing at the deleted prompt. (Review item #23.)
      setSelectedPromptByLane((prev) => {
        let mutated = false;
        for (const value of prev.values()) {
          if (value === promptId) {
            mutated = true;
            break;
          }
        }
        if (!mutated) return prev;
        const next = new Map(prev);
        for (const [key, value] of prev) {
          if (value === promptId) next.set(key, null);
        }
        return next;
      });
      await reloadPrompts();
    },
    [reloadPrompts]
  );

  const handleLoadPrompt = useCallback(async (promptId: string) => {
    return api().getPrompt(promptId);
  }, []);

  const selectedPromptId = sessionKey
    ? selectedPromptByLane.get(sessionKey) ?? null
    : null;

  const handleSelectPromptForChat = useCallback(
    (promptId: string | null) => {
      if (!sessionKey) return;
      setSelectedPromptByLane((prev) => {
        if ((prev.get(sessionKey) ?? null) === promptId) return prev;
        const next = new Map(prev);
        next.set(sessionKey, promptId);
        return next;
      });
    },
    [sessionKey]
  );

  const activePromptName = selectedPromptId
    ? prompts.find((p) => p.id === selectedPromptId)?.name ?? null
    : null;

  return {
    prompts,
    promptsLoading,
    promptsError,
    selectedPromptId,
    activePromptName,
    handleCreatePrompt,
    handleSavePrompt,
    handleDeletePrompt,
    handleLoadPrompt,
    handleSelectPromptForChat,
  };
}
