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


def _on_connect(dbapi_connection, _record) -> None:  # pragma: no cover - sqlite pragma
    cur = dbapi_connection.cursor()
    cur.execute("PRAGMA foreign_keys=ON")
    cur.execute("PRAGMA journal_mode=WAL")
    cur.close()


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
    ]
    with get_engine().begin() as conn:
        for table, column, coltype in additive:
            cols = {row[1] for row in conn.execute(text(f"PRAGMA table_info({table})"))}
            if column not in cols:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {coltype}"))


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
            "Du bist ein präziser Protokollant. Fasse Besprechungen sachlich, "
            "strukturiert und ohne Erfindungen zusammen."
        ),
        user_prompt_template=(
            "Erstelle ein Meeting-Protokoll für das Thema '{{topic}}' vom {{date}}.\n\n"
            "Gliedere in: Teilnehmer ({{speakers}}), Besprochene Punkte, "
            "Entscheidungen, offene Fragen.\n\nTranskript:\n{{transcript}}"
        ),
        output_format="markdown",
        is_builtin=True,
    ),
    SummaryTemplate(
        name="Action Items / To-dos",
        system_prompt="Du extrahierst konkrete Aufgaben aus Gesprächen.",
        user_prompt_template=(
            "Extrahiere alle Action Items aus dem Transkript als Checkliste. "
            "Nenne pro Punkt — wenn erkennbar — die verantwortliche Person aus "
            "({{speakers}}) und eine Frist.\n\nTranskript:\n{{transcript}}"
        ),
        output_format="markdown",
        is_builtin=True,
    ),
    SummaryTemplate(
        name="Vorlesungs-Zusammenfassung",
        system_prompt="Du bist ein Tutor, der Vorlesungen lernfreundlich zusammenfasst.",
        user_prompt_template=(
            "Fasse die Vorlesung zum Thema '{{topic}}' zusammen. Strukturiere nach "
            "Kernkonzepten mit kurzen Erklärungen und nenne wichtige Begriffe.\n\n"
            "Transkript:\n{{transcript}}"
        ),
        output_format="markdown",
        is_builtin=True,
    ),
    SummaryTemplate(
        name="Kurz-Abstract",
        system_prompt="Du schreibst knappe, treffende Zusammenfassungen.",
        user_prompt_template=(
            "Schreibe ein Abstract von höchstens 5 Sätzen.\n\nTranskript:\n{{transcript}}"
        ),
        output_format="text",
        is_builtin=True,
    ),
    SummaryTemplate(
        name="Q&A-Extraktion",
        system_prompt="Du extrahierst Frage-Antwort-Paare aus Gesprächen.",
        user_prompt_template=(
            "Liste alle gestellten Fragen und die jeweils gegebenen Antworten als "
            "Q&A-Paare auf.\n\nTranskript:\n{{transcript}}"
        ),
        output_format="markdown",
        is_builtin=True,
    ),
]


def _seed_builtin_templates() -> None:
    with session_scope() as session:
        existing = session.exec(
            select(SummaryTemplate).where(SummaryTemplate.is_builtin == True)  # noqa: E712
        ).first()
        if existing:
            return
        for tpl in BUILTIN_TEMPLATES:
            session.add(tpl)
