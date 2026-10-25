# Added 2026 by sleezy6 (fork of sammyview80/viralo, Apache-2.0).
"""Regenerate existing clips: new AI title/caption/tags, a re-render, or both.

A clip keeps its id, schedule and storage key. Re-rendering goes through the same
_export_clip path as the pipeline (current caption, emoji and hook code), updating
the clip in place; the old video stays playable until the new upload lands.
"""
import logging
import os
from pathlib import Path

from sqlalchemy import text

from workers.celery_app import celery_app
from workers.tasks.video._core import (
    CAPCUT_STYLES,
    VIDEO_TEMP_DIR,
    ClipResult,
    _effective_caption_style,
    _get_session,
    _load_transcript_words,
)

__all__ = ["REGEN_MODES", "regenerate_clips", "_regenerate_clips"]

REGEN_MODES = ("text", "render", "both")
log = logging.getLogger(__name__)


def _fetch_source(tenant_id: str, video_id: str, row, work_dir: Path, cfg: dict) -> str:
    """Source video for re-rendering: the stored original, else a fresh YouTube download."""
    out = work_dir / "source_regen.mp4"
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
        got = _download_youtube(row.source_url, str(out), quality=cfg.get("output_quality", "source"),
                                tenant_id=tenant_id)
        return got or str(out)
    raise FileNotFoundError("The original video is no longer available to re-render from")


def _set_status(tenant_id: str, clip_id: str, status: str, error: str | None = None) -> None:
    with _get_session(tenant_id) as session:
        session.execute(
            text("""
                UPDATE clips
                   SET status = :st,
                       metadata = CASE WHEN :err IS NULL
                                       THEN COALESCE(metadata, '{}'::jsonb) - 'regenerate_error'
                                       ELSE COALESCE(metadata, '{}'::jsonb)
                                            || jsonb_build_object('regenerate_error', CAST(:err AS text))
                                  END,
                       updated_at = NOW()
                 WHERE id = CAST(:cid AS uuid)
            """),
            {"cid": clip_id, "st": status, "err": error},
        )


def _regenerate_clips(tenant_id: str, video_id: str, clip_ids: list[str], mode: str) -> dict:
    """Regenerate clips of one video in order. Returns {clip_id: "ok" | error}."""
    if mode not in REGEN_MODES:
        raise ValueError(f"mode must be one of {REGEN_MODES}")
    from workers.tasks.video.ai import _batch_ai_content
    from workers.tasks.video.pipeline import _resolve_pipeline_language
    from workers.tasks.video.render import _export_clip, _generate_captions
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
    style = _effective_caption_style(cfg)
    words_per_line = 5 if style == "tiktok" else (3 if style in CAPCUT_STYLES else 6)  # as the pipeline
    language = _resolve_pipeline_language(cfg, meta_lang=vmeta.get("language_detected") or None)
    platforms = cfg.get("platforms", ["tiktok", "reels", "shorts"])
    content_type = vmeta.get("content_type", "other") or "other"
    occasion = cfg.get("occasion") or vmeta.get("occasion", "") or ""
    viral_type = vmeta.get("viral_type", "") or ""

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
                clip = ClipResult(
                    start=float(row.start_sec), end=float(row.end_sec),
                    score=float(row.score or 0), title=row.title or "",
                    reason=cmeta.get("viral_reason", "") or "",
                    platform=row.platform or "tiktok",
                    hook_score=float(signals.get("hook_score") or 0.0),
                )
                captions = _generate_captions(words, clip, max_words=words_per_line)
                ai_content = {
                    "title": cmeta.get("ai_title") or clip.title,
                    "platforms": cmeta.get("platforms") or {},
                    "all_hashtags": cmeta.get("trending_hashtags") or [],
                }

                if mode in ("text", "both"):
                    new = _batch_ai_content(
                        [clip], words, {0: captions}, platforms,
                        content_type=content_type, topic_focus=cfg.get("topic_focus", ""),
                        language=language,
                    ).get(0) or {}
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
                # Same hand-off as the pipeline: upload replaces the stored file and
                # flips the clip back to "ready"; job_id = video id, like retry-upload.
                upload_clip_to_storage.delay(cid, clip_path, tenant_id, video_id)
                results[cid] = "ok"
            except Exception as e:  # one bad clip must not stop the rest
                log.exception("regenerate %s (%s) failed", cid, mode)
                _set_status(tenant_id, cid, "ready", error=str(e)[:300])
                results[cid] = str(e)[:300]
    finally:
        if source_path:
            try:
                Path(source_path).unlink(missing_ok=True)
            except Exception:
                pass
    return results


@celery_app.task(bind=True, name="workers.tasks.video.regenerate_clips",
                 time_limit=4 * 3600, soft_time_limit=4 * 3600 - 120)
def regenerate_clips(self, tenant_id: str, video_id: str, clip_ids: list[str], mode: str) -> dict:
    return _regenerate_clips(tenant_id, video_id, list(clip_ids), mode)
