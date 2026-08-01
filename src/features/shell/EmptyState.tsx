import { pickPdf } from "../../ipc/dialog";
import { useTabsStore } from "../../state/tabs-store";
import type { RecentEntry } from "../../lib/session";

function IbrisMark() {
  return (
    <svg width="36" height="42" viewBox="0 0 24 28" aria-hidden="true">
      <path
        d="M4 1h10l6 6v20H4z"
        fill="var(--bg-raised)"
        stroke="var(--text-dim)"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M14 1v6h6"
        fill="none"
        stroke="var(--accent)"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RecentCard({ entry }: { entry: RecentEntry }) {
  const openTab = useTabsStore((s) => s.openTab);
  const removeRecent = useTabsStore((s) => s.removeRecent);
  const missing = entry.missing === true;

  return (
    <div className={missing ? "recent-card missing" : "recent-card"}>
      <button
        className="recent-open"
        disabled={missing}
        title={entry.path}
        onClick={() => void openTab(entry.path)}
      >
        <div className="recent-thumb">
          {entry.thumbnail ? (
            <img src={entry.thumbnail} alt="" />
          ) : (
            <span className="recent-thumb-count">
              {entry.pageCount}
              <small>{entry.pageCount === 1 ? "page" : "pages"}</small>
            </span>
          )}
        </div>
        <div className="recent-title">{entry.title}</div>
        <div className="recent-meta">
          {missing
            ? "Not found"
            : `${entry.pageCount} ${entry.pageCount === 1 ? "page" : "pages"}`}
        </div>
      </button>
      {missing && (
        <button
          className="recent-remove"
          aria-label={`Remove ${entry.title} from recent files`}
          onClick={() => removeRecent(entry.path)}
        >
          ×
        </button>
      )}
    </div>
  );
}

/** First screen: open a document, or return to a recent one. */
export function EmptyState() {
  const recents = useTabsStore((s) => s.recents);
  const openTab = useTabsStore((s) => s.openTab);

  return (
    <div className="empty">
      <div className="empty-inner">
        <div className="empty-mark">
          <IbrisMark />
          <span className="empty-word">Ibris</span>
        </div>
        <div className="empty-actions">
          <button
            className="btn-primary"
            onClick={() =>
              void pickPdf().then((path) => {
                if (path) void openTab(path);
              })
            }
          >
            Open PDF…
          </button>
          <span className="empty-hint">
            or drop a file anywhere in this window
          </span>
        </div>
        {recents.length > 0 && (
          <>
            <div className="recents-label">Recent</div>
            <div className="recents-grid">
              {recents.map((r) => (
                <RecentCard key={r.path} entry={r} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
