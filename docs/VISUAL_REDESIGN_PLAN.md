# Umsetzungsplan: Evidence-first Redesign

## Status und Umfang

**Status:** Abgeschlossen
**Stand:** 2026-07-20

**Aktueller Umsetzungsstand:** Das gemeinsame Seitenraster, die kompakte globale Navigation,
der neue Heute-Arbeitsplatz und die gemeinsame `EvidenceTrail`-Quellenspur sind umgesetzt.
Die Quellenspur verbindet Aufgaben, Gedächtniseinträge, Personeninformationen, den
Meeting-Zeitstrahl, Suchtreffer und aufgeklappte Chat-Quellen mit ihrer Originalstelle. Für den
Heute-Arbeitsplatz ist außerdem der Lesbarkeits-Sweep mit stärkerem
Metakontrast, größeren Lesestufen und klar getrennten Arbeitsbereichen abgeschlossen. Die
Gedächtnis-Unterseiten Commitment Radar, Decision Ledger, Aufgaben, Personen und Archiv sind
in einer gemeinsamen Inhaltsnavigation zusammengeführt; die Topbar zeigt nur noch den
übergeordneten Bereich. Die
Flächenhierarchie ist ebenfalls vereinheitlicht: Kennzahlen und Filter erscheinen als
kompakte Leisten, während Gedächtnis-, Aufgaben- und Wissenslisten jeweils eine dominante
Arbeitsfläche bilden. Der seitenübergreifende typografische Sweep ist ebenfalls abgeschlossen:
gemeinsame Rollen steuern Display-, Abschnitts-, Inhalts- und Metatexte, während Zeit- und
Quellenangaben eine eigene tabellarische Datenstimme erhalten. Der abschließende Theme- und
CSS-Feinschliff konsolidiert die Light-/Dark-Tokens, zugängliche Status- und Fokusfarben sowie
reduzierte Bewegung. Nicht mehr gerenderte Startseiten- und Quellenbutton-Regeln wurden
entfernt; die Zielbreiten `1440px`, `1024px` und `700px` sind abschließend geprüft.

Dieser Plan beschreibt die nächste größere visuelle Ausbaustufe von Tarscribe. Das Ziel ist
kein vollständiger Stilwechsel, sondern eine klarere gemeinsame Produktoberfläche: ruhiger,
prägnanter und stärker auf die belegbare Verbindung zwischen Gespräch, Erkenntnis und
Folgearbeit ausgerichtet.

Der Plan umfasst fünf Arbeitsstränge:

- eine einheitliche Seitenarchitektur für Start, Gedächtnis, Aufgaben und Personen,
- eine fokussiertere Startseite als täglicher Arbeitsplatz,
- eine wiederkehrende visuelle Quellenspur als Tarscribe-Erkennungsmerkmal,
- eine deutlichere Hierarchie der Flächen mit weniger gleichgewichtigen Karten,
- ein prägnanteres typografisches System.

Nicht Teil dieses Plans sind eine konzeptionelle Überarbeitung der Leerzustände und neue
Handlungsaufforderungen innerhalb dieser Zustände. Funktionale Produktänderungen an Aufnahme,
Suche, Gedächtnis oder Auswertung werden nur vorgesehen, wenn sie für die neue Darstellung
technisch notwendig sind.

## 1. Ausgangslage

Tarscribe besitzt bereits eine ruhige, helle Oberfläche mit zurückhaltender Mint-Farbwelt,
klaren Zuständen und einer macOS-nahen Typografie. Die wichtigsten visuellen Brüche entstehen
derzeit nicht durch einzelne Komponenten, sondern durch die Gesamtstruktur:

- Gedächtnis, Aufgaben und Personen verwenden unterschiedliche maximale Inhaltsbreiten.
- Im Gedächtnis konkurrieren Seitentitel, Unterseiten-Navigation, Inhalts-Tabs, Kennzahlen und
  Filter um die Aufmerksamkeit.
- Auf der Startseite dominiert die Archivsuche, während Aufnahme, Diktat, offene Arbeit und
  aktuelle Verarbeitung visuell nachgeordnet sind.
