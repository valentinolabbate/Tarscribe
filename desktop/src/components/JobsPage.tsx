import { useState } from "react";
import { useActiveJobs, useCancelJob } from "../hooks/queries";
import { jobPhaseLabel } from "../lib/format";
import type { DebugJob } from "../lib/types";
import { RefreshIcon, StopIcon } from "./icons";
import { useToast } from "./Toast";

const STATUS_LABEL: Record<DebugJob["status"], string> = {
  pending: "Wartet",
  running: "Läuft",
  done: "Fertig",
  failed: "Fehler",
  canceled: "Gestoppt",
};

function fmtTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function progressPercent(job: DebugJob): number {
  return Math.max(0, Math.min(100, Math.round((job.progress ?? 0) * 100)));
}

function JobRow({
  job,
  stopping,
  onStop,
  onOpenRecording,
}: {
  job: DebugJob;
  stopping: boolean;
  onStop: (job: DebugJob) => void;
  onOpenRecording: (recordingId: number) => void;
}) {
  const percent = progressPercent(job);
  const canStop = job.status === "pending" || job.status === "running";
  return (
    <div className="job-debug-row">
      <div className="job-debug-main">
        <div className="job-debug-titleline">
          <span className={`badge ${job.status}`}>{STATUS_LABEL[job.status]}</span>
          <strong>{jobPhaseLabel(job.phase)}</strong>
        </div>
        <button className="job-debug-recording" onClick={() => onOpenRecording(job.recording_id)}>
          {job.recording_title ?? `Aufnahme ${job.recording_id}`}
        </button>
        <div className="job-debug-meta">
          {job.topic_name && <span>{job.topic_name}</span>}
          <span>Start {fmtTime(job.created_at)}</span>
          <span>Update {fmtTime(job.updated_at)}</span>
          <span>#{job.job_id}</span>
        </div>
        <div className="job-debug-progress" aria-label={`Fortschritt ${percent}%`}>
          <span style={{ width: `${percent}%` }} />
        </div>
        {job.error && <div className="job-debug-error">{job.error}</div>}
      </div>
      <button
        className="btn ghost danger job-debug-stop"
        title="Job stoppen"
        disabled={!canStop || stopping}
        onClick={() => onStop(job)}
      >
        <StopIcon width={15} height={15} />
        {stopping ? "Stoppe" : "Stop"}
      </button>
    </div>
  );
}

export function JobsPage({ onOpenRecording }: { onOpenRecording: (recordingId: number) => void }) {
  const { data: jobs, isLoading, isFetching, isError, refetch } = useActiveJobs();
  const cancelJob = useCancelJob();
  const toast = useToast();
  const [stoppingId, setStoppingId] = useState<number | null>(null);

  const stopJob = (job: DebugJob) => {
    setStoppingId(job.job_id);
    cancelJob.mutate(job.job_id, {
      onSuccess: () => toast("Job gestoppt.", "success"),
      onError: (err) => toast(`Job konnte nicht gestoppt werden: ${(err as Error).message}`, "error"),
      onSettled: () => setStoppingId(null),
    });
  };

  return (
    <div className="jobs-debug-page">
      <div className="jobs-debug-head">
        <div>
          <span className="topbar-eyebrow">Debug</span>
          <h2>Laufende Jobs</h2>
        </div>
        <button className="btn ghost" disabled={isFetching} onClick={() => void refetch()} title="Aktualisieren">
          <RefreshIcon width={16} height={16} />
          {isFetching ? "Aktualisiere" : "Aktualisieren"}
        </button>
      </div>

      {isLoading ? (
        <div className="empty">
          <div className="spinner" />
        </div>
      ) : isError ? (
        <div className="empty">
          <div className="big">Jobs konnten nicht geladen werden</div>
        </div>
      ) : jobs?.length ? (
        <div className="jobs-debug-list">
          {jobs.map((job) => (
            <JobRow
              key={job.job_id}
              job={job}
              stopping={stoppingId === job.job_id}
              onStop={stopJob}
              onOpenRecording={onOpenRecording}
            />
          ))}
        </div>
      ) : (
        <div className="empty jobs-debug-empty">
          <div className="big">Keine laufenden Jobs</div>
        </div>
      )}
    </div>
  );
}
