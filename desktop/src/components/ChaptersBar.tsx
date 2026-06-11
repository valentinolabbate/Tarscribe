import { useState } from "react";
import { useChapters, useGenerateChapters } from "../hooks/queries";
import { useJobFor } from "../hooks/useJobs";
import { api } from "../lib/api";
import { fmtDuration } from "../lib/format";
import { useToast } from "./Toast";
import { ChaptersIcon } from "./icons";

/** Clickable chapter chips below the player + generate/export controls. */
export function ChaptersBar({
  recordingId,
  recordingTitle,
  durationSec,
  currentTime,
  onSeek,
}: {
  recordingId: number;
  recordingTitle: string;
  durationSec: number;
  currentTime: number;
  onSeek: (sec: number) => void;
}) {
  const { data: chapters } = useChapters(recordingId);
  const generate = useGenerateChapters(recordingId);
  const job = useJobFor(recordingId);
  const toast = useToast();
  const [exportOpen, setExportOpen] = useState(false);

  const generating =
    generate.isPending ||
    (job?.phase === "chapters" && (job.status === "pending" || job.status === "running"));

  async function exportChapters(format: "youtube" | "srt") {
    setExportOpen(false);
    try {
      await api.downloadChapters(recordingId, format, recordingTitle);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }

  if (!chapters || chapters.length === 0) {
    return (
      <div className="chapters-bar empty">
        <ChaptersIcon width={15} height={15} />
        <span>Kapitel gliedern lange Aufnahmen nach Themen.</span>
        <button className="btn ghost" disabled={generating} onClick={() => generate.mutate()}>
          {generating ? "Erkenne Kapitel…" : "Kapitel erkennen"}
        </button>
        {job?.phase === "chapters" && job.status === "failed" && (
          <span className="chapters-error">{job.error}</span>
        )}
      </div>
    );
  }

  const active =
    [...chapters].reverse().find((c) => currentTime >= c.start) ?? chapters[0];

  return (
    <div className="chapters-bar">
      <div className="chapters-chips">
        {chapters.map((c) => (
          <button
            key={c.id}
            className={`chapter-chip ${c.id === active.id ? "active" : ""}`}
            onClick={() => onSeek(c.start)}
            title={`${fmtDuration(c.start)}${c.end != null ? `–${fmtDuration(c.end)}` : ""}`}
          >
            <span className="chapter-time">{fmtDuration(c.start)}</span>
            {c.title}
          </button>
        ))}
      </div>
      <div className="chapters-actions">
        <button
          className="btn ghost"
          disabled={generating}
          onClick={() => generate.mutate()}
          title="Kapitel neu erkennen (ersetzt die aktuelle Gliederung)"
        >
          {generating ? "Erkenne…" : "Neu"}
        </button>
        <div className="export-wrap">
          <button className="btn ghost" onClick={() => setExportOpen((v) => !v)}>
            Export ▾
          </button>
          {exportOpen && (
            <div className="export-menu" onMouseLeave={() => setExportOpen(false)}>
              <button onClick={() => exportChapters("youtube")}>YouTube-Kapitel (.txt)</button>
              <button onClick={() => exportChapters("srt")}>Kapitel als .SRT</button>
            </div>
          )}
        </div>
      </div>
      {durationSec > 0 && (
        <div className="chapters-strip" aria-hidden>
          {chapters.map((c) => (
            <span
              key={c.id}
              className={`chapters-strip-seg ${c.id === active.id ? "active" : ""}`}
              style={{
                left: `${(c.start / durationSec) * 100}%`,
                width: `${(((c.end ?? durationSec) - c.start) / durationSec) * 100}%`,
              }}
              onClick={() => onSeek(c.start)}
              title={c.title}
            />
          ))}
        </div>
      )}
    </div>
  );
}
