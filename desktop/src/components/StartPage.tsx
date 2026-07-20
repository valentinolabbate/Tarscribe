import ReactMarkdown from "react-markdown";
import { useState, type CSSProperties } from "react";
import { ChatPanel } from "./ChatPanel";
import { DictationPanel } from "./DictationPanel";
import { RecordControl } from "./RecordControl";
import {
  useActionItems,
  useAllRecordings,
  useCreateDigest,
  useDigests,
  useRebuildThreads,
  useSendDigestToFolder,
  useThreads,
  useUpdateActionItem,
} from "../hooks/queries";
import type { DictationController } from "../hooks/useDictation";
import { fmtDate, fmtDuration } from "../lib/format";
import type { ActionItem, Digest, Recording, Topic, TopicThread } from "../lib/types";
import { EvidenceTrail } from "./EvidenceTrail";
import { ActivityIcon, MemoryIcon, TasksIcon, WaveIcon } from "./icons";
import { timelineKind } from "./meeting-timeline/model";
import { memorySectionForActionItem } from "./MemorySectionNav";
import { useToast } from "./Toast";

function DigestPanel() {
  const { data: digests, isLoading } = useDigests();
  const createDigest = useCreateDigest();
  const sendDigest = useSendDigestToFolder();
  const toast = useToast();
  const latest: Digest | undefined = digests?.[0];
  const range = latest ? `${fmtDate(latest.date_from)} - ${fmtDate(latest.date_to)}` : "Letzte 7 Tage";
  const latestAgeDays = latest
    ? Math.floor((Date.now() - new Date(latest.created_at).getTime()) / 86_400_000)
    : null;
  const stale = latestAgeDays == null || latestAgeDays >= 7;

  async function exportLatest() {
    if (!latest) return;
    try {
      const res = await sendDigest.mutateAsync(latest.id);
      toast(`Digest exportiert: ${res.path}`, "success");
    } catch (e) {
      toast(`Digest-Export fehlgeschlagen: ${(e as Error).message}`, "error");
    }
  }

  return (
    <section className="start-card digest-panel compact-insight" aria-label="Wochen-Digest">
      <div className="start-card-head">
        <div>
          <h3>Wochen-Digest</h3>
        </div>
        <div className="start-card-actions">
          <button
            className="btn"
            disabled={createDigest.isPending}
            onClick={() => createDigest.mutate(7)}
          >
            {createDigest.isPending ? "Erstelle..." : latest ? "Neu erstellen" : "Digest erstellen"}
          </button>
        </div>
      </div>

      {isLoading && <div className="start-card-note">Wird geladen…</div>}
      {createDigest.isPending && (
        <div className="start-card-note">Digest wird erstellt…</div>
      )}
      {!isLoading && !createDigest.isPending && latest && stale && (
        <div className="start-card-note due">Vor {latestAgeDays} Tagen erstellt</div>
      )}
      {!isLoading && !createDigest.isPending && !latest && (
        <div className="start-card-note">Entscheidungen und Aufgaben der letzten sieben Tage.</div>
      )}
      {latest && !createDigest.isPending && (
        <details className="start-card-disclosure">
          <summary>
            <span>{range}</span>
            <small>{latest.recording_count} Quellen</small>
          </summary>
          <div className="start-disclosure-actions">
            <button className="btn ghost" onClick={() => navigator.clipboard.writeText(latest.content_markdown)}>
              Kopieren
            </button>
            <button className="btn ghost" onClick={exportLatest} disabled={sendDigest.isPending}>
              {sendDigest.isPending ? "Exportiere…" : "Exportieren"}
            </button>
          </div>
          <article className="digest-body">
            <div className="digest-markdown markdown">
              <ReactMarkdown>{latest.content_markdown}</ReactMarkdown>
            </div>
          </article>
        </details>
      )}
    </section>
  );
}

