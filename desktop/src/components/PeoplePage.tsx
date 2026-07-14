import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useKnownSpeakers, usePeopleMemory } from "../hooks/queries";
import { fmtDate, fmtDuration } from "../lib/format";
import type { ActionItem, PeopleMemory, PeopleMemoryRecording, TopicThread } from "../lib/types";
import {
  ActivityIcon,
  ChatIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  LinkIcon,
  SearchIcon,
  SpeakerIdIcon,
  SummaryIcon,
  TasksIcon,
  WaveIcon,
} from "./icons";

const PEOPLE_LIST_PREVIEW_LIMIT = 3;

function PersonAvatar({ name, color, large = false }: { name: string; color: string; large?: boolean }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  return (
    <span
      className={`people-avatar ${large ? "large" : ""}`}
      style={{ "--people-color": color } as CSSProperties}
    >
      {initials || "?"}
    </span>
  );
}

function SourceButton({
  recordingId,
  title,
  startSec,
  onOpenRecording,
}: {
  recordingId: number;
  title: string | null;
  startSec?: number | null;
  onOpenRecording: (recordingId: number, startSec?: number | null) => void;
}) {
  return (
    <button
      className="people-source"
      onClick={() => onOpenRecording(recordingId, startSec)}
      title="Belegende Aufnahme öffnen"
    >
      <LinkIcon width={11} height={11} />
      <span>
        {startSec != null ? fmtDuration(startSec) : "Aufnahme öffnen"}
        {title ? ` · ${title}` : ""}
      </span>
    </button>
  );
}

function MemoryItem({
  item,
  onOpenRecording,
}: {
  item: ActionItem;
  onOpenRecording: (recordingId: number, startSec?: number | null) => void;
}) {
  return (
    <article className={`people-memory-item ${item.done ? "done" : ""}`}>
      <div className="people-memory-item-head">
        <span className={`action-kind ${item.kind}`}>
          {item.kind === "decision" ? "Entscheidung" : item.done ? "Erledigt" : "Offen"}
        </span>
        {item.due_date && <time>{fmtDate(item.due_date)}</time>}
      </div>
      <strong>{item.text}</strong>
      <div className="people-memory-meta">
        {item.assignee && <span>{item.assignee}</span>}
        {item.topic_name && <span>{item.topic_name}</span>}
      </div>
      <SourceButton
        recordingId={item.recording_id}
        title={item.recording_title}
        startSec={item.source_start_sec}
        onOpenRecording={onOpenRecording}
      />
    </article>
  );
}

function RecordingCard({
  recording,
  onOpenRecording,
}: {
  recording: PeopleMemoryRecording;
  onOpenRecording: (recordingId: number, startSec?: number | null) => void;
}) {
  return (
    <button
      className="people-recording"
      onClick={() => onOpenRecording(recording.id, recording.start_sec)}
    >
      <span className="topic-dot" style={{ background: recording.topic_color }} />
      <span className="people-recording-copy">
        <strong>{recording.title}</strong>
        <small>{recording.topic_name} · {fmtDate(recording.created_at)}</small>
      </span>
      <span className="people-recording-time">
        {recording.talk_sec > 0 ? `${fmtDuration(recording.talk_sec)} gesprochen` : "Teilgenommen"}
      </span>
    </button>
  );
}

function ThreadCard({
  thread,
  onOpenRecording,
}: {
  thread: TopicThread;
  onOpenRecording: (recordingId: number, startSec?: number | null) => void;
}) {
  return (
    <article className="people-thread">
      <div>
        <strong>{thread.title}</strong>
        <span>{thread.recording_count} gemeinsame Aufnahmen</span>
      </div>
      <div className="people-thread-sources">
        {thread.mentions.slice(0, 6).map((mention) => (
          <button
            key={mention.id}
            onClick={() => onOpenRecording(mention.recording_id, mention.start_sec)}
            title={mention.recording_title ?? "Aufnahme öffnen"}
          >
            <span className="topic-dot" style={{ background: mention.topic_color ?? "var(--accent)" }} />
            {mention.recording_created_at ? fmtDate(mention.recording_created_at) : "Aufnahme"}
            {mention.start_sec != null && <code>{fmtDuration(mention.start_sec)}</code>}
          </button>
        ))}
      </div>
    </article>
  );
}

