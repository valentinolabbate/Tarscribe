# Feature-Ideen / Roadmap

Festgehalten am 2026-06-11 (Stand: v0.5.0). Status-Werte: **Idee** → **Geplant** → **In Arbeit** → **Umgesetzt (vX.Y.Z)**.

| # | Feature | Status | Aufwand (grob) |
|---|---------|--------|----------------|
| 1 | Meeting-Erkennung mit Auto-Aufnahme-Angebot | In Arbeit | M (2–3 Tage) |
| 2 | Themen-Threads über Aufnahmen hinweg | In Arbeit | L (4–6 Tage) |
| 3 | Wochen-Digest | In Arbeit | S–M (1–2 Tage) |
| 4 | Diktat-Inbox mit globalem Hotkey + Direkt-Aufgabe | In Arbeit | M (2–3 Tage) |

---

## 1. Meeting-Erkennung mit Auto-Aufnahme-Angebot

**Status:** In Arbeit

**Aktueller Stand (2026-06-11):** Desktop-MVP ist implementiert: konfigurierbare
Meeting-App-Liste in den Einstellungen, Tauri-Hintergrundprüfung laufender Prozesse,
Frontend-Prompt und Start einer Aufnahme in einem automatisch angelegten Bereich
„Meetings". Die Mikrofon-Aktivitätsprüfung und der Datenschutz-Hinweis beim ersten
Aktivieren sind noch offen.

Tarscribe merkt, wenn ein Zoom-/Teams-/Meet-Call startet (laufende Apps + Mikrofonnutzung
via CoreAudio erkennbar) und fragt dezent über die Menüleiste: „Meeting läuft — aufnehmen?"
Eine Aufnahme, die man nicht starten muss, ist das nutzerfreundlichste Feature überhaupt —
der häufigste Grund für „Mist, das hätte ich aufnehmen sollen" entfällt.

- **Baut auf:** vorhandene Aufnahme-Infrastruktur (Mikrofon + System-Audio, Tray-Menü).
- **Noch zu bauen:** Mikrofon-Aktivität als zweites Signal, Tray-/Notification-Prompt,
  Datenschutz-Hinweis beim ersten Aktivieren.
- **Offene Fragen:** Browser-Meetings zuverlässiger erkennen, ohne jeden Chrome-/Safari-Start
  als Meeting zu interpretieren.

**Umsetzung (Skizze):**

1. **Erkennung im Tauri-Shell (Rust):** Hintergrund-Loop (alle ~5 s, nur wenn keine
   Aufnahme läuft). Zwei Signale kombinieren:
   - Laufende Meeting-Apps über die Prozessliste (`sysinfo`-Crate; Namen wie `zoom.us`,
     `Microsoft Teams`, `Webex`; Liste in den Einstellungen erweiterbar).
   - Mikrofon aktiv: CoreAudio-Property `kAudioDevicePropertyDeviceIsRunningSomewhere`
     auf dem Default-Input-Device — passt in den bestehenden nativen Recorder-Teil
     (`desktop/src-tauri/native`).
