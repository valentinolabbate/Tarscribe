"""LiveAnalysisService: drives rolling ASR and diarization for the active live session.

Design (plan §4.3):
- Own single-worker executor, separate from the final-job executor.
- Coalescing ticks: at most one analysis in flight + one queued pending.
- Non-blocking ASR/diar locks: skip if a final job holds the model.
- ASR every ~3 s, diarization every ~10 s.
- Degrades to ASR-only if HF token missing or pyannote fails.
"""

from __future__ import annotations

import json
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .db import session_scope
from .models import LiveRecordingSession, LiveSessionStatus
from .ws import hub

ASR_INTERVAL_SEC: float = 3.0
DIAR_INTERVAL_SEC: float = 10.0
MIN_AUDIO_SEC: float = 1.0
DIAR_MIN_AUDIO_SEC: float = 5.0  # from live_diarization.DIAR_MIN_AUDIO_SEC


class LiveAnalysisService:
    """Manages rolling ASR + diarization for the active live session."""

    def __init__(self) -> None:
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="tarscribe-live")
        self._mu = threading.Lock()

        # Session tracking
        self._session_id: str | None = None
        self._running = False
        self._pending_tick = False
        self._last_run_at: float = 0.0

        # Diarization state (per session; reset on attach)
        self._diar_state: object | None = None   # ml.live_diarization.DiarizationState
        self._diar_backend: object | None = None  # ml.diarization.DiarizationBackend
        self._diar_degraded: bool = False
        self._last_diar_at: float = 0.0

    # ── Session lifecycle ────────────────────────────────────────────────────

    def attach(self, session_id: str) -> None:
        with self._mu:
            self._session_id = session_id
            self._running = False
            self._pending_tick = False
            self._last_run_at = 0.0
        self._diar_state = None
        self._diar_backend = None
        self._diar_degraded = False
        self._last_diar_at = 0.0

    def detach(self, session_id: str) -> None:
        with self._mu:
            if self._session_id == session_id:
                self._session_id = None
        # Release the cached diarization pipeline.
        self._diar_backend = None
        self._diar_state = None

    # ── Tick ────────────────────────────────────────────────────────────────

    def tick(self, session_id: str) -> None:
        """Signal new PCM arrived. Fires at most once per ASR_INTERVAL_SEC."""
        from .settings_store import load_prefs
        if not load_prefs().get("live_transcription_enabled", True):
            return

        with self._mu:
            if self._session_id != session_id:
                return
            now = time.monotonic()
            if now - self._last_run_at < ASR_INTERVAL_SEC:
                return
            if self._running:
                self._pending_tick = True
                return
            self._running = True
            self._last_run_at = now

        self._executor.submit(self._run, session_id)

    # ── Worker ──────────────────────────────────────────────────────────────

    def _run(self, session_id: str) -> None:
        import sys

        try:
            if not sys.is_finalizing():
                self._analyze(session_id)
        except Exception:
            if not sys.is_finalizing():
                traceback.print_exc()
        finally:
            rerun = False
            with self._mu:
                self._running = False
                if self._pending_tick and self._session_id == session_id:
                    self._pending_tick = False
                    self._running = True
                    self._last_run_at = time.monotonic()
                    rerun = True
            if rerun:
                self._executor.submit(self._run, session_id)

    def _analyze(self, session_id: str) -> None:
        from .ml.lifecycle import asr_lock
        from .ml.live_asr import analyze_window
        from .settings_store import load_prefs

        # ── Read session ─────────────────────────────────────────────────
        with session_scope() as s:
            sess = s.get(LiveRecordingSession, session_id)
            if not sess or sess.status not in (
                LiveSessionStatus.recording, LiveSessionStatus.paused
            ):
                return
            pcm_path = Path(sess.pcm_path)
            duration = sess.received_duration_sec
            sample_rate = sess.sample_rate
            channels = sess.channels
            prev_json = sess.transcript_snapshot_json
            prev_spk_json = sess.speaker_snapshot_json
            prev_revision = 0
            prev_spk_revision = 0

        if duration < MIN_AUDIO_SEC:
            return

        prev_words: list[dict] = []
        if prev_json:
            try:
                snap = json.loads(prev_json)
                prev_words = snap.get("words", [])
                prev_revision = snap.get("revision", 0)
            except Exception:
                pass
        if prev_spk_json:
            try:
                prev_spk_revision = json.loads(prev_spk_json).get("revision", 0)
            except Exception:
                pass

        language = load_prefs().get("language")

        # ── ASR ──────────────────────────────────────────────────────────
        if not asr_lock.acquire(timeout=0):
            return
        try:
            new_words = analyze_window(
                pcm_path=pcm_path,
                session_id=session_id,
                current_duration_sec=duration,
                previous_words=prev_words,
                sample_rate=sample_rate,
                channels=channels,
                language=language,
            )
        finally:
            asr_lock.release()

        # ── Diarization ───────────────────────────────────────────────────
        now = time.monotonic()
        speakers_snap: dict | None = None
        should_diarize = (
            not self._diar_degraded
            and duration >= DIAR_MIN_AUDIO_SEC
            and now - self._last_diar_at >= DIAR_INTERVAL_SEC
        )

        if should_diarize:
            self._last_diar_at = now
            updated_state = self._diarization_tick(
                session_id, pcm_path, duration, sample_rate, channels
            )
            if updated_state is not None:
                self._diar_state = updated_state

        if self._diar_state is not None:
            from .ml.live_diarization import assign_speakers_to_words
            new_words = assign_speakers_to_words(new_words, self._diar_state.segments)

        if should_diarize and self._diar_state is not None:
            speakers_snap = {
                "revision": prev_spk_revision + 1,
                "speakers": [c.to_dict() for c in self._diar_state.clusters.values()],
            }

        # ── Persist ──────────────────────────────────────────────────────
        transcript_snap = {
            "revision": prev_revision + 1,
            "duration_sec": round(duration, 2),
            "words": new_words,
        }

        with session_scope() as s:
            sess = s.get(LiveRecordingSession, session_id)
            if sess and sess.status in (LiveSessionStatus.recording, LiveSessionStatus.paused):
                sess.transcript_snapshot_json = json.dumps(transcript_snap)
                sess.last_analyzed_sec = duration
                if speakers_snap is not None:
                    sess.speaker_snapshot_json = json.dumps(speakers_snap)
                s.add(sess)

        hub.broadcast({
            "type": "live_transcript",
            "session_id": session_id,
            "snapshot": transcript_snap,
        })
        if speakers_snap is not None:
            hub.broadcast({
                "type": "live_speakers",
                "session_id": session_id,
                "snapshot": speakers_snap,
            })

    # ── Diarization tick ─────────────────────────────────────────────────────

    def _diarization_tick(
        self,
        session_id: str,
        pcm_path: Path,
        duration: float,
        sample_rate: int,
        channels: int,
    ) -> object | None:
        """Run one diarization analysis. Returns updated DiarizationState or None on failure."""
        from .ml.lifecycle import diar_lock
        from .ml.live_diarization import DiarizationState, match_known_speakers, run_window
        from .ml.diarization import DEFAULT_MODEL, DiarizationBackend
        from .settings_store import get_hf_token, load_prefs

        if not load_prefs().get("live_speaker_detection_enabled", True):
            return None

        if self._diar_backend is None:
            token = get_hf_token()
            if not token:
                self._diar_degraded = True
                hub.broadcast({
                    "type": "live_degraded",
                    "session_id": session_id,
                    "reason": "no_hf_token",
                })
                return None
            model_id = load_prefs().get("diarization_model") or DEFAULT_MODEL
            from .hardware import detect_hardware
            device = detect_hardware().recommended_device
            self._diar_backend = DiarizationBackend(
                hf_token=token, model_id=model_id, device=device
            )

        state: DiarizationState = self._diar_state or DiarizationState()

        if not diar_lock.acquire(timeout=0):
            return None  # final diarization job running; skip this tick

        try:
            state = run_window(
                pcm_path=pcm_path,
                current_duration_sec=duration,
                state=state,
                diarize_fn=self._diar_backend.diarize,
                sample_rate=sample_rate,
                channels=channels,
            )
        except Exception:
            traceback.print_exc()
            self._diar_degraded = True
            hub.broadcast({
                "type": "live_degraded",
                "session_id": session_id,
                "reason": "diarization_error",
            })
            return None
        finally:
            diar_lock.release()

        # Known-speaker matching (best-effort, same diar_lock is released above).
        try:
            threshold = float(load_prefs().get("speaker_match_threshold", 0.5))
            with session_scope() as s:
                from sqlmodel import select
                from .models import KnownSpeaker
                known = [
                    {"id": k.id, "name": k.name, "embedding_blob": k.embedding_blob}
                    for k in s.exec(select(KnownSpeaker)).all()
                    if k.embedding_blob
                ]
            if known:
                match_known_speakers(
                    state=state,
                    pcm_path=pcm_path,
                    current_duration_sec=duration,
                    sample_rate=sample_rate,
                    channels=channels,
                    known=known,
                    threshold=threshold,
                )
        except Exception:
            traceback.print_exc()

        return state


# ── Singleton ────────────────────────────────────────────────────────────────

_service: LiveAnalysisService | None = None


def get_service() -> LiveAnalysisService:
    global _service
    if _service is None:
        _service = LiveAnalysisService()
    return _service
