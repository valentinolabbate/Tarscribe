# Umsetzungsplan: Live-Transkription während der Aufnahme

## Status und Umfang

Dieses Dokument beschreibt die nächste größere Ausbaustufe von Tarscribe:

- Während einer laufenden Aufnahme erscheint auf der Aufnahme-Detailseite fortlaufend ein Transkript.
- Sprecher werden bereits während der Aufnahme provisorisch getrennt.
- Erkannte Sprecher werden mit den bekannten Sprechern verglichen und bei ausreichender Sicherheit benannt.
- Nach dem Stoppen bleibt die bestehende vollständige ASR- und Diarisationspipeline die verbindliche Quelle für das finale Ergebnis.

Die Live-Anzeige ist bewusst **provisorisch**. Text und Sprecherzuordnung dürfen sich für die letzten Sekunden noch ändern. Das finale Ergebnis wird weiterhin aus der vollständigen Audiodatei berechnet und ersetzt die Live-Vorschau.

## 1. Aktueller Stand

### Frontend

Die Aufnahme läuft aktuell ausschließlich lokal im Browser:

- `desktop/src/lib/recorder.ts`
  - nutzt `MediaRecorder`
  - sammelt WebM-Chunks lokal
  - erzeugt erst beim Stoppen einen vollständigen `Blob`
- `desktop/src/hooks/useRecording.tsx`
  - startet und stoppt den lokalen Recorder
  - lädt erst nach dem Stoppen die vollständige Datei über `api.uploadRecording(...)` hoch
- `desktop/src/App.tsx`
  - öffnet die Detailseite nur für bereits gespeicherte `Recording`-Datensätze
- `desktop/src/components/RecordingDetail.tsx`
  - rendert das finale Transkript, Sprecherlabels und den Audio-Player
  - erwartet eine persistierte Aufnahme mit Datenbank-ID

Während einer laufenden Aufnahme existiert serverseitig noch keine Session und kein Datensatz, der auf einer Detailseite dargestellt werden könnte.

### Backend

Die bestehende Verarbeitung arbeitet auf vollständigen WAV-Dateien:

- `backend/tarscribe_backend/routers/recordings.py`
  - nimmt eine fertige Audiodatei an
  - normalisiert sie nach WAV
  - erzeugt danach den `Recording`-Datensatz
- `backend/tarscribe_backend/jobs.py`
  - verarbeitet finale ASR-, Diarisations- und Summary-Jobs
  - verwendet einen gemeinsamen `ThreadPoolExecutor(max_workers=1)`
- `backend/tarscribe_backend/ml/diarization.py`
  - führt pyannote auf einer vollständigen Datei aus
- `backend/tarscribe_backend/ml/speaker_matching.py`
  - bildet Embeddings für finale Sprechercluster
  - vergleicht diese mit bekannten Sprechern
- `backend/tarscribe_backend/ws.py`
  - kann neue JSON-Events an verbundene Clients broadcasten

Die vorhandene pyannote-Pipeline ist keine echte Streaming-Diarisation. Für die Live-Ansicht wird deshalb eine Rolling-Window-Verarbeitung benötigt.

## 2. Zielbild

Während der Aufnahme laufen zwei voneinander entkoppelte Audiowege:

1. **Archivaufnahme**
   - Die bestehende `MediaRecorder`-Aufnahme bleibt unverändert aktiv.
   - Sie ist die verlässliche Quelle für die finale Audiodatei.
   - Ein Ausfall der Live-Verarbeitung darf die Aufnahme niemals beschädigen oder abbrechen.

2. **Live-Analyse**
   - Ein `AudioWorklet` liest mono PCM-Audio aus dem Mikrofonstream.
   - Der Client bündelt die Samples in kleine, nummerierte Chunks und sendet sie an eine serverseitige Live-Session.
   - Das Backend appendet die Chunks verlustfrei, analysiert regelmäßig ein Rolling Window und broadcastet Snapshots an die Detailseite.

