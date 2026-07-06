# Plan: Agentic RAG + App-Logo oben links

Status: verabschiedet. Zwei unabhängige Änderungen.

---

## Teil A — Agentic RAG für alle LLM-basierten Analysen

### Ziel

Das LLM soll vor jeder generierenden Aufgabe (Zusammenfassung, Action Items,
Kapitel, Diktat, Digest) aktiv und iterativ den internen RAG-Index durchsuchen
koennen, bis es genug Kontext hat. Native OpenAI-`tools`-Schnittstelle mit
automatischem Fallback auf die bestehende One-Shot-RAG-Anreicherung, wenn das
Modell keine Tools unterstuetzt.

### Design-Entscheidungen

1. **Native OpenAI `tools`** + automatischer Fallback auf aktuelle One-Shot-RAG-Anreicherung.
2. **Opt-in** ueber neuen Pref (Default `false`). Alte Pipeline bleibt als Fallback.
3. **Loop-Limits konfigurierbar**: `max_rounds` (Default 5), `max_context_tokens` (Default 12000).
4. **Scope: alle LLM-Schritte** — Summaries, Action Items, Chapters, Dictation, Digest.

---

### Phase 1 — Preferences (`backend/tarscribe_backend/settings_store.py`)

In `DEFAULT_PREFS` (`settings_store.py:30-66`) ergaenzen:

```python
"agent_rag_enabled": False,          # Hauptschalter (Default aus)
"agent_rag": {
    "max_rounds": 5,                 # max Tool-Call-Runden
    "max_context_tokens": 12000,     # Token-Budget fuer gesammelten Kontext
    "top_k": 6,                      # Treffer pro Suche
},
```

Zusaetzlich Hilfsfunktion `get_agent_rag_config() -> dict` analog zu
`get_llm_config()` / `get_rag_config()`. Liefert gemergte Prefs + RAG-Status.

---

### Phase 2 — Transport-Erweiterung (`backend/tarscribe_backend/llm.py`)

#### 2a. `_chat_payload` erweitern (`llm.py:62-89`)

Zwei neue optionale Parameter:

```python
def _chat_payload(messages, model, temperature, top_p, top_k, max_tokens,
                  reasoning_effort, provider, tools=None, tool_choice=None) -> dict:
```

Einfuegen, wenn gesetzt:

```python
if tools is not None:
    payload["tools"] = tools
if tool_choice is not None:
    payload["tool_choice"] = tool_choice
```

`stream` bleibt `True` fuer Content-Streaming, wird aber fuer Tool-Runden auf
`False` gesetzt (siehe 2b).

#### 2b. Neue non-streaming Chat-Funktion fuer Tool-Runden

Tool-Loops brauchen die volle Response (mit `tool_calls`), nicht inkrementelle
Deltas. Neue Funktion:

```python
async def achat_complete(messages, model, base_url, temperature=0.3,
                         top_p=None, top_k=None, max_tokens=None,
                         api_key=None, reasoning_effort=None, provider=None,
                         tools=None, tool_choice=None) -> dict:
    """Non-streaming completion. Liefert vollstaendiges choice dict:
       {"message": {"role","content","tool_calls"}, "finish_reason"}.
       Verwendet stream=False. Parsed choices[0].message (nicht delta)."""
```

Nutzt `httpx.AsyncClient` (analog `astream_chat:144-180`), aber
`payload["stream"] = False`. Returned dict enthaelt `content` (str|None) und
`tool_calls` (list|None).

Sync-Variante `chat_complete(...)` fuer Digest (`insights.py` nutzt sync
`L.stream_chat`).

#### 2c. `_parse_stream_line` unveraendert lassen

Bestehende Streaming-Funktion (`astream_chat`) bleibt fuer die finale
Streaming-Generierung der Zusammenfassung (WS-UX) erhalten. Tool-Runden nutzen
`achat_complete` (non-streaming). Keine Aenderung an `_parse_stream_line:92-102`.

---

### Phase 3 — Neues Modul `backend/tarscribe_backend/agent.py` (Kern-Loop)

#### 3a. Tool-Definition (OpenAI JSON Schema)

```python
SEARCH_KNOWLEDGE_TOOL = {
    "type": "function",
    "function": {
        "name": "search_knowledge",
        "description": (
            "Durchsuche die Tarscribe-Wissensbasis (Transkripte, "
            "Zusammenfassungen, Dokumente) nach relevantem Kontext. "
            "Rufe dies mehrfach mit unterschiedlichen Queries ab, bis "
            "du genug Kontext gesammelt hast."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Suchanfrage — natuerliche Sprache oder Schlagworte.",
                },
                "scope": {
                    "type": "string",
                    "enum": ["topic", "recording", "all"],
                    "description": "Suchbereich: Topic, aktuelles Recording oder alles.",
                    "default": "topic",
                },
            },
            "required": ["query"],
        },
    },
}
```

