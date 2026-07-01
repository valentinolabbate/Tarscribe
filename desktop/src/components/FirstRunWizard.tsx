import { type FormEvent, useEffect, useState } from "react";
import { api } from "../lib/api";
import { validateHfToken } from "../lib/formValidation";
import { PERFORMANCE_PROFILES, performanceProfileLabel } from "../lib/performanceProfiles";
import type { HardwareInfo, PerformanceProfile, SecretStorageStatus } from "../lib/types";
import { LlmSettings } from "./LlmSettings";
import { LogoIcon, SpeakerIdIcon } from "./icons";

export function FirstRunWizard({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [hw, setHw] = useState<HardwareInfo | null>(null);
  const [ffmpeg, setFfmpeg] = useState(true);
  const [token, setToken] = useState("");
  const [tokenTouched, setTokenTouched] = useState(false);
  const [tokenStatus, setTokenStatus] = useState<string | null>(null);
  const [hasToken, setHasToken] = useState(false);
  const [secretStorage, setSecretStorage] = useState<SecretStorageStatus | null>(null);
  const [profile, setProfile] = useState<PerformanceProfile>("balanced");
  const [warming, setWarming] = useState(false);
  const [warmDone, setWarmDone] = useState(false);
  const [warmError, setWarmError] = useState<string | null>(null);

  useEffect(() => {
    api.setupStatus().then((s) => {
      setHw(s.hardware);
      setFfmpeg(s.ffmpeg_available);
      setHasToken(s.hf_token_set);
      setSecretStorage(s.secret_storage);
    });
    api.getSettings().then((s) => setProfile(s.performance_profile)).catch(() => {});
  }, []);

  const tokenError = token.trim() ? validateHfToken(token) : null;

  async function saveToken(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    setTokenTouched(true);
    if (!token.trim() || tokenError) return;
    try {
      const res = await api.setHfToken(token.trim());
      setHasToken(true);
      setTokenStatus(`Gültig${res.name ? ` (${res.name})` : ""}`);
      setToken("");
    } catch (e) {
      setHasToken(false);
      setTokenStatus(`Nicht gespeichert: ${(e as Error).message}`);
    }
  }

  async function warmup() {
    setWarming(true);
    setWarmError(null);
    try {
      await api.warmup();
      setWarmDone(true);
    } catch (e) {
      setWarmError(String((e as Error).message));
    } finally {
      setWarming(false);
    }
  }

  async function chooseProfile(next: PerformanceProfile) {
    setProfile(next);
    await api.updateSettings({ performance_profile: next });
  }

  async function finish() {
    await api.completeSetup();
    onDone();
  }

  const steps = ["Willkommen", "System", "Sprecher", "Zusammenfassung", "Modell", "Fertig"];

  return (
    <div className="wizard">
      <div className="wizard-card">
        <div className="wizard-steps">
          {steps.map((s, i) => (
            <div key={s} className={`wizard-dot ${i === step ? "active" : ""} ${i < step ? "done" : ""}`}>
              <span />
              {s}
            </div>
          ))}
        </div>

        <div className="wizard-body">
          {step === 0 && (
            <div className="wizard-welcome">
              <LogoIcon className="wizard-logo" />
              <h1>Willkommen bei Tarscribe</h1>
              <p>
                Transkribiere und analysiere deine Aufnahmen auf deinem Mac. Optionale Chat-Funktionen
                verbindest du mit dem Anbieter oder Endpoint deiner Wahl.
                Lass uns das in wenigen Schritten einrichten.
              </p>
            </div>
          )}

          {step === 1 && (
            <div>
              <h2>System-Check</h2>
              <div className="check-row">
                <span className={hw?.is_apple_silicon ? "ok" : "warn"}>●</span>
                {hw ? (hw.is_apple_silicon ? "Apple Silicon erkannt" : `${hw.os} / ${hw.arch}`) : "Prüfe…"}
              </div>
              <div className="check-row">
                <span className="ok">●</span>
                Bestes Modell: <strong>{hw?.recommended_asr ?? "…"}</strong>
              </div>
              <div className="field" style={{ marginTop: 14 }}>
                <label>Leistungsstufe</label>
                <div className="performance-options">
                  {PERFORMANCE_PROFILES.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      className={profile === option.id ? "performance-option active" : "performance-option"}
                      onClick={() => chooseProfile(option.id)}
                    >
                      <span className="performance-option-head">
                        <strong>{option.label}</strong>
                        {hw?.recommended_profile === option.id && <span className="mini-badge">Empfohlen</span>}
                      </span>
                      <span>{option.detail}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="check-row">
                <span className={ffmpeg ? "ok" : "warn"}>●</span>
                {ffmpeg ? "ffmpeg verfügbar" : "ffmpeg fehlt — bitte installieren (brew install ffmpeg)"}
              </div>
              <div className="check-row">
                <span className={secretStorage == null ? "muted" : secretStorage.secure ? "ok" : "warn"}>●</span>
                {secretStorage == null
                  ? "Keychain wird geprüft"
                  : secretStorage.secure
                    ? "Keychain für Tokens verfügbar"
                    : "Keychain nicht verfügbar — Tokens können nicht sicher gespeichert werden"}
              </div>
            </div>
          )}

          {step === 2 && (
            <div>
              <h2>
                <SpeakerIdIcon width={18} height={18} /> Sprecher-Erkennung (optional)
              </h2>
              <p className="muted">
                Für die Trennung mehrerer Sprecher wird ein kostenloser HuggingFace-Token benötigt.
                Erstelle ihn unter huggingface.co/settings/tokens und akzeptiere die Lizenz von
                pyannote/speaker-diarization-community-1.
              </p>
              {secretStorage && !secretStorage.secure && (
                <div style={{ color: "var(--danger)", fontSize: 12, lineHeight: 1.5, marginBottom: 10 }}>
                  Die macOS-Keychain ist nicht verfügbar. Tarscribe speichert Tokens deshalb nicht,
                  bis ein sicherer Secret-Speicher erreichbar ist.
                </div>
              )}
              {hasToken ? (
                <div className="badge ready">✓ Token hinterlegt</div>
              ) : (
                <form onSubmit={saveToken}>
                  <div style={{ display: "flex", gap: 6 }}>
                    <input
                      type="password"
                      placeholder="hf_…"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      onBlur={() => setTokenTouched(true)}
                      style={{ flex: 1 }}
                      spellCheck={false}
                      aria-invalid={tokenTouched && !!tokenError}
                      aria-describedby={tokenTouched && tokenError ? "first-run-token-error" : undefined}
                    />
                    <button className="btn primary" type="submit" disabled={!token.trim() || !!tokenError}>
                      Speichern
                    </button>
                  </div>
                  {tokenTouched && tokenError && (
                    <div id="first-run-token-error" className="field-error">
                      {tokenError}
                    </div>
                  )}
                </form>
              )}
              {tokenStatus && <div className="muted" style={{ marginTop: 8 }}>{tokenStatus}</div>}
            </div>
          )}

          {step === 3 && (
            <div>
              <h2>Zusammenfassungen (optional)</h2>
              <p className="muted">
                Verbinde ein Chat-Modell, um Transkripte zusammenzufassen. Das kann ein Anbieter
                oder ein eigener OpenAI-kompatibler Endpoint sein; du kannst es auch später einrichten.
              </p>
              <LlmSettings />
            </div>
          )}

          {step === 4 && (
            <div>
              <h2>Modell vorbereiten</h2>
              <p className="muted">
                Lade das Transkriptions-Modell ({performanceProfileLabel(profile)}) jetzt herunter, damit die
                erste Aufnahme sofort startet. Das kann beim ersten Mal ein paar Minuten dauern.
              </p>
              {warmDone ? (
                <div className="badge ready">✓ Modell bereit</div>
              ) : (
                <button className="btn primary" onClick={warmup} disabled={warming}>
                  {warming ? "Lädt Modell…" : "Modell herunterladen"}
                </button>
              )}
              {warmError && <div style={{ color: "var(--danger)", marginTop: 8 }}>{warmError}</div>}
            </div>
          )}

          {step === 5 && (
            <div className="wizard-welcome">
              <div className="badge ready" style={{ fontSize: 14, padding: "6px 14px" }}>✓ Alles bereit</div>
              <h1>Los geht's!</h1>
              <p>Lege einen Themenbereich an und lade deine erste Aufnahme hoch.</p>
            </div>
          )}
        </div>

        <div className="wizard-actions">
          {step > 0 && step < 5 && (
            <button className="btn ghost" onClick={() => setStep(step - 1)}>Zurück</button>
          )}
          <div style={{ flex: 1 }} />
          {step < 5 ? (
            <button className="btn primary" onClick={() => setStep(step + 1)}>
              {step === 0 ? "Einrichten" : "Weiter"}
            </button>
          ) : (
            <button className="btn primary" onClick={finish}>Fertig</button>
          )}
        </div>
      </div>
    </div>
  );
}