Nach dem Stoppen wird die Archivaufnahme wie bisher hochgeladen. Anschließend laufen die bestehenden vollständigen ASR- und Diarisationsjobs. Das provisorische Live-Ergebnis bleibt sichtbar, bis es durch das finale Ergebnis ersetzt werden kann.

## 3. Bewusste Produktentscheidung: provisorisch statt scheinbar final

Live-ASR und Live-Sprecherlabels müssen im UI ihren Status sichtbar machen:

- **Stabiler Text**: älter als der Stabilisierungshorizont und nicht mehr veränderlich.
- **Vorläufiger Text**: die letzten Sekunden; darf bei neuen Chunks ersetzt werden.
- **Vorläufiger Sprecher**: ein temporärer Live-Cluster wie `Sprecher 1`.
- **Vermutlich bekannte Person**: ein Match mit ausreichendem Score, aber noch nicht final.
- **Final**: Ergebnis der vollständigen Verarbeitung nach dem Stoppen.

Die letzten Wörter einer Rolling-Window-ASR ändern sich typischerweise. Ebenso können kurze Audioabschnitte noch keine zuverlässige Sprechererkennung liefern. Das UI darf daraus keine falsche Sicherheit ableiten.

## 4. Architektur

### 4.1 Clientseitige PCM-Erfassung

`MediaRecorder`-Chunks sind nicht zuverlässig einzeln dekodierbar: Browser können Container-Metadaten nur in den ersten Chunk schreiben. Die Live-Pipeline soll deshalb nicht auf einzeln transkodierten WebM-Chunks basieren.

Stattdessen wird der bestehende Mikrofonstream zusätzlich an einen `AudioWorklet` gebunden:

- Eingang: Browser-Audioframes als Float32
- Konvertierung: mono PCM16
- Ziel-Samplerate: 16 kHz
- Chunk-Größe: 2 Sekunden
- Upload: binär oder `multipart/form-data`
- Reihenfolge: monotone `sequence_number`

Der Client hält nur einen begrenzten Upload-Puffer. Bei langsamer Verbindung werden Analyse-Updates verzögert, aber die lokale Archivaufnahme läuft weiter.

### 4.2 Live-Session statt vorzeitigem Recording

Eine laufende Aufnahme erhält eine eigene `LiveRecordingSession`. Sie ist von `Recording` getrennt, weil:

- die finale Archivdatei noch nicht existiert,
- Live-Zustand vorläufig ist,
- ein Browser-Abbruch oder Neustart eine Session unvollständig hinterlassen kann,
- bestehende Recording- und Job-Semantik nicht aufgeweicht werden soll.

Eine Session durchläuft:

```text
starting -> recording <-> paused -> finalizing -> completed
                                   \-> failed
                                   \-> canceled
```

### 4.3 Eigener Live-Analyse-Service

Live-Verarbeitung darf nicht in den bestehenden finalen Job-Executor eingereiht werden. Sonst können Chunks auflaufen und finale Jobs blockieren.

Benötigt wird ein separater `LiveAnalysisService`:

- maximal eine aktive Live-Session als MVP
- eigener Executor oder dedizierter Worker
- koaleszierende Analyse-Ticks: Wenn bereits eine Analyse läuft, wird höchstens ein neuer Tick vorgemerkt
- keine Queue pro Audiochunk
- ASR und Diarisation mit unterschiedlicher Frequenz
- persistierte Snapshots nach erfolgreichen Updates
- Event-Broadcast nach Snapshot-Änderungen

### 4.4 Rolling-Window-ASR

Das bestehende ASR-Modell wird für überlappende Fenster aufgerufen:

- Analyse alle 3 Sekunden
- ASR-Fenster: letzte 20 bis 30 Sekunden
- Überlappung: mindestens 4 bis 6 Sekunden
- Wörter älter als 6 Sekunden hinter dem Live-Ende werden stabilisiert
- nur der vorläufige Tail wird bei der nächsten Analyse ersetzt

