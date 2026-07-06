import type { Topic } from "../../lib/types";
import { ActivityIcon, HomeIcon, PlusIcon, SettingsIcon, TasksIcon } from "../icons";
import { TopicRow } from "./TopicRow";

export function Sidebar({
  topics,
  activeTopic,
  showHome,
  showTasks,
  showJobs,
  onHome,
  onTasks,
  onJobs,
  onNewTopic,
  onSelectTopic,
  onMoveTopic,
  onSettings,
}: {
  topics: Topic[];
  activeTopic: number | null;
  showHome: boolean;
  showTasks: boolean;
  showJobs: boolean;
  onHome: () => void;
  onTasks: () => void;
  onJobs: () => void;
  onNewTopic: () => void;
  onSelectTopic: (topicId: number) => void;
  onMoveTopic: (topicId: number, direction: -1 | 1) => void;
  onSettings: () => void;
}) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <img src="logo.png" alt="Tarscribe" className="brand-logo" />
        <div className="brand-name">Tarscribe</div>
      </div>

      <button className={`topic-item ${showHome ? "active" : ""}`} onClick={onHome}>
        <HomeIcon width={16} height={16} /> Start
      </button>

      <button className={`topic-item ${showTasks ? "active" : ""}`} onClick={onTasks}>
        <TasksIcon width={16} height={16} /> Aufgaben
      </button>

      <div className="section-label">
        <span>Bibliothek</span>
        <button className="btn ghost" style={{ padding: 2 }} title="Neuer Themenbereich" onClick={onNewTopic}>
          <PlusIcon width={15} height={15} />
        </button>
      </div>

      <div className="topic-list">
        {topics.map((topic, index) => (
          <TopicRow
            key={topic.id}
            topic={topic}
            active={topic.id === activeTopic && !showHome && !showTasks && !showJobs}
            canMoveUp={index > 0}
            canMoveDown={index < topics.length - 1}
            onSelect={() => onSelectTopic(topic.id)}
            onMoveUp={() => onMoveTopic(topic.id, -1)}
            onMoveDown={() => onMoveTopic(topic.id, 1)}
          />
        ))}
      </div>

      {topics.length === 0 && (
        <button className="topic-item" onClick={onNewTopic}>
          <PlusIcon width={15} height={15} /> Ersten Bereich anlegen
        </button>
      )}

      <div style={{ flex: 1 }} />
      <div className="sidebar-status" title="Audio, Transkripte und Chat bleiben auf diesem Mac.">
        <span className="sidebar-status-dot" />
        <strong>Lokal bereit</strong>
      </div>
      <button className={`topic-item sidebar-utility ${showJobs ? "active" : ""}`} onClick={onJobs}>
        <ActivityIcon width={16} height={16} /> Verarbeitung
      </button>
      <button className="topic-item" onClick={onSettings}>
        <SettingsIcon width={16} height={16} /> Einstellungen
      </button>
    </aside>
  );
}
