# Modified 2026 by sleezy6 (fork of sammyview80/viralo, Apache-2.0): Studio clip suggestions.
"""Studio suggestions: unrendered clip regions on the source timeline.

The pipeline stores its top picks and runners-up as `clips` rows with status
'suggested' (no video file yet). The Studio lets the user adjust them, pick a title
and export; export re-uses the regenerate path to render from the stored source.
"""
import asyncio
import json
import logging
import os
import uuid
from pathlib import Path

from sqlalchemy import text

from workers.tasks.video._core import ClipResult, _generate_srt, _get_session
from workers.tasks.video.ai import _title_options
from workers.tasks.video.render import _generate_captions, _generate_thumbnail

__all__ = ["SUGGESTED", "suggestion_meta", "insert_suggestions", "keep_source_copy"]

SUGGESTED = "suggested"


def suggestion_meta(clip: ClipResult, tier: str, content: dict | None, cfg: dict,
                    occasion: str = "", viral_type: str = "") -> dict:
    """clip_metadata for a suggestion row (same keys an export writes, plus the
    title options and which tier the AI put it in)."""
    content = content or {}
    title = (content.get("title") or clip.title or "").strip()[:100]
    options = content.get("titles") or ([] if not content.get("ai_ok") else _title_options([], title))
    meta = {
        "ai_title": title,
        "title_options": options,
        "tier": tier,
        "viral_reason": clip.reason or "",
        "viral_score": round(float(clip.score), 2),
        "platforms": content.get("platforms", {}),
        "occasion": occasion or "",
        "viral_type": viral_type or "",
        "template_id": cfg.get("template_id") or "",
        "aspect_ratio": cfg.get("aspect_ratio", "9:16"),
        "signals": {"hook_score": round(clip.hook_score, 3) if clip.hook_score else 0.0,
                    "audio_energy": None, "speech_rate": None},
    }
    if content.get("all_hashtags"):
        meta["trending_hashtags"] = content["all_hashtags"]
    return meta


def _upload_thumb(path: str, key: str) -> str | None:
    from shared.storage.base import get_storage

    async def _up() -> str | None:
        st = get_storage(os.getenv("STORAGE_PROVIDER", "local"))
        with open(path, "rb") as f:
            return await st.upload(f, key, "image/jpeg")
    try:
        return asyncio.run(_up())
    except Exception as e:
        logging.warning("suggestion thumbnail upload failed (%s): %s", key, e)
        return None
    finally:
        Path(path).unlink(missing_ok=True)


def insert_suggestions(tenant_id: str, video_id: str, items: list[tuple[ClipResult, str, dict | None]],
                       source_path: str, work_dir: Path, cfg: dict, words: list,
                       occasion: str = "", viral_type: str = "",
                       words_per_line: int = 5) -> list[str]:
    """Store (clip, tier, ai_content) items as 'suggested' clips. Returns their ids."""
    ids: list[str] = []
    rows = []
    for clip, tier, content in items:
        cid = str(uuid.uuid4())
        thumb_url = None
        thumb_path = str(work_dir / f"sugg_{cid}.jpg")
        try:
            _generate_thumbnail(source_path, clip, thumb_path)
            thumb_url = _upload_thumb(thumb_path, f"clips/{tenant_id}/{cid}_thumb.jpg")
        except Exception as e:
            logging.info("suggestion thumbnail skipped for %.1f-%.1f: %s", clip.start, clip.end, e)
        srt = ""
        if words:
            try:
                srt = _generate_srt(_generate_captions(words, clip, max_words=words_per_line))
            except Exception:
                srt = ""
        meta = suggestion_meta(clip, tier, content, cfg, occasion, viral_type)
        rows.append({
            "id": cid, "tid": tenant_id, "vid": video_id, "title": meta["ai_title"] or "Clip",
            "ss": clip.start, "es": clip.end, "sms": int(clip.start * 1000), "ems": int(clip.end * 1000),
            "dur": int((clip.end - clip.start) * 1000), "plat": clip.platform, "score": float(clip.score),
            "thumb": thumb_url, "srt": srt, "meta": json.dumps(meta),
        })
        ids.append(cid)
    if not rows:
        return ids
    with _get_session(tenant_id) as session:
        session.execute(
            text("""
                INSERT INTO clips
                  (id, tenant_id, video_id, title, start_sec, end_sec,
                   start_ms, end_ms, duration_ms, platform, score, status,
                   storage_url, thumbnail_url, caption_srt, metadata, created_at, updated_at)
                VALUES
                  (CAST(:id AS uuid), CAST(:tid AS uuid), CAST(:vid AS uuid), :title, :ss, :es,
                   :sms, :ems, :dur, :plat, :score, 'suggested',
                   NULL, :thumb, :srt, CAST(:meta AS jsonb), NOW(), NOW())
            """),
            rows,
        )
    return ids


def keep_source_copy(tenant_id: str, video_id: str, source_path: str) -> None:
    """Studio exports render from the source later, so a project without a stored
    original (YouTube imports) gets its downloaded file copied to storage now."""
    with _get_session(tenant_id) as session:
        row = session.execute(
            text("SELECT original_storage_key FROM videos WHERE id = CAST(:vid AS uuid)"),
            {"vid": video_id},
        ).fetchone()
    if not row or row.original_storage_key or not source_path or not Path(source_path).exists():
        return
    from shared.storage.base import get_storage
    ext = Path(source_path).suffix.lower() or ".mp4"
    key = f"originals/{tenant_id}/{video_id}/source{ext}"

    async def _up() -> str:
        st = get_storage(os.getenv("STORAGE_PROVIDER", "local"))
        with open(source_path, "rb") as f:
            return await st.upload(f, key, "video/mp4")
    try:
        stored = asyncio.run(_up())
    except Exception as e:
        logging.warning("keep_source_copy failed for %s: %s", video_id, e)
        return
    with _get_session(tenant_id) as session:
        session.execute(
            text("UPDATE videos SET original_storage_key = :k WHERE id = CAST(:vid AS uuid)"),
            {"k": stored or key, "vid": video_id},
        )
    logging.info("Kept a copy of the source for %s (%s)", video_id, stored or key)
