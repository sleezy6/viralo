# Added 2026 by sleezy6 (fork of sammyview80/viralo, Apache-2.0).
"""Regenerate existing clips: new AI title/caption/tags, a re-render, or both.

A clip keeps its id, schedule and storage key. Re-rendering goes through the same
_export_clip path as the pipeline (current caption, emoji and hook code), updating
the clip in place; the old video stays playable until the new upload lands.
"""
import json
import logging
import os
import re
import uuid
from pathlib import Path

from sqlalchemy import text

from workers.celery_app import celery_app
from workers.tasks.video._core import (
    CAPCUT_STYLES,
    VIDEO_TEMP_DIR,
    CaptionSegment,
    ClipResult,
    WordTimestamp,
    _effective_caption_style,
    _get_session,
    _load_transcript_words,
)

__all__ = ["REGEN_MODES", "regenerate_clips", "_regenerate_clips"]

REGEN_MODES = ("text", "render", "both")
log = logging.getLogger(__name__)


def _fetch_source(tenant_id: str, video_id: str, row, work_dir: Path, cfg: dict) -> str:
    """Source video for re-rendering: the stored original, else a fresh YouTube download."""
    # Unique per task: two regenerates of the same video must not share (and delete)
    # one source file.
    out = work_dir / f"source_regen_{uuid.uuid4().hex[:8]}.mp4"
    if row.original_storage_key:
        import asyncio
        from shared.storage.base import get_storage
        storage = get_storage(os.getenv("STORAGE_PROVIDER", "local"))
        try:
            asyncio.run(storage.download(row.original_storage_key, str(out)))
            return str(out)
        except Exception as e:
            # Older installs deleted originals once clips were uploaded; YouTube sources
            # can still be fetched again, uploads cannot.
            if not (row.source_type == "youtube_url" and row.source_url):
                raise FileNotFoundError(
                    "The original upload was deleted after processing, so this clip can't be "
                    "re-rendered. New title/caption/tags still works; re-upload the video to re-render."
                ) from e
    if row.source_type == "youtube_url" and row.source_url:
        from workers.tasks.video.download import _download_youtube
        # _download_youtube returns the yt-dlp client that won ("tv", "web"…), not a path.
        _download_youtube(row.source_url, str(out), quality=cfg.get("output_quality", "source"),
                          tenant_id=tenant_id)
        if not out.is_file() or out.stat().st_size == 0:
            raise FileNotFoundError("Couldn't download the YouTube video again to re-render it")
        return str(out)
    raise FileNotFoundError("The original video is no longer available to re-render from")


def _float_or_none(v) -> float | None:
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _restore_status(tenant_id: str, clip_id: str, error: str, only_if_regenerating: bool = False) -> None:
    """After a failed regenerate: the clip is usable again ("ready") if it still has a
    video file, otherwise "failed" — never "ready" without a file. The error is shown
    on the clip."""
    with _get_session(tenant_id) as session:
        session.execute(
            text(f"""
                UPDATE clips
                   SET status = CASE WHEN COALESCE(storage_url, '') <> '' THEN 'ready' ELSE 'failed' END,
                       metadata = COALESCE(metadata, '{{}}'::jsonb)
                                  || jsonb_build_object('regenerate_error', CAST(:err AS text)),
                       updated_at = NOW()
                 WHERE id = CAST(:cid AS uuid)
                 {"AND status = 'regenerating'" if only_if_regenerating else ""}
            """),
            {"cid": clip_id, "err": error[:300]},
        )


def _norm_word(w: str) -> str:
    return re.sub(r"[^\w]+", "", (w or "").lower())