#### 3b. Token-Schaetzer

Kein `tiktoken` (kein SDK). Char-basierte Heuristik (~4 chars/token fuer
Deutsch/Englisch):

```python
def _estimate_tokens(text: str) -> int:
    return max(1, len(text) // 4)
```

#### 3c. Tool-Dispatcher

```python
def _execute_tool(session, tool_name, arguments, *, topic_id, recording_id, top_k) -> str:
    """Fuehrt einen Tool-Call aus, liefert JSON-String fuer die tool-Nachricht."""
    if tool_name == "search_knowledge":
        scope = arguments.get("scope", "topic")
        if scope == "recording" and recording_id:
            hits = R.search(session, arguments["query"], top_k=top_k, recording_id=recording_id)
        elif scope == "all":
            hits = R.search(session, arguments["query"], top_k=top_k)
        else:  # topic
            hits = R.retrieve_topic_knowledge(
                session, arguments["query"], topic_id=topic_id,
                exclude_recording_id=recording_id, top_k=top_k
            )
        return json.dumps(_compact_hits(hits), ensure_ascii=False)
```

`_compact_hits` reduziert jeden Hit auf `{title, source_type, text}` (keine
internen IDs/distances) um Token zu sparen.

#### 3d. Core-Loop

```python
async def research_context(*, session, topic_id, recording_id, task_description,
                           messages_seed, cfg, job_id=None) -> tuple[str, list[dict]]:
    """
    Fuehrt den agentischen Retrieval-Loop aus.

    Args:
        task_description: was wir kontext recherchieren (z.B. "Zusammenfassung erstellen")
        messages_seed: [system, user] — der initiale Prompt mit Transkript/Aufgabe
        cfg: {model, base_url, api_key, temperature, top_p, top_k, max_rounds,
              max_context_tokens, provider}
        job_id: fuer Cancellation-Checks

    Returns:
        (research_notes: str, sources: list[dict])
        - research_notes: gesammelte Kontext-Passagen als formatierter Block
        - sources: fuer _save_summary_sources
    """
```

Loop-Logik:
1. `messages = list(messages_seed)` + System-Prompt: *"Du recherchierst Kontext.
   Verwende search_knowledge, um relevante Passagen zu finden. Stelle gezielte
   Queries. Wenn du genug hast, antworte kurz mit 'Kontext ausreichend'."*
2. `accumulated_sources = []`, `accumulated_tokens = 0`
3. For `round in range(max_rounds)`:
   - `_raise_if_canceled(job_id)` (wenn job_id)
   - `resp = await L.achat_complete(messages, tools=[SEARCH_KNOWLEDGE_TOOL],
     tool_choice="auto", ...)`
   - `msg = resp["message"]`; `messages.append(msg)`
   - Wenn `msg.tool_calls` leer -> **Loop beenden** (Modell sagt "genug")
   - Fuer jeden `tool_call` in `msg.tool_calls`:
     - `_execute_tool(...)` -> `tool_result_json`
     - `messages.append({"role":"tool","tool_call_id":tool_call.id,
       "content":tool_result_json})`
     - SchaeTze Tokens von `tool_result_json`; `accumulated_tokens += est`
     - Sammle `sources` aus Hits
   - Wenn `accumulated_tokens >= max_context_tokens` -> **Loop beenden** (Budget
     erschoepft). Hinweis an Modell: "Kontext-Budget erreicht."
4. Finales `research_notes` = formatierte Quelle aus `accumulated_sources` (wie
   `_format_topic_knowledge` in `jobs.py:574-584`).
5. Return `(research_notes, sources)`.

#### 3e. Agent-Chat-Callable fuer `analysis.py`-Funktionen

Fuer Action Items / Chapters / Dictation, die `AsyncChat` nutzen
(`analysis.py:14-15`):

```python
def make_agent_chat_async(*, session_factory, topic_id, recording_id, cfg,
                          job_id=None) -> AsyncChat:
    """
    Liefert eine AsyncChat-kompatible Callable.
    Wenn aufgerufen mit messages:
      1. Fuehrt research_context Loop aus (nur wenn agent_rag_enabled UND rag_enabled)
      2. Injiziert research_notes in die messages
      3. Fuehrt finalen Chat-Call aus (non-streaming, mit tools falls unterstuetzt)
      4. Liefert finalen Content als str
    """
    async def _chat(messages: list[dict]) -> str:
        ...
    return _chat
```

