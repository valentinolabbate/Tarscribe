import { type FormEvent, type ReactNode } from "react";
import { validateHttpUrl } from "../../lib/formValidation";
import type { AppSettings } from "../../lib/types";

export function CalendarSettingsTab({
  settings,
  setSettings,
  caldavPassword,
  setCaldavPassword,
  busy,
  secretStorageWarning,
  statusEl,
  saveCaldav,
  testCaldav,
  removeCaldavPassword,
}: {
  settings: AppSettings;
  setSettings: (settings: AppSettings) => void;
  caldavPassword: string;
  setCaldavPassword: (value: string) => void;
  busy: boolean;
  secretStorageWarning: ReactNode;
  statusEl: ReactNode;
  saveCaldav: () => void;
  testCaldav: () => void;
  removeCaldavPassword: () => void;
}) {
  const urlError = validateHttpUrl(settings.caldav.url, "CalDAV-URL");
  const showUrlError = settings.caldav.url.trim().length > 0 && !!urlError;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!urlError) saveCaldav();
  }

  return (
    <form onSubmit={submit}>
      <div className="field">
        <label>CalDAV-Kalender</label>
        <input
          type="url"
          placeholder="https://cloud.example.com/remote.php/dav/calendars/name/tasks/"
          value={settings.caldav.url}
          onChange={(event) =>
            setSettings({ ...settings, caldav: { ...settings.caldav, url: event.target.value } })
          }
          spellCheck={false}
          aria-invalid={showUrlError}
          aria-describedby={showUrlError ? "caldav-url-error" : undefined}
        />
        {showUrlError && (
          <div id="caldav-url-error" className="field-error">
            {urlError}
          </div>
        )}
        <div className="rec-sub" style={{ marginTop: 7, fontSize: 11.5, lineHeight: 1.5 }}>
          Kalender-Collection-URL, nicht nur die Web-Oberfläche. Nextcloud zeigt sie in den
          Kalender-Einstellungen an.
        </div>
      </div>

      <div className="field">
        <label>Benutzername</label>
        <input
          type="text"
          value={settings.caldav.username}
          onChange={(event) =>
            setSettings({ ...settings, caldav: { ...settings.caldav, username: event.target.value } })
          }
          spellCheck={false}
          autoComplete="username"
        />
      </div>

      <div className="field">
        <label>App-Passwort</label>
        {secretStorageWarning}
        {settings.caldav_password_set && !caldavPassword ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" }}>
            <span className="badge ready">✓ Passwort hinterlegt</span>
            <button className="btn ghost danger" type="button" onClick={removeCaldavPassword} disabled={busy}>
              Entfernen
            </button>
          </div>
        ) : (
          <input
            type="password"
            value={caldavPassword}
            onChange={(event) => setCaldavPassword(event.target.value)}
            spellCheck={false}
            autoComplete="current-password"
            placeholder={settings.caldav_password_set ? "Neues Passwort setzen" : "App-Passwort"}
          />
        )}
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button className="btn" type="button" onClick={testCaldav} disabled={busy || !!urlError}>
          Verbindung testen
        </button>
        <button className="btn primary" type="submit" disabled={busy || !!urlError}>
          Speichern
        </button>
      </div>
      {statusEl}
    </form>
  );
}
