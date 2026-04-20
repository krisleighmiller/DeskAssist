import { useEffect, useMemo, useState } from "react";
import type { PromptDraftDto, PromptInputDto, PromptSummaryDto } from "../types";

interface PromptsTabProps {
  hasCasefile: boolean;
  prompts: PromptSummaryDto[];
  loading: boolean;
  error: string | null;
  // The prompt currently selected as the system prompt for the active lane's
  // chat; null means "no system prompt". Selection is per-lane and lives in
  // the parent App so it survives tab switches.
  selectedPromptId: string | null;
  onSelectForChat: (promptId: string | null) => void;
  hasActiveLane: boolean;
  onCreate: (input: PromptInputDto) => Promise<PromptDraftDto>;
  onSave: (promptId: string, input: PromptInputDto) => Promise<PromptDraftDto>;
  onDelete: (promptId: string) => Promise<void>;
  onLoad: (promptId: string) => Promise<PromptDraftDto>;
}

interface DraftState {
  promptId: string | null;
  name: string;
  body: string;
  baselineName: string;
  baselineBody: string;
  loading: boolean;
  saving: boolean;
  error: string | null;
}

const EMPTY_DRAFT: DraftState = {
  promptId: null,
  name: "",
  body: "",
  baselineName: "",
  baselineBody: "",
  loading: false,
  saving: false,
  error: null,
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function PromptsTab({
  hasCasefile,
  prompts,
  loading,
  error,
  selectedPromptId,
  onSelectForChat,
  hasActiveLane,
  onCreate,
  onSave,
  onDelete,
  onLoad,
}: PromptsTabProps): JSX.Element {
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);
  const [newDraftMode, setNewDraftMode] = useState(false);

  // Whenever the casefile flips away (or the active prompt is deleted), reset.
  useEffect(() => {
    if (!hasCasefile) {
      setDraft(EMPTY_DRAFT);
      setNewDraftMode(false);
    }
  }, [hasCasefile]);

  // If the prompt we were editing was deleted out from under us, drop back to
  // the empty-state. The parent reload happens after onDelete resolves.
  useEffect(() => {
    if (
      draft.promptId !== null &&
      !prompts.some((p) => p.id === draft.promptId) &&
      !draft.loading &&
      !draft.saving
    ) {
      setDraft(EMPTY_DRAFT);
    }
  }, [prompts, draft.promptId, draft.loading, draft.saving]);

  const dirty =
    newDraftMode ||
    draft.name !== draft.baselineName ||
    draft.body !== draft.baselineBody;

  const sortedPrompts = useMemo(
    () => [...prompts].sort((a, b) => a.name.localeCompare(b.name)),
    [prompts]
  );

  const beginNew = () => {
    setNewDraftMode(true);
    setDraft({ ...EMPTY_DRAFT });
  };

  const openExisting = async (promptId: string) => {
    setNewDraftMode(false);
    setDraft({ ...EMPTY_DRAFT, promptId, loading: true });
    try {
      const full = await onLoad(promptId);
      setDraft({
        promptId: full.id,
        name: full.name,
        body: full.body,
        baselineName: full.name,
        baselineBody: full.body,
        loading: false,
        saving: false,
        error: null,
      });
    } catch (err) {
      setDraft({
        ...EMPTY_DRAFT,
        promptId,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const submit = async () => {
    if (draft.saving) return;
    if (!draft.name.trim()) {
      setDraft((prev) => ({ ...prev, error: "Name is required." }));
      return;
    }
    setDraft((prev) => ({ ...prev, saving: true, error: null }));
    try {
      const saved =
        newDraftMode || draft.promptId === null
          ? await onCreate({ name: draft.name.trim(), body: draft.body })
          : await onSave(draft.promptId, {
              name: draft.name.trim(),
              body: draft.body,
            });
      setNewDraftMode(false);
      setDraft({
        promptId: saved.id,
        name: saved.name,
        body: saved.body,
        baselineName: saved.name,
        baselineBody: saved.body,
        loading: false,
        saving: false,
        error: null,
      });
    } catch (err) {
      setDraft((prev) => ({
        ...prev,
        saving: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  };

  const remove = async () => {
    if (!draft.promptId || draft.saving) return;
    if (
      !window.confirm(
        `Delete prompt "${draft.baselineName || draft.name}"? This cannot be undone.`
      )
    ) {
      return;
    }
    setDraft((prev) => ({ ...prev, saving: true, error: null }));
    try {
      await onDelete(draft.promptId);
      // The selection effect above will reset draft once `prompts` updates.
    } catch (err) {
      setDraft((prev) => ({
        ...prev,
        saving: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  };

  if (!hasCasefile) {
    return (
      <div className="prompts-tab">
        <span className="hint">Open a casefile to manage prompt drafts.</span>
      </div>
    );
  }

  const editing = draft.promptId !== null || newDraftMode;
  const canActivate =
    hasActiveLane && draft.promptId !== null && !newDraftMode && !dirty;
  const isActiveSelection =
    selectedPromptId !== null && draft.promptId === selectedPromptId;

  return (
    <div className="prompts-tab">
      <div className="prompts-toolbar">
        <button type="button" onClick={beginNew} disabled={draft.saving}>
          + New prompt
        </button>
        <span className="hint">
          Stored under <code>.casefile/prompts/&lt;id&gt;.md</code>.
          {loading && " Loading..."}
          {error && <span className="prompts-error"> · {error}</span>}
        </span>
      </div>
      <div className="prompts-body">
        <ul className="prompts-list">
          {sortedPrompts.length === 0 && !loading && (
            <li className="prompts-empty">No prompts yet.</li>
          )}
          {sortedPrompts.map((p) => {
            const isOpen = p.id === draft.promptId;
            const isSelected = p.id === selectedPromptId;
            return (
              <li
                key={p.id}
                className={`prompts-list-item${isOpen ? " open" : ""}${
                  isSelected ? " selected" : ""
                }`}
              >
                <button
                  type="button"
                  className="prompts-list-button"
                  onClick={() => void openExisting(p.id)}
                >
                  <span className="prompts-list-name">{p.name}</span>
                  <span className="prompts-list-meta">
                    {formatBytes(p.sizeBytes)}
                    {isSelected ? " · in use" : ""}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="prompts-editor">
          {!editing ? (
            <span className="hint">Select a prompt to edit, or create a new one.</span>
          ) : (
            <>
              <input
                type="text"
                value={draft.name}
                placeholder="Prompt name (e.g. 'Reviewer')"
                onChange={(event) =>
                  setDraft((prev) => ({ ...prev, name: event.target.value }))
                }
                disabled={draft.loading || draft.saving}
              />
              <textarea
                value={draft.body}
                onChange={(event) =>
                  setDraft((prev) => ({ ...prev, body: event.target.value }))
                }
                placeholder="System prompt body. Markdown welcome."
                spellCheck={false}
                disabled={draft.loading || draft.saving}
              />
              {draft.error && <span className="prompts-error">{draft.error}</span>}
              <div className="prompts-actions">
                <button
                  type="button"
                  onClick={() => void submit()}
                  disabled={
                    draft.loading || draft.saving || !draft.name.trim() || !dirty
                  }
                >
                  {draft.saving
                    ? "Saving..."
                    : newDraftMode || draft.promptId === null
                      ? "Create"
                      : "Save"}
                </button>
                {draft.promptId !== null && !newDraftMode && (
                  <>
                    <button
                      type="button"
                      onClick={() =>
                        onSelectForChat(isActiveSelection ? null : draft.promptId)
                      }
                      disabled={!canActivate}
                      title={
                        !hasActiveLane
                          ? "Pick a lane first"
                          : dirty
                            ? "Save your changes before activating"
                            : ""
                      }
                    >
                      {isActiveSelection ? "Clear from chat" : "Use in chat"}
                    </button>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => void remove()}
                      disabled={draft.saving}
                    >
                      Delete
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
