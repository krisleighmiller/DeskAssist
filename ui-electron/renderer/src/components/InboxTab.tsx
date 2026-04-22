import { useEffect, useMemo, useState } from "react";
import type {
  InboxItemContent,
  InboxItemDto,
  InboxSourceDto,
  InboxSourceInput,
} from "../types";

interface InboxTabProps {
  hasCasefile: boolean;
  sources: InboxSourceDto[];
  loading: boolean;
  error: string | null;
  // CRUD bound to the parent so loading state stays consistent with the
  // rest of the casefile (see App.tsx: reloadInboxSources).
  onAddSource: (input: InboxSourceInput) => Promise<InboxSourceDto>;
  onRemoveSource: (sourceId: string) => Promise<void>;
  onChooseRoot: () => Promise<string | null>;
  // Items + content endpoints stay local to this tab — the parent doesn't
  // need a global cache because users only ever look at one source at a
  // time and we re-list when they switch.
  onListItems: (sourceId: string) => Promise<InboxItemDto[]>;
  onReadItem: (sourceId: string, path: string) => Promise<InboxItemContent>;
}

interface AddFormState {
  name: string;
  root: string;
  busy: boolean;
  error: string | null;
}

const EMPTY_ADD: AddFormState = { name: "", root: "", busy: false, error: null };

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function InboxTab({
  hasCasefile,
  sources,
  loading,
  error,
  onAddSource,
  onRemoveSource,
  onChooseRoot,
  onListItems,
  onReadItem,
}: InboxTabProps): JSX.Element {
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [items, setItems] = useState<InboxItemDto[]>([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [itemsError, setItemsError] = useState<string | null>(null);

  const [selectedItemPath, setSelectedItemPath] = useState<string | null>(null);
  const [content, setContent] = useState<InboxItemContent | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);

  const [addForm, setAddForm] = useState<AddFormState>(EMPTY_ADD);

  // Default the selection to the first source so the items pane has
  // something to show when the user lands on the tab.
  useEffect(() => {
    if (selectedSourceId && sources.some((s) => s.id === selectedSourceId)) return;
    setSelectedSourceId(sources[0]?.id ?? null);
  }, [sources, selectedSourceId]);

  // Reset transient panes when the casefile flips away.
  useEffect(() => {
    if (!hasCasefile) {
      setSelectedSourceId(null);
      setSelectedItemPath(null);
      setItems([]);
      setContent(null);
    }
  }, [hasCasefile]);

  // When the selected source changes, refresh its items.
  useEffect(() => {
    if (!selectedSourceId) {
      setItems([]);
      setSelectedItemPath(null);
      setContent(null);
      return;
    }
    let cancelled = false;
    setItemsLoading(true);
    setItemsError(null);
    onListItems(selectedSourceId)
      .then((next) => {
        if (cancelled) return;
        setItems(next);
        // Drop the open document if it no longer exists in the new list.
        if (selectedItemPath && !next.some((it) => it.path === selectedItemPath)) {
          setSelectedItemPath(null);
          setContent(null);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setItemsError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setItemsLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // selectedItemPath intentionally omitted: this effect only runs when
    // the *source* changes; item selection has its own loader below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSourceId]);

  const openItem = async (path: string) => {
    if (!selectedSourceId) return;
    setSelectedItemPath(path);
    setContent(null);
    setContentError(null);
    setContentLoading(true);
    try {
      const result = await onReadItem(selectedSourceId, path);
      setContent(result);
    } catch (err) {
      setContentError(err instanceof Error ? err.message : String(err));
    } finally {
      setContentLoading(false);
    }
  };

  const submitAdd = async () => {
    const name = addForm.name.trim();
    const root = addForm.root.trim();
    if (!name || !root || addForm.busy) return;
    setAddForm({ ...addForm, busy: true, error: null });
    try {
      const created = await onAddSource({ name, root });
      setAddForm(EMPTY_ADD);
      setSelectedSourceId(created.id);
    } catch (err) {
      setAddForm({
        ...addForm,
        busy: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const browseRoot = async () => {
    try {
      const picked = await onChooseRoot();
      if (picked) {
        setAddForm((prev) => ({
          ...prev,
          root: picked,
          // Auto-fill the name from the directory's basename if the user
          // hasn't typed one yet — saves a step in the common path.
          name: prev.name.trim() ? prev.name : basename(picked),
        }));
      }
    } catch (err) {
      setAddForm((prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  };

  const removeSelected = async () => {
    if (!selectedSourceId) return;
    if (!window.confirm("Remove this inbox source? Items on disk are not deleted.")) {
      return;
    }
    try {
      await onRemoveSource(selectedSourceId);
      setSelectedSourceId(null);
    } catch (err) {
      setItemsError(err instanceof Error ? err.message : String(err));
    }
  };

  const sortedItems = useMemo(() => {
    return [...items].sort((a, b) => a.path.localeCompare(b.path));
  }, [items]);

  const selectedSource = useMemo(
    () => sources.find((s) => s.id === selectedSourceId) ?? null,
    [sources, selectedSourceId]
  );

  if (!hasCasefile) {
    return (
      <div className="inbox-tab">
        <span className="hint">Open a casefile to manage inbox sources.</span>
      </div>
    );
  }

  return (
    <div className="inbox-tab">
      <form
        className="inbox-add"
        onSubmit={(event) => {
          event.preventDefault();
          void submitAdd();
        }}
      >
        <div className="inbox-add-row">
          <input
            type="text"
            placeholder="Name (e.g. Project Notes)"
            value={addForm.name}
            onChange={(event) =>
              setAddForm({ ...addForm, name: event.target.value, error: null })
            }
            disabled={addForm.busy}
          />
          <input
            type="text"
            placeholder="Folder path"
            value={addForm.root}
            onChange={(event) =>
              setAddForm({ ...addForm, root: event.target.value, error: null })
            }
            disabled={addForm.busy}
            spellCheck={false}
          />
          <button type="button" onClick={() => void browseRoot()} disabled={addForm.busy}>
            Browse...
          </button>
          <button
            type="submit"
            disabled={addForm.busy || !addForm.name.trim() || !addForm.root.trim()}
          >
            {addForm.busy ? "Adding..." : "Add source"}
          </button>
        </div>
        {addForm.error && <span className="inbox-error">{addForm.error}</span>}
        <span className="hint">
          Inbox sources are read-only references — files stay in place on disk
          and are surfaced for browsing here.
        </span>
      </form>

      <div className="inbox-body">
        <div className="inbox-sources">
          <header>Sources</header>
          {loading && <span className="hint">Loading...</span>}
          {error && <span className="inbox-error">{error}</span>}
          {!loading && sources.length === 0 && (
            <span className="hint">No sources yet.</span>
          )}
          <ul>
            {sources.map((source) => (
              <li
                key={source.id}
                className={source.id === selectedSourceId ? "active" : ""}
              >
                <button type="button" onClick={() => setSelectedSourceId(source.id)}>
                  <span className="inbox-source-name">{source.name}</span>
                  <span className="inbox-source-root">{source.root}</span>
                </button>
              </li>
            ))}
          </ul>
          {selectedSource && (
            <button type="button" className="danger" onClick={() => void removeSelected()}>
              Remove "{selectedSource.name}"
            </button>
          )}
        </div>

        <div className="inbox-items">
          <header>Items</header>
          {!selectedSource && <span className="hint">Pick a source to list items.</span>}
          {itemsLoading && <span className="hint">Loading items...</span>}
          {itemsError && <span className="inbox-error">{itemsError}</span>}
          {selectedSource && !itemsLoading && sortedItems.length === 0 && !itemsError && (
            <span className="hint">No text files found at this source.</span>
          )}
          <ul>
            {sortedItems.map((item) => (
              <li
                key={item.path}
                className={item.path === selectedItemPath ? "active" : ""}
              >
                <button type="button" onClick={() => void openItem(item.path)}>
                  <span className="inbox-item-path">{item.path}</span>
                  <span className="inbox-item-meta">{formatSize(item.sizeBytes)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="inbox-content">
          <header>
            {selectedItemPath ? (
              <span className="inbox-content-title">{selectedItemPath}</span>
            ) : (
              <span className="hint">Pick an item to view its contents.</span>
            )}
          </header>
          {contentLoading && <span className="hint">Loading...</span>}
          {contentError && <span className="inbox-error">{contentError}</span>}
          {content && (
            <>
              {content.truncated && (
                <span className="hint">
                  Showing the first {content.content.length.toLocaleString()} characters
                  (truncated).
                </span>
              )}
              <pre className="inbox-content-body">{content.content || <em>(empty)</em>}</pre>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function basename(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