**Vorteil**: `extract_action_items_async`, `generate_chapters_async`,
`analyze_dictation_async` brauchen keine Signaturaenderung — nur der Caller in
`jobs.py` tauscht `_llm_chat_fn_async()` gegen `make_agent_chat_async(...)`.

---

### Phase 4 — Einbindung: Summaries (`backend/tarscribe_backend/jobs.py`)

Die Zusammenfassung ist speziell: finale Generierung **muss streamen** (WS-UX).
Daher zweiphasig.

#### 4a. Neue Research-Phase (ersetzt/ergaenzt Phase D, `jobs.py:800-826`)

```python
# Nach Phase C (Prompt gebaut), vor Phase E (Streaming):
research_notes = ""
research_sources = []
if agent_rag_enabled and R.rag_enabled():
    try:
        with session_scope() as rs:
            research_notes, research_sources = await agent.research_context(
                session=rs, topic_id=topic_id, recording_id=recording_id,
                task_description="Zusammenfassung erstellen",
                messages_seed=[{"role":"system","content":research_system_prompt},
                               {"role":"user","content":user_prompt}],
                cfg=agent_cfg, job_id=job_id,
            )
        if research_sources:
            _save_summary_sources(summary_id, research_sources)
        if research_notes:
            system_prompt += "\n\n--- Rechercheurierter Kontext ---\n" + research_notes
    except Exception:
        traceback.print_exc()  # -> Fallback zu Plain Summary
elif use_topic_knowledge and R.rag_enabled():
    # BESTEHENDE One-Shot-Anreicherung (Phase D, jobs.py:800-826) — bleibt als Fallback
    ...
```

#### 4b. Streaming-Generierung unveraendert

Phase E (`jobs.py:833-871`) `L.astream_chat` bleibt — nur `messages` enthalten
jetzt ggf. die research_notes im System-Prompt. WS-Streaming, throttled DB
save, finalize — alles wie gehabt.

#### 4c. Map-Reduce-Interaktion

Wenn `chunk_text` >1 Chunk (`jobs.py:754-777`): Research laeuft **vor** dem
Map-Reduce mit gekuerztem Transkript-Extrakt -> `research_notes` -> in finalen
Summary-Call injizieren. Map-Reduce nur fuer Chunk-Pre-Summary, nicht fuer
Research.

---

### Phase 5 — Einbindung: Action Items (`jobs.py:954-996`)

`_run_action_items_async` baut aktuell `chat = _llm_chat_fn_async()`
(`jobs.py:962`).

```python
if agent_rag_enabled and R.rag_enabled():
    chat = agent.make_agent_chat_async(
        session_factory=session_scope, topic_id=topic_id,
        recording_id=recording_id, cfg=agent_cfg, job_id=job_id,
    )
else:
    chat = _llm_chat_fn_async()
```

`analysis.extract_action_items_async(chat, ...)` (`jobs.py:976`) — keine
Aenderung. Der agent-chat fuehrt intern Research -> finalen Call -> returned
JSON.

---

### Phase 6 — Einbindung: Chapters (`analysis.py:460-505`)

Analog: `_run_chapters_async` (in `jobs.py`, aehnlich wie action items) tauscht
das Callable.

---

### Phase 7 — Einbindung: Dictation (`analysis.py:327-377`)

`analyze_dictation_async` wird aufgerufen in der Live-/Dictation-Pipeline.
Gleiche Callable-Tausch-Logik. Hier `topic_id` ggf. `None` (neues Recording) ->
Research ueberspringen oder scope="all".

---

### Phase 8 — Einbindung: Digest (`routers/insights.py:713-788`)

`_generate_digest_markdown` ruft `L.stream_chat` direkt (sync, kein Callable).
Umbau:

```python
if agent_rag_enabled and R.rag_enabled():
    content, model = agent.generate_digest_with_research(
        session_scope=session_scope, cfg=agent_cfg, ...
    )
else:
    content, model = _generate_digest_markdown(...)  # bestehend
```

Oder: `agent.research_context_sync(...)` + bestehender
`_generate_digest_markdown` mit angereichertem Prompt.

---

### Phase 9 — Capability-Detection & Fallback

#### 9a. Wann Fallback?

1. **API-Fehler** bei Tool-Call (HTTP 400/422 mit "tools"/"function" in
   Fehlermeldung) -> Modell/Endpoint unterstuetzt keine Tools.
