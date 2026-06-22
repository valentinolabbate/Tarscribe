import ReactMarkdown from "react-markdown";
import { ChatPanel } from "./ChatPanel";
import { DictationPanel } from "./DictationPanel";
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
    <section className="start-card digest-panel" aria-label="Wochen-Digest">
      <div className="start-card-head">
        <div>
          <span className="page-kicker">Deine Woche</span>
          <h3>Wochen-Digest</h3>
          <p>Themen, Entscheidungen und offene Aufgaben deiner Woche.</p>
        </div>
        <div className="start-card-actions">
          {latest && (
            <button
              className="btn ghost"
              onClick={() => navigator.clipboard.writeText(latest.content_markdown)}
            >
              Kopieren
            </button>
          )}
          {latest && (
            <button className="btn ghost" onClick={exportLatest} disabled={sendDigest.isPending}>
              {sendDigest.isPending ? "Exportiere..." : "Exportieren"}
            </button>
          )}
          <button
            className="btn primary"
            disabled={createDigest.isPending}
            onClick={() => createDigest.mutate(7)}
          >
            {createDigest.isPending ? "Erstelle..." : latest ? "Neu erstellen" : "Digest erstellen"}
          </button>
        </div>
      </div>

      {isLoading && <div className="digest-empty">Digests werden geladen...</div>}
      {createDigest.isPending && (
        <div className="digest-empty">Der Digest wird mit deinem konfigurierten Chat-Modell erstellt.</div>
      )}
      {!isLoading && !createDigest.isPending && latest && stale && (
        <div className="digest-reminder">
          {latestAgeDays == null
            ? "Noch kein Wochenrückblick vorhanden."
            : `Letzter Digest vor ${latestAgeDays} Tagen erstellt.`}{" "}
          Ein neuer Rückblick ist fällig.
        </div>
      )}
      {!isLoading && !createDigest.isPending && !latest && (
        <div className="digest-empty empty-next">
          <strong>Nächster Schritt</strong>
          <span>Erstelle einen 7-Tage-Rückblick, sobald Aufnahmen transkribiert sind.</span>
          <button
            className="btn ghost"
            disabled={createDigest.isPending}
            onClick={() => createDigest.mutate(7)}
          >
            Rückblick erstellen
          </button>
        </div>
      )}
      {latest && !createDigest.isPending && (
        <article className="digest-body">
          <div className="digest-meta">
            <span>{range}</span>
            <span>{latest.recording_count} Quellen</span>
            {latest.model && <span>{latest.model}</span>}
          </div>
          <div className="digest-markdown markdown">
            <ReactMarkdown>{latest.content_markdown}</ReactMarkdown>
          </div>
        </article>
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
    <section className="start-card threads-panel" aria-label="Themen-Threads">
      <div className="start-card-head">
        <div>
          <span className="page-kicker">Projektgedächtnis</span>
          <h3>Themen-Threads</h3>
          <p>Verbundene Kapitel über mehrere Aufnahmen hinweg.</p>
        </div>
        <button className="btn ghost" onClick={rebuildThreads} disabled={rebuild.isPending}>
          {rebuild.isPending ? "Aktualisiere..." : "Aktualisieren"}
        </button>
      </div>
      {isLoading && <div className="digest-empty">Threads werden geladen...</div>}
      {!isLoading && visible.length === 0 && (
        <div className="digest-empty empty-next">
          <strong>Nächster Schritt</strong>
          <span>Erzeuge Kapitel in mehreren Aufnahmen und aktualisiere dann das Projektgedächtnis.</span>
          <button className="btn ghost" onClick={rebuildThreads} disabled={rebuild.isPending}>
            {rebuild.isPending ? "Aktualisiere..." : "Threads suchen"}
          </button>
        </div>
      )}
      {visible.length > 0 && (
        <div className="thread-list">
          {visible.map((thread: TopicThread) => (
            <article className="thread-card" key={thread.id}>
              <div className="thread-card-head">
                <strong>{thread.title}</strong>
                <span>
                  {thread.recording_count} Aufnahmen · {thread.mention_count} Erwähnungen
                </span>
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

  return (
    <div className="start-page">
      <header className="start-header">
        <div className="start-header-text">
          <span className="page-kicker">Start</span>
          <h2>Arbeitsbereich</h2>
          <p>Suche in Aufnahmen, frage dein Archiv oder sprich ein Diktat ein.</p>
        </div>
        <div className="start-stats">
          <div className="stat">
            <strong>{recordingCount}</strong>
            <span>Aufnahmen</span>
          </div>
          <div className="stat">
            <strong>{transcribedCount}</strong>
            <span>Transkribiert</span>
          </div>
          <div className="stat">
            <strong>{diarizedCount}</strong>
            <span>Diarisiert</span>
          </div>
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
