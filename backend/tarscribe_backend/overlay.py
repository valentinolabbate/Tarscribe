"""Load and apply the Stage D manual-correction overlay for a recording.

Edits are stored as ``ManualEdit`` rows and applied on read, so they survive
re-running diarization (Stages B/C).
"""

from __future__ import annotations

import json

from sqlmodel import Session, select

from .models import ManualEdit


def load_overlay(session: Session, recording_id: int) -> tuple[dict[str, str], list[tuple]]:
    """Return (relabel_map, reassigns) from the stored manual edits.

    relabel_map: raw speaker label -> merged label (transitively resolved).
    reassigns: list of (start, end, speaker) ranges forcing a speaker.
    """
    edits = session.exec(
        select(ManualEdit)
        .where(ManualEdit.recording_id == recording_id)
        .order_by(ManualEdit.created_at)
    ).all()

    relabel: dict[str, str] = {}
    reassigns: list[tuple] = []
    for e in edits:
        payload = json.loads(e.payload_json or "{}")
        if e.edit_type == "merge":
            src, dst = payload.get("from"), payload.get("to")
            if src and dst:
                relabel[src] = dst
        elif e.edit_type == "reassign":
            reassigns.append(
                (float(payload["start"]), float(payload["end"]), payload["speaker"])
            )

    # Resolve transitive merges (A->B, B->C => A->C).
    def resolve(label: str, _seen: set[str] | None = None) -> str:
        _seen = _seen or set()
        while label in relabel and label not in _seen:
            _seen.add(label)
            label = relabel[label]
        return label

    relabel = {k: resolve(k) for k in relabel}
    return relabel, reassigns