Der Server broadcastet vollständige Snapshots oder versionierte Revisionen, keine ungesicherten Text-Deltas. Damit kann sich die Detailseite nach Verbindungsabbrüchen korrekt synchronisieren.

### 4.5 Rolling-Window-Diarisation

pyannote bleibt im Einsatz, wird aber seltener auf einem größeren Fenster ausgeführt:

- Analyse alle 8 bis 12 Sekunden
- Fenster: letzte 30 bis 45 Sekunden
- Mindestmenge an Sprache vor dem ersten Lauf: 5 Sekunden
- temporäre Cluster werden anhand zeitlicher Überschneidung und Embedding-Ähnlichkeit auf stabile Live-Labels gemappt
- kurze oder unsichere Segmente bleiben zunächst `Sprecher unbekannt`

Dieses Verfahren ist eine angenäherte Live-Diarisation. Nach dem Stoppen ersetzt die vollständige pyannote-Verarbeitung die Live-Zuordnung.

### 4.6 Vergleich mit bekannten Sprechern

Für ausreichend lange Live-Cluster werden ECAPA-Embeddings erzeugt und mit den vorhandenen Known-Speaker-Embeddings verglichen:

- Mindestdauer an sauberer Sprache pro Cluster: zunächst 3 bis 5 Sekunden
- Vergleich über die bestehende Cosine-Similarity
- Match-Schwelle aus den bestehenden Matching-Einstellungen übernehmen
- Hysterese einführen:
  - ein bekannter Sprecher wird erst nach mehreren konsistenten Bewertungen angezeigt
  - ein bestehender Match wird nicht durch einen einzelnen schwächeren Lauf entfernt
- UI zeigt Score und Vorläufigkeitsstatus

Falls Diarisation oder Speaker-Embedding nicht verfügbar ist, läuft Live-ASR weiter. Die Oberfläche zeigt dann einen klaren reduzierten Betriebsmodus.

## 5. Datenmodell

Für das MVP genügt eine kompakte persistierte Session mit JSON-Snapshots. Eine normalisierte Live-Word-Tabelle wäre erst nötig, wenn später gezielte serverseitige Live-Suche oder kollaborative Bearbeitung hinzukommt.

### Neue Tabelle `live_recording_sessions`

| Feld | Typ | Zweck |
| --- | --- | --- |
| `id` | UUID/String | stabile Session-ID |
| `topic_id` | FK | Zielthema |
| `title` | String | Aufnahmetitel |
| `status` | String | `starting`, `recording`, `paused`, `finalizing`, `completed`, `failed`, `canceled` |
| `pcm_path` | String | appendbare PCM-Datei im Data-Verzeichnis |
| `sample_rate` | Integer | initial `16000` |
| `channels` | Integer | initial `1` |
| `last_sequence_number` | Integer | höchster angenommener Chunk |
| `received_duration_sec` | Float | bestätigte PCM-Dauer |
| `transcript_snapshot_json` | Text | versionierter Wort-Snapshot |
| `speaker_snapshot_json` | Text | versionierte Live-Cluster und Matches |
| `last_analyzed_sec` | Float | letzter verarbeiteter Audiostand |
| `finalized_recording_id` | FK, nullable | zugehörige finale Aufnahme |
| `error` | Text, nullable | Fehlerbeschreibung |
| `created_at` | DateTime | Erstellung |
| `updated_at` | DateTime | letzte Änderung |

### Snapshot-Format

```json
{
  "revision": 12,
  "duration_sec": 37.4,
  "words": [
    {
      "id": "live-word-41",
      "start": 31.2,
      "end": 31.8,
      "text": "Beispiel",
      "confidence": 0.93,
      "is_final": false,
      "speaker_id": "live-speaker-1"
    }
  ]
}
```

```json
{
  "revision": 4,
  "speakers": [
    {
      "id": "live-speaker-1",
      "display_name": "Max Mustermann",
      "known_speaker_id": 3,
      "similarity": 0.86,
      "match_status": "probable"
    }
  ]
}
```