function ThreadsPanel({
  onOpenSource,
}: {
  onOpenSource: (recordingId: number, startSec?: number | null) => void;
}) {
  const { data: threads, isLoading } = useThreads();
  const rebuild = useRebuildThreads();
  const toast = useToast();
  const visible = threads?.slice(0, 5) ?? [];

  async function rebuildThreads() {
    try {
      const res = await rebuild.mutateAsync();
      if (res.indexed_chunks === 0) {
        toast("Noch keine semantisch indexierten Transkripte vorhanden.", "info");
      } else {
        toast(
          `${res.threads} semantische Threads aus ${res.mentions} Aufnahmen erkannt.`,
          "success",
        );
      }
    } catch (e) {
      toast(`Threads konnten nicht aktualisiert werden: ${(e as Error).message}`, "error");
    }
  }

  return (
    <section className="start-card threads-panel compact-insight" aria-label="Themen-Threads">
      <div className="start-card-head">
        <div>
          <h3>Themen-Threads</h3>
        </div>
        <button className="btn ghost" onClick={rebuildThreads} disabled={rebuild.isPending}>
          {rebuild.isPending ? "Analysiere..." : "Semantisch aktualisieren"}
        </button>
      </div>
      {isLoading && <div className="start-card-note">Wird geladen…</div>}
      {!isLoading && visible.length === 0 && (
        <div className="start-card-note">Semantische Verbindungen zwischen deinen Aufnahmen.</div>
      )}
      {visible.length > 0 && (
        <details className="start-card-disclosure">
          <summary>
            <span>{visible.length} Threads</span>
            <small>Anzeigen</small>
          </summary>
          <div className="thread-list">
            {visible.map((thread: TopicThread) => (
              <article className="thread-card" key={thread.id}>
                <div className="thread-card-head">
                  <strong>{thread.title}</strong>
                  <span>{thread.recording_count} Aufnahmen</span>
                </div>
                <div className="thread-mentions">
                  {thread.mentions.slice(0, 6).map((mention) => (
                    <button
                      key={mention.id}
                      className="thread-chip"
                      onClick={() => onOpenSource(mention.recording_id, mention.start_sec)}
                      title={mention.recording_title ?? "Aufnahme öffnen"}
                    >
                      <span className="topic-dot" style={{ background: mention.topic_color ?? "var(--accent)" }} />
                      <span>{mention.recording_created_at ? fmtDate(mention.recording_created_at) : "Datum offen"}</span>
                      {mention.start_sec != null && <code>{fmtDuration(mention.start_sec)}</code>}
                    </button>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

function taskPriority(item: ActionItem): number {
  if (item.attention_flags.includes("overdue")) return 0;
  if (item.due_date) return 1;
  if (item.attention_flags.includes("needs_review")) return 2;
  return 3;
}

export function TodayItem({
  item,
  onOpenSource,
  onOpenMemoryItem,
  onComplete,
  completing,
}: {
  item: ActionItem;
  onOpenSource: (recordingId: number, startSec?: number | null) => void;
  onOpenMemoryItem: (item: ActionItem) => void;
  onComplete: (item: ActionItem) => void;
  completing: boolean;
}) {
  const overdue = item.attention_flags.includes("overdue");
  const kind = timelineKind(item);
  const kindLabel = kind === "commitment" ? "Zusage" : kind === "decision" ? "Entscheidung" : "Aufgabe";
  const destination = memorySectionForActionItem(item);
  const destinationLabel = destination === "radar" ? "Radar öffnen" : destination === "ledger" ? "Ledger öffnen" : "Aufgaben öffnen";
  const completionLabel = kind === "commitment" ? "Zusage als fertig markieren" : "Aufgabe als erledigt markieren";
  return (
    <article className={`start-today-item ${overdue ? "overdue" : ""}`}>
      <div className="start-today-item-head">
        <span>{overdue ? `${kindLabel} · überfällig` : kindLabel}</span>
        {item.due_date && <time>{fmtDate(item.due_date)}</time>}
      </div>
      <strong>{item.text}</strong>
      <EvidenceTrail
        recordingId={item.recording_id}
        recordingTitle={item.recording_title}
        startSec={item.source_start_sec}
        topicName={item.topic_name}
        topicColor={item.topic_color}
        compact
        missing={item.attention_flags.includes("missing_source")}
        onOpenRecording={onOpenSource}
      />
      <div className="start-today-item-actions">
        <button
          type="button"
          className="start-item-complete"
          disabled={completing}
          aria-label={`${completionLabel}: ${item.text}`}
          onClick={() => onComplete(item)}
        >
          <span className="start-complete-mark" aria-hidden="true" />
          {completing ? "Speichert…" : kind === "commitment" ? "Fertig" : "Erledigen"}
        </button>
        <button
          type="button"
          className="start-item-memory"
          aria-label={`${kindLabel} im Gedächtnis öffnen: ${item.text}`}
          onClick={() => onOpenMemoryItem(item)}
        >
          <MemoryIcon width={13} height={13} />
          {destinationLabel}
        </button>
      </div>
    </article>
  );
}

function RecentRecording({
  recording,
  topic,
  onOpenSource,
}: {
  recording: Recording;
  topic: Topic | undefined;
  onOpenSource: (recordingId: number, startSec?: number | null) => void;
}) {
  const processing = ["queued", "transcribing", "diarizing"].includes(recording.status);
  return (
    <button type="button" className="start-recent-recording" onClick={() => onOpenSource(recording.id)}>
      <span className="start-recent-wave" style={{ "--recent-color": topic?.color || "var(--accent)" } as CSSProperties} aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
        <span />
      </span>
      <span className="start-recent-copy">
        <span>{processing ? "In Verarbeitung" : "Zuletzt aufgenommen"}</span>
        <strong>{recording.title}</strong>
        <small>{topic?.name || "Themenbereich"} · {fmtDate(recording.created_at)}</small>
      </span>
      <code>{fmtDuration(recording.duration_sec)}</code>
    </button>
  );
}

export function StartPage({
  topics,
  onOpenSource,
  onOpenMemoryItem,
  onOpenDocument,
  dictation,
  dictationShortcutLabel,
}: {
  topics: Topic[];
  onOpenSource: (recordingId: number, startSec?: number | null) => void;
  onOpenMemoryItem: (item: ActionItem) => void;
  onOpenDocument: (documentId: number) => void;
  dictation: DictationController;
  dictationShortcutLabel: string;
}) {
  const recordingCount = topics.reduce((sum, topic) => sum + topic.recording_count, 0);
  const transcribedCount = topics.reduce((sum, topic) => sum + topic.transcribed_count, 0);
  const [captureTopicId, setCaptureTopicId] = useState<number | null>(null);
  const captureTopic = topics.find((topic) => topic.id === captureTopicId) ?? topics[0];
  const { data: actionItems } = useActionItems({ done: false });
  const { data: recordings } = useAllRecordings();
  const updateActionItem = useUpdateActionItem();
  const toast = useToast();
  const openTasks = (actionItems ?? []).filter((item) => item.kind === "task" && !item.done);
  const personalTasks = openTasks.filter((item) => item.is_mine || item.include_in_tasks);
  const todayItems = (personalTasks.length ? personalTasks : openTasks)
    .slice()
    .sort((a, b) => taskPriority(a) - taskPriority(b) || (a.due_date ?? "9").localeCompare(b.due_date ?? "9"))
    .slice(0, 3);
  const recentRecording = recordings?.[0];
  const processingCount = (recordings ?? []).filter((recording) =>
    ["queued", "transcribing", "diarizing"].includes(recording.status),
  ).length;

  function completeTodayItem(item: ActionItem) {
    const label = timelineKind(item) === "commitment" ? "Zusage" : "Aufgabe";
    updateActionItem.mutate(
      { id: item.id, patch: { done: true } },
      {
        onSuccess: () => toast(`${label} abgeschlossen.`, "success"),
        onError: (completionError) =>
          toast(`${label} konnte nicht abgeschlossen werden: ${(completionError as Error).message}`, "error"),
      },
    );
  }

  return (
    <div className="page-shell start-page">
      <header className="start-focus">
        <div className="start-focus-copy">
          <h2>Heute</h2>
          <p>Aufnahme starten, offene Aufgaben abschließen oder zur belegenden Stelle zurückkehren.</p>
          <div className="start-focus-stats" aria-label="Arbeitsstand">
            <span><strong>{recordingCount}</strong> Aufnahmen</span>
            <span><strong>{transcribedCount}</strong> transkribiert</span>
            <span><strong>{todayItems.length}</strong> im Fokus</span>
            {processingCount > 0 && <span className="active"><strong>{processingCount}</strong> in Verarbeitung</span>}
          </div>
        </div>
        <div className="start-capture-dock">
          <div className="start-capture-record">
            <div>
              <WaveIcon width={18} height={18} />
              <span><strong>Neue Aufnahme</strong><small>{captureTopic?.name || "Themenbereich wählen"}</small></span>
            </div>
            <div>
              {captureTopic && topics.length > 1 && (
                <select
                  aria-label="Themenbereich für neue Aufnahme"
                  value={captureTopic.id}
                  onChange={(event) => setCaptureTopicId(Number(event.target.value))}
                >
                  {topics.map((topic) => <option key={topic.id} value={topic.id}>{topic.name}</option>)}
                </select>
              )}
              {captureTopic && <RecordControl topicId={captureTopic.id} topicName={captureTopic.name} primary />}
            </div>
          </div>
          <DictationPanel dictation={dictation} shortcutLabel={dictationShortcutLabel} />
        </div>
      </header>

      <div className="start-workspace">
        <div className="start-today-column">
          <section className="start-today" aria-labelledby="start-today-title">
            <div className="start-section-head">
              <div>
                <span className="page-kicker">Nächste Schritte</span>
                <h3 id="start-today-title">Heute im Blick</h3>
              </div>
              <TasksIcon width={18} height={18} />
            </div>
            <div className="start-today-list">
              {todayItems.length > 0 ? todayItems.map((item) => (
                <TodayItem
                  key={item.id}
                  item={item}
                  onOpenSource={onOpenSource}
                  onOpenMemoryItem={onOpenMemoryItem}
                  onComplete={completeTodayItem}
                  completing={updateActionItem.isPending && updateActionItem.variables?.id === item.id}
                />
              )) : (
                <div className="start-today-note">Keine offenen Aufgaben oder Zusagen in deiner aktuellen Auswahl.</div>
              )}
            </div>
          </section>

          <section className="start-recent" aria-labelledby="start-recent-title">
            <div className="start-section-head compact">
              <div>
                <span className="page-kicker">Wiedereinstieg</span>
                <h3 id="start-recent-title">Zuletzt</h3>
              </div>
              <ActivityIcon width={17} height={17} />
            </div>
            {recentRecording ? (
              <RecentRecording
                recording={recentRecording}
                topic={topics.find((topic) => topic.id === recentRecording.topic_id)}
                onOpenSource={onOpenSource}
              />
            ) : (
              <div className="start-today-note">Noch keine Aufnahme vorhanden.</div>
            )}
          </section>
        </div>

        <section className="start-knowledge work-surface" aria-label="Suche und Wissens-Chat">
          <div className="start-knowledge-head">
            <div>
              <span className="page-kicker">Wissensraum</span>
              <h3>Im Archiv weiterdenken</h3>
            </div>
            <MemoryIcon width={18} height={18} />
          </div>
          <ChatPanel topics={topics} onOpenSource={onOpenSource} onOpenDocument={onOpenDocument} />
        </section>
      </div>

      <div className="start-insights">
        <DigestPanel />
        <ThreadsPanel onOpenSource={onOpenSource} />
      </div>
    </div>
  );
}