function ExpandablePeopleList<T>({
  items,
  className,
  empty,
  itemLabel,
  getKey,
  renderItem,
}: {
  items: T[];
  className: string;
  empty: string;
  itemLabel: string;
  getKey: (item: T) => number | string;
  renderItem: (item: T) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const hiddenCount = Math.max(0, items.length - PEOPLE_LIST_PREVIEW_LIMIT);
  const visibleItems = expanded ? items : items.slice(0, PEOPLE_LIST_PREVIEW_LIMIT);

  if (items.length === 0) {
    return <div className="people-empty">{empty}</div>;
  }

  return (
    <>
      <div className={`people-collapsible-list ${expanded ? "expanded" : "collapsed"} ${className}`}>
        {visibleItems.map((item) => (
          <div key={getKey(item)} className="people-collapsible-item">
            {renderItem(item)}
          </div>
        ))}
      </div>
      {hiddenCount > 0 && (
        <button
          type="button"
          className="people-list-toggle"
          aria-expanded={expanded}
          aria-label={expanded ? `${itemLabel} einklappen` : `${itemLabel} aufklappen`}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? (
            <>
              <ChevronUpIcon width={14} height={14} />
              Weniger anzeigen
            </>
          ) : (
            <>
              <ChevronDownIcon width={14} height={14} />
              {hiddenCount === 1 ? "1 weiteren Eintrag anzeigen" : `${hiddenCount} weitere anzeigen`}
            </>
          )}
        </button>
      )}
    </>
  );
}

function PeopleSectionHeading({
  eyebrow,
  title,
  count,
  icon,
}: {
  eyebrow: string;
  title: string;
  count: number;
  icon: ReactNode;
}) {
  return (
    <div className="people-section-head">
      <div className="people-section-title">
        <span className="people-section-icon">{icon}</span>
        <div>
          <span className="page-kicker">{eyebrow}</span>
          <h3>{title}</h3>
        </div>
      </div>
      <span className="people-section-count">{count}</span>
    </div>
  );
}

export function PeopleMemoryView({
  memory,
  onOpenRecording,
}: {
  memory: PeopleMemory;
  onOpenRecording: (recordingId: number, startSec?: number | null) => void;
}) {
  const openTasks = memory.tasks.filter((item) => !item.done);
  const completedTasks = memory.tasks.filter((item) => item.done);
  const lastSeen = memory.stats.last_seen_at ? fmtDate(memory.stats.last_seen_at) : "Noch kein Gespräch";
  return (
    <div
      className="people-memory-view"
      style={{ "--people-color": memory.speaker.color } as CSSProperties}
    >
      <header className="people-hero">
        <div className="people-hero-row">
          <div className="people-hero-identity">
            <PersonAvatar name={memory.speaker.name} color={memory.speaker.color} large />
            <div className="people-hero-copy">
              <span className="page-kicker">People Memory</span>
              <h2>{memory.speaker.name}</h2>
              <p>Quellenbasiertes Profil aus gemeinsamen Gesprächen</p>
              <div className="people-hero-meta">
                <span>Zuletzt {lastSeen}</span>
                <span>{fmtDuration(memory.stats.talk_sec)} Sprechzeit</span>
                <span>
                  {memory.speaker.sample_count} {memory.speaker.sample_count === 1 ? "Stimmprobe" : "Stimmproben"}
                </span>
              </div>
            </div>
          </div>
          <div className="people-voiceprint" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
        </div>
        <div className="people-scoreboard">
          <div><WaveIcon width={16} height={16} /><strong>{memory.stats.recording_count}</strong><span>Gespräche</span></div>
          <div><TasksIcon width={16} height={16} /><strong>{memory.stats.open_task_count}</strong><span>Offene Zusagen</span></div>
          <div><SummaryIcon width={16} height={16} /><strong>{memory.stats.decision_count}</strong><span>Entscheidungen</span></div>
          <div><ChatIcon width={16} height={16} /><strong>{memory.stats.thread_count}</strong><span>Gemeinsame Themen</span></div>
        </div>
      </header>

      <div className="people-memory-grid">
        <section className="people-section people-tasks">
          <PeopleSectionHeading
            eyebrow="Verantwortung"
            title="Offene Zusagen und Aufgaben"
            count={openTasks.length}
            icon={<TasksIcon width={16} height={16} />}
          />
          <ExpandablePeopleList
            key={`${memory.speaker.id}-open-tasks`}
            items={openTasks}
            className="people-memory-list"
            empty="Keine offenen Aufgaben erkannt."
            itemLabel="Aufgaben"
            getKey={(item) => item.id}
            renderItem={(item) => <MemoryItem item={item} onOpenRecording={onOpenRecording} />}
          />
          {completedTasks.length > 0 && (
            <details className="people-completed">
              <summary>{completedTasks.length} erledigte Aufgaben</summary>
              <ExpandablePeopleList
                key={`${memory.speaker.id}-completed-tasks`}
                items={completedTasks}
                className="people-memory-list"
                empty="Keine erledigten Aufgaben."
                itemLabel="erledigte Aufgaben"
                getKey={(item) => item.id}
                renderItem={(item) => <MemoryItem item={item} onOpenRecording={onOpenRecording} />}
              />
            </details>
          )}
        </section>

        <section className="people-section people-recordings">
          <PeopleSectionHeading
            eyebrow="Verlauf"
            title="Letzte Gespräche"
            count={memory.recordings.length}
            icon={<ActivityIcon width={16} height={16} />}
          />
          <ExpandablePeopleList
            key={`${memory.speaker.id}-recordings`}
            items={memory.recordings}
            className="people-recording-list"
            empty="Noch keiner Aufnahme eindeutig zugeordnet."
            itemLabel="Gespräche"
            getKey={(recording) => recording.id}
            renderItem={(recording) => (
              <RecordingCard recording={recording} onOpenRecording={onOpenRecording} />
            )}
          />
        </section>

        <section className="people-section people-topics">
          <PeopleSectionHeading
            eyebrow="Kontext"
            title="Gemeinsame Themen"
            count={memory.threads.length}
            icon={<ChatIcon width={16} height={16} />}
          />
          <ExpandablePeopleList
            key={`${memory.speaker.id}-threads`}
            items={memory.threads}
            className="people-thread-list"
            empty="Noch keine wiederkehrenden Themen erkannt."
            itemLabel="Themen"
            getKey={(thread) => thread.id}
            renderItem={(thread) => <ThreadCard thread={thread} onOpenRecording={onOpenRecording} />}
          />
        </section>

        <section className="people-section people-decisions">
          <PeopleSectionHeading
            eyebrow="Beschlüsse"
            title="Vergangene Entscheidungen"
            count={memory.decisions.length}
            icon={<SummaryIcon width={16} height={16} />}
          />
          <ExpandablePeopleList
            key={`${memory.speaker.id}-decisions`}
            items={memory.decisions}
            className="people-memory-list"
            empty="Keine Entscheidungen aus gemeinsamen Gesprächen."
            itemLabel="Entscheidungen"
            getKey={(item) => item.id}
            renderItem={(item) => <MemoryItem item={item} onOpenRecording={onOpenRecording} />}
          />
        </section>
      </div>
    </div>
  );
}