## 6. API-Vertrag

### REST-Endpunkte

| Methode | Pfad | Zweck |
| --- | --- | --- |
| `POST` | `/api/live-recordings` | Session vor dem Recorder-Start anlegen |
| `POST` | `/api/live-recordings/{session_id}/chunks` | nummerierten PCM16-Chunk hochladen |
| `POST` | `/api/live-recordings/{session_id}/pause` | Session pausieren und Puffer flushen |
| `POST` | `/api/live-recordings/{session_id}/resume` | Session fortsetzen |
| `POST` | `/api/live-recordings/{session_id}/finish` | Session finalisieren und Recording-Verknüpfung setzen |
| `DELETE` | `/api/live-recordings/{session_id}` | abgebrochene Session markieren |
| `GET` | `/api/live-recordings/{session_id}` | vollständigen Snapshot für Initial-Load und Polling-Fallback laden |

Chunk-Upload:

```text
POST /api/live-recordings/{session_id}/chunks
Content-Type: application/octet-stream
X-Sequence-Number: 17
X-Sample-Rate: 16000
X-Channels: 1
```

Antwort:

```json
{
  "accepted": true,
  "last_sequence_number": 17,
  "received_duration_sec": 34.0
}
```

Eigenschaften:

- idempotent für bereits bestätigte Sequenzen
- Ablehnung oder explizite Fehlerantwort bei Lücken
- keine stillschweigende Neuordnung
- REST-Authentifizierung analog zu den bestehenden API-Endpunkten

### WebSocket-Events

Der bestehende WebSocket kann für Server-Push erweitert werden. Jedes Live-Event trägt eine Session-ID, damit der Client nur relevante Events verarbeitet.

```json
{
  "type": "live_transcript",
  "session_id": "uuid",
  "snapshot": {
    "revision": 12,
    "duration_sec": 37.4,
    "words": []
  }
}
```

```json
{
  "type": "live_speakers",
  "session_id": "uuid",
  "snapshot": {
    "revision": 4,
    "speakers": []
  }
}
```

Weitere Events:

| Event | Zweck |
| --- | --- |
| `live_session` | Statusänderung, bestätigte Dauer und Backpressure |
| `live_transcript` | versionierter Transkript-Snapshot |
| `live_speakers` | versionierter Speaker-Snapshot |
| `live_degraded` | Live-ASR oder Live-Speaker-Erkennung eingeschränkt |
| `live_error` | nicht ignorierbarer Session-Fehler |
| `live_finalized` | finale `recording_id` für den Wechsel auf die bestehende Detailseite |

Der Client lädt bei WebSocket-Reconnect zusätzlich den REST-Snapshot. WebSocket-Events sind eine Beschleunigung, nicht die einzige Quelle des Zustands.

## 7. Backend-Arbeitspakete

### B1. Session-Persistenz und Lifecycle

Dateien:

- `backend/tarscribe_backend/models.py`
- neue Migration gemäß bestehendem Datenbank-Setup
- neue Datei `backend/tarscribe_backend/routers/live_recordings.py`
- `backend/tarscribe_backend/main.py`

Aufgaben:

- `LiveRecordingSession` ergänzen
- CRUD- und Lifecycle-Endpunkte implementieren
- Session-Dateien unter einem eigenen Unterverzeichnis speichern
- veraltete Sessions beim Start erkennen und als `failed` markieren
- Cleanup für abgebrochene Sessions ergänzen

### B2. Sichere PCM-Annahme

Dateien:

- neue Datei `backend/tarscribe_backend/live_audio.py`
- `backend/tarscribe_backend/routers/live_recordings.py`

Aufgaben:

- Binärchunks validieren
- Sequenznummern idempotent verarbeiten
- nur bestätigte, lückenlose PCM-Daten appenden
- Dauer aus Sample-Anzahl berechnen
- Rolling-WAV oder temporäre WAV-Datei für Modellaufrufe erzeugen
- Fehler klar an Client und Session-State melden

### B3. Rolling-ASR

