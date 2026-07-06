from __future__ import annotations

from collections import defaultdict
from typing import Any
import re

import numpy as np
from sqlmodel import Session, select

from .models import Chapter, RagChunk, Recording, ThreadMention, TopicThread

THREAD_SIMILARITY_THRESHOLD = 0.72
THREAD_MIN_TEXT_CHARS = 40


def _normalize(vector: np.ndarray) -> np.ndarray | None:
    norm = float(np.linalg.norm(vector))
    if norm <= 1e-8:
        return None
    return vector / norm


def _load_candidates(session: Session) -> tuple[list[dict[str, Any]], dict[int, Recording]]:
    from .db import vec_available

    if not vec_available():
        return [], {}
    chunks = session.exec(
        select(RagChunk)
        .where(
            RagChunk.source_type == "transcript",
            RagChunk.recording_id.is_not(None),
        )
        .order_by(RagChunk.id)
    ).all()
    if not chunks:
        return [], {}

    rows = session.connection().exec_driver_sql(
        "SELECT rowid, embedding FROM rag_chunk_vec"
    ).fetchall()
    vectors = {int(row[0]): row[1] for row in rows}
    recording_ids = {int(chunk.recording_id) for chunk in chunks if chunk.recording_id is not None}
    recordings = {
        int(recording.id): recording
        for recording in session.exec(
            select(Recording).where(Recording.id.in_(recording_ids))
        ).all()
        if recording.id is not None
    }

    candidates: list[dict[str, Any]] = []
    for chunk in chunks:
        if chunk.id is None or chunk.recording_id is None:
            continue
        if len(chunk.text.strip()) < THREAD_MIN_TEXT_CHARS:
            continue
        blob = vectors.get(chunk.id)
        recording = recordings.get(chunk.recording_id)
        if blob is None or recording is None:
            continue
        vector = _normalize(np.frombuffer(blob, dtype=np.float32).astype(np.float64))
        if vector is None:
            continue
        candidates.append({"chunk": chunk, "recording": recording, "vector": vector})

    candidates.sort(
        key=lambda candidate: (
            candidate["recording"].created_at,
            candidate["recording"].id,
            candidate["chunk"].chunk_index,
        )
    )
    return candidates, recordings


def _cluster_centroid(cluster: dict[str, Any]) -> np.ndarray:
    recording_means = []
    for recording_id, vector_sum in cluster["recording_sums"].items():
        mean = vector_sum / cluster["recording_counts"][recording_id]
        normalized = _normalize(mean)
        if normalized is not None:
            recording_means.append(normalized)
    centroid = _normalize(np.mean(recording_means, axis=0))
    if centroid is None:
        return cluster["members"][0]["vector"]
    return centroid


def _add_to_cluster(cluster: dict[str, Any], candidate: dict[str, Any]) -> None:
    recording_id = int(candidate["recording"].id)
    cluster["members"].append(candidate)
    if recording_id in cluster["recording_sums"]:
        cluster["recording_sums"][recording_id] += candidate["vector"]
        cluster["recording_counts"][recording_id] += 1
    else:
        cluster["recording_sums"][recording_id] = candidate["vector"].copy()
        cluster["recording_counts"][recording_id] = 1
    cluster["centroid"] = _cluster_centroid(cluster)


