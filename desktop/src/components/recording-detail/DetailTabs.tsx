import type { DetailTab } from "./model";

export function DetailTabs({
  tabs,
  activeTab,
  onSelect,
}: {
  tabs: Array<{ id: DetailTab; label: string; meta: string }>;
  activeTab: DetailTab;
  onSelect: (tab: DetailTab) => void;
}) {
  return (
    <nav className="detail-tabs" aria-label="Bereiche der Aufnahme">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          className={`detail-tab ${activeTab === tab.id ? "active" : ""}`}
          onClick={() => onSelect(tab.id)}
          type="button"
        >
          <span>{tab.label}</span>
          {tab.meta && <small>{tab.meta}</small>}
        </button>
      ))}
    </nav>
  );
}
