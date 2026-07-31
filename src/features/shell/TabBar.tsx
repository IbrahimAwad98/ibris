import { useTabsStore } from "../../state/tabs-store";

/** One row of document tabs; hidden while no document is open. */
export function TabBar() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const activateTab = useTabsStore((s) => s.activateTab);
  const closeTab = useTabsStore((s) => s.closeTab);

  if (tabs.length === 0) return null;

  return (
    <div
      role="tablist"
      style={{
        display: "flex",
        alignItems: "stretch",
        flexShrink: 0,
        background: "var(--bg-raised)",
        overflowX: "auto",
        scrollbarWidth: "none",
      }}
    >
      {tabs.map((t) => {
        const active = t.id === activeTabId;
        return (
          <div
            key={t.id}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            title={t.path}
            onClick={() => activateTab(t.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") activateTab(t.id);
            }}
            onAuxClick={(e) => {
              if (e.button === 1) void closeTab(t.id);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "7px 6px 7px 12px",
              maxWidth: 200,
              minWidth: 0,
              cursor: "default",
              userSelect: "none",
              whiteSpace: "nowrap",
              fontSize: 13,
              background: active ? "var(--bg)" : "transparent",
              color: active ? "var(--text)" : "var(--text-dim)",
              borderRight: "1px solid var(--border-deep)",
            }}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
              {t.title}
            </span>
            <button
              aria-label={`Close ${t.title}`}
              onClick={(e) => {
                e.stopPropagation();
                void closeTab(t.id);
              }}
              style={{
                border: "none",
                background: "transparent",
                color: "inherit",
                cursor: "pointer",
                padding: "0 5px",
                fontSize: 14,
                lineHeight: 1.2,
                borderRadius: 3,
              }}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