2. **Modell ignoriert Tools**: Round 1 returned Content ohne `tool_calls` ->
   Modell hat sich entschieden, keine Suche zu machen. Legitime Entscheidung.
   Behandle als "keine Research noetig" -> `research_notes = ""` -> Plain
   Summary. Optional: Fallback auf One-Shot `retrieve_topic_knowledge`.

#### 9b. Caching

Capability pro Model speichern (in-memory Dict `{model: bool}` oder in
`settings.json` als `agent_rag.capable_models: list[str]`). Vermeidet
wiederholte fehlgeschlagene Tool-Calls.

#### 9c. Fallback-Reihenfolge

```
agent_rag_enabled AND rag_enabled AND model_supports_tools?
  -> YES: agent.research_context (Tool-Loop)
  -> NO (model lacks tools): bestehende One-Shot retrieve_topic_knowledge (Phase D)
  -> NO (rag disabled): Plain Summary
```

---

### Phase 10 — Cancellation-Integration

- `agent.research_context` und `make_agent_chat_async` erhalten `job_id`.
- `_raise_if_canceled(job_id)` (`jobs.py:144-146`) wird pro Runde und pro
  Tool-Call geprueft.
- Laeuft auf `tarscribe-async-jobs` Loop (via `_submit_llm_job`) —
  `future.cancel()` schliesst HTTP-Streams.
- `achat_complete` nutzt `httpx.AsyncClient` (cancellable wie `astream_chat`).

---

### Phase 11 — Token-Budget-Management

- `max_context_tokens` (Default 12000) begrenzt gesammelten Research-Kontext.
- `_estimate_tokens(text) = len(text) // 4` (Heuristik, kein SDK).
- Pro Tool-Result: Tokens kumulieren. Bei Ueberschreitung: Loop-Abbruch, Modell
  erhaelt Hinweis.
- Finaler Summary-Call bekommt `research_notes` (budgetiert) + Transkript. Falls
  Transkript + notes Context-Limit ueberschreitet -> bestehendes Map-Reduce
  (`chunk_text`).

---

### Phase 12 — Testing-Strategie

#### Unit-Tests (neu: `tests/test_agent.py`)

- `research_context` mit gemocktem `L.achat_complete` (returned tool_calls ->
  dann content) -> prueft Loop, Token-Budget, Cancellation.
- `_execute_tool` mit gemocktem `R.search` -> prueft Scope-Dispatch, JSON-Format.
- `_estimate_tokens` Edge-Cases.
- Fallback: Tool-Call wirft 400 -> Fallback auf `retrieve_topic_knowledge`.
- `make_agent_chat_async` -> returned Callable, die Research + Final-Call
  kombiniert.

#### Integration-Tests (erweitert `tests/test_api.py`, `tests/test_jobs.py`)

- Summary mit `agent_rag_enabled=True` + gemocktem LLM (tool_calls) -> prueft
  `Summary.sources` gesetzt, Content enthaelt Research.
- Summary mit `agent_rag_enabled=True` + LLM ohne tool_calls -> Fallback zu
  One-Shot oder Plain.
- Action Items / Chapters / Dictation mit Agent-Chat -> prueft Research
  injiziert.
- Pref `False` -> bestehende Pipeline unveraendert (Regression).

#### Backend-Checks

```bash
cd backend && .venv/bin/python -m pytest
cd backend && .venv/bin/python -m ruff check .
```

---

## Teil B — App-Logo oben links

### Fundstelle

- **Platzhalter**: `desktop/src/components/layout/Sidebar.tsx:34-37` —
  `.brand-mark` rendert `LogoIcon` (Inline-SVG mit vertikalen Balken,
  `desktop/src/components/icons.tsx:15-21`). Das ist der Platzhalter oben
  links in der Sidebar.
- **Echtes App-Icon**: `desktop/src-tauri/icons/icon.png` (512x512 RGBA), plus
  `128x128.png`, `32x32.png`.
- **Styles**: `desktop/src/styles.css:107-120` — `.brand-mark` ist 36x36px mit
  Accent-Rahmen/Hintergrund (fuer Line-Art-Icon ausgelegt); `.brand .logo`
  22x22.
- **CSP**: `img-src 'self' blob: data:` — Same-Origin-PNGs sind erlaubt.

### Design-Entscheidung

Logo ohne Rahmen, 32px PNG direkt (Accent-Box entfernen, PNG direkt 32px mit
leicht abgerundeten Ecken — wirkt wie ein echtes App-Icon, sauberer Look).

### Schritt L1 — Asset bereitstellen