- Kennzahlen, Filter, Inhalte und Zustände erscheinen häufig als ähnlich gewichtete weiße
  Karten mit Rahmen.
- Quellen, Zeitmarken, Sprecher und Belegstatus sind funktional vorhanden, bilden aber noch
  keine wiedererkennbare visuelle Sprache.
- Unterhalb von 720 Pixeln verschwindet die globale Sidebar, ohne eine gleichwertige kompakte
  Navigation anzubieten.

## 2. Zielbild

Die App soll sich wie ein zusammenhängender Arbeitsraum anfühlen und nicht wie eine Folge
separater Dashboards. Beim Wechsel zwischen Bereichen bleiben Raster, Seitentitel,
Navigation und Abstände stabil. Die inhaltliche Hierarchie wird hauptsächlich über
Typografie, Gruppierung und Weißraum vermittelt; Flächen und Rahmen unterstützen nur noch
interaktive oder besonders wichtige Inhalte.

Das visuelle Leitmotiv ist die **Quellenspur**:

```text
Gespräch → Sprecher → Aussage → Aufgabe oder Entscheidung → Originalstelle
```

Sie macht Tarscribes wichtigste Produkteigenschaft sichtbar: Erkenntnisse bleiben mit ihrer
Quelle verbunden.

## 3. Gestaltungsprinzipien

### Beleg vor Dekoration

Quellenstatus, Aufnahme, Sprecher und Zeitpunkt erhalten einen festen visuellen Platz. Farbe
und Bewegung werden nur eingesetzt, wenn sie Orientierung, Status oder Herkunft vermitteln.

### Ein Raster, unterschiedliche Dichte

Alle Hauptseiten teilen sich denselben Inhaltsrahmen. Innerhalb dieses Rahmens dürfen Start,
Gedächtnis, Aufgaben und Personen unterschiedliche Spaltenaufteilungen verwenden, ohne dass
die linke Kante, der Seitentitel oder die Grundabstände springen.

### Flächen nach Bedeutung

Nicht jede Gruppe benötigt eine Karte. Drei klar definierte Oberflächenebenen ersetzen die
heutige Vielzahl ähnlich aussehender Container:

1. **Canvas:** Seitenhintergrund und nicht interaktive Gruppierung ohne Rahmen.
2. **Section:** zusammengehörige Inhalte mit Abstand oder feiner Trennlinie.
3. **Interactive Surface:** auswählbare, fokussierte oder direkt bedienbare Inhalte mit
   Hintergrund, Rahmen und bei Bedarf Schatten.

### Zustände bleiben zugänglich

Aktiv, ausgewählt, überfällig und in Verarbeitung dürfen nicht nur über Farbe erkennbar sein.
Kontrast, Fokusrahmen, Text und Symbole bleiben Bestandteil der Zustandsdarstellung.

## 4. Arbeitsstrang A: Einheitliche Seitenarchitektur

### Ziel

Start, Gedächtnis, Aufgaben und Personen erhalten einen gemeinsamen Seitenrahmen mit stabilen
Breiten, Abständen und Navigationsebenen.

### Umsetzung

- Einen wiederverwendbaren `PageShell` beziehungsweise gemeinsame CSS-Struktur für
  Seitentitel, optionale Unterseiten-Navigation, Aktionen und Inhaltsbereich einführen.
- Eine gemeinsame maximale Inhaltsbreite von zunächst `1180px` verwenden. Breitere
  Personen-Dossiers werden innerhalb des Rasters über eine zusätzliche Spalte gelöst, nicht
  über einen Wechsel auf eine vollständig andere Seitenbreite.
- Die Topbar auf den übergeordneten Bereich beschränken und die Gedächtnis-Unterseiten als
  gemeinsame Inhaltsnavigation direkt über der jeweiligen Oberfläche führen.
- Wiederholte Titel innerhalb der Inhaltsfläche entfernen, wenn der Topbar-Titel den Bereich
  bereits eindeutig bezeichnet.