Dateien:

- neue Datei `backend/tarscribe_backend/ml/live_asr.py`
- neue Datei `backend/tarscribe_backend/live_analysis.py`

Aufgaben:

- eigenes Live-ASR-Serviceobjekt ergänzen
- Fensterextraktion implementieren
- Wortzeitstempel auf globale Session-Zeit verschieben
- stabilen Prefix erhalten und nur den vorläufigen Tail ersetzen
- Snapshots versionieren und persistieren
- `live_transcript` broadcasten

### B4. Rolling-Diarisation

Dateien:

- neue Datei `backend/tarscribe_backend/ml/live_diarization.py`
- `backend/tarscribe_backend/live_analysis.py`

Aufgaben:

- Rolling-Window-Aufrufe der vorhandenen pyannote-Pipeline kapseln
- lokale Fenstercluster auf stabile Live-Cluster mappen
- Überlappung, Embedding-Ähnlichkeit und Mindestdauer berücksichtigen
- Speaker-Snapshots versionieren und broadcasten
- bei fehlendem Hugging-Face-Token oder Modellfehlern auf ASR-only degradieren

### B5. Live-Matching bekannter Sprecher

Dateien:

- `backend/tarscribe_backend/ml/speaker_matching.py`
- `backend/tarscribe_backend/ml/embedding.py`
- `backend/tarscribe_backend/ml/live_diarization.py`

Aufgaben:

- wiederverwendbare Matching-Primitiven aus der finalen Pipeline extrahieren
- Live-Cluster-Embedding aus ausreichend langen Segmenten erzeugen
- Schwellenwert und Hysterese anwenden
- `probable` statt `final` verwenden
- Änderungen in den Speaker-Snapshot schreiben

### B6. Finalisierung

Dateien:

- `backend/tarscribe_backend/routers/live_recordings.py`
- `backend/tarscribe_backend/routers/recordings.py`
- `backend/tarscribe_backend/jobs.py`

Aufgaben:

- Upload der finalen Archivdatei mit der Live-Session verknüpfen
- `finalized_recording_id` setzen
- bestehende finale ASR- und Diarisationsjobs unverändert anstoßen
- `live_finalized` mit `recording_id` senden
- provisorisches Ergebnis erhalten, falls ein finaler Job scheitert

## 8. Frontend-Arbeitspakete

### F1. PCM-Capture als Zusatzpfad

Dateien:

- `desktop/src/lib/recorder.ts`
- neue Datei `desktop/src/lib/livePcmCapture.ts`
- neues AudioWorklet-Modul

Aufgaben:

- vorhandenen Mikrofonstream parallel an `AudioWorklet` anschließen
- auf 16 kHz mono PCM16 resamplen
- 2-Sekunden-Chunks erzeugen
- `sequence_number` vergeben
- Capture bei Pause anhalten und bei Resume fortsetzen
- bestehende Archivaufnahme unverändert erhalten

### F2. Upload-Queue und Live-Session-State

Dateien:

- `desktop/src/lib/api.ts`
- `desktop/src/hooks/useRecording.tsx`
- neue Datei `desktop/src/hooks/useLiveRecording.ts`
- `desktop/src/types.ts`

Aufgaben:

- Session vor Aufnahmebeginn anlegen
- Chunks geordnet senden
- bestätigten High-Water-Mark verfolgen
- Retry für fehlgeschlagene Uploads implementieren
- Puffergrenze und Backpressure-Status abbilden
- REST-Snapshot und WebSocket-Events zusammenführen
- bei Live-Fehlern nur die Vorschau degradieren, nicht die Aufnahme stoppen

### F3. Live-Detailseite

Dateien:

- neue Datei `desktop/src/components/LiveRecordingDetail.tsx`
- `desktop/src/components/RecordingDetail.tsx`
- `desktop/src/components/GlobalRecordingIndicator.tsx`
- `desktop/src/App.tsx`

Aufgaben:

