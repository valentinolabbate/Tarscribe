import { useEffect, useState } from "react";
import { useKnownSpeakers, usePeopleMemory } from "../hooks/queries";
import { fmtDate, fmtDuration } from "../lib/format";
import type { ActionItem, PeopleMemory, PeopleMemoryRecording, TopicThread } from "../lib/types";
import { SpeakerIdIcon } from "./icons";

function PersonAvatar({ name, color, large = false }: { name: string; color: string; large?: boolean }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  return (
    <span className={`people-avatar ${large ? "large" : ""}`} style={{ background: color }}>
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
      {startSec != null ? `▶ ${fmtDuration(startSec)}` : "Aufnahme öffnen"}
      {title ? ` · ${title}` : ""}
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

export function PeopleMemoryView({
  memory,
  onOpenRecording,
}: {
  memory: PeopleMemory;
  onOpenRecording: (recordingId: number, startSec?: number | null) => void;
}) {
  const openTasks = memory.tasks.filter((item) => !item.done);
  const completedTasks = memory.tasks.filter((item) => item.done);
  return (
    <div className="people-memory-view">
      <header className="people-hero">
        <PersonAvatar name={memory.speaker.name} color={memory.speaker.color} large />
        <div>
          <span className="page-kicker">People Memory</span>
          <h2>{memory.speaker.name}</h2>
          <p>
            Belegte Gespräche, Zusagen, Entscheidungen und Themen. Keine Persönlichkeitsbewertung.
          </p>
        </div>
      </header>

      <div className="people-scoreboard">
        <div><strong>{memory.stats.recording_count}</strong><span>Gespräche</span></div>
        <div><strong>{memory.stats.open_task_count}</strong><span>offene Zusagen</span></div>
        <div><strong>{memory.stats.decision_count}</strong><span>Entscheidungen</span></div>
        <div><strong>{memory.stats.thread_count}</strong><span>Themen-Threads</span></div>
      </div>

      <div className="people-memory-grid">
        <section className="people-section people-tasks">
          <div className="people-section-head">
            <div><span className="page-kicker">Verantwortung</span><h3>Offene Zusagen und Aufgaben</h3></div>
            <span>{openTasks.length}</span>
          </div>
          {openTasks.length > 0 ? (
            <div className="people-memory-list">
              {openTasks.map((item) => (
                <MemoryItem key={item.id} item={item} onOpenRecording={onOpenRecording} />
              ))}
            </div>
          ) : (
            <div className="people-empty">Keine offenen Aufgaben erkannt.</div>
          )}
          {completedTasks.length > 0 && (
            <details className="people-completed">
              <summary>{completedTasks.length} erledigte Aufgaben</summary>
              <div className="people-memory-list">
                {completedTasks.map((item) => (
                  <MemoryItem key={item.id} item={item} onOpenRecording={onOpenRecording} />
                ))}
              </div>
            </details>
          )}
        </section>

        <section className="people-section people-recordings">
          <div className="people-section-head">
            <div><span className="page-kicker">Verlauf</span><h3>Letzte Gespräche</h3></div>
            <span>{memory.recordings.length}</span>
          </div>
          {memory.recordings.length > 0 ? (
            <div className="people-recording-list">
              {memory.recordings.slice(0, 10).map((recording) => (
                <RecordingCard
                  key={recording.id}
                  recording={recording}
                  onOpenRecording={onOpenRecording}
                />
              ))}
            </div>
          ) : (
            <div className="people-empty">Noch keiner Aufnahme eindeutig zugeordnet.</div>
          )}
        </section>

        <section className="people-section">
          <div className="people-section-head">
            <div><span className="page-kicker">Kontext</span><h3>Gemeinsame Themen</h3></div>
            <span>{memory.threads.length}</span>
          </div>
          {memory.threads.length > 0 ? (
            <div className="people-thread-list">
              {memory.threads.map((thread) => (
                <ThreadCard key={thread.id} thread={thread} onOpenRecording={onOpenRecording} />
              ))}
            </div>
          ) : (
            <div className="people-empty">Noch keine wiederkehrenden Themen erkannt.</div>
          )}
        </section>

        <section className="people-section">
          <div className="people-section-head">
            <div><span className="page-kicker">Beschlüsse</span><h3>Vergangene Entscheidungen</h3></div>
            <span>{memory.decisions.length}</span>
          </div>
          {memory.decisions.length > 0 ? (
            <div className="people-memory-list">
              {memory.decisions.map((item) => (
                <MemoryItem key={item.id} item={item} onOpenRecording={onOpenRecording} />
              ))}
            </div>
          ) : (
            <div className="people-empty">Keine Entscheidungen aus gemeinsamen Gesprächen.</div>
          )}
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
  const { data: memory, isLoading: memoryLoading } = usePeopleMemory(selectedId);

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
    <div className="people-page">
      <aside className="people-list" aria-label="Bekannte Personen">
        <div className="people-list-head">
          <span className="page-kicker">Gedächtnis</span>
          <h3>Personen</h3>
        </div>
        {speakers.map((speaker) => (
          <button
            key={speaker.id}
            className={speaker.id === selectedId ? "active" : ""}
            onClick={() => setSelectedId(speaker.id)}
          >
            <PersonAvatar name={speaker.name} color={speaker.color} />
            <span><strong>{speaker.name}</strong><small>{speaker.sample_count} Stimmproben</small></span>
          </button>
        ))}
      </aside>
      <main className="people-profile">
        {memoryLoading && <div className="people-empty-page">Profil wird aufgebaut…</div>}
        {memory && <PeopleMemoryView memory={memory} onOpenRecording={onOpenRecording} />}
      </main>
    </div>
  );
}
