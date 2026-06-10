"""Database engine, session helpers, and one-time seeding."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import event
from sqlalchemy.engine import Engine
from sqlmodel import Session, SQLModel, create_engine, select

from .config import get_settings
from .models import SummaryTemplate

_engine: Engine | None = None

# Set on first connection: whether sqlite-vec loaded successfully. RAG features
# degrade gracefully (stay disabled) when this is False instead of crashing.
VEC_AVAILABLE: bool | None = None


def _on_connect(dbapi_connection, _record) -> None:  # pragma: no cover - sqlite pragma
    cur = dbapi_connection.cursor()
    cur.execute("PRAGMA foreign_keys=ON")
    cur.execute("PRAGMA journal_mode=WAL")
    # Wait briefly for a competing writer instead of failing immediately, so a
    # background index job and the job-progress writer don't collide.
    cur.execute("PRAGMA busy_timeout=5000")
    cur.close()
    _load_vec_extension(dbapi_connection)


def _load_vec_extension(dbapi_connection) -> None:
    """Load the sqlite-vec extension on a raw connection; record availability once."""
    global VEC_AVAILABLE
    try:
        import sqlite_vec

        dbapi_connection.enable_load_extension(True)
        sqlite_vec.load(dbapi_connection)
        dbapi_connection.enable_load_extension(False)
        if VEC_AVAILABLE is None:
            VEC_AVAILABLE = True
    except Exception as exc:  # noqa: BLE001
        if VEC_AVAILABLE is None:
            VEC_AVAILABLE = False
            print(f"[tarscribe] sqlite-vec unavailable, RAG disabled: {exc}")


def vec_available() -> bool:
    """True if the sqlite-vec extension loaded. Forces a connection if needed."""
    if VEC_AVAILABLE is None:
        with get_engine().connect() as conn:  # triggers _on_connect
            conn.exec_driver_sql("SELECT 1")
    return bool(VEC_AVAILABLE)


def get_engine() -> Engine:
    global _engine
    if _engine is None:
        settings = get_settings()
        _engine = create_engine(
            f"sqlite:///{settings.db_path}",
            connect_args={"check_same_thread": False},
        )
        event.listen(_engine, "connect", _on_connect)
    return _engine


def init_db() -> None:
    """Create tables and seed built-in data."""
    # Import models so they register on SQLModel.metadata before create_all.
    from . import models  # noqa: F401

    SQLModel.metadata.create_all(get_engine())
    _run_lightweight_migrations()
    _seed_builtin_templates()


def _run_lightweight_migrations() -> None:
    """Add columns introduced after a DB was first created (SQLite ADD COLUMN)."""
    from sqlalchemy import text

    additive = [
        ("topics", "export_path", "TEXT"),
        ("recordings", "exported_at", "DATETIME"),
    ]
    with get_engine().begin() as conn:
        for table, column, coltype in additive:
            cols = {row[1] for row in conn.execute(text(f"PRAGMA table_info({table})"))}
            if column not in cols:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {coltype}"))

    _ensure_vec_table()
    _mark_stale_live_sessions()


def _ensure_vec_table() -> None:
    """Create the sqlite-vec virtual table for chunk embeddings.

    The embedding dimension is model-dependent, so it is read from prefs. If the
    configured dimension changes, the vec table and all indexed chunks are dropped
    so a re-index rebuilds them at the new dimension.
    """
    if not vec_available():
        return
    from sqlalchemy import text

    from .settings_store import load_prefs

    dim = int((load_prefs().get("rag") or {}).get("dimension") or 768)
    with get_engine().begin() as conn:
        conn.execute(
            text(
                "CREATE TABLE IF NOT EXISTS rag_index_meta (key TEXT PRIMARY KEY, value TEXT)"
            )
        )
        row = conn.execute(
            text("SELECT value FROM rag_index_meta WHERE key='dimension'")
        ).fetchone()
        stored_dim = int(row[0]) if row else None
        if stored_dim is not None and stored_dim != dim:
            # Dimension changed -> wipe the index; chunks must be re-embedded.
            conn.execute(text("DROP TABLE IF EXISTS rag_chunk_vec"))
            conn.execute(text("DELETE FROM rag_chunks"))
            stored_dim = None
        conn.execute(
            text(
                f"CREATE VIRTUAL TABLE IF NOT EXISTS rag_chunk_vec USING vec0("
                f"embedding float[{dim}], topic_id integer, recording_id integer)"
            )
        )
        if stored_dim != dim:
            conn.execute(
                text(
                    "INSERT INTO rag_index_meta (key, value) VALUES ('dimension', :d) "
                    "ON CONFLICT(key) DO UPDATE SET value=excluded.value"
                ),
                {"d": str(dim)},
            )


def _mark_stale_live_sessions() -> None:
    """Mark active live sessions from a previous run as failed and remove their PCM files."""
    import shutil
    from pathlib import Path

    from sqlalchemy import text

    active_statuses = ("starting", "recording", "paused", "finalizing")
    placeholders = ",".join(f"'{s}'" for s in active_statuses)
    with get_engine().begin() as conn:
        tables = {row[0] for row in conn.execute(text("SELECT name FROM sqlite_master WHERE type='table'"))}
        if "live_recording_sessions" not in tables:
            return
        rows = conn.execute(
            text(f"SELECT pcm_path FROM live_recording_sessions WHERE status IN ({placeholders})")
        ).fetchall()
        conn.execute(
            text(
                f"UPDATE live_recording_sessions"
                f" SET status='failed', error='Backend unerwartet beendet'"
                f" WHERE status IN ({placeholders})"
            )
        )

    for (pcm_path,) in rows:
        if pcm_path:
            try:
                shutil.rmtree(Path(pcm_path).parent, ignore_errors=True)
            except Exception:
                pass


@contextmanager
def session_scope() -> Iterator[Session]:
    session = Session(get_engine())
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def get_session() -> Iterator[Session]:
    """FastAPI dependency."""
    with Session(get_engine()) as session:
        yield session


BUILTIN_TEMPLATES = [
    SummaryTemplate(
        name="Meeting-Protokoll",
        system_prompt=(
            "Du bist ein präziser Protokollant. Erstelle Meeting-Protokolle als vollständige "
            "Obsidian-Markdown-Notizen mit YAML-Frontmatter, klaren Abschnittsüberschriften und "
            "Obsidian-Callouts (> [!important]) für Entscheidungen. "
            "Halte dich strikt ans Transkript — keine Erfindungen."
        ),
        user_prompt_template=(
            "Erstelle ein Meeting-Protokoll für das Thema «{{topic}}» vom {{date}} als Obsidian-Notiz.\n\n"
            "Beginne zwingend mit diesem YAML-Frontmatter (Werte unverändert übernehmen):\n"
            "---\n"
            'title: "Meeting – {{topic}}"\n'
            "date: {{date_iso}}\n"
            "participants: [{{speakers}}]\n"
            "duration: {{duration}}\n"
            "tags:\n"
            "  - meeting\n"
            "  - tarscribe\n"
            "---\n\n"
            "Danach diese Abschnitte:\n\n"
            "## Teilnehmer\n"
            "Liste der Teilnehmer aus dem Transkript.\n\n"
            "## Besprochene Punkte\n"
            "Nummerierte Liste aller Gesprächsthemen.\n\n"
            "## Entscheidungen\n"
            "Falls Entscheidungen gefallen sind, als Obsidian-Callout:\n"
            "> [!important] Entscheidungen\n"
            "> - Entscheidung 1\n\n"
            "## Offene Fragen & Nächste Schritte\n"
            "Als Checkliste (- [ ] Aufgabe — Verantwortliche Person).\n\n"
            "Transkript:\n{{transcript}}"
        ),
        output_format="markdown",
        is_builtin=True,
    ),
    SummaryTemplate(
        name="Action Items / To-dos",
        system_prompt=(
            "Du extrahierst konkrete, umsetzbare Aufgaben aus Gesprächen und gibst sie als "
            "Obsidian-Checkliste aus. Jeder Punkt beginnt mit - [ ]. Nenne verantwortliche Person "
            "und Frist wenn erkennbar. Keine Erfindungen."
        ),
        user_prompt_template=(
            "Extrahiere alle Action Items aus dem Transkript als Obsidian-Checkliste.\n\n"
            "Format pro Eintrag:\n"
            "- [ ] **Aufgabe** — *Verantwortliche Person* (Frist falls genannt)\n\n"
            "Regeln:\n"
            "- Nur konkrete, zuordenbare Aufgaben aus dem Transkript\n"
            "- Gruppiere nach Verantwortlichen (## Name als Überschrift), bekannte Namen: {{speakers}}\n"
            "- Nicht zuordenbare Aufgaben unter ## Offen\n"
            "- Kein einleitender Text, beginne direkt mit der Liste\n\n"
            "Transkript:\n{{transcript}}"
        ),
        output_format="markdown",
        is_builtin=True,
    ),
    SummaryTemplate(
        name="Vorlesungs-Zusammenfassung",
        system_prompt=(
            "Du bist ein Lernassistent, der Vorlesungen als strukturierte Obsidian-Lernnotizen "
            "zusammenfasst. Verwende YAML-Frontmatter, hierarchische Überschriften, "
            "> [!note]-Callouts für Definitionen und - [ ]-Checklisten für Nacharbeit. "
            "Nur Inhalte aus dem Transkript."
        ),
        user_prompt_template=(
            "Fasse die Vorlesung «{{topic}}» vom {{date}} als Obsidian-Lernnotiz zusammen.\n\n"
            "Beginne zwingend mit diesem YAML-Frontmatter:\n"
            "---\n"
            'title: "{{topic}}"\n'
            "date: {{date_iso}}\n"
            "duration: {{duration}}\n"
            "tags:\n"
            "  - vorlesung\n"
            "  - tarscribe\n"
            "---\n\n"
            "Danach diese Struktur:\n\n"
            "## Überblick\n"
            "2–3 Sätze zur Einordnung des Themas.\n\n"
            "## Kernkonzepte\n"
            "Für jedes Konzept eine eigene ### Überschrift mit kurzer Erklärung.\n\n"
            "## Definitionen & Begriffe\n"
            "> [!note] Definitionen\n"
            "> **Begriff:** Erklärung\n\n"
            "## Zum Nacharbeiten\n"
            "- [ ] Offene Frage oder zu vertiefendes Thema\n\n"
            "Transkript:\n{{transcript}}"
        ),
        output_format="markdown",
        is_builtin=True,
    ),
    SummaryTemplate(
        name="Kurz-Abstract",
        system_prompt=(
            "Du schreibst knappe, präzise Zusammenfassungen in maximal 5 Sätzen. "
            "Sachlich, ohne Floskeln."
        ),
        user_prompt_template=(
            "Fasse das folgende Transkript in einem Obsidian-Callout von maximal 5 Sätzen zusammen.\n\n"
            "Ausgabeformat (exakt so):\n"
            "> [!abstract] Zusammenfassung\n"
            "> Satz 1. Satz 2. Satz 3.\n\n"
            "Kein weiterer Text davor oder danach.\n\n"
            "Transkript:\n{{transcript}}"
        ),
        output_format="markdown",
        is_builtin=True,
    ),
    SummaryTemplate(
        name="Q&A-Extraktion",
        system_prompt=(
            "Du extrahierst Frage-Antwort-Paare aus Gesprächen und formatierst jedes Paar als "
            "Obsidian-Callout. Nur tatsächlich gestellte Fragen und ihre Antworten aus dem Transkript."
        ),
        user_prompt_template=(
            "Extrahiere alle Fragen und Antworten aus dem Transkript als Obsidian-Callouts.\n\n"
            "Format für jedes Q&A-Paar:\n"
            "> [!question] Frage\n"
            "> **A:** Antworttext\n\n"
            "Falls eine Frage unbeantwortet blieb:\n"
            "> [!question] Frage\n"
            "> **A:** *Keine eindeutige Antwort im Gespräch.*\n\n"
            "Kein einleitender Text, beginne direkt mit dem ersten Callout.\n\n"
            "Transkript:\n{{transcript}}"
        ),
        output_format="markdown",
        is_builtin=True,
    ),
]


def _seed_builtin_templates() -> None:
    """Upsert built-in templates by name so updates reach existing installations."""
    with session_scope() as session:
        for tpl in BUILTIN_TEMPLATES:
            existing = session.exec(
                select(SummaryTemplate).where(
                    SummaryTemplate.name == tpl.name,
                    SummaryTemplate.is_builtin == True,  # noqa: E712
                )
            ).first()
            if existing is None:
                session.add(tpl)
            else:
                existing.system_prompt = tpl.system_prompt
                existing.user_prompt_template = tpl.user_prompt_template
                existing.output_format = tpl.output_format
                session.add(existing)
