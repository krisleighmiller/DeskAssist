import type { RecentContext } from "../types";

interface HomeViewProps {
  recentContexts: RecentContext[];
  onChooseCasefile: () => void | Promise<void>;
  onOpenRecentContext: (root: string, activeContextId: string | null) => void | Promise<void>;
  onSetRecentPinned: (root: string, pinned: boolean) => void;
}

function basenameFromPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "recently";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function HomeView({
  recentContexts,
  onChooseCasefile,
  onOpenRecentContext,
  onSetRecentPinned,
}: HomeViewProps): JSX.Element {
  const latest = recentContexts.reduce<RecentContext | null>((best, context) => {
    if (!best) return context;
    return Date.parse(context.updatedAt) > Date.parse(best.updatedAt) ? context : best;
  }, null);
  const pinned = recentContexts.filter((context) => context.pinned);
  const recent = recentContexts.filter((context) => !context.pinned);

  const renderContextCard = (context: RecentContext) => {
    const rootName = basenameFromPath(context.root);
    return (
      <div key={context.root} className="home-context-card">
        <div className="home-context-main">
          <div className="home-context-title">{rootName}</div>
          <div className="home-context-meta">
            {context.activeContextName ? `Resume ${context.activeContextName}` : "Resume workspace"}
            {" - "}
            {formatUpdatedAt(context.updatedAt)}
          </div>
          <div className="home-context-path" title={context.root}>
            {context.root}
          </div>
        </div>
        <div className="home-context-actions">
          <button
            type="button"
            onClick={() => {
              void Promise.resolve(
                onOpenRecentContext(context.root, context.activeContextId)
              );
            }}
          >
            Resume
          </button>
          <button
            type="button"
            className="home-secondary-action"
            onClick={() => onSetRecentPinned(context.root, !context.pinned)}
          >
            {context.pinned ? "Unpin" : "Pin"}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="home-view">
      <section className="home-hero">
        <div>
          <div className="home-kicker">DeskAssist</div>
          <h1>Resume your work.</h1>
          <p>
            Pick up a recent context, open another workspace, or resume the
            last active thread.
          </p>
        </div>
        <div className="home-hero-actions">
          <button
            type="button"
            onClick={() => {
              void Promise.resolve(onChooseCasefile());
            }}
          >
            Open Workspace
          </button>
          <button
            type="button"
            disabled={!latest}
            onClick={() => {
              if (!latest) return;
              void Promise.resolve(
                onOpenRecentContext(latest.root, latest.activeContextId)
              );
            }}
          >
            Resume Latest
          </button>
        </div>
      </section>

      <section className="home-section">
        <div className="home-section-header">
          <h2>Pinned Work</h2>
          <span>{pinned.length > 0 ? `${pinned.length} pinned` : "Nothing pinned yet"}</span>
        </div>
        {pinned.length > 0 ? (
          <div className="home-context-list">{pinned.map(renderContextCard)}</div>
        ) : (
          <div className="home-empty-card">
            Pin recurring contexts here so they stay above normal recents.
          </div>
        )}
      </section>

      <section className="home-section">
        <div className="home-section-header">
          <h2>Recent Contexts</h2>
          <span>{recent.length > 0 ? `${recent.length} recent` : "No recent work yet"}</span>
        </div>
        {recent.length > 0 ? (
          <div className="home-context-list">{recent.map(renderContextCard)}</div>
        ) : (
          <div className="home-empty-card">
            Open a workspace to start building your recent work list.
          </div>
        )}
      </section>

      <section className="home-section">
        <div className="home-section-header">
          <h2>Quick Capture</h2>
          <span>Requires an active context</span>
        </div>
        <div className="home-empty-card">
          Resume or open a workspace, then use Quick Capture in the toolbar to
          open `quick-capture.md` in that context.
        </div>
      </section>
    </div>
  );
}