- laufende Aufnahme als Detailansicht öffnen
- Aufnahmezeit, Pause, Resume und Stop anzeigen
- stabiles Transkript normal darstellen
- vorläufigen Tail sichtbar absetzen
- Speaker-Chips mit `vorläufig`, `vermutlich erkannt` und Score darstellen
- Auto-Scroll mit manueller Unterbrechung ergänzen
- Verbindungsprobleme und ASR-only-Modus klar anzeigen
- nach `live_finalized` auf bestehende `RecordingDetail` wechseln

### F4. Wiederverwendbare Transkriptansicht

Dateien:

- `desktop/src/components/RecordingDetail.tsx`
- neue gemeinsame Transkript-Komponente

Aufgaben:

- Darstellung von Utterances und Sprecherlabels aus der bestehenden Detailseite extrahieren
- Live- und finale Daten über klar getrennte View-Modelle einspeisen
- bestehende finale Bearbeitung und Audio-Player-Funktionalität nicht in die Live-Ansicht ziehen

## 9. Fehlerfälle und Robustheit

### Verbindungsabbruch

- Client puffert eine begrenzte Anzahl PCM-Chunks.
- Nach Reconnect werden nicht bestätigte Chunks ab dem letzten High-Water-Mark erneut gesendet.
- REST-Snapshot synchronisiert die Anzeige.
- Ist der Puffer voll, zeigt das UI eine Warnung. Die Archivaufnahme läuft weiter.

### Browser- oder App-Abbruch

- Session bleibt mit letztem Snapshot erhalten.
- Beim nächsten Backend-Start werden alte aktive Sessions als fehlgeschlagen markiert.
- Eine spätere Wiederaufnahme derselben Session ist im MVP nicht erforderlich.

### Modellfehler

- ASR-Fehler: Live-Anzeige meldet Verzögerung oder Degradierung; Aufnahme bleibt aktiv.
- Diarisationsfehler: Transkript läuft ohne Sprechertrennung weiter.
- Matching-Fehler: temporäre Sprecherlabels bleiben sichtbar.

### Ressourcenknappheit

- nur eine aktive Live-Session gleichzeitig
- keine unbeschränkte Analysequeue
- Diarisation seltener als ASR
- Analyse-Ticks werden zusammengefasst
- optionaler Feature-Flag zum Abschalten der Live-Diarisation

### Datenschutz und Authentifizierung

- REST-Uploads verwenden die vorhandene Token-Authentifizierung.
- Live-Events enthalten Session-IDs und werden im Client gefiltert.
- Vor einem späteren Mehrbenutzerbetrieb muss der WebSocket zusätzlich serverseitig pro Benutzer oder Session autorisiert werden.

## 10. Feature-Flags und Einstellungen

Für eine kontrollierte Einführung werden Einstellungen ergänzt:

| Einstellung | Default | Zweck |
| --- | --- | --- |
| `live_transcription_enabled` | `true` | Live-ASR aktivieren |
| `live_speaker_detection_enabled` | `true` | Rolling-Diarisation aktivieren |
| `live_chunk_duration_sec` | `2` | PCM-Upload-Frequenz |
| `live_asr_interval_sec` | `3` | ASR-Analysefrequenz |
| `live_diarization_interval_sec` | `10` | Speaker-Analysefrequenz |
| `live_match_min_speech_sec` | `4` | Mindestmaterial für Known-Speaker-Match |

Diese Werte sollten zunächst als Backend-Konfiguration geführt werden. Eine UI für Experteneinstellungen ist für das MVP nicht nötig.

## 11. Testplan

### Backend-Unit-Tests

- doppelt gesendete Chunk-Sequenz wird idempotent behandelt
- Lücken in Chunk-Sequenzen werden erkannt
- bestätigte PCM-Dauer wird korrekt berechnet
- stabiler ASR-Prefix bleibt bei Tail-Revision erhalten
- globale Wortzeitstempel stimmen nach Rolling-Window-Verschiebung
- Live-Cluster bleiben über mehrere Diarisationsfenster stabil
- Known-Speaker-Match benötigt Mindestdauer und wiederholte Bestätigung
- Pause, Resume, Finish und Cancel validieren Zustandsübergänge