- Pro Ebene genau einen aktiven Navigationszustand zeigen:
  - Sidebar: Hauptbereich,
  - Inhaltsnavigation: Gedächtnis-Unterseite,
  - Inhalts-Tabs: Darstellungsmodus des aktuellen Inhalts.
- Für kompakte Fenster eine globale Navigation als Toolbar-Schaltfläche mit Sidebar-Sheet
  oder Popover bereitstellen.
- Horizontale Unterseiten-Navigation bei geringer Breite scrollbar halten, ohne dass aktive
  Tabs abgeschnitten werden.

### Betroffene Bereiche

- `desktop/src/App.tsx`
- `desktop/src/components/layout/Sidebar.tsx`
- `desktop/src/components/layout/TopBar.tsx`
- `desktop/src/components/MemoryPage.tsx`
- `desktop/src/components/TasksPage.tsx`
- `desktop/src/components/PeoplePage.tsx`
- `desktop/src/styles.css`

### Abnahmekriterien

- Die Inhaltskante bleibt beim Wechsel zwischen Übersicht, Aufgaben und Personen stabil.
- Seitentitel und Navigation werden nicht innerhalb derselben Ansicht doppelt wiederholt.
- Start und Bibliothek bleiben bei einer Fensterbreite von 700 Pixeln erreichbar.
- Tastaturfokus und aktive Zustände sind in Sidebar, kompakter Navigation und Unterseiten-Tabs
  eindeutig sichtbar.
- Die Seiten funktionieren bei 1440, 1024 und 700 Pixeln Breite ohne horizontales
  Seiten-Scrolling.

## 5. Arbeitsstrang B: Startseite als täglicher Arbeitsplatz

### Ziel

Die Startseite beantwortet zuerst „Was ist jetzt relevant?“ und bietet danach Suche und
Archivzugriff. Aufnahme und laufende Arbeit werden zum visuellen Einstiegspunkt.

### Zielstruktur

```text
┌────────────────────────────────────────────────────────────┐
│ Fokusleiste: Aufnahme · Diktat · Verarbeitung              │
├───────────────────────────────┬────────────────────────────┤
│ Heute                         │ Zuletzt                    │
│ offene Zusagen und Aufgaben   │ Aufnahme / aktueller Stand │
├───────────────────────────────┴────────────────────────────┤
│ Archivsuche und Wissens-Chat                               │
├───────────────────────────────┬────────────────────────────┤
│ Wochen-Digest                 │ Themen-Threads             │
└───────────────────────────────┴────────────────────────────┘
```

### Umsetzung

- Aufnahme und Diktat in einer kompakten Fokusleiste bündeln; aktive Aufnahme oder laufende
  Verarbeitung darf diese Leiste temporär erweitern.
- Die wichtigsten offenen Zusagen und Aufgaben als begrenzte „Heute“-Liste darstellen. Die
  Priorisierung verwendet vorhandene Fälligkeits- und Statusinformationen.
- Die zuletzt bearbeitete oder aufgenommene Aufnahme als direkten Wiedereinstieg anzeigen.
- Archivsuche und Wissens-Chat unterhalb des Fokusbereichs weiter als große Arbeitsfläche
  anbieten, aber nicht mehr als einziges dominantes Element der Seite.
- Wochen-Digest und Themen-Threads als sekundäre Module am unteren Ende der Startseite
  gruppieren.
- Die Anordnung auf schmalen Breiten in derselben semantischen Reihenfolge stapeln:
  Fokus, Heute, Zuletzt, Suche, Digest und Threads.

### Betroffene Bereiche

- `desktop/src/components/StartPage.tsx`
- bestehende Diktat-, Digest-, Thread- und Chat-Komponenten
- gegebenenfalls gemeinsame Typen oder API-Selektoren für priorisierte Aufgaben
- `desktop/src/styles.css`

### Abnahmekriterien

- Aufnahme, Diktat und Verarbeitungsstatus sind ohne Scrollen erreichbar.
- Eine vorhandene nächste Aufgabe oder Zusage ist vor der Archivsuche sichtbar.
- Der Wissens-Chat behält alle heutigen Funktionen und denselben verfügbaren Arbeitsraum,
  sobald er aktiv genutzt wird.
