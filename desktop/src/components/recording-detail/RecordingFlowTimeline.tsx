import type { FlowStep } from "./model";

export function RecordingFlowTimeline({ steps }: { steps: FlowStep[] }) {
  return (
    <ol className="recording-flow" aria-label="Verarbeitungsschritte">
      {steps.map((step, index) => (
        <li
          className={`recording-flow-step ${step.state}`}
          key={step.key}
          aria-current={step.state === "active" ? "step" : undefined}
        >
          <div className="recording-flow-marker" aria-hidden="true">
            <span>{step.state === "error" ? "!" : step.state === "done" ? "✓" : index + 1}</span>
          </div>
          <div className="recording-flow-copy">
            <div className="recording-flow-heading">
              <strong>{step.label}</strong>
              <span className="recording-flow-kicker">{step.eyebrow}</span>
            </div>
            <small>{step.detail}</small>
            {step.progress != null && (
              <div className="recording-flow-progress" aria-hidden="true">
                <span style={{ width: `${step.progress}%` }} />
              </div>
            )}
          </div>
          {step.selection && (
            <select aria-label={step.selection.label} value={step.selection.value}
              disabled={step.selection.disabled}
              onChange={(event) => step.selection?.onChange(Number(event.target.value))}>
              <option value="" disabled>Vorlage auswählen</option>
              {step.selection.options.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          )}
          {step.action && (
            <button
              className={step.state === "next" || step.state === "error" ? "btn primary" : "btn ghost"}
              disabled={step.action.disabled}
              onClick={step.action.onClick}
              type="button"
              aria-label={`${step.label}: ${step.action.label}`}
            >
              {step.action.label}
            </button>
          )}
        </li>
      ))}
    </ol>
  );
}