export function PeoplePage({
  onOpenRecording,
}: {
  onOpenRecording: (recordingId: number, startSec?: number | null) => void;
}) {
  const { data: speakers, isLoading: speakersLoading } = useKnownSpeakers();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const { data: memory, isLoading: memoryLoading } = usePeopleMemory(selectedId);
  const visibleSpeakers = speakers?.filter((speaker) =>
    speaker.name.toLocaleLowerCase("de").includes(query.trim().toLocaleLowerCase("de")),
  );

  useEffect(() => {
    if (!speakers?.length) {
      setSelectedId(null);
      return;
    }
    if (selectedId == null || !speakers.some((speaker) => speaker.id === selectedId)) {
      setSelectedId(speakers[0].id);
    }
  }, [selectedId, speakers]);

  if (speakersLoading) return <div className="people-empty-page">People Memory wird geladen…</div>;
  if (!speakers?.length) {
    return (
      <div className="people-empty-page">
        <SpeakerIdIcon width={34} height={34} />
        <h2>Noch keine bekannten Personen</h2>
        <p>Speichere in einer Aufnahme zuerst eine Stimme als bekannten Sprecher.</p>
      </div>
    );
  }

  return (
    <div className="people-page people-page-dossier">
      <aside className="people-list" aria-label="Bekannte Personen">
        <div className="people-list-head">
          <div>
            <span className="page-kicker">Gedächtnis</span>
            <h3>Personen</h3>
          </div>
          <span className="people-list-count">{speakers.length}</span>
        </div>
        <label className="people-search">
          <SearchIcon width={14} height={14} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Person suchen"
            aria-label="Person suchen"
          />
        </label>
        <div className="people-directory">
          {visibleSpeakers?.map((speaker) => (
            <button
              key={speaker.id}
              className={speaker.id === selectedId ? "active" : ""}
              style={{ "--people-color": speaker.color } as CSSProperties}
              aria-pressed={speaker.id === selectedId}
              onClick={() => setSelectedId(speaker.id)}
            >
              <PersonAvatar name={speaker.name} color={speaker.color} />
              <span>
                <strong>{speaker.name}</strong>
                <small>
                  {speaker.sample_count} {speaker.sample_count === 1 ? "Stimmprobe" : "Stimmproben"}
                </small>
              </span>
            </button>
          ))}
          {visibleSpeakers?.length === 0 && <div className="people-list-empty">Keine Person gefunden</div>}
        </div>
      </aside>
      <main className="people-profile">
        {memoryLoading && <div className="people-empty-page">Profil wird aufgebaut…</div>}
        {memory && <PeopleMemoryView memory={memory} onOpenRecording={onOpenRecording} />}
      </main>
    </div>
  );
}