### Backend-API-Tests

- Session anlegen, Chunks senden, Snapshot laden und finalisieren
- Retry desselben Chunks
- fehlende Sequenz
- Authentifizierungsfehler
- degradierter Modus bei nicht verfügbarer Diarisation
- `live_finalized` verknüpft die richtige `recording_id`

### Frontend-Tests

- Aufnahme startet Session und öffnet Live-Detailseite
- Mock-Chunks werden geordnet gesendet
- WebSocket-Snapshot aktualisiert Live-Text
- jüngster Tail wird als vorläufig dargestellt
- Speaker wechselt von temporärem Label zu vermutetem Known-Speaker
- Reconnect lädt REST-Snapshot
- Pause stoppt PCM-Uploads
- Stop wechselt nach Finalisierung auf die normale Detailseite
- Live-Analysefehler stoppt die lokale Archivaufnahme nicht

### Manuelle Validierung auf macOS

- 5-Minuten-Aufnahme mit einem bekannten Sprecher
- 15-Minuten-Aufnahme mit zwei bekannten und einem unbekannten Sprecher
- 30- bis 90-Minuten-Langzeittest
- Pause und Resume mehrfach verwenden
- Backend während einer laufenden Aufnahme kurz unterbrechen
- Live-Diarisation ohne Hugging-Face-Token prüfen
- CPU-, Speicher- und UI-Reaktionsverhalten beobachten
- finale Aufnahme und finales Transkript mit der bestehenden Pipeline vergleichen

## 12. Akzeptanzkriterien

Das MVP ist abgeschlossen, wenn:

- eine Aufnahme aus der Live-Detailseite gestartet und beendet werden kann,
- das erste Live-Transkript innerhalb von höchstens 5 Sekunden nach gesprochener Sprache sichtbar wird,
- Textupdates danach ungefähr alle 3 Sekunden erscheinen,
- der vorläufige Tail erkennbar von stabilem Text getrennt ist,
- ein temporärer Sprecher nach ausreichend Sprache innerhalb von ungefähr 15 Sekunden sichtbar wird,
- ein bekannter Sprecher bei ausreichender Audioqualität innerhalb von ungefähr 20 Sekunden als vorläufiger Match erscheint,
- WebSocket-Reconnect und REST-Snapshot die Anzeige wiederherstellen,
- Live-Verarbeitungsfehler die Archivaufnahme nicht beschädigen,
- nach dem Stoppen die bestehende finale ASR- und Diarisationspipeline läuft,
- die Detailseite nach Finalisierung automatisch auf das kanonische Recording wechselt,
- finale Ergebnisse weiterhin bearbeitbar sind wie bisher.

## 13. Umsetzungsreihenfolge

### Phase 0: Technischer Spike

Ziel: PCM-Erfassung und reale Modelllaufzeiten auf dem Zielgerät messen.

1. `AudioWorklet` mit 16-kHz-PCM-Ausgabe prototypisch integrieren.
2. 2-Sekunden-Chunks lokal prüfen.
3. Rolling-ASR für 20- bis 30-Sekunden-Fenster benchmarken.
4. pyannote für 30- bis 45-Sekunden-Fenster benchmarken.
5. Frequenzen und Speichergrenzen anhand der Messwerte bestätigen.

Ergebnis: dokumentierte Laufzeiten und endgültige Default-Intervalle.

### Phase 1: Session-Grundlage und Live-Detailseite

Ziel: verlustfreie Live-Audioannahme ohne ML-Abhängigkeit.

1. Datenmodell und REST-Lifecycle ergänzen.
2. PCM-Upload mit Sequenzen und Idempotenz implementieren.
3. Frontend-Queue und Statusmodell ergänzen.
4. leere Live-Detailseite mit Timer, Pause, Resume und Stop öffnen.
5. Archivaufnahme und Finalisierung end-to-end prüfen.

