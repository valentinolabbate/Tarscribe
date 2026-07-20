import type { Topic } from "../../lib/types";
import { ActivityIcon, CloseIcon, HomeIcon, MemoryIcon, PlusIcon, SettingsIcon } from "../icons";
import { TopicRow } from "./TopicRow";

export function Sidebar({
  topics,
  activeTopic,
  showHome,
  showTasks,
  showMemory,
  showPeople,
  showJobs,
  onHome,
  onMemory,
  onJobs,
  onNewTopic,
  onSelectTopic,
  onMoveTopic,
  onSettings,
  compactOpen = false,
  onClose = () => {},
}: {
  topics: Topic[];
  activeTopic: number | null;
  showHome: boolean;
  showTasks: boolean;
  showMemory: boolean;
  showPeople: boolean;
  showJobs: boolean;
  onHome: () => void;
  onMemory: () => void;
  onJobs: () => void;
  onNewTopic: () => void;
  onSelectTopic: (topicId: number) => void;
  onMoveTopic: (topicId: number, direction: -1 | 1) => void;
  onSettings: () => void;
  compactOpen?: boolean;
  onClose?: () => void;
}) {
  function navigate(action: () => void) {
    action();
    onClose();
  }

  return (
    <aside className={`sidebar ${compactOpen ? "compact-open" : ""}`} aria-label="Hauptnavigation">
      <div className="brand">
        <img src="logo.png" alt="Tarscribe" className="brand-logo" />
        <div className="brand-name">Tarscribe</div>
        <button type="button" className="sidebar-compact-close" aria-label="Navigation schließen" onClick={onClose}>
          <CloseIcon width={18} height={18} />
        </button>
      </div>

      <button className={`topic-item ${showHome ? "active" : ""}`} onClick={() => navigate(onHome)}>
        <HomeIcon width={16} height={16} /> Start
      </button>

      <button
        className={`topic-item ${showMemory || showTasks || showPeople ? "active" : ""}`}
        onClick={() => navigate(onMemory)}
        aria-current={showMemory || showTasks || showPeople ? "page" : undefined}
      >
        <MemoryIcon width={16} height={16} /> Gedächtnis
      </button>

      <div className="sidebar-library">
        <div className="section-label">
          <span>Bibliothek</span>
          <button className="btn ghost" style={{ padding: 2 }} title="Neuer Themenbereich" onClick={() => navigate(onNewTopic)}>
            <PlusIcon width={15} height={15} />
          </button>
        </div>

        <div className="topic-list">
          {topics.map((topic, index) => (
            <TopicRow
              key={topic.id}
              topic={topic}
              active={topic.id === activeTopic && !showHome && !showTasks && !showMemory && !showPeople && !showJobs}
              canMoveUp={index > 0}
              canMoveDown={index < topics.length - 1}
              onSelect={() => navigate(() => onSelectTopic(topic.id))}
              onMoveUp={() => onMoveTopic(topic.id, -1)}
              onMoveDown={() => onMoveTopic(topic.id, 1)}
            />
          ))}

          {topics.length === 0 && (
            <button className="topic-item" onClick={() => navigate(onNewTopic)}>
              <PlusIcon width={15} height={15} /> Ersten Bereich anlegen
            </button>
          )}
        </div>
      </div>

      <div className="sidebar-footer">
        <div className="sidebar-status" title="Audio, Transkripte und Chat bleiben auf diesem Mac.">
          <span className="sidebar-status-dot" />
          <strong>Lokal bereit</strong>
        </div>
        <button className={`topic-item sidebar-utility ${showJobs ? "active" : ""}`} onClick={() => navigate(onJobs)}>
          <ActivityIcon width={16} height={16} /> Verarbeitung
        </button>
        <button className="topic-item" onClick={() => navigate(onSettings)}>
          <SettingsIcon width={16} height={16} /> Einstellungen
        </button>
      </div>
    </aside>
  );
}