- Die Reihenfolge der Bereiche bleibt zwischen Desktop- und kompakter Darstellung logisch
  identisch.
- Startseite, Chat und Diktat lassen sich vollständig per Tastatur bedienen.

## 6. Arbeitsstrang C: Quellenspur als visuelle Signatur

### Ziel

Aufgaben, Entscheidungen, Personeninformationen und relevante Suchtreffer zeigen ihre
Herkunft in einer einheitlichen, sofort erkennbaren Form.

### Komponente

Eine gemeinsame Komponente, vorläufig `EvidenceTrail`, enthält je nach Kontext:

- Themenfarbe oder neutrale Belegfarbe als schmale vertikale Spur,
- Aufnahme oder Dokument als Quelle,
- Zeitmarke beziehungsweise Dokumentstelle,
- Sprecher oder Person,
- kurzes Originalzitat, wenn genügend Platz vorhanden ist,
- Belegstatus wie vorhanden, zu prüfen oder ohne Beleg,
- direkte Aktion zum Öffnen der Originalstelle.

Die Spur bleibt kompakt und darf in Listen nicht zu einer zweiten Karte werden. In dichten
Ansichten besteht sie nur aus Linie, Symbol, Zeitmarke und Quellenname. In Detailansichten
kann sie Zitat und weitere Metadaten aufklappen.

### Visuelles Verhalten

- Hover und Tastaturfokus heben Spur und zugehörigen Inhalt gemeinsam hervor.
- Das Öffnen einer Quelle verwendet eine kurze, zurückhaltende Hervorhebung der Zielstelle.
- Zeitmarken und technische Quellenangaben nutzen die neue Monospace-Metarolle.
- Themenfarben dienen der Herkunft, Emerald kennzeichnet Bedienung oder positiven Status.
  Beides wird nicht vermischt.
- Bei `prefers-reduced-motion` entfallen Übergangsbewegungen; die Zustandsänderung bleibt über
  Kontrast und Fokus sichtbar.

### Betroffene Bereiche

- `desktop/src/components/MemoryPage.tsx`
- `desktop/src/components/TasksPage.tsx`
- `desktop/src/components/PeoplePage.tsx`
- `desktop/src/components/MeetingTimeline.tsx`
- Suchtreffer und verwendete Quellen im Wissens-Chat
- neue gemeinsame Komponente unter `desktop/src/components/`
- `desktop/src/styles.css`

### Abnahmekriterien

- Derselbe Quellentyp sieht in Gedächtnis, Aufgaben und Personen gleich aus.
- Jede dargestellte Zeitmarke öffnet weiterhin die korrekte Aufnahmeposition.
- Einträge ohne Quelle werden eindeutig gekennzeichnet, ohne eine Quelle zu suggerieren.
- Die Quellenspur funktioniert in einzeiligen Listen ebenso wie in ausführlichen
  Detailansichten.
- Farbige Herkunft bleibt auch ohne Farbwahrnehmung über Text oder Symbol verständlich.

## 7. Arbeitsstrang D: Flächenhierarchie und geringere Kartendichte — abgeschlossen

### Ziel

Wichtige Inhalte erhalten mehr Gewicht, während Kennzahlen und Filter weniger Raum und
visuelle Aufmerksamkeit beanspruchen.

### Umsetzung

- Die drei Oberflächenebenen als gemeinsame Tokens und Hilfsklassen in `styles.css`
  definieren.
- Kennzahlen im Gedächtnis als kompakte Statuszeile gruppieren. Nullwerte erhalten weniger
  Kontrast als Zustände mit Handlungsbedarf.
- Die Aufgaben-Scorecards zu einer kompakten, auswählbaren Statusleiste verdichten, ohne ihre
  Filterfunktion zu verlieren.
- Filter als zusammenhängende Werkzeugleiste darstellen und nicht als eigenständige große
  Karte behandeln.
- Listen über Rhythmus, Spaltenausrichtung und Trennlinien strukturieren; Karten nur für
  ausgewählte, interaktive oder hervorgehobene Einträge verwenden.