2. **Prompt:** Bei beiden Signalen ein Tauri-Event `meeting-detected` ans Frontend +
   macOS-Notification („Meeting läuft — aufnehmen?"); zusätzlich Eintrag im Tray-Menü.
   Pro erkannter Sitzung nur einmal fragen (Cooldown, bis Mikro wieder frei ist).
3. **Start:** Bei „Aufnehmen" den bestehenden `useRecording`-Flow starten; Themenbereich:
   zuletzt genutzter oder fester Standard („Meetings", per Einstellung).
4. **Einstellungen:** Toggle `meeting_detection_enabled` + App-Liste in `settings_store`
   (Backend) und `SettingsModal.tsx`; Event-Listener in `App.tsx` (gleiches Muster wie
   die bestehenden `menu`-Events).

## 2. Themen-Threads: „Was wurde zu X über die Zeit besprochen?"

**Status:** In Arbeit

**Aktueller Stand (2026-06-11):** Erste Thread-Scheibe ist implementiert:
Datenmodell (`threads`, `thread_mentions`), Rebuild-API, Aufnahme-spezifische Thread-API
und Startseiten-Panel. Die erste Erkennung gruppiert gleiche/ähnliche Kapitelüberschriften
über mehrere Aufnahmen. Embedding-Clustering, LLM-Titel und Detailseiten-Badges sind noch
offen.

Die Embeddings aller Aufnahmen liegen bereits in der Datenbank (sqlite-vec). Damit lässt
sich erkennen, dass dasselbe Thema in mehreren Meetings auftaucht — als Zeitstrahl:
„Budget-Planung: erwähnt am 3.5., entschieden am 28.5., wieder offen seit 10.6."
Auf der Detailseite ein Hinweis „Dieses Thema kam schon 3× vor", auf der Startseite eine
Thread-Ansicht. Macht aus der Bibliothek ein echtes Projektgedächtnis — das kann kein
Konkurrenzprodukt, das lokal läuft.

- **Baut auf:** RAG-Index (`rag_chunks` + `rag_chunk_vec`), Kapitel (Themen-Titel als
  Thread-Kandidaten), Action-Items (Entscheidungs-Status im Zeitstrahl).
- **Noch zu bauen:** Embedding-Clustering ähnlicher Chunks, LLM-vergebene Thread-Titel,
  Detailseiten-Hinweis und automatischer Rebuild nach Embedding-/Kapitel-Jobs.
- **Offene Fragen:** Clustering-Schwelle; wie aggressiv ähnliche, aber nicht gleiche
  Themen zusammengeführt werden sollen.

**Umsetzung (Skizze):**

1. **Datenmodell:** Tabellen `threads` (id, title, updated_at) und `thread_mentions`
   (thread_id, recording_id, chunk_id, datum) in `models.py`.
2. **Clustering-Job (Python, numpy):** Vektoren aus `rag_chunk_vec` lesen (liegen schon
   da, keine neuen Embedding-Aufrufe nötig). Greedy-Clustering über Kosinus-Ähnlichkeit
   (Schwelle ~0.78, empirisch justieren); nur Transkript-Chunks unterschiedlicher
   Aufnahmen verbinden — Threads mit Erwähnungen in ≥ 2 Aufnahmen behalten.
3. **Benennung:** Ein LLM-Call pro neuem Thread (repräsentative Chunk-Texte → Titel,
   max. 6 Wörter) — gleiche Job-Infrastruktur wie `action_items`/`chapters`
   (`jobs.py`, neuer `JobPhase.threads`).
4. **Trigger:** Debounced nach jedem Embedding-Job (läuft auf dem vorhandenen
   `_embed_executor`), plus Button „Threads aktualisieren".
5. **API + UI:** `GET /api/threads` (mit Erwähnungen, sortiert nach letzter Aktivität),
   `GET /api/recordings/{id}/threads`. Startseite: Thread-Liste mit Zeitstrahl-Chips
   (Datum → Klick öffnet Aufnahme an der Stelle); Detailseite: Hinweis-Badge
   „Thema kam schon n× vor".

## 3. Wochen-Digest

**Status:** In Arbeit

**Aktueller Stand (2026-06-11):** Manuelle 7-Tage-Digest-Erstellung ist implementiert:
persistierte Digests, API (`POST/GET /api/digests`), Startseiten-Anzeige mit Markdown,
Export in einen globalen Digest-Ordner und Hinweis, wenn der letzte Digest älter als
sieben Tage ist. Ein stiller Auto-Job ist bewusst noch nicht aktiv; die UI fordert zur
Erstellung auf.

Einmal pro Woche oder auf Knopfdruck: „Deine Woche" — besprochene Themen, getroffene
Entscheidungen, noch offene Aufgaben, wer viel/wenig zu Wort kam. Optional als Markdown
in den Obsidian-Export-Ordner.

- **Baut auf:** Summaries, Action-Items, Sprecher-Statistiken, LLM-Job-Pipeline —
  im Kern ein einziger neuer LLM-Job plus eine Anzeige-Seite.
- **Noch zu bauen:** optionaler stiller Zeitplan/Auto-Job.
- **Offene Fragen:** Aufbewahrung alter Digests.

**Umsetzung (Skizze):**

1. **Datenmodell:** Tabelle `digests` (id, date_from, date_to, content_markdown,
   created_at) in `models.py`.
2. **Digest-Job:** Neuer `JobPhase.digest` in `jobs.py`: Aufnahmen im Zeitraum laden,
   pro Aufnahme vorhandene Summary (sonst Kurz-Extrakt aus dem Transkript), offene
   Action-Items und Sprecher-Anteile einsammeln → ein LLM-Call mit festem
   Digest-Prompt → Markdown speichern. Kein neues ML, nur Aggregation + `llm.stream_chat`.
3. **API:** `POST /api/digests?days=7` (erstellen), `GET /api/digests` (Liste),
   `GET /api/digests/{id}`.
4. **UI:** Abschnitt auf der Startseite („Deine Woche" mit Erstellen-Button, Render über
   das vorhandene `react-markdown`); Export in den Themen-Export-Ordner über das
   bestehende Send-to-Folder-Muster (`routers/export.py`).
5. **Auto-Trigger (optional, v2):** Beim App-Start prüfen, ob der letzte Digest > 7 Tage
   alt ist → Hinweis-Banner statt stillem Hintergrund-Job.

## 4. Diktat-Inbox mit globalem Hotkey + Direkt-Aufgabe

**Status:** In Arbeit

**Aktueller Stand (2026-06-11):** Erste nutzbare Scheibe ist implementiert:
Diktat-Aufnahme auf der Startseite, globaler Desktop-Hotkey `⌥⌘D` als Toggle,
automatische Inbox-Anlage, direkter ASR-Start und Backend-Nachverarbeitung für Titel,
Themenvorschlag und Aufgaben. Der Hotkey ist konfigurierbar, es gibt ein App-weites
Diktat-Pill-Overlay und Abschlussfeedback nach der Verarbeitung. Ein separates
Always-on-top-Zweitfenster für Aufnahme bei geschlossener Hauptansicht ist noch offen.

Hotkey drücken, Gedanken einsprechen, loslassen. Die Notiz wird transkribiert und vom LLM
automatisch betitelt und in den passenden Themenbereich einsortiert (oder in eine „Inbox").
Senkt die Hürde, Tarscribe auch für Schnellnotizen zu nutzen.

**Zusätzlich:** Das LLM soll aus dem Diktat direkt eine Aufgabe machen können — erkennt es
eine Aufgabenformulierung („ich muss noch…", „erinner mich an…"), legt es automatisch ein
Action-Item an (inkl. Frist, falls genannt), das in der globalen Aufgaben-Ansicht erscheint.

- **Baut auf:** Aufnahme + ASR-Pipeline, Action-Items (v0.5.0), Aufgaben-Seite.
- **Noch zu bauen:** Push-to-talk-Aufnahmefluss ohne offenes Hauptfenster und optionales
  separates Overlay-Window.
- **Entschieden:** Diktat-Audio bleibt als normale Aufnahme erhalten; Löschen läuft über
  die vorhandene Aufnahme-Löschung.

**Umsetzung (Skizze):**

1. **Hotkey:** `tauri-plugin-global-shortcut` mit `⌥⌘D` ist als Toggle verdrahtet.
   Erster Druck startet, zweiter stoppt und speichert (Key-Up ist mit globalen
   Shortcuts nicht zuverlässig erkennbar). Der Shortcut ist in den Einstellungen änderbar.
2. **Aufnahme ohne Hauptfenster:** Kleines Always-on-top-Overlay-Fenster (zweites
   Tauri-Window, „Pill" mit Pegel + Timer + Stopp), Aufnahme über den vorhandenen
   Mikrofon-Recorder (`lib/recorder.ts`); Upload über den bestehenden
   `uploadRecording`-Flow in einen automatisch angelegten Themenbereich „Inbox".
3. **Auto-Verarbeitung (Backend):** Nach dem ASR-Job für Inbox-Aufnahmen ein
   LLM-Nachschritt (Erweiterung in `jobs.py`, Prompt in `analysis.py`):
   - **Titel** generieren (ersetzt „Diktat 2026-06-11 14:32"),
   - **Themenbereich vorschlagen** (Liste vorhandener Topics im Prompt; bei geringer
     Sicherheit bleibt es in der Inbox),
   - **Aufgaben-Erkennung:** Formulierungen wie „ich muss noch…" / „erinner mich an…"
     → direkt `ActionItem` anlegen (Frist parsen, falls genannt) — landet automatisch
     in der globalen Aufgaben-Ansicht (v0.5.0).
4. **Feedback:** Toast nach Abschluss („Notiz gespeichert · 1 Aufgabe angelegt"),
   Klick öffnet die Notiz. Ohne konfiguriertes LLM: nur Transkription in die Inbox.
