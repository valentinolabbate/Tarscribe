import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useDeleteActionItem,
  useMemoryEnrichmentStatus,
  useProjectMemory,
  useRetryMemoryEnrichment,
  useStartMemoryEnrichment,
  useUpdateActionItem,
} from "../hooks/queries";
import { useUndoableDelete } from "../hooks/useUndoableDelete";
import { fmtDate, fmtDuration } from "../lib/format";
import type { ActionItem, Topic } from "../lib/types";
import {
  ActivityIcon,
  LinkIcon,
  MemoryIcon,
  RefreshIcon,
  SearchIcon,
  SpeakerIdIcon,
  TasksIcon,
  TrashIcon,
} from "./icons";
import { needsEvidenceReview } from "./memory/model";

type MemoryView = "radar" | "ledger" | "archive";
type RadarFilter = "attention" | "evidence" | "overdue" | "soon" | "undated" | "all";
type MemoryPatch = Partial<
  Pick<
    ActionItem,
    | "done"
    | "text"
    | "assignee"
    | "recipient"
    | "due"
    | "due_date"
    | "review_state"
    | "decision_status"
    | "superseded_by_id"
  >
>;

const decisionLabels: Record<ActionItem["decision_status"], string> = {
  proposed: "Vorgeschlagen",
  current: "Gültig",
  superseded: "Ersetzt",
  rejected: "Verworfen",
};

function priority(item: ActionItem): number {
  if (needsEvidenceReview(item)) return 0;
  if (item.attention_flags.includes("overdue")) return 1;
  if (item.attention_flags.includes("needs_review")) return 2;
  if (item.attention_flags.includes("due_soon")) return 3;
  if (item.attention_flags.includes("missing_owner")) return 4;
  if (item.attention_flags.includes("missing_due")) return 5;
  return 6;
}

function attentionLabel(item: ActionItem): string {
  if (needsEvidenceReview(item)) return "Ohne Beleg";
  if (item.attention_flags.includes("overdue")) return "Überfällig";
  if (item.attention_flags.includes("needs_review")) return "Bitte prüfen";
  if (item.attention_flags.includes("due_soon")) return "Bald fällig";
  if (item.attention_flags.includes("missing_owner")) return "Verantwortung offen";
  if (item.attention_flags.includes("missing_due")) return "Ohne Frist";
  return item.done ? "Erledigt" : "Im Blick";
}

function SourceTrace({
  item,
  onOpenRecording,
}: {
  item: ActionItem;
  onOpenRecording: (recordingId: number, startSec?: number | null) => void;
}) {
  if (item.attention_flags.includes("missing_source")) {
    return (
      <div className="memory-source missing">
        <span className="memory-source-pin">
          <LinkIcon width={12} height={12} />
        </span>
        <span className="memory-source-copy">
          <strong>Keine vollständige Belegspur gefunden</strong>
          <em>Zitat oder Zeitmarke fehlt. Prüfe die Aufgabe und korrigiere oder lösche sie.</em>
        </span>
      </div>
    );
  }
  return (
    <button
      type="button"
      className="memory-source"
      onClick={() => onOpenRecording(item.recording_id, item.source_start_sec)}
      title="Belegende Aufnahme öffnen"
    >
      <span className="memory-source-pin">
        <LinkIcon width={12} height={12} />
      </span>
      <span className="memory-source-copy">
        <span>
          {item.source_start_sec != null ? fmtDuration(item.source_start_sec) : "Aufnahme"}
          {item.recording_title ? ` · ${item.recording_title}` : ""}
        </span>
        {item.source_quote ? <q>{item.source_quote}</q> : <em>Belegstelle noch nicht gespeichert</em>}
      </span>
    </button>
  );
}

function ReviewControls({
  item,
  onUpdate,
}: {
  item: ActionItem;
  onUpdate: (id: number, patch: MemoryPatch) => void;
}) {
  if (item.review_state === "confirmed") {
    return <span className="memory-reviewed">Geprüft · {Math.round(item.confidence * 100)} %</span>;
  }
  return (
    <div className="memory-review-actions">
      <button
        type="button"
        className="btn primary compact"
        onClick={() => onUpdate(item.id, { review_state: "confirmed" })}
      >
        Bestätigen
      </button>
      <button
        type="button"
        className="btn ghost compact"
        onClick={() => onUpdate(item.id, { review_state: "rejected" })}
      >
        Verwerfen
      </button>
    </div>
  );
}