- Schatten auf schwebende oder hervorgehobene Flächen begrenzen. Standardabschnitte verwenden
  keinen Schatten.
- Rahmenkontrast vereinheitlichen und verschachtelte Rahmen vermeiden.

### Betroffene Bereiche

- `desktop/src/components/MemoryPage.tsx`
- `desktop/src/components/TasksPage.tsx`
- `desktop/src/components/tasks/TasksScoreboard.tsx`
- `desktop/src/components/PeoplePage.tsx`
- `desktop/src/components/StartPage.tsx`
- `desktop/src/styles.css`

### Abnahmekriterien

- Auf jeder Seite existiert genau eine klar dominante Inhaltsfläche.
- Kennzahlen und Filter bleiben bedienbar, beanspruchen aber weniger vertikale Höhe.
- Verschachtelte Karten besitzen nicht gleichzeitig Rahmen und Schatten auf mehreren Ebenen.
- Aktive Filter und ausgewählte Inhalte sind stärker als ihre Container hervorgehoben.
- Die Hierarchie bleibt im hellen und dunklen Farbschema verständlich.

## 8. Arbeitsstrang E: Prägnanteres typografisches System — abgeschlossen

### Ziel

Typografie übernimmt einen größeren Teil der Hierarchie und gibt Quellen, Zeitmarken und
Statusinformationen eine eigene funktionale Stimme.

### Typografische Rollen

| Rolle | Verwendung | Richtung |
| --- | --- | --- |
| Display | zentrale Seitenaussage oder Fokusbereich | `32–36px`, kräftig, enge Laufweite |
| Page title | Topbar und Unterseiten | `18–22px`, kräftig |
| Section title | Listen- und Modulüberschriften | `15–17px`, semibold |
| Body | Inhalte und Erklärungen | `13–15px`, normale Laufweite |
| Meta | Label, Status und Hilfstext | `11–12px`, klarer Kontrast |
| Source mono | Zeitmarken, Quellenpositionen, Laufzeiten | System-Monospace, tabellarische Ziffern |

### Umsetzung

- Bestehende lokale beziehungsweise Systemschriften beibehalten; keine externe
  Font-Abhängigkeit einführen.
- Globale Typografie-Tokens für Größe, Gewicht, Zeilenhöhe und Laufweite definieren.
- Versalien nur für kurze Eyebrows und Kategorien verwenden, nicht für längere Metatexte.
- Zahlen in Laufzeiten, Zeitmarken und Kennzahlen mit tabellarischen Ziffern setzen.
- Sehr helle Metatexte im bestehenden Farbsystem auf ausreichenden Kontrast prüfen.
- Emerald auf Aktionen, Auswahl und bestätigte Zustände konzentrieren; Rot ausschließlich für
  überfällige oder fehlerhafte Zustände einsetzen.

### Abnahmekriterien

- Seitentitel, Abschnittstitel, Inhalt und Metadaten sind ohne zusätzliche Karten eindeutig
  unterscheidbar.
- Zeitmarken springen beim Wechsel der Ziffern nicht in der Breite.
- Keine neue Webfont-Anfrage und kein zusätzlicher Startzeit- oder Offline-Nachteil entsteht.
- Text erfüllt in beiden Farbschemata mindestens WCAG-AA-Kontrast, soweit es sich nicht um rein
  dekorative Information handelt.

## 9. Umsetzung in Etappen

### Etappe 1: Fundament

- Seitenraster und gemeinsame Abstände definieren.
- Topbar, Unterseiten-Navigation und kompakte globale Navigation umsetzen.
- Typografie- und Oberflächen-Tokens einführen.
- Bestehende Seiten zunächst ohne inhaltliche Neuordnung auf das neue Fundament migrieren.

**Ergebnis:** Die App wirkt beim Navigieren bereits stabiler, ohne dass fachliche Abläufe
verändert wurden.

### Etappe 2: Startseite

- Fokusleiste, Heute-Bereich und letzten Wiedereinstieg zusammensetzen.
- Suche, Digest und Threads in die neue Informationshierarchie einordnen.
- Desktop- und Kompaktlayout gemeinsam umsetzen.

