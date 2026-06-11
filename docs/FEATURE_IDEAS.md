# Feature-Ideen / Roadmap

Festgehalten am 2026-06-11 (Stand: v0.5.0). Status-Werte: **Idee** → **Geplant** → **In Arbeit** → **Umgesetzt (vX.Y.Z)**.

| # | Feature | Status |
|---|---------|--------|
| 1 | Meeting-Erkennung mit Auto-Aufnahme-Angebot | Idee |
| 2 | Themen-Threads über Aufnahmen hinweg | Idee |
| 3 | Wochen-Digest | Idee |
| 4 | Diktat-Inbox mit globalem Hotkey + Direkt-Aufgabe | Idee |

---

## 1. Meeting-Erkennung mit Auto-Aufnahme-Angebot

**Status:** Idee

Tarscribe merkt, wenn ein Zoom-/Teams-/Meet-Call startet (laufende Apps + Mikrofonnutzung
via CoreAudio erkennbar) und fragt dezent über die Menüleiste: „Meeting läuft — aufnehmen?"
Eine Aufnahme, die man nicht starten muss, ist das nutzerfreundlichste Feature überhaupt —
der häufigste Grund für „Mist, das hätte ich aufnehmen sollen" entfällt.

- **Baut auf:** vorhandene Aufnahme-Infrastruktur (Mikrofon + System-Audio, Tray-Menü).
- **Neu zu bauen:** Erkennung (laufende Meeting-Apps + aktive Mikrofonnutzung, nativer
  macOS-Teil im Tauri-Shell) und der Tray-Prompt.
- **Offene Fragen:** Erkennungs-Heuristik (App-Liste konfigurierbar?), Verhalten bei
  „Nein" (für dieses Meeting stumm bleiben), Datenschutz-Hinweis beim ersten Mal.

## 2. Themen-Threads: „Was wurde zu X über die Zeit besprochen?"

**Status:** Idee

Die Embeddings aller Aufnahmen liegen bereits in der Datenbank (sqlite-vec). Damit lässt
sich erkennen, dass dasselbe Thema in mehreren Meetings auftaucht — als Zeitstrahl:
„Budget-Planung: erwähnt am 3.5., entschieden am 28.5., wieder offen seit 10.6."
Auf der Detailseite ein Hinweis „Dieses Thema kam schon 3× vor", auf der Startseite eine
Thread-Ansicht. Macht aus der Bibliothek ein echtes Projektgedächtnis — das kann kein
Konkurrenzprodukt, das lokal läuft.

- **Baut auf:** RAG-Index (`rag_chunks` + `rag_chunk_vec`), Kapitel (Themen-Titel als
  Thread-Kandidaten), Action-Items (Entscheidungs-Status im Zeitstrahl).
- **Neu zu bauen:** Cross-Recording-Clustering ähnlicher Chunks/Kapitel, Thread-Modell,
  Thread-Ansicht (Startseite) + Hinweis auf der Detailseite.
- **Offene Fragen:** Clustering-Schwelle; LLM-vergebene Thread-Titel; wann neu berechnen
  (nach jedem Embedding-Job vs. periodisch).

## 3. Wochen-Digest

**Status:** Idee

Einmal pro Woche oder auf Knopfdruck: „Deine Woche" — besprochene Themen, getroffene
Entscheidungen, noch offene Aufgaben, wer viel/wenig zu Wort kam. Optional als Markdown
in den Obsidian-Export-Ordner.

- **Baut auf:** Summaries, Action-Items, Sprecher-Statistiken, LLM-Job-Pipeline —
  im Kern ein einziger neuer LLM-Job plus eine Anzeige-Seite.
- **Neu zu bauen:** Digest-Job (Zeitraum-Aggregation über Aufnahmen), Digest-Seite,
  optionaler Zeitplan + Markdown-Export.
- **Offene Fragen:** Auslösung (App-Start am Montag? Manuell?), Aufbewahrung alter Digests.

## 4. Diktat-Inbox mit globalem Hotkey + Direkt-Aufgabe

**Status:** Idee

Hotkey drücken, Gedanken einsprechen, loslassen. Die Notiz wird transkribiert und vom LLM
automatisch betitelt und in den passenden Themenbereich einsortiert (oder in eine „Inbox").
Senkt die Hürde, Tarscribe auch für Schnellnotizen zu nutzen.

**Zusätzlich:** Das LLM soll aus dem Diktat direkt eine Aufgabe machen können — erkennt es
eine Aufgabenformulierung („ich muss noch…", „erinner mich an…"), legt es automatisch ein
Action-Item an (inkl. Frist, falls genannt), das in der globalen Aufgaben-Ansicht erscheint.

- **Baut auf:** Aufnahme + ASR-Pipeline, Action-Items (v0.5.0), Aufgaben-Seite.
- **Neu zu bauen:** globaler Hotkey (Tauri global-shortcut), Push-to-talk-Aufnahmefluss
  ohne offenes Fenster, „Inbox"-Themenbereich, LLM-Schritt für Titel + Einsortierung +
  Aufgaben-Erkennung.
- **Offene Fragen:** Standard-Hotkey; Verhalten ohne konfiguriertes LLM (dann nur Inbox,
  ohne Auto-Titel/Aufgabe); Diktat zusätzlich als Audio behalten oder nur Text.