function MemoryEditor({
  item,
  onUpdate,
  onClose,
}: {
  item: ActionItem;
  onUpdate: (id: number, patch: MemoryPatch) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(item.text);
  const [assignee, setAssignee] = useState(item.assignee ?? "");
  const [recipient, setRecipient] = useState(item.recipient ?? "");
  const [due, setDue] = useState(item.due ?? "");
  const [dueDate, setDueDate] = useState(item.due_date ?? "");

  return (
    <form
      className="memory-editor"
      onSubmit={(event) => {
        event.preventDefault();
        if (!text.trim()) return;
        onUpdate(item.id, {
          text: text.trim(),
          assignee: assignee.trim() || null,
          recipient: recipient.trim() || null,
          due: due.trim() || null,
          due_date: dueDate || null,
        });
        onClose();
      }}
    >
      <label className="memory-editor-wide">
        <span>{item.kind === "decision" ? "Entscheidung" : "Zusage"}</span>
        <input value={text} onChange={(event) => setText(event.target.value)} autoFocus />
      </label>
      {item.kind === "task" && (
        <>
          <label>
            <span>Verantwortlich</span>
            <input value={assignee} onChange={(event) => setAssignee(event.target.value)} />
          </label>
          <label>
            <span>Für wen</span>
            <input value={recipient} onChange={(event) => setRecipient(event.target.value)} />
          </label>
          <label>
            <span>Frist im Wortlaut</span>
            <input value={due} onChange={(event) => setDue(event.target.value)} />
          </label>
          <label>
            <span>Datum</span>
            <input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
          </label>
        </>
      )}
      <div className="memory-editor-actions">
        <button type="button" className="btn ghost compact" onClick={onClose}>Abbrechen</button>
        <button type="submit" className="btn primary compact" disabled={!text.trim()}>Speichern</button>
      </div>
    </form>
  );
}

function CommitmentCard({
  item,
  onUpdate,
  onDelete,
  onOpenRecording,
}: {
  item: ActionItem;
  onUpdate: (id: number, patch: MemoryPatch) => void;
  onDelete: (item: ActionItem) => void;
  onOpenRecording: (recordingId: number, startSec?: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const evidenceMissing = needsEvidenceReview(item);
  const tone = evidenceMissing
    ? "evidence"
    : item.attention_flags.includes("overdue")
    ? "urgent"
    : item.review_state === "pending"
      ? "review"
      : item.done
        ? "done"
        : "steady";

  return (
    <article className={`memory-commitment ${tone}`}>
      <div className="memory-card-marker" aria-hidden="true" />
      <div className="memory-card-main">
        <div className="memory-card-head">
          <span className="memory-attention-label">{attentionLabel(item)}</span>
          <div className="memory-card-context">
            {item.topic_name && <span>{item.topic_name}</span>}
            {item.due_date && <time>{fmtDate(item.due_date)}</time>}
          </div>
        </div>
        {editing ? (
          <MemoryEditor item={item} onUpdate={onUpdate} onClose={() => setEditing(false)} />
        ) : (
          <>
            <h3>{item.text}</h3>
            <div className="memory-commitment-meta">
              <span><strong>{item.assignee || "Noch niemand"}</strong> verantwortlich</span>
              {item.recipient && <span>für {item.recipient}</span>}
              {!item.due_date && item.due && <span>{item.due}</span>}
            </div>
            <SourceTrace item={item} onOpenRecording={onOpenRecording} />
            <div className="memory-card-actions">
              {!evidenceMissing && <ReviewControls item={item} onUpdate={onUpdate} />}
              <button type="button" className="btn ghost compact" onClick={() => setEditing(true)}>
                Bearbeiten
              </button>
              {evidenceMissing ? (
                <button type="button" className="btn ghost danger compact" onClick={() => onDelete(item)}>
                  <TrashIcon width={12} height={12} /> Löschen
                </button>
              ) : (
                <button
                  type="button"
                  className="btn ghost compact"
                  onClick={() => onUpdate(item.id, { done: !item.done })}
                >
                  {item.done ? "Wieder öffnen" : "Erledigt"}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </article>
  );
}

function DecisionCard({
  item,
  decisions,
  onUpdate,
  onOpenRecording,
}: {
  item: ActionItem;
  decisions: ActionItem[];
  onUpdate: (id: number, patch: MemoryPatch) => void;
  onOpenRecording: (recordingId: number, startSec?: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const successor = decisions.find((candidate) => candidate.id === item.superseded_by_id);
  const candidates = decisions.filter(
    (candidate) => candidate.id !== item.id && candidate.decision_status === "current",
  );

  return (
    <article className={`memory-decision ${item.decision_status}`}>
      <div className="memory-ledger-node" aria-hidden="true" />
      <div className="memory-decision-card">
        <div className="memory-card-head">
          <span className={`memory-decision-status ${item.decision_status}`}>
            {decisionLabels[item.decision_status]}
          </span>
          <time>{fmtDate(item.recording_created_at ?? item.created_at)}</time>
        </div>
        {editing ? (
          <MemoryEditor item={item} onUpdate={onUpdate} onClose={() => setEditing(false)} />
        ) : (
          <>
            <h3>{item.text}</h3>
            {successor && <p className="memory-successor">Ersetzt durch: {successor.text}</p>}
            <SourceTrace item={item} onOpenRecording={onOpenRecording} />
            <div className="memory-decision-controls">
              <ReviewControls item={item} onUpdate={onUpdate} />
              <button type="button" className="btn ghost compact" onClick={() => setEditing(true)}>
                Bearbeiten
              </button>
              <label>
                <span>Status</span>
                <select
                  value={item.decision_status}
                  onChange={(event) =>
                    onUpdate(item.id, {
                      decision_status: event.target.value as ActionItem["decision_status"],
                      superseded_by_id: event.target.value === "superseded" ? item.superseded_by_id : null,
                    })
                  }
                >
                  <option value="proposed">Vorgeschlagen</option>
                  <option value="current">Gültig</option>
                  <option value="superseded">Ersetzt</option>
                  <option value="rejected">Verworfen</option>
                </select>
              </label>
              {candidates.length > 0 && (
                <label className="memory-successor-select">
                  <span>Ersetzt durch</span>
                  <select
                    value={item.superseded_by_id ?? ""}
                    onChange={(event) =>
                      onUpdate(item.id, {
                        superseded_by_id: event.target.value ? Number(event.target.value) : null,
                        decision_status: event.target.value ? "superseded" : item.decision_status,
                      })
                    }
                  >
                    <option value="">Nicht verknüpft</option>
                    {candidates.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>{candidate.text}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          </>
        )}
      </div>
    </article>
  );
}

function MemoryEnrichmentPanel() {
  const queryClient = useQueryClient();
  const { data: status, isLoading } = useMemoryEnrichmentStatus();
  const start = useStartMemoryEnrichment();
  const retry = useRetryMemoryEnrichment();
  const run = status?.latest_run;
  const active = run?.status === "pending" || run?.status === "running";
  const terminal = run?.status === "done" || run?.status === "partial" || run?.status === "failed";

  useEffect(() => {
    if (terminal) queryClient.invalidateQueries({ queryKey: ["project-memory"] });
  }, [queryClient, run?.id, terminal]);

  if (isLoading || !status) return null;
  if (!status.restartable_items && !active && !run) return null;

  if (active && run) {
    const percent = Math.round(Math.max(0, Math.min(1, run.progress)) * 100);
    return (
      <section className="memory-enrichment running" aria-live="polite">
        <div className="memory-enrichment-icon"><RefreshIcon width={20} height={20} /></div>
        <div className="memory-enrichment-copy">
          <span className="page-kicker">Altbestand wird angereichert</span>
          <h3>{run.processed_recordings} von {run.total_recordings} Aufnahmen geprüft</h3>
          <p>Belegstellen werden ergänzt. Texte, Fristen und Fortschritt bleiben unverändert.</p>
          <div className="memory-enrichment-progress" aria-label={`${percent} Prozent abgeschlossen`}>
            <span style={{ width: `${percent}%` }} />
          </div>
        </div>
        <div className="memory-enrichment-result">
          <strong>{percent} %</strong>
          <span>{run.enriched_items} Belege ergänzt</span>
        </div>
      </section>
    );
  }

  if (status.restartable_items > 0) {
    const isRestart = status.retryable_items > 0;
    const action = isRestart ? retry : start;
    return (
      <section className="memory-enrichment ready">
        <div className="memory-enrichment-icon"><MemoryIcon width={21} height={21} /></div>
        <div className="memory-enrichment-copy">
          <span className="page-kicker">{isRestart ? "Altbestand erneut prüfen" : "Altbestand integrieren"}</span>
          <h3>
            {status.restartable_items} {status.restartable_items === 1 ? "bestehender Eintrag braucht" : "bestehende Einträge brauchen"} eine Belegspur
          </h3>
          <p>
            {isRestart
              ? "Der Neustart prüft nur weiterhin unbelegte Einträge. Bereits gefundene Belege und jeder Aufgabenfortschritt bleiben erhalten."
              : "Ein spezieller Abgleich ergänzt nur Zitat, Zeitmarke und Empfänger. Erledigt-Status, Text, Frist und manuelle Änderungen bleiben erhalten."}
          </p>
          {run?.status === "failed" && <span className="memory-enrichment-error">{run.error || "Der letzte Lauf ist fehlgeschlagen."}</span>}
        </div>
        <div className="memory-enrichment-cta">
          <span>{status.restartable_recordings} {status.restartable_recordings === 1 ? "Aufnahme" : "Aufnahmen"}</span>
          <button className="btn primary" disabled={action.isPending} onClick={() => action.mutate()}>
            {action.isPending ? "Wird vorbereitet…" : isRestart ? "Erneut starten" : "Jetzt anreichern"}
          </button>
        </div>
      </section>
    );
  }

  if (run && terminal) {
    return (
      <section className={`memory-enrichment complete ${run.status}`}>
        <div className="memory-enrichment-icon"><TasksIcon width={20} height={20} /></div>
        <div className="memory-enrichment-copy">
          <span className="page-kicker">Altbestand integriert</span>
          <h3>{run.enriched_items} Belegspuren ergänzt</h3>
          <p>
            {run.unmatched_items > 0
              ? `${run.unmatched_items} Einträge blieben unverändert, weil kein eindeutiger Beleg gefunden wurde.`
              : "Alle geeigneten Einträge wurden geprüft, ohne ihren Fortschritt zu verändern."}
          </p>
        </div>
        <div className="memory-enrichment-result">
          <strong>{run.total_items}</strong>
          <span>Einträge geprüft</span>
        </div>
      </section>
    );
  }

  return null;
}

export function MemoryPage({
  topics,
  onOpenRecording,
}: {
  topics: Topic[];
  onOpenRecording: (recordingId: number, startSec?: number | null) => void;
}) {
  const { data: memory, isLoading, isError, error } = useProjectMemory();
  const update = useUpdateActionItem();
  const remove = useDeleteActionItem();
  const { isPending: isDeletePending, schedule: scheduleDelete } = useUndoableDelete();
  const [view, setView] = useState<MemoryView>("radar");
  const [radarFilter, setRadarFilter] = useState<RadarFilter>("attention");
  const [topicId, setTopicId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [involvementOnly, setInvolvementOnly] = useState(true);

  const updateItem = (id: number, patch: MemoryPatch) => update.mutate({ id, patch });
  const deleteItem = (item: ActionItem) => {
    scheduleDelete(item.id, () => remove.mutate(item.id), "Aufgabe gelöscht");
  };
  const normalizedSearch = search.trim().toLocaleLowerCase("de-DE");
  const topicMatches = (item: ActionItem) => topicId == null || item.topic_id === topicId;
  const involvementMatches = (item: ActionItem) => !involvementOnly || item.is_involved;
  const searchMatches = (item: ActionItem) =>
    !normalizedSearch ||
    [item.text, item.assignee, item.recipient, item.topic_name, item.source_quote]
      .filter(Boolean)
      .some((value) => value!.toLocaleLowerCase("de-DE").includes(normalizedSearch));
  const unsupportedCount = (memory?.commitments ?? [])
    .filter((item) => !isDeletePending(item.id))
    .filter(topicMatches)
    .filter(involvementMatches)
    .filter(searchMatches)
    .filter(needsEvidenceReview)
    .length;

  const commitments = useMemo(() => {
    const items = (memory?.commitments ?? [])
      .filter((item) => !isDeletePending(item.id))
      .filter(topicMatches)
      .filter(involvementMatches)
      .filter(searchMatches)
      .filter((item) => {
        if (radarFilter === "all") return true;
        if (radarFilter === "evidence") return needsEvidenceReview(item);
        if (radarFilter === "overdue") return item.attention_flags.includes("overdue");
        if (radarFilter === "soon") return item.attention_flags.includes("due_soon");
        if (radarFilter === "undated") return item.attention_flags.includes("missing_due");
        return (
          needsEvidenceReview(item) ||
          (!item.done &&
            item.attention_flags.some((flag) =>
              ["overdue", "due_soon", "needs_review", "low_confidence", "missing_owner"].includes(
                flag,
              ),
            ))
        );
      });
    return items.sort((a, b) => priority(a) - priority(b) || (a.due_date ?? "9").localeCompare(b.due_date ?? "9"));
  }, [involvementOnly, isDeletePending, memory, normalizedSearch, radarFilter, topicId]);

  const decisions = useMemo(
    () => (memory?.decisions ?? [])
      .filter(topicMatches)
      .filter(involvementMatches)
      .filter(searchMatches)
      .sort((a, b) =>
        (b.recording_created_at ?? b.created_at).localeCompare(a.recording_created_at ?? a.created_at),
      ),
    [involvementOnly, memory, normalizedSearch, topicId],
  );

  const archived = useMemo(
    () => (memory?.rejected ?? [])
      .filter(topicMatches)
      .filter(involvementMatches)
      .filter(searchMatches),
    [involvementOnly, memory, normalizedSearch, topicId],
  );

  if (isLoading) return <div className="memory-empty">Projektgedächtnis wird aufgebaut…</div>;
  if (isError || !memory) {
    return (
      <div className="memory-empty" role="alert">
        <MemoryIcon width={30} height={30} />
        <strong>Projektgedächtnis konnte nicht geladen werden</strong>
        <span>{error instanceof Error ? error.message : "Versuche es später erneut."}</span>
      </div>
    );
  }

  return (
    <div className="memory-page">
      <header className="memory-header">
        <div>
          <span className="page-kicker">Projektgedächtnis</span>
          <h2>Was gilt. Was offen bleibt.</h2>
          <p>Zusagen und Entscheidungen mit einer direkten Spur zurück zum Gespräch.</p>
        </div>
        <div className="memory-pulse" aria-label={`${memory.stats.attention_count} Einträge brauchen Aufmerksamkeit`}>
          <span className="memory-pulse-ring" aria-hidden="true" />
          <strong>{memory.stats.attention_count}</strong>
          <span>brauchen<br />Aufmerksamkeit</span>
        </div>
      </header>

      <MemoryEnrichmentPanel />

      <div className="memory-status-line" aria-label="Gedächtnisstatus">
        <div className={memory.stats.overdue_commitments ? "urgent" : ""}>
          <strong>{memory.stats.overdue_commitments}</strong><span>überfällig</span>
        </div>
        <div><strong>{memory.stats.needs_review}</strong><span>zu prüfen</span></div>
        <div className={unsupportedCount ? "evidence" : ""}>
          <strong>{unsupportedCount}</strong><span>ohne Beleg</span>
        </div>
        <div><strong>{memory.stats.open_commitments}</strong><span>offene Zusagen</span></div>
        <div><strong>{memory.stats.current_decisions}</strong><span>gültige Beschlüsse</span></div>
        <div><strong>{memory.stats.superseded_decisions}</strong><span>ersetzte Beschlüsse</span></div>
      </div>

      <div className="memory-view-tabs" role="tablist" aria-label="Gedächtnisansicht">
        <button role="tab" aria-selected={view === "radar"} className={view === "radar" ? "active" : ""} onClick={() => setView("radar")}>
          <ActivityIcon width={15} height={15} /> Commitment Radar
        </button>
        <button role="tab" aria-selected={view === "ledger"} className={view === "ledger" ? "active" : ""} onClick={() => setView("ledger")}>
          <MemoryIcon width={15} height={15} /> Decision Ledger
        </button>
        <button role="tab" aria-selected={view === "archive"} className={view === "archive" ? "active" : ""} onClick={() => setView("archive")}>
          Archiv <span>{memory.rejected.length}</span>
        </button>
      </div>

      <section className="memory-toolbar" aria-label="Gedächtnis filtern">
        <label className="memory-search">
          <SearchIcon width={14} height={14} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Zusagen und Entscheidungen durchsuchen" />
        </label>
        <button
          type="button"
          className={`memory-involvement-filter ${involvementOnly ? "active" : ""}`}
          aria-pressed={involvementOnly}
          onClick={() => setInvolvementOnly((value) => !value)}
        >
          <SpeakerIdIcon width={15} height={15} /> Eigene Involvierung
        </button>
        <label>
          <span>Bereich</span>
          <select value={topicId ?? ""} onChange={(event) => setTopicId(event.target.value ? Number(event.target.value) : null)}>
            <option value="">Alle Themenbereiche</option>
            {topics.map((topic) => <option key={topic.id} value={topic.id}>{topic.name}</option>)}
          </select>
        </label>
      </section>

      {view === "radar" && (
        <section className="memory-radar-view">
          <div className="memory-radar-filters" aria-label="Radar eingrenzen">
            {([
              ["attention", "Im Fokus"],
              ["evidence", "Ohne Beleg"],
              ["overdue", "Überfällig"],
              ["soon", "Bald fällig"],
              ["undated", "Ohne Frist"],
              ["all", "Alle"],
            ] as Array<[RadarFilter, string]>).map(([id, label]) => (
              <button key={id} className={radarFilter === id ? "active" : ""} onClick={() => setRadarFilter(id)}>
                {label}
                {id === "evidence" && unsupportedCount > 0 && (
                  <span>{unsupportedCount}</span>
                )}
              </button>
            ))}
          </div>
          <div className="memory-section-head">
            <div>
              <span className="page-kicker">
                {radarFilter === "evidence" ? "Belegprüfung" : "Aufmerksamkeit"}
              </span>
              <h3>
                {commitments.length}{" "}
                {radarFilter === "evidence"
                  ? commitments.length === 1
                    ? "unbelegte Aufgabe"
                    : "unbelegte Aufgaben"
                  : commitments.length === 1
                    ? "Zusage"
                    : "Zusagen"}
              </h3>
            </div>
            <span>{radarFilter === "evidence" ? "Bearbeiten oder löschen" : "Dringendes zuerst"}</span>
          </div>
          {commitments.length ? (
            <div className="memory-commitment-list">
              {commitments.map((item) => (
                <CommitmentCard
                  key={item.id}
                  item={item}
                  onUpdate={updateItem}
                  onDelete={deleteItem}
                  onOpenRecording={onOpenRecording}
                />
              ))}
            </div>
          ) : (
            <div className="memory-empty compact"><TasksIcon width={24} height={24} /><strong>Nichts in dieser Auswahl</strong><span>Der Radar meldet hier gerade keinen Handlungsbedarf.</span></div>
          )}
        </section>
      )}

      {view === "ledger" && (
        <section className="memory-ledger-view">
          <div className="memory-section-head">
            <div><span className="page-kicker">Chronik</span><h3>{decisions.length} {decisions.length === 1 ? "Entscheidung" : "Entscheidungen"}</h3></div>
            <span>Neueste zuerst</span>
          </div>
          {decisions.length ? (
            <div className="memory-ledger-line">
              {decisions.map((item) => (
                <DecisionCard key={item.id} item={item} decisions={memory.decisions} onUpdate={updateItem} onOpenRecording={onOpenRecording} />
              ))}
            </div>
          ) : (
            <div className="memory-empty compact"><MemoryIcon width={24} height={24} /><strong>Noch keine Entscheidungen</strong><span>Bestätigte Beschlüsse erscheinen hier mit ihrer Belegspur.</span></div>
          )}
        </section>
      )}

      {view === "archive" && (
        <section className="memory-archive-view">
          <div className="memory-section-head"><div><span className="page-kicker">Ausgeblendet</span><h3>{archived.length} verworfene Einträge</h3></div></div>
          {archived.length ? archived.map((item) => (
            <article className="memory-archive-item" key={item.id}>
              <div><span>{item.kind === "decision" ? "Entscheidung" : "Zusage"}</span><strong>{item.text}</strong></div>
              <button className="btn ghost compact" onClick={() => updateItem(item.id, { review_state: "pending" })}>Erneut prüfen</button>
            </article>
          )) : <div className="memory-empty compact"><strong>Archiv ist leer</strong><span>Verworfene Erkennungen können hier wiederhergestellt werden.</span></div>}
        </section>
      )}
    </div>
  );
}
