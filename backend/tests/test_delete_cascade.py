"""Database-level delete cascade coverage."""

from __future__ import annotations

import importlib
import sqlite3
import tempfile

import pytest
from sqlmodel import Session, select


@pytest.fixture()
def db_env(monkeypatch):
    tmp = tempfile.mkdtemp(prefix="tarscribe-cascade-test-")
    monkeypatch.setenv("TARSCRIBE_DATA_DIR", tmp)
    monkeypatch.setenv("TARSCRIBE_AUTH_TOKEN", "")

    import tarscribe_backend.config as config

    importlib.reload(config)
    config.get_settings.cache_clear()

    import tarscribe_backend.db as db

    importlib.reload(db)
    db.init_db()
    return db


@pytest.fixture()
def client(db_env):
    from fastapi.testclient import TestClient

    import tarscribe_backend.main as main

    importlib.reload(main)
    return TestClient(main.create_app())


def test_delete_recording_cascades_all_recording_children(db_env):
    from tarscribe_backend.models import (
        ActionItem,
        Chapter,
        ChatMessage,
        ChatSession,
        DiarizationRun,
        Document,
        Job,
        JobPhase,
        JobStatus,
        KnownSpeaker,
        LiveRecordingSession,
        LiveSessionStatus,
        ManualEdit,
        RagChunk,
        Recording,
        Segment,
        SpeakerLabel,
        Summary,
        ThreadMention,
        Topic,
        TopicThread,
        Transcript,
        Word,
    )

    with Session(db_env.get_engine()) as session:
        topic = Topic(name="Cascade")
        known = KnownSpeaker(name="Anna")
        thread = TopicThread(title="Wiederkehrendes Thema")
        session.add(topic)
        session.add(known)
        session.add(thread)
        session.flush()

        recording = Recording(
            topic_id=topic.id,
            title="Aufnahme",
            audio_path="/tmp/tarscribe-cascade-missing.wav",
        )
        session.add(recording)
        session.flush()

        transcript = Transcript(recording_id=recording.id, asr_model="test")
        run = DiarizationRun(recording_id=recording.id, model="test")
        summary = Summary(recording_id=recording.id, model="test")
        chapter = Chapter(recording_id=recording.id, idx=0, start=0.0, title="Kapitel")
        document = Document(
            topic_id=topic.id,
            recording_id=recording.id,
            title="Dokument",
            file_path="/tmp/tarscribe-cascade-doc.txt",
        )
        chat = ChatSession(scope="recording", recording_id=recording.id, topic_id=topic.id)
        session.add(transcript)
        session.add(run)
        session.add(summary)
        session.add(chapter)
        session.add(document)
        session.add(chat)
        session.flush()

        chunk = RagChunk(
            recording_id=recording.id,
            topic_id=topic.id,
            summary_id=summary.id,
            document_id=document.id,
            source_type="document",
            text="Indextext",
            content_hash="h",
            embed_model="m",
        )
        session.add(chunk)
        session.flush()

        session.add(Word(transcript_id=transcript.id, idx=0, start=0.0, end=1.0, text="Hallo"))
        session.add(Segment(run_id=run.id, start=0.0, end=1.0, speaker_label="SPEAKER_00"))
        session.add(
            SpeakerLabel(
                recording_id=recording.id,
                original_label="SPEAKER_00",
                known_speaker_id=known.id,
            )
        )
        session.add(ManualEdit(recording_id=recording.id, edit_type="rename"))
        session.add(ActionItem(recording_id=recording.id, text="Aufgabe"))
        session.add(
            ThreadMention(
                thread_id=thread.id,
                recording_id=recording.id,
                chapter_id=chapter.id,
                chunk_id=chunk.id,
                text="Erwaehnung",
            )
        )
        session.add(Job(recording_id=recording.id, phase=JobPhase.asr, status=JobStatus.done))
        session.add(
            LiveRecordingSession(
                id="live-cascade",
                topic_id=topic.id,
                title="Live",
                status=LiveSessionStatus.completed,
                finalized_recording_id=recording.id,
            )
        )
        session.add(ChatMessage(session_id=chat.id, role="user", content="Frage"))
        session.commit()
        recording_id = recording.id
        topic_id = topic.id
        thread_id = thread.id
        known_id = known.id

    with Session(db_env.get_engine()) as session:
        recording = session.get(Recording, recording_id)
        session.delete(recording)
        session.commit()

    with Session(db_env.get_engine()) as session:
        assert session.get(Recording, recording_id) is None
        assert session.get(Topic, topic_id) is not None
        assert session.get(TopicThread, thread_id) is not None
        assert session.get(KnownSpeaker, known_id) is not None
        for model in (
            Transcript,
            Word,
            DiarizationRun,
            Segment,
            SpeakerLabel,
            ManualEdit,
            Summary,
            Document,
            RagChunk,
            ChatSession,
            ChatMessage,
            ActionItem,
            Chapter,
            ThreadMention,
            Job,
            LiveRecordingSession,
        ):
            assert session.exec(select(model)).all() == []


