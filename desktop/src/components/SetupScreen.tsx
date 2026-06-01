import { useEffect, useRef, useState } from "react";
import { invoke, listen } from "../lib/tauri";
import { LogoIcon } from "./icons";

/**
 * Shown on first launch of a packaged build when the Python environment still
 * needs to be created. Drives the Rust `setup_environment` command and streams
 * its progress. In dev (env already present) this screen never appears.
 */
export function SetupScreen({ onReady }: { onReady: () => void }) {
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let un: (() => void) | undefined;
    listen<string>("setup-progress", (line) => {
      setLines((l) => [...l.slice(-200), line]);
    }).then((u) => (un = u));
    return () => un?.();
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [lines]);

  async function build() {
    setBuilding(true);
    setError(null);
    try {
      await invoke("setup_environment");
      onReady();
    } catch (e) {
      setError(String(e));
      setBuilding(false);
    }
  }

  return (
    <div className="wizard">
      <div className="wizard-card">
        <div className="wizard-body wizard-welcome">
          <LogoIcon className="wizard-logo" />
          <h1>Einmalige Einrichtung</h1>
          <p>
            Tarscribe lädt jetzt die lokalen KI-Modelle und richtet die Umgebung ein. Das passiert
            nur beim ersten Start, benötigt eine Internetverbindung und kann einige Minuten dauern.
          </p>

          {building && (
            <>
              <div className="spinner" style={{ margin: "8px auto" }} />
              <div className="setup-log" ref={logRef}>
                {lines.map((l, i) => (
                  <div key={i}>{l}</div>
                ))}
              </div>
            </>
          )}
          {error && <div style={{ color: "var(--danger)", maxWidth: 440 }}>{error}</div>}
        </div>
        <div className="wizard-actions">
          <div style={{ flex: 1 }} />
          <button className="btn primary" onClick={build} disabled={building}>
            {building ? "Richte ein…" : error ? "Erneut versuchen" : "Einrichtung starten"}
          </button>
        </div>
      </div>
    </div>
  );
}
