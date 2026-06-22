import { useEffect, useState, type CSSProperties } from "react";
import { api } from "../lib/api";
import type { McpCapability, McpDiagnostics, McpHostTarget, McpInfo } from "../lib/types";
import { toast } from "./Toast";

const fallbackCapabilities: McpCapability[] = [
  { id: "upload", label: "Upload & Pipeline", ready: true, tools: [] },
  { id: "context", label: "Kontext", ready: true, tools: [] },
  { id: "search", label: "Suche", ready: true, tools: [] },
  { id: "tasks", label: "Aufgaben", ready: true, tools: [] },
  { id: "analysis", label: "Analyse", ready: true, tools: [] },
  { id: "export", label: "Export", ready: true, tools: [] },
];

export function McpSettings() {
  const [info, setInfo] = useState<McpInfo | null>(null);
  const [diagnostics, setDiagnostics] = useState<McpDiagnostics | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showManual, setShowManual] = useState(false);

  function load() {
    api.getMcpInfo().then(setInfo).catch(() => setInfo(null));
  }
  useEffect(load, []);

  async function register(t: McpHostTarget) {
    setBusy(t.id);
    try {
      await api.registerMcp(t.id);
      toast(`MCP für ${t.label} eingerichtet. ${t.label} ggf. neu starten.`, "success");
      load();
    } catch (e) {
      toast(`Einrichtung fehlgeschlagen: ${(e as Error).message}`, "error");
    } finally {
      setBusy(null);
    }
  }

  async function unregister(t: McpHostTarget) {
    setBusy(t.id);
    try {
      await api.unregisterMcp(t.id);
      toast(`MCP-Eintrag aus ${t.label} entfernt.`, "success");
      load();
    } catch (e) {
      toast(`Entfernen fehlgeschlagen: ${(e as Error).message}`, "error");
    } finally {
      setBusy(null);
    }
  }

  function copy(text: string) {
    navigator.clipboard.writeText(text).then(
      () => toast("In die Zwischenablage kopiert.", "success"),
      () => toast("Kopieren fehlgeschlagen.", "error"),
    );
  }

  async function testConnection() {
    setBusy("__mcp_test");
    try {
      const result = await api.getMcpDiagnostics();
      setDiagnostics(result);
      toast(result.ok ? "MCP-Verbindung ist bereit." : "MCP braucht noch Aufmerksamkeit.", result.ok ? "success" : "error");
    } catch (e) {
      toast(`MCP-Test fehlgeschlagen: ${(e as Error).message}`, "error");
    } finally {
      setBusy(null);
    }
  }

  // Detected hosts first, then the rest.
  const targets = info
    ? [...info.targets].sort((a, b) => Number(b.present) - Number(a.present))
    : [];
  const capabilities = diagnostics?.capabilities ?? fallbackCapabilities;
  const connectionLabel = diagnostics
    ? diagnostics.ok
      ? "Bereit für Agenten"
      : "Prüfung unvollständig"
    : "Noch nicht getestet";
  const connectionHint = diagnostics
    ? diagnostics.ok
      ? `${diagnostics.tools.count} Tools verfügbar`
      : diagnostics.connection_file.error || diagnostics.tools.error || "Details unten prüfen"
    : "Teste Verbindung, Tool-Liste und lokale Verbindungsdatei.";

  return (
    <div className="field">
      <label>MCP-Server für Agenten</label>
      <div className="rec-sub" style={{ fontSize: 12, lineHeight: 1.6, marginBottom: 12 }}>
        Erlaubt KI-Agenten, Aufnahmen autonom zu laden, zu transkribieren und Sprecher zu
        erkennen. Der Server ist in der App enthalten — kein separater Install. Tarscribe muss
        dafür laufen. Ein Klick richtet den Host ein; danach den jeweiligen Host neu starten.
      </div>

      {!info && <div className="rec-sub" style={{ fontSize: 12 }}>Wird geladen…</div>}

      <div className="mcp-health-card">
        <span className={`mcp-status-dot ${diagnostics?.ok ? "ok" : diagnostics ? "warn" : ""}`} />
        <div className="mcp-health-copy">
          <strong>{connectionLabel}</strong>
          <span>{connectionHint}</span>
        </div>
        <button className="btn" disabled={busy === "__mcp_test"} onClick={testConnection}>
          {busy === "__mcp_test" ? "Teste…" : "Verbindung testen"}
        </button>
      </div>

      {diagnostics && (
        <div className="mcp-diagnostics-grid">
          <div>
            <span>Datei</span>
            <strong>{diagnostics.connection_file.ok ? "ok" : "fehlt"}</strong>
          </div>
          <div>
            <span>Backend</span>
            <strong>{diagnostics.backend.ok ? "läuft" : "offline"}</strong>
          </div>
          <div>
            <span>Tools</span>
            <strong>{diagnostics.tools.count}</strong>
          </div>
        </div>
      )}

      <div className="mcp-capability-strip" aria-label="MCP-Funktionen">
        {capabilities.map((capability) => (
          <span
            key={capability.id}
            className={`mcp-capability ${capability.ready ? "ready" : "missing"}`}
            title={capability.tools.length ? capability.tools.join(", ") : undefined}
          >
            {capability.label}
          </span>
        ))}
      </div>

      {targets.map((t) => (
        <div
          key={t.id}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            padding: "8px 0",
            borderTop: "1px solid var(--border, #2a2a30)",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <strong>{t.label}</strong>
              {t.registered && <span className="badge ready">✓ eingerichtet</span>}
              {!t.registered && t.present && <span className="badge">erkannt</span>}
            </div>
            <div
              className="rec-sub"
              style={{ fontSize: 11, opacity: 0.7, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              title={t.path}
            >
              {t.path}
            </div>
          </div>
          {t.registered ? (
            <button className="btn ghost danger" disabled={busy === t.id} onClick={() => unregister(t)}>
              Entfernen
            </button>
          ) : (
            <button
              className={t.present ? "btn primary" : "btn"}
              disabled={busy === t.id}
              onClick={() => register(t)}
            >
              Einrichten
            </button>
          )}
        </div>
      ))}

      {info && (
        <>
          <button
            className="btn ghost"
            style={{ marginTop: 12 }}
            onClick={() => setShowManual((v) => !v)}
          >
            {showManual ? "Manuelle Einrichtung ausblenden" : "Manuelle Einrichtung / anderer Host"}
          </button>
          {showManual && (
            <div style={{ marginTop: 10 }}>
              <div className="rec-sub" style={{ fontSize: 11.5, marginBottom: 6 }}>
                Für andere stdio-MCP-Hosts. Startbefehl:
              </div>
              <pre style={preStyle}>{`${info.command} ${info.args.join(" ")}`}</pre>
              <div className="rec-sub" style={{ fontSize: 11.5, margin: "8px 0 6px" }}>
                Oder als <code>mcpServers</code>-Block:
              </div>
              <pre style={preStyle}>{info.snippet}</pre>
              <button className="btn" onClick={() => copy(info.snippet)}>
                Snippet kopieren
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const preStyle: CSSProperties = {
  background: "var(--bg-input)",
  border: "1px solid var(--border-strong)",
  color: "var(--text)",
  padding: 10,
  borderRadius: 8,
  fontSize: 11,
  overflowX: "auto",
  whiteSpace: "pre",
};
