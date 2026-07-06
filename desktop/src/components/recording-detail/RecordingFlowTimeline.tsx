import type { FlowStep } from "./model";

export function RecordingFlowTimeline({ steps }: { steps: FlowStep[] }) {
  const visibleSteps = steps.filter((step) => step.state === "active" || step.state === "error");
  if (visibleSteps.length === 0) {
    const transcriptReady = steps.some((step) => step.key === "transcript" && step.state === "done");
    const analysisReady = steps.some((step) => step.key === "analysis" && step.state === "done");
    if (!transcriptReady) return null;
    return (
      <div className="recording-flow-summary">
        <span>✓</span>
        <strong>{analysisReady ? "Aufnahme ausgewertet" : "Transkript bereit"}</strong>
      </div>
    );
  }

  return (
    <section className="recording-flow" aria-label="Aufnahme-Workflow">
      {visibleSteps.map((step) => (
        <article
          className={`recording-flow-step ${step.state}`}
          key={step.key}
          aria-current={step.state === "active" ? "step" : undefined}
        >
          <div className="recording-flow-marker" aria-hidden="true">
            <span>{step.state === "error" ? "!" : "•"}</span>
          </div>
          <div className="recording-flow-copy">
            <span className="recording-flow-kicker">{step.eyebrow}</span>
            <strong>{step.label}</strong>
            <small>{step.detail}</small>
            {step.progress != null && (
              <div className="recording-flow-progress" aria-hidden="true">
                <span style={{ width: `${step.progress}%` }} />
              </div>
            )}
          </div>
          {step.action && (
            <button
              className={step.state === "next" || step.state === "error" ? "btn primary" : "btn ghost"}
              disabled={step.action.disabled}
              onClick={step.action.onClick}
              type="button"
            >
              {step.action.label}
            </button>
          )}
        </article>
      ))}
    </section>
  );
}
