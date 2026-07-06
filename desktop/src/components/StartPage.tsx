import ReactMarkdown from "react-markdown";
import { useState } from "react";
import { ChatPanel } from "./ChatPanel";
import { DictationPanel } from "./DictationPanel";
import { RecordControl } from "./RecordControl";
import {
  useCreateDigest,
  useDigests,
  useRebuildThreads,
  useSendDigestToFolder,
  useThreads,
} from "../hooks/queries";
import type { DictationController } from "../hooks/useDictation";
import { fmtDate, fmtDuration } from "../lib/format";
import type { Digest, Topic, TopicThread } from "../lib/types";
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
      toast(`${res.threads} Threads aus ${res.mentions} Erwähnungen erkannt.`, "success");
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
          {rebuild.isPending ? "Aktualisiere..." : "Aktualisieren"}
        </button>
      </div>
      {isLoading && <div className="start-card-note">Wird geladen…</div>}
      {!isLoading && visible.length === 0 && (
        <div className="start-card-note">Verbindungen zwischen deinen Aufnahmen.</div>
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

/**
 * Landing page: semantic search over all recordings (no LLM required) plus a
 * message bar to start a knowledge chat. The underlying panel toggles between
 * "Suche" and "Chat"; it defaults to search so it is useful without a chat LLM.
 */
export function StartPage({
  topics,
  onOpenSource,
  dictation,
  dictationShortcutLabel,
}: {
  topics: Topic[];
  onOpenSource: (recordingId: number, startSec?: number | null) => void;
  dictation: DictationController;
  dictationShortcutLabel: string;
}) {
  const recordingCount = topics.reduce((sum, topic) => sum + topic.recording_count, 0);
  const transcribedCount = topics.reduce((sum, topic) => sum + topic.transcribed_count, 0);
  const diarizedCount = topics.reduce((sum, topic) => sum + topic.diarized_count, 0);
  const [captureTopicId, setCaptureTopicId] = useState<number | null>(null);
  const captureTopic = topics.find((topic) => topic.id === captureTopicId) ?? topics[0];

  return (
    <div className="start-page">
      <header className="start-overview">
        <div className="start-overview-stats">
          {recordingCount === 0 ? (
            <strong>Noch keine Aufnahmen</strong>
          ) : (
            <>
              <strong>{recordingCount} Aufnahmen</strong>
              <span>{transcribedCount} transkribiert</span>
              {diarizedCount > 0 && <span>{diarizedCount} mit Sprechererkennung</span>}
            </>
          )}
        </div>
        <div className="start-quick-record">
          {captureTopic && (
            <>
              {topics.length > 1 && (
                <select
                  aria-label="Themenbereich für neue Aufnahme"
                  value={captureTopic.id}
                  onChange={(event) => setCaptureTopicId(Number(event.target.value))}
                >
                  {topics.map((topic) => (
                    <option key={topic.id} value={topic.id}>{topic.name}</option>
                  ))}
                </select>
              )}
              <RecordControl topicId={captureTopic.id} topicName={captureTopic.name} primary />
            </>
          )}
        </div>
      </header>

      <div className="start-body">
        <section className="start-primary" aria-label="Suche und Wissens-Chat">
          <ChatPanel topics={topics} onOpenSource={onOpenSource} />
        </section>
        <aside className="start-aside">
          <DictationPanel dictation={dictation} shortcutLabel={dictationShortcutLabel} />
          <DigestPanel />
          <ThreadsPanel onOpenSource={onOpenSource} />
        </aside>
      </div>
    </div>
  );
}