def test_delete_topic_keeps_recording_guard(client, db_env):
    from tarscribe_backend.models import Recording, Topic

    with Session(db_env.get_engine()) as session:
        topic = Topic(name="Blockiert")
        session.add(topic)
        session.flush()
        session.add(Recording(topic_id=topic.id, title="Aufnahme", audio_path="/tmp/missing.wav"))
        session.commit()
        topic_id = topic.id

    response = client.delete(f"/api/topics/{topic_id}")
    assert response.status_code == 409


def test_delete_topic_cascades_topic_documents_and_nulls_chat_topic(db_env):
    from tarscribe_backend.models import ChatMessage, ChatSession, Document, RagChunk, Topic

    with Session(db_env.get_engine()) as session:
        topic = Topic(name="Projekt")
        session.add(topic)
        session.flush()
        document = Document(
            topic_id=topic.id,
            title="Handbuch",
            file_path="/tmp/tarscribe-topic-doc.txt",
        )
        chat = ChatSession(scope="global", topic_id=topic.id)
        session.add(document)
        session.add(chat)
        session.flush()
        session.add(
            RagChunk(
                recording_id=None,
                topic_id=topic.id,
                document_id=document.id,
                source_type="document",
                text="Wissen",
                content_hash="h",
                embed_model="m",
            )
        )
        session.add(ChatMessage(session_id=chat.id, role="user", content="Frage"))
        session.commit()
        topic_id = topic.id
        chat_id = chat.id

    with Session(db_env.get_engine()) as session:
        topic = session.get(Topic, topic_id)
        session.delete(topic)
        session.commit()

    with Session(db_env.get_engine()) as session:
        chat = session.get(ChatSession, chat_id)
        assert session.get(Topic, topic_id) is None
        assert chat is not None
        assert chat.topic_id is None
        assert session.exec(select(Document)).all() == []
        assert session.exec(select(RagChunk)).all() == []
        assert len(session.exec(select(ChatMessage)).all()) == 1


def test_cascade_migration_rebuilds_legacy_no_action_fk(db_env):
    from tarscribe_backend.config import get_settings

    db_path = str(get_settings().db_path)
    raw = sqlite3.connect(db_path)
    raw.isolation_level = None
    raw.execute("PRAGMA foreign_keys=OFF")
    raw.execute("DROP TABLE words")
    raw.execute(
        "CREATE TABLE words ("
        "id INTEGER NOT NULL,"
        "transcript_id INTEGER NOT NULL,"
        "idx INTEGER NOT NULL,"
        "start FLOAT NOT NULL,"
        "end FLOAT NOT NULL,"
        "text VARCHAR NOT NULL,"
        "confidence FLOAT,"
        "PRIMARY KEY (id),"
        "FOREIGN KEY(transcript_id) REFERENCES transcripts (id)"
        ")"
    )
    raw.close()

    db_env._migrate_cascade_foreign_keys()

    raw = sqlite3.connect(db_path)
    fks = raw.execute("PRAGMA foreign_key_list(words)").fetchall()
    indexes = {row[1] for row in raw.execute("PRAGMA index_list(words)").fetchall()}
    raw.close()

    assert any(row[3] == "transcript_id" and row[6].upper() == "CASCADE" for row in fks)
    assert "ix_words_transcript_id" in indexes