**Ergebnis:** Der Einstieg in Tarscribe richtet sich auf aktuelle Arbeit statt ausschließlich
auf Archivsuche.

### Etappe 3: Quellenspur — abgeschlossen

- `EvidenceTrail` als gemeinsame Komponente implementieren und testen.
- Zuerst Aufgaben und Gedächtnis migrieren, anschließend Personen, Timeline und Suchtreffer.
- Quellenöffnung, Zeitmarken und Tastaturfokus in jeder Ansicht verifizieren.

**Ergebnis:** Tarscribes Quellenorientierung wird zu einem wiedererkennbaren Produktmerkmal.

### Etappe 4: Verdichtung, Typografie und Theme-Feinschliff — abgeschlossen

- Scoreboards, Statuszeilen, Filter und Listen auf die neuen Oberflächenebenen umstellen.
- Rahmen, Schatten, Abstände und Metafarben konsolidieren.
- Veraltete oder doppelte CSS-Regeln entfernen.
- Helles und dunkles Farbschema sowie reduzierte Bewegung prüfen.

**Ergebnis:** Die visuelle Hierarchie ist durchgängig, und die Stylesheet-Komplexität wächst
nicht dauerhaft durch zusätzliche Überschreibungen.

## 10. Technische Leitplanken

- Bestehende Datenmodelle und APIs wiederverwenden, sofern die benötigten Herkunftsdaten
  bereits verfügbar sind.
- Fehlende Quelleninformationen nicht im Frontend ableiten oder erfinden.
- Neue gemeinsame Komponenten erhalten fokussierte Vitest-Tests für Zustände und
  Interaktionen.
- Vorhandene Navigationstests werden um kompakte Fensterbreiten und Tastaturbedienung
  erweitert.
- Responsive Regeln werden bei den jeweiligen Komponenten gebündelt; neue späte globale
  Überschreibungsblöcke in `styles.css` sollen vermieden werden.
- Animationen bleiben kurz, zweckgebunden und respektieren `prefers-reduced-motion`.

## 11. Verifikation

Jede Etappe wird in einem isolierten lokalen Datenverzeichnis mit realistischen Daten geprüft:

- ohne Aufnahmen,
- mit mehreren Themenbereichen,
- mit offenen, überfälligen und erledigten Aufgaben,
- mit belegten und unbelegten Gedächtniseinträgen,
- mit bekannten Personen und längeren Namen,
- mit laufender Verarbeitung,
- im hellen und dunklen Farbschema.

Browser-Prüfbreiten:

- `1440px`: große Desktop-Ansicht,
- `1024px`: kompaktes App-Fenster,
- `700px`: schmale Darstellung ohne Sidebar,
- zusätzlich minimale unterstützte Fenstergröße der Tauri-App.

Nach jeder Implementierungsetappe müssen mindestens diese Prüfungen erfolgreich sein:

```bash
cd desktop
npm test
npm run build
```

Bei Änderungen an Backend-Verträgen oder Datenmodellen zusätzlich:

```bash
cd backend
.venv/bin/python -m pytest
.venv/bin/python -m ruff check .
```

## 12. Definition of Done

Das Redesign ist abgeschlossen, wenn:

- alle Haupt- und Gedächtnisseiten dasselbe Seitenraster verwenden,
- die globale Navigation auch im kompakten Fenster erreichbar bleibt,
- die Startseite aktuelle Arbeit vor Suche und Archiv priorisiert,
- Aufgaben, Entscheidungen und Personeninformationen dieselbe Quellenspur verwenden,
- Kennzahlen, Filter, Listen und interaktive Flächen klar unterschiedliche Gewichtung besitzen,
- die typografischen Rollen durchgängig angewendet werden,
- alle bestehenden Funktionen, Quellenlinks und Zeitmarken erhalten bleiben,
- Frontend-Tests und Build erfolgreich sind,
- die zentralen Ansichten in den festgelegten Fensterbreiten visuell geprüft wurden.
