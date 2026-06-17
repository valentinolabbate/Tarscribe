import { useEffect, useState, type CSSProperties } from "react";
import { api } from "../lib/api";
import type { McpHostTarget, McpInfo } from "../lib/types";
import { toast } from "./Toast";

export function McpSettings() {
  const [info, setInfo] = useState<McpInfo | null>(null);
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

  // Detected hosts first, then the rest.
  const targets = info
    ? [...info.targets].sort((a, b) => Number(b.present) - Number(a.present))
    : [];

  return (
    <div className="field">
      <label>MCP-Server für Agenten</label>
      <div className="rec-sub" style={{ fontSize: 12, lineHeight: 1.6, marginBottom: 12 }}>
        Erlaubt KI-Agenten, Aufnahmen autonom zu laden, zu transkribieren und Sprecher zu
        erkennen. Der Server ist in der App enthalten — kein separater Install. Tarscribe muss
        dafür laufen. Ein Klick richtet den Host ein; danach den jeweiligen Host neu starten.
      </div>

      {!info && <div className="rec-sub" style={{ fontSize: 12 }}>Wird geladen…</div>}

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
  background: "var(--bg-elev, #1c1c22)",
  padding: 10,
  borderRadius: 8,
  fontSize: 11,
  overflowX: "auto",
  whiteSpace: "pre",
};