def _segment_from_text(text_: str, start: float, end: float, words: list, base: float) -> CaptionSegment:
    """One caption from text the user wrote, `start`/`end` in seconds of the original
    video. Word timings come from the transcript when the words still match it (so
    highlighted-word styles stay in sync); otherwise they're spread over the caption
    by word length. Times in the result are relative to `base` (the clip start)."""
    toks = text_.split()
    spoken = [w for w in words if w.start >= start - 0.3 and w.end <= end + 0.3]
    keyed = [(i, _norm_word(t)) for i, t in enumerate(toks) if _norm_word(t)]
    times: list[tuple[float, float] | None] = [None] * len(toks)
    if keyed and [k for _, k in keyed] == [_norm_word(w.word) for w in spoken]:
        for (i, _), w in zip(keyed, spoken):
            times[i] = (min(max(w.start, start), end), min(max(w.end, start), end))
        last = (start, start)
        for i in range(len(toks)):  # emoji and other symbols ride along with the word before
            times[i] = times[i] or last
            last = times[i]
    else:
        weights = [len(t) + 1 for t in toks] or [1]
        total, t = float(sum(weights)), start
        for i, wgt in enumerate(weights[: len(toks)]):
            d = (end - start) * wgt / total
            times[i] = (t, t + d)
            t += d
    seg_words = [WordTimestamp(tok, max(0.0, a - base), max(0.0, b - base))
                 for tok, (a, b) in zip(toks, times)]
    # Speaker: whoever says most of the transcript's words in this stretch.
    voices = [w.speaker for w in words if getattr(w, "speaker", None) and w.start < end and w.end > start]
    speaker = max(set(voices), key=voices.count) if voices else None
    return CaptionSegment(text=" ".join(toks), start=max(0.0, start - base),
                          end=max(0.0, end - base), words=seg_words, speaker=speaker)


def _build_captions(words: list, clip: ClipResult, max_words: int, custom: dict | None) -> list:
    """Captions for a clip: the user's edited captions where they edited them
    (custom["range"], seconds of the original video), the transcript elsewhere."""
    from workers.tasks.video.render import _generate_captions
    auto = _generate_captions(words, clip, max_words=max_words)
    if not custom or "items" not in custom:
        return auto
    lo, hi = custom.get("range") or (clip.start, clip.end)
    segs = []
    for it in custom["items"]:
        s, e = max(float(it["start"]), clip.start), min(float(it["end"]), clip.end)
        if e - s >= 0.05 and str(it.get("text", "")).strip():
            segs.append(_segment_from_text(str(it["text"]).strip(), s, e, words, clip.start))
    for seg in auto:  # transcript captions only outside the part the user edited
        mid = clip.start + (seg.start + seg.end) / 2
        if mid < lo or mid > hi:
            segs.append(seg)
    return sorted(segs, key=lambda c: c.start)


def _save_applied_edits(tenant_id: str, clip_id: str, custom: dict, shift_sec: float,
                        old_editor: dict | None) -> None:
    """After the editor's edits are applied: remember the edited captions (so later
    re-renders keep them) and reset the editor to the new clip, shifting sound-effect
    markers by how far the start moved. Captions reload from the new caption file."""
    markers = []
    for m in (old_editor or {}).get("markers") or []:
        t = int(m.get("time_ms", 0) - shift_sec * 1000)
        if t >= 0:
            markers.append({**m, "time_ms": t})
    editor = {"trim_start_sec": 0, "trim_end_sec": None, "captions": [], "markers": markers}
    with _get_session(tenant_id) as session:
        session.execute(
            text("""UPDATE clips SET metadata = COALESCE(metadata, '{}'::jsonb) || CAST(:m AS jsonb),
                           updated_at = NOW() WHERE id = CAST(:id AS uuid)"""),
            {"id": clip_id, "m": json.dumps({"custom_captions": custom, "editor": editor})},
        )


def _save_new_timing(tenant_id: str, clip_id: str, start: float, end: float, start_moved: bool) -> None:
    """Store a re-cut clip's new place in the original video. Saved editor trims no
    longer fit: a moved start shifts every editor timing, so those edits are dropped;
    a moved end only invalidates the trim end."""
    with _get_session(tenant_id) as session:
        session.execute(
            text("""
                UPDATE clips
                   SET start_sec = :s, end_sec = :e, start_ms = :sms, end_ms = :ems,
                       duration_ms = :dur,
                       metadata = CASE
                           WHEN :moved THEN COALESCE(metadata, '{}'::jsonb) - 'editor'
                           WHEN metadata ? 'editor'
                             THEN jsonb_set(metadata, '{editor,trim_end_sec}', 'null'::jsonb)
                           ELSE metadata END,
                       updated_at = NOW()
                 WHERE id = CAST(:id AS uuid)
            """),
            {"id": clip_id, "s": start, "e": end, "sms": int(start * 1000),
             "ems": int(end * 1000), "dur": int((end - start) * 1000), "moved": start_moved},
        )


