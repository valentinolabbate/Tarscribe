"""Database engine, session helpers, and one-time seeding."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import event
from sqlalchemy.engine import Engine
from sqlalchemy.schema import CreateIndex, CreateTable
from sqlmodel import Session, SQLModel, create_engine, select

from .config import get_settings
from .models import SummaryTemplate

_engine: Engine | None = None

# Set on first connection: whether sqlite-vec loaded successfully. RAG features
# degrade gracefully (stay disabled) when this is False instead of crashing.
VEC_AVAILABLE: bool | None = None

# Whether the FTS5 keyword index could be created (set during migrations).
FTS_AVAILABLE: bool = False

_CASCADE_FK_ONDELETE = {
    "transcripts": {"recording_id": "CASCADE"},
    "words": {"transcript_id": "CASCADE"},
    "diarization_runs": {"recording_id": "CASCADE"},
    "speaker_segments": {"run_id": "CASCADE"},
    "speaker_labels": {"recording_id": "CASCADE", "known_speaker_id": "SET NULL"},
    "manual_edits": {"recording_id": "CASCADE"},
    "summaries": {"recording_id": "CASCADE"},
    "documents": {"topic_id": "CASCADE", "recording_id": "CASCADE"},
    "rag_chunks": {
        "recording_id": "CASCADE",
        "summary_id": "CASCADE",
        "document_id": "CASCADE",
    },
    "chat_sessions": {"recording_id": "CASCADE", "topic_id": "SET NULL"},
    "chat_messages": {"session_id": "CASCADE"},
    "action_items": {"recording_id": "CASCADE"},
    "chapters": {"recording_id": "CASCADE"},
    "thread_mentions": {
        "thread_id": "CASCADE",
        "recording_id": "CASCADE",
        "chapter_id": "SET NULL",
        "chunk_id": "SET NULL",
    },
    "jobs": {"recording_id": "CASCADE"},
    "live_recording_sessions": {
        "topic_id": "CASCADE",
        "finalized_recording_id": "CASCADE",
    },
}


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
        ("topics", "calendar_export_mode", "TEXT DEFAULT 'off'"),
        ("topics", "calendar_url", "TEXT"),
        ("topics", "position", "INTEGER DEFAULT 0"),
        ("recordings", "kind", "TEXT DEFAULT 'recording'"),
        ("recordings", "exported_at", "DATETIME"),
        ("action_items", "due_date", "TEXT"),
        ("action_items", "include_in_tasks", "INTEGER DEFAULT 0"),
        ("action_items", "calendar_uid", "TEXT"),
        ("action_items", "calendar_href", "TEXT"),
        ("action_items", "calendar_etag", "TEXT"),
        ("action_items", "calendar_status", "TEXT DEFAULT 'idle'"),
        ("action_items", "calendar_error", "TEXT"),
        ("action_items", "calendar_exported_at", "DATETIME"),
        ("summaries", "sources", "TEXT"),
        ("summaries", "generated_content", "TEXT"),
        ("summaries", "revision", "INTEGER DEFAULT 0"),
        ("summaries", "updated_at", "DATETIME"),
    ]
    with get_engine().begin() as conn:
        for table, column, coltype in additive:
            cols = {row[1] for row in conn.execute(text(f"PRAGMA table_info({table})"))}
            if column not in cols:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {coltype}"))
                if (table, column) == ("topics", "position"):
                    # Seed existing rows with their creation order so the sidebar
                    # keeps a stable arrangement until the user reorders manually.
                    conn.execute(
                        text(
                            "UPDATE topics SET position = ("
                            "  SELECT COUNT(*) FROM topics AS t2"
                            "  WHERE t2.created_at < topics.created_at"
                            "     OR (t2.created_at = topics.created_at AND t2.id < topics.id)"
                            ")"
                        )
                    )
        conn.execute(text("UPDATE summaries SET revision = 0 WHERE revision IS NULL"))
        conn.execute(
            text("UPDATE summaries SET updated_at = created_at WHERE updated_at IS NULL")
        )

    _migrate_rag_chunks_for_documents()
    _migrate_cascade_foreign_keys()
    _ensure_vec_table()
    _ensure_fts_table()
    _mark_stale_live_sessions()
    _mark_stale_jobs()


def _migrate_rag_chunks_for_documents() -> None:
    """Make rag_chunks.recording_id nullable and add a document_id column.

    Topic-level document chunks have no recording_id, which the original
    NOT NULL column rejected; SQLite can't relax NOT NULL in place, so the
    table is rebuilt once. Chunk ids are preserved so the sqlite-vec and FTS
    rows (keyed by rag_chunks.id) stay in sync without a re-index.
    """
    import sqlite3

    from sqlalchemy import text

    with get_engine().begin() as conn:
        tables = {
            r[0]
            for r in conn.execute(text("SELECT name FROM sqlite_master WHERE type='table'"))
        }
        if "rag_chunks" not in tables:
            return  # fresh DB: create_all already built the new schema
        cols = {r[1] for r in conn.execute(text("PRAGMA table_info(rag_chunks)"))}
        if "document_id" in cols:
            return  # already migrated

    # Rebuild with foreign keys disabled (the standard SQLite table-rebuild
    # procedure). A plain sqlite3 connection in autocommit mode is used so the
    # PRAGMA actually takes effect — it is a no-op inside an open transaction.
    conn = sqlite3.connect(str(get_settings().db_path))
    conn.isolation_level = None
    try:
        conn.execute("PRAGMA foreign_keys=OFF")
        conn.execute("BEGIN")
        conn.execute(
            "CREATE TABLE rag_chunks_new ("
            " id INTEGER PRIMARY KEY,"
            " recording_id INTEGER REFERENCES recordings(id),"
            " topic_id INTEGER NOT NULL,"
            " summary_id INTEGER REFERENCES summaries(id),"
            " document_id INTEGER REFERENCES documents(id),"
            " source_type VARCHAR NOT NULL,"
            " chunk_index INTEGER NOT NULL,"
            " text VARCHAR NOT NULL,"
            " start_sec FLOAT,"
            " end_sec FLOAT,"
            " speaker VARCHAR,"
            " content_hash VARCHAR NOT NULL,"
            " embed_model VARCHAR NOT NULL,"
            " created_at DATETIME NOT NULL)"
        )
        conn.execute(
            "INSERT INTO rag_chunks_new"
            " (id, recording_id, topic_id, summary_id, document_id, source_type,"
            "  chunk_index, text, start_sec, end_sec, speaker, content_hash,"
            "  embed_model, created_at)"
            " SELECT id, recording_id, topic_id, summary_id, NULL, source_type,"
            "  chunk_index, text, start_sec, end_sec, speaker, content_hash,"
            "  embed_model, created_at FROM rag_chunks"
        )
        conn.execute("DROP TABLE rag_chunks")
        conn.execute("ALTER TABLE rag_chunks_new RENAME TO rag_chunks")
        conn.execute("CREATE INDEX ix_rag_chunks_recording_id ON rag_chunks(recording_id)")
        conn.execute("CREATE INDEX ix_rag_chunks_topic_id ON rag_chunks(topic_id)")
        conn.execute("CREATE INDEX ix_rag_chunks_document_id ON rag_chunks(document_id)")
        conn.execute("COMMIT")
        conn.execute("PRAGMA foreign_keys=ON")
    finally:
        conn.close()


def _migrate_cascade_foreign_keys() -> None:
    import sqlite3

    from sqlalchemy import text

    engine = get_engine()
    with engine.begin() as conn:
        tables = {
            row[0]
            for row in conn.execute(text("SELECT name FROM sqlite_master WHERE type='table'"))
        }
        rebuild = [
            table_name
            for table_name, expected in _CASCADE_FK_ONDELETE.items()
            if table_name in tables
            and table_name in SQLModel.metadata.tables
            and _foreign_key_actions(conn, table_name) != expected
        ]
    if not rebuild:
        return

    conn = sqlite3.connect(str(get_settings().db_path))
    conn.isolation_level = None
    try:
        conn.execute("PRAGMA foreign_keys=OFF")
        conn.execute("BEGIN")
        for table_name in rebuild:
            _rebuild_table_with_current_metadata(conn, table_name)
        conn.execute("COMMIT")
        conn.execute("PRAGMA foreign_keys=ON")
        violations = conn.execute("PRAGMA foreign_key_check").fetchall()
        if violations:
            print(f"[tarscribe] foreign key violations after cascade migration: {violations}")
    except Exception:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        conn.execute("PRAGMA foreign_keys=ON")
        raise
    finally:
        conn.close()


def _foreign_key_actions(conn, table_name: str) -> dict[str, str]:
    from sqlalchemy import text

    actions = {}
    for row in conn.execute(text(f"PRAGMA foreign_key_list({_quote_identifier(table_name)})")):
        actions[row[3]] = (row[6] or "NO ACTION").upper()
    return {
        column: actions.get(column, "NO ACTION")
        for column in _CASCADE_FK_ONDELETE[table_name]
    }


def _rebuild_table_with_current_metadata(conn, table_name: str) -> None:
    from sqlalchemy import MetaData

    table = SQLModel.metadata.tables[table_name]
    temp_name = f"{table_name}__cascade_new"
    metadata = MetaData()
    for other_table in SQLModel.metadata.tables.values():
        if other_table.name != table_name:
            other_table.to_metadata(metadata)
    temp_table = table.to_metadata(metadata, name=temp_name)
    dialect = get_engine().dialect
    conn.execute(f"DROP TABLE IF EXISTS {_quote_identifier(temp_name)}")
    conn.execute(str(CreateTable(temp_table).compile(dialect=dialect)))
    old_columns = {
        row[1] for row in conn.execute(f"PRAGMA table_info({_quote_identifier(table_name)})")
    }
    columns = [column.name for column in table.columns if column.name in old_columns]
    if columns:
        column_list = ", ".join(_quote_identifier(column) for column in columns)
        conn.execute(
            f"INSERT INTO {_quote_identifier(temp_name)} ({column_list}) "
            f"SELECT {column_list} FROM {_quote_identifier(table_name)}"
        )
    conn.execute(f"DROP TABLE {_quote_identifier(table_name)}")
    conn.execute(
        f"ALTER TABLE {_quote_identifier(temp_name)} RENAME TO {_quote_identifier(table_name)}"
    )
    for index in table.indexes:
        conn.execute(str(CreateIndex(index).compile(dialect=dialect)))


def _quote_identifier(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


def _ensure_vec_table() -> bool:
    """Create/repair the sqlite-vec table for chunk embeddings.

    Embeddings from different models (or dimensions) are not comparable, so when
    the configured embedding model or its dimension changes, the existing index is
    wiped and must be rebuilt. Returns True if an existing index was invalidated
    (so the caller can trigger a re-index).
    """
    if not vec_available():
        return False
    from sqlalchemy import text

    from .settings_store import load_prefs

    rag = load_prefs().get("rag") or {}
    dim = int(rag.get("dimension") or 768)
    model = rag.get("model") or "nomic-embed-text"
    invalidated = False
    with get_engine().begin() as conn:
        conn.execute(
            text(
                "CREATE TABLE IF NOT EXISTS rag_index_meta (key TEXT PRIMARY KEY, value TEXT)"
            )
        )
        meta = {r[0]: r[1] for r in conn.execute(text("SELECT key, value FROM rag_index_meta"))}
        stored_dim = int(meta["dimension"]) if "dimension" in meta else None
        stored_model = meta.get("model")
        dim_changed = stored_dim is not None and stored_dim != dim
        model_changed = stored_model is not None and stored_model != model
        if dim_changed or model_changed:
            # Dimension change needs a fresh table (different vector width); a
            # model change at the same dimension only needs the rows cleared.
            if dim_changed:
                conn.execute(text("DROP TABLE IF EXISTS rag_chunk_vec"))
            else:
                conn.execute(text("DELETE FROM rag_chunk_vec"))
            conn.execute(text("DELETE FROM rag_chunks"))
            invalidated = True
        conn.execute(
            text(
                f"CREATE VIRTUAL TABLE IF NOT EXISTS rag_chunk_vec USING vec0("
                f"embedding float[{dim}], topic_id integer, recording_id integer)"
            )
        )
        for key, value in (("dimension", str(dim)), ("model", str(model))):
            conn.execute(
                text(
                    "INSERT INTO rag_index_meta (key, value) VALUES (:k, :v) "
                    "ON CONFLICT(key) DO UPDATE SET value=excluded.value"
                ),
                {"k": key, "v": value},
            )
    return invalidated


def fts_available() -> bool:
    return FTS_AVAILABLE


def _ensure_fts_table() -> None:
    """Create the FTS5 keyword index over rag_chunks and backfill it.

    Standalone FTS table (text duplicated) so plain INSERT/DELETE keep it in
    sync; rowid mirrors RagChunk.id. Rebuilt automatically when row counts
    diverge (first run after update, or after the vec index was wiped).
    """
    global FTS_AVAILABLE
    from sqlalchemy import text

    try:
        with get_engine().begin() as conn:
            conn.execute(
                text(
                    "CREATE VIRTUAL TABLE IF NOT EXISTS rag_chunk_fts USING fts5("
                    "text, tokenize='unicode61 remove_diacritics 2')"
                )
            )
            n_fts = conn.execute(text("SELECT count(*) FROM rag_chunk_fts")).scalar()
            n_chunks = conn.execute(text("SELECT count(*) FROM rag_chunks")).scalar()
            if n_fts != n_chunks:
                conn.execute(text("DELETE FROM rag_chunk_fts"))
                conn.execute(
                    text("INSERT INTO rag_chunk_fts(rowid, text) SELECT id, text FROM rag_chunks")
                )
        FTS_AVAILABLE = True
    except Exception as exc:  # noqa: BLE001 - sqlite without FTS5
        FTS_AVAILABLE = False
        print(f"[tarscribe] FTS5 nicht verfügbar, Stichwortsuche deaktiviert: {exc}")


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


def _mark_stale_jobs() -> None:
    """Fail jobs left pending/running by a previous run and reset their recordings.

    The in-process executor dies with the backend, so these jobs can never
    finish; without this they stay "running" in the UI forever.
    """
    from sqlalchemy import text

    with get_engine().begin() as conn:
        tables = {row[0] for row in conn.execute(text("SELECT name FROM sqlite_master WHERE type='table'"))}
        if "jobs" not in tables:
            return
        conn.execute(
            text(
                "UPDATE jobs SET status='failed', error='Backend unerwartet beendet'"
                " WHERE status IN ('pending','running')"
            )
        )
        # Mirror the job error path: recordings stuck mid-pipeline become failed
        # so the user can retry them.
        conn.execute(
            text(
                "UPDATE recordings SET status='failed'"
                " WHERE status IN ('queued','transcribing','diarizing')"
            )
        )


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


# Plain specs (not ORM instances): fresh SummaryTemplate rows are built from these
# on each seed, so seeding stays idempotent and never reuses detached instances.
BUILTIN_TEMPLATES = [
    dict(
        name="Meeting-Protokoll",
        system_prompt=(
            "Du bist ein präziser Protokollant. Erstelle Meeting-Protokolle als vollständige "
            "Obsidian-Markdown-Notizen mit YAML-Frontmatter, klaren Abschnittsüberschriften und "
            "Obsidian-Callouts (> [!important]) für Entscheidungen. "
            "Halte dich strikt ans Transkript — keine Erfindungen. "
            "Der Themenbereich ist nur Ablage- oder Projektkontext, nicht das zwingende Thema "
            "des Meetings. Lehne das Protokoll nicht ab, wenn Transkript und Themenbereich "
            "unterschiedlich wirken."
        ),
        user_prompt_template=(
            "Erstelle ein Meeting-Protokoll für die Aufnahme «{{recording_title}}» vom {{date}} "
            "als Obsidian-Notiz.\n\n"
            "Kontext:\n"
            "- Themenbereich/Ablage: «{{topic}}»\n"
            "- Das folgende Transkript ist die verbindliche Quelle für das Protokoll.\n"
            "- Der Themenbereich ist kein Suchauftrag und kein Grund, das Protokoll abzulehnen.\n"
            "- Wenn das Transkript ein konkreteres Thema erkennen lässt, verwende dieses Thema "
            "in Überschriften und Inhalt.\n\n"
            "Beginne zwingend mit diesem YAML-Frontmatter (Werte unverändert übernehmen):\n"
            "---\n"
            'title: "Meeting – {{recording_title}}"\n'
            "date: {{date_iso}}\n"
            'topic_area: "{{topic}}"\n'
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
            "## Offene Fragen\n"
            "Tatsächlich offengebliebene Fragen als Stichpunkte. Keine Aufgaben oder nächsten "
            "Schritte formulieren.\n\n"
            "Transkript:\n{{transcript}}"
        ),
        output_format="markdown",
    ),
    dict(
        name="Vorlesungs-Zusammenfassung",
        system_prompt=(
            "Du bist ein Lernassistent, der Vorlesungen als strukturierte Obsidian-Lernnotizen "
            "zusammenfasst. Verwende YAML-Frontmatter, hierarchische Überschriften, "
            "> [!note]-Callouts für Definitionen und klare Stichpunkte. "
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
            "## Offene Fragen\n"
            "Tatsächlich offengebliebene Fragen als Stichpunkte, ohne Aufgaben zu formulieren.\n\n"
            "Transkript:\n{{transcript}}"
        ),
        output_format="markdown",
    ),
    dict(
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
    ),
    dict(
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
    ),
]


def _seed_builtin_templates() -> None:
    """Upsert built-in templates by name and prune obsolete ones.

    Upserting by name lets template updates reach existing installations.
    Built-in templates that are no longer shipped (e.g. the old
    "Action Items / To-dos" template, now superseded by the dedicated
    action-items feature) are removed; summaries that referenced them keep
    their content but have their template link cleared.
    """
    from .models import Summary

    with session_scope() as session:
        for spec in BUILTIN_TEMPLATES:
            existing = session.exec(
                select(SummaryTemplate).where(
                    SummaryTemplate.name == spec["name"],
                    SummaryTemplate.is_builtin == True,  # noqa: E712
                )
            ).first()
            if existing is None:
                session.add(SummaryTemplate(is_builtin=True, **spec))
            else:
                existing.system_prompt = spec["system_prompt"]
                existing.user_prompt_template = spec["user_prompt_template"]
                existing.output_format = spec["output_format"]
                session.add(existing)

        keep = {spec["name"] for spec in BUILTIN_TEMPLATES}
        obsolete = session.exec(
            select(SummaryTemplate).where(
                SummaryTemplate.is_builtin == True,  # noqa: E712
                SummaryTemplate.name.not_in(keep),  # type: ignore[attr-defined]
            )
        ).all()
        for tpl in obsolete:
            for summary in session.exec(
                select(Summary).where(Summary.template_id == tpl.id)
            ).all():
                summary.template_id = None
                session.add(summary)
            session.delete(tpl)