Kopiere `desktop/src-tauri/icons/128x128.png` -> `desktop/public/logo.png`
(128px reicht fuer Retina @ 32px Display-Groesse; `public/` wird von
Vite/Tauri unter Same-Origin ausgeliefert -> CSP-konform).

### Schritt L2 — `desktop/src/components/layout/Sidebar.tsx` anpassen

Ersetze in `Sidebar.tsx:34-37`:

```tsx
<div className="brand">
  <img src="logo.png" alt="Tarscribe" className="brand-logo" />
  <div className="brand-name">Tarscribe</div>
</div>
```

`LogoIcon`-Import (`Sidebar.tsx:2`) entfernen. Optional `LogoIcon` aus
`icons.tsx:15-21` loeschen, falls nirgends sonst genutzt (nur `Sidebar.tsx`
importiert es).

### Schritt L3 — CSS anpassen (`desktop/src/styles.css:98-129`)

- `.brand-mark`-Rahmen entfernen (Accent-Rahmen/Hintergrund war fuer Line-Art
  gedacht — mit farbigem PNG wirkt das eingeengt).
- Neue Regel:

```css
.brand .brand-logo {
  width: 32px;
  height: 32px;
  border-radius: 8px;       /* abgerundete Ecken wie App-Icon */
  object-fit: contain;
}
```

- `.brand-name` ggf. aufraeumen (bestehende Regeln fuer `.brand` / `.brand span`
  beibehalten oder anpassen).

### Schritt L4 — Verifizieren

- `cd desktop && npm run build` (tsc + vite) — stellt sicher, dass keine
  ungenutzten Importe/Typfehler bleiben.
- `cd desktop && npm test` — falls Sidebar in Tests snapshotiert wird.
- Visueller Check: App startet, Logo oben links gerendert, CSP-Verletzung in
  DevTools-Konsole? (sollte keine sein).

---

## Implementierungsreihenfolge (konsolidiert)

| Phase | Was | Datei(en) | Testbar? |
|-------|-----|-----------|----------|
| B-L1 | Asset kopieren | `desktop/public/logo.png` | Visuell |
| B-L2 | Sidebar: PNG statt LogoIcon | `desktop/src/components/layout/Sidebar.tsx` | Build/Test |
| B-L3 | CSS anpassen | `desktop/src/styles.css` | Visuell |
| B-L4 | Frontend-Verifikation | — | `npm run build` + `npm test` |
| A-1 | Preferences + `get_agent_rag_config()` | `backend/tarscribe_backend/settings_store.py` | Unit |
| A-2 | `achat_complete` / `chat_complete` + `_chat_payload` tools | `backend/tarscribe_backend/llm.py` | Unit (mock httpx) |
| A-3 | `agent.py`: Tool-Def, Dispatcher, `research_context`, `make_agent_chat_async` | `backend/tarscribe_backend/agent.py` (neu) | Unit (mock L+R) |
| A-4 | Summaries: Research-Phase in `_run_summary_async` | `backend/tarscribe_backend/jobs.py` | Integration |
| A-5 | Action Items / Chapters / Dictation: Callable-Tausch | `backend/tarscribe_backend/jobs.py` | Integration |
| A-6 | Digest | `backend/tarscribe_backend/routers/insights.py` | Integration |
| A-7 | Capability-Detection + Caching | `backend/tarscribe_backend/agent.py`, `backend/tarscribe_backend/llm.py` | Unit |
| A-8 | Tests gruen, Lint gruen | — | `pytest` + `ruff` |

Teil B ist unabhaengig und kann zuerst (schneller Win) oder parallel umgesetzt
werden. Teil A Phasen 1-3 sind rein additiv (kein Verhalten aendert sich, da
Pref default `false`). Phasen 4-8 aktivieren den neuen Pfad nur wenn Pref an.

---

## Risiko & Fallback-Garantie (Teil A)

- **Pref `agent_rag_enabled` default `false`** -> null Verhaltensaenderung fuer
  bestehende Nutzer.
- **Alle Agent-Pfade in try/except** -> jeder Fehler degradiert zur bestehenden
  Pipeline.
- **Capability-Caching** -> wiederholte fehlgeschlagene Tool-Calls werden
  vermieden.
- **Keine Aenderung an Streaming-UX** -> Summary streamt weiterhin ueber WS.

## Risiko (Teil B)

- Minimal: Asset-Fallback, falls `logo.png` fehlt -> `<img>` zeigt nichts;
  Build schlaegt nicht fehl. Visueller Check in Schritt L4.
- CSP bleibt gueltig (`img-src 'self'` deckt Same-Origin-PNG aus `public/` ab).