### Phase 2: Live-ASR

Ziel: fortlaufendes provisorisches Transkript.

1. separaten `LiveAnalysisService` ergänzen.
2. Rolling-ASR und stabilen Prefix implementieren.
3. Snapshots persistieren und broadcasten.
4. Live-Text mit vorläufigem Tail darstellen.
5. Reconnect- und Degradierungsfälle testen.

### Phase 3: Live-Diarisation

Ziel: stabile temporäre Sprecherlabels.

1. Rolling-pyannote kapseln.
2. Cluster über Fenster hinweg stabilisieren.
3. Speaker-Snapshots broadcasten.
4. Live-Transcript in Utterances mit temporären Sprechern gruppieren.
5. ASR-only-Fallback prüfen.

### Phase 4: Known-Speaker-Matching

Ziel: bekannte Sprecher vorsichtig vorläufig benennen.

1. Matching-Primitiven aus finaler Pipeline wiederverwenden.
2. Mindestdauer, Schwelle und Hysterese implementieren.
3. Score und Vorläufigkeitsstatus im UI anzeigen.
4. Tests mit bekannten und unbekannten Sprechern durchführen.

### Phase 5: Finalisierung und Härtung

Ziel: sauberer Übergang vom Live-Snapshot zum kanonischen Recording.

1. finale Aufnahme eindeutig mit Live-Session verknüpfen.
2. automatische Navigation auf bestehende Detailseite ergänzen.
3. Fehlerfälle, Cleanup und Langzeittests abdecken.
4. Feature-Flags dokumentieren.
5. Release-Checkliste ausführen.

## 14. Risiken und vorab zu klärende Messpunkte

| Risiko | Maßnahme |
| --- | --- |
| pyannote ist auf dem Zielgerät für 10-Sekunden-Intervalle zu langsam | in Phase 0 messen; Intervall erhöhen oder Live-Diarisation optional deaktivieren |
| gleichzeitige ASR und Diarisation verursachen hohen Speicherverbrauch | Modelle gezielt warmhalten oder entladen; nur eine Live-Session; keine Analysequeue |
| Wort-Merge erzeugt Duplikate oder verschluckt Tail-Wörter | Snapshot-basiertes Merge-Verfahren mit Zeitstempeln und Unit-Tests |
| schlechte Audioqualität erzeugt falsche Known-Speaker-Matches | Mindestdauer, Hysterese und sichtbarer Vorläufigkeitsstatus |
| Netzwerkstörung füllt Client-Puffer | Puffergrenze, Warnung, Retry; lokale Archivaufnahme bleibt unabhängig |
| finale Verarbeitung weicht sichtbar vom Live-Ergebnis ab | UI kommuniziert provisorischen Zustand und ersetzt Snapshot erst kontrolliert |

## 15. Nicht Teil des MVP

- echte tokenweise ASR-Ausgabe mit Subsekunden-Latenz
- serverseitig rekonstruierte Archivaufnahme als Ersatz für `MediaRecorder`
- mehrere gleichzeitige Live-Aufnahmen
- kollaborative Live-Bearbeitung durch mehrere Clients
- finale Sprecherkorrekturen direkt während der Aufnahme
- Mehrbenutzer-Autorisierung für Live-WebSocket-Kanäle

## 16. Release-Strategie

Diese Funktion sollte nicht in einem einzigen großen Schritt veröffentlicht werden:

1. technische Spike-Ergebnisse dokumentieren,
2. Session-Lifecycle und Live-ASR hinter Feature-Flag integrieren,
3. Live-ASR intern validieren,
4. Rolling-Diarisation und Known-Speaker-Matching ergänzen,
5. Langzeittests und Reconnect-Tests durchführen,
6. Feature-Flag standardmäßig aktivieren,
7. Version releasen.

Vor dem Release müssen mindestens Frontend-Build, Backend-Tests, Rust-Check und ein manueller Live-Aufnahme-Smoke-Test erfolgreich sein.