def _regenerate_clips(tenant_id: str, video_id: str, clip_ids: list[str], mode: str,
                      timing: dict | None = None) -> dict:
    """Regenerate clips of one video in order. Returns {clip_id: "ok" | error}.

    `timing` ({"start", "end"} in seconds of the original video) re-cuts a single clip
    at new times, e.g. to extend it past its current end."""
    if mode not in REGEN_MODES:
        raise ValueError(f"mode must be one of {REGEN_MODES}")
    from workers.tasks.video.ai import _batch_ai_content
    from workers.tasks.video.pipeline import _resolve_pipeline_language
    from workers.tasks.video.render import _export_clip
    from workers.tasks.video.tasks import upload_clip_to_storage
    from workers.tasks.video.transcribe import _probe_video

    with _get_session(tenant_id) as session:
        vrow = session.execute(
            text("""
                SELECT clip_config, metadata, original_storage_key, source_type, source_url
                  FROM videos WHERE id = CAST(:vid AS uuid)
            """),
            {"vid": video_id},
        ).fetchone()
    if not vrow:
        raise FileNotFoundError(f"Video {video_id} not found")
    cfg = vrow.clip_config or {}
    vmeta = vrow.metadata or {}

    words = _load_transcript_words(tenant_id, video_id)
    from workers.tasks.video.speakers import init_speakers, load_speakers, speaker_names
    from workers.tasks.video.transcribe import set_speaker_names
    spk_settings = load_speakers(tenant_id, video_id) or init_speakers(tenant_id, video_id, words)
    set_speaker_names(speaker_names(spk_settings))
    style = _effective_caption_style(cfg)
    words_per_line = 5 if style == "tiktok" else (3 if style in CAPCUT_STYLES else 6)  # as the pipeline
    language = _resolve_pipeline_language(cfg, meta_lang=vmeta.get("language_detected") or None)
    platforms = cfg.get("platforms", ["tiktok", "reels", "shorts"])
    content_type = vmeta.get("content_type", "other") or "other"
    occasion = cfg.get("occasion") or vmeta.get("occasion", "") or ""
    viral_type = vmeta.get("viral_type", "") or ""
    from workers.tasks.video.game_context import with_game_context
    topic_focus = with_game_context(cfg.get("topic_focus", ""), vmeta.get("game"))

    work_dir = Path(VIDEO_TEMP_DIR) / video_id / "regen"
    work_dir.mkdir(parents=True, exist_ok=True)
    source_path: str | None = None
    meta = None
    results: dict[str, str] = {}

    try:
        for cid in clip_ids:
            try:
                with _get_session(tenant_id) as session:
                    row = session.execute(
                        text("""
                            SELECT title, start_sec, end_sec, platform, score, metadata
                              FROM clips
                             WHERE id = CAST(:cid AS uuid) AND video_id = CAST(:vid AS uuid)
                        """),
                        {"cid": cid, "vid": video_id},
                    ).fetchone()
                if not row:
                    results[cid] = "not found"
                    continue
                cmeta = row.metadata or {}
                signals = cmeta.get("signals") or {}
                start, end = float(row.start_sec), float(row.end_sec)
                if timing and mode != "text":
                    if source_path is None:
                        source_path = _fetch_source(tenant_id, video_id, vrow, work_dir, cfg)
                        meta = _probe_video(source_path)
                    start = max(0.0, float(timing["start"]))
                    end = min(float(timing["end"]), float(meta.duration or timing["end"]))
                    if end - start < 1:
                        raise ValueError("the new start/end leave less than 1 second of video")
                clip = ClipResult(
                    start=start, end=end,
                    score=float(row.score or 0), title=row.title or "",
                    reason=cmeta.get("viral_reason", "") or "",
                    platform=row.platform or "tiktok",
                    hook_score=float(signals.get("hook_score") or 0.0),
                    # keep the original scoring signals (they'd be overwritten with None)
                    audio_energy=_float_or_none(signals.get("audio_energy")),
                    speech_rate=_float_or_none(signals.get("speech_rate")),
                )
                applied = None  # editor edits being applied: {"range", "items"} in source seconds
                if timing and isinstance(timing.get("captions"), list):
                    applied = {"range": [start, end], "items": timing["captions"]}
                custom = applied or cmeta.get("custom_captions")
                captions = _build_captions(words, clip, words_per_line, custom)
                ai_content = {
                    "title": cmeta.get("ai_title") or clip.title,
                    "platforms": cmeta.get("platforms") or {},
                    "all_hashtags": cmeta.get("trending_hashtags") or [],
                }

                if mode in ("text", "both"):
                    old_titles = [t for t in (row.title, cmeta.get("ai_title")) if t]
                    new = _batch_ai_content(
                        [clip], words, {0: captions}, platforms,
                        content_type=content_type, topic_focus=topic_focus,
                        language=language, avoid_titles={0: old_titles},
                    ).get(0) or {}
                    if new.get("ai_ok") is False or not new.get("title"):
                        # The AI gave no usable answer; don't report success with the old text.
                        raise RuntimeError(
                            "The AI didn't return a new title, so nothing was changed. Check that "
                            "your AI server answers in time and isn't cut off (stop reason "
                            "'length'), then try again.")
                    if new.get("title"):
                        ai_content = {
                            "title": new["title"],
                            "platforms": new.get("platforms") or ai_content["platforms"],
                            "all_hashtags": new.get("all_hashtags") or ai_content["all_hashtags"],
                        }
                    if mode == "text":
                        import json
                        title = str(ai_content["title"])[:100].strip()
                        with _get_session(tenant_id) as session:
                            session.execute(
                                text("""
                                    UPDATE clips
                                       SET title = :title,
                                           metadata = (COALESCE(metadata, '{}'::jsonb) - 'regenerate_error')
                                                      || CAST(:meta AS jsonb),
                                           status = 'ready', updated_at = NOW()
                                     WHERE id = CAST(:cid AS uuid)
                                """),
                                {"cid": cid, "title": title, "meta": json.dumps({
                                    "ai_title": title,
                                    "platforms": ai_content["platforms"],
                                    "trending_hashtags": ai_content["all_hashtags"],
                                })},
                            )
                        results[cid] = "ok"
                        continue

                if source_path is None:
                    source_path = _fetch_source(tenant_id, video_id, vrow, work_dir, cfg)
                    meta = _probe_video(source_path)
                exported = _export_clip(
                    tenant_id=tenant_id, video_id=video_id, clip=clip, captions=captions,
                    source_path=source_path, work_dir=work_dir, meta=meta, cfg=cfg,
                    words=words, ai_content=ai_content, occasion=occasion,
                    viral_type=viral_type, existing_clip_id=cid,
                )
                if not exported:
                    raise RuntimeError("render produced no clip")
                _, clip_path = exported
                if (start, end) != (float(row.start_sec), float(row.end_sec)):
                    _save_new_timing(tenant_id, cid, start, end,
                                     start_moved=abs(start - float(row.start_sec)) >= 0.05)
                if applied is not None:
                    _save_applied_edits(tenant_id, cid, applied, shift_sec=start - float(row.start_sec),
                                        old_editor=cmeta.get("editor") if isinstance(cmeta, dict) else None)
                # Same hand-off as the pipeline: upload replaces the stored file and
                # flips the clip back to "ready"; job_id = video id, like retry-upload.
                upload_clip_to_storage.delay(cid, clip_path, tenant_id, video_id)
                results[cid] = "ok"
            except Exception as e:  # one bad clip must not stop the rest
                log.exception("regenerate %s (%s) failed", cid, mode)
                _restore_status(tenant_id, cid, str(e))
                from celery.exceptions import SoftTimeLimitExceeded
                if isinstance(e, SoftTimeLimitExceeded):
                    raise  # out of time: the task wrapper resets the clips not reached yet
                results[cid] = str(e)[:300]
    finally:
        if source_path:
            try:
                Path(source_path).unlink(missing_ok=True)
            except Exception:
                pass
    return results


@celery_app.task(bind=True, name="workers.tasks.video.regenerate_clips", acks_late=True,
                 time_limit=4 * 3600, soft_time_limit=4 * 3600 - 120)
def regenerate_clips(self, tenant_id: str, video_id: str, clip_ids: list[str], mode: str,
                     timing: dict | None = None) -> dict:
    try:
        return _regenerate_clips(tenant_id, video_id, list(clip_ids), mode, timing)
    except Exception as e:
        # Failed before or between clips (missing video, DB error, out of time):
        # don't leave the remaining clips "regenerating" — that refuses every retry.
        msg = ("Regenerate ran out of time." if type(e).__name__ == "SoftTimeLimitExceeded"
               else f"Regenerate failed: {str(e)[:200]}")
        for cid in clip_ids:
            try:
                _restore_status(tenant_id, cid, msg, only_if_regenerating=True)
            except Exception:
                log.exception("could not reset clip %s after a failed regenerate", cid)
        raise
