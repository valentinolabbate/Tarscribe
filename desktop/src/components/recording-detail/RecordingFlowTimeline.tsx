import type { FlowStep } from "./model";

export function RecordingFlowTimeline({ steps }: { steps: FlowStep[] }) {
  return (
    <section className="recording-flow" aria-label="Aufnahme-Workflow">
      {steps.map((step, index) => (
        <article
          className={`recording-flow-step ${step.state}`}
          key={step.key}
          aria-current={step.state === "active" ? "step" : undefined}
        >
          <div className="recording-flow-marker" aria-hidden="true">
            <span>{index + 1}</span>
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