def _semantic_clusters(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    clusters: list[dict[str, Any]] = []
    for candidate in candidates:
        if not clusters:
            cluster = {
                "members": [],
                "recording_sums": {},
                "recording_counts": {},
                "centroid": candidate["vector"],
            }
            _add_to_cluster(cluster, candidate)
            clusters.append(cluster)
            continue

        similarities = [float(np.dot(candidate["vector"], cluster["centroid"])) for cluster in clusters]
        best_index = int(np.argmax(similarities))
        if similarities[best_index] >= THREAD_SIMILARITY_THRESHOLD:
            _add_to_cluster(clusters[best_index], candidate)
        else:
            cluster = {
                "members": [],
                "recording_sums": {},
                "recording_counts": {},
                "centroid": candidate["vector"],
            }
            _add_to_cluster(cluster, candidate)
            clusters.append(cluster)

    return [cluster for cluster in clusters if len(cluster["recording_sums"]) >= 2]


def _chapter_lookup(session: Session, recording_ids: set[int]) -> dict[int, list[Chapter]]:
    chapters = session.exec(
        select(Chapter)
        .where(Chapter.recording_id.in_(recording_ids))
        .order_by(Chapter.recording_id, Chapter.start)
    ).all()
    result: dict[int, list[Chapter]] = defaultdict(list)
    for chapter in chapters:
        result[chapter.recording_id].append(chapter)
    return result


def _candidate_chapter(candidate: dict[str, Any], chapters: dict[int, list[Chapter]]) -> Chapter | None:
    chunk = candidate["chunk"]
    start = chunk.start_sec
    if start is None or chunk.recording_id is None:
        return None
    match = None
    for chapter in chapters.get(chunk.recording_id, []):
        if chapter.start > start:
            break
        if chapter.end is None or start < chapter.end:
            match = chapter
    return match


def _fallback_title(text: str) -> str:
    clean = re.sub(r"(?m)^[^:\n]{1,40}:\s*", "", text)
    clean = re.sub(r"\s+", " ", clean).strip(" -#*\t\n")
    first = re.split(r"[.!?]", clean, maxsplit=1)[0].strip()
    words = first.split()
    title = " ".join(words[:7]).strip(" ,;:-")
    if len(words) > 7:
        title += " …"
    return title[:80] or "Wiederkehrendes Thema"


def _cluster_title(cluster: dict[str, Any], chapters: dict[int, list[Chapter]]) -> str:
    ranked = sorted(
        cluster["members"],
        key=lambda member: float(np.dot(member["vector"], cluster["centroid"])),
        reverse=True,
    )
    for candidate in ranked:
        chapter = _candidate_chapter(candidate, chapters)
        if chapter and chapter.title.strip():
            return chapter.title.strip()[:80]
    return _fallback_title(ranked[0]["chunk"].text)


def _representative_members(cluster: dict[str, Any]) -> list[dict[str, Any]]:
    by_recording: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for member in cluster["members"]:
        by_recording[int(member["recording"].id)].append(member)
    representatives = [
        max(
            members,
            key=lambda member: float(np.dot(member["vector"], cluster["centroid"])),
        )
        for members in by_recording.values()
    ]
    return sorted(representatives, key=lambda member: member["recording"].created_at)


def rebuild_semantic_threads(session: Session) -> dict[str, int | str | float]:
    candidates, recordings = _load_candidates(session)
    clusters = _semantic_clusters(candidates)
    chapters = _chapter_lookup(session, set(recordings)) if recordings else {}

    for mention in session.exec(select(ThreadMention)).all():
        session.delete(mention)
    for thread in session.exec(select(TopicThread)).all():
        session.delete(thread)
    session.flush()

    mentions_created = 0
    ordered_clusters = sorted(
        clusters,
        key=lambda cluster: max(
            member["recording"].created_at for member in cluster["members"]
        ),
        reverse=True,
    )
    for cluster in ordered_clusters:
        representatives = _representative_members(cluster)
        thread = TopicThread(
            title=_cluster_title(cluster, chapters),
            updated_at=max(member["recording"].created_at for member in representatives),
        )
        session.add(thread)
        session.flush()
        for member in representatives:
            chunk = member["chunk"]
            recording = member["recording"]
            chapter = _candidate_chapter(member, chapters)
            session.add(
                ThreadMention(
                    thread_id=thread.id,
                    recording_id=recording.id,
                    chapter_id=chapter.id if chapter else None,
                    chunk_id=chunk.id,
                    start_sec=chunk.start_sec,
                    text=chapter.title if chapter else chunk.text[:240].strip(),
                    created_at=recording.created_at,
                )
            )
            mentions_created += 1
    session.commit()
    return {
        "threads": len(ordered_clusters),
        "mentions": mentions_created,
        "indexed_chunks": len(candidates),
        "mode": "semantic",
        "threshold": THREAD_SIMILARITY_THRESHOLD,
    }
