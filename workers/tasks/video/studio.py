# Modified 2026 by sleezy6 (fork of sammyview80/viralo, Apache-2.0): Studio title options.
"""More title options for a Studio clip, without touching its video."""
import json
import logging

from sqlalchemy import text

from workers.celery_app import celery_app
from workers.tasks.video._core import ClipResult, _get_session, _load_transcript_words

__all__ = ["suggest_clip_titles", "_suggest_clip_titles", "merge_title_options"]

log = logging.getLogger(__name__)
MAX_OPTIONS = 15


def merge_title_options(old: list | None, new: list | None, limit: int = MAX_OPTIONS) -> list[dict]:
    """Existing options first (the user may have been looking at them), new ones after,
    no duplicates, at most `limit` (the oldest unscored ones drop first)."""
    out: list[dict] = []
    seen: set[str] = set()
    for o in list(old or []) + list(new or []):
        if not isinstance(o, dict):
            continue
        t = " ".join(str(o.get("text") or "").split())
        if t and t.lower() not in seen:
            seen.add(t.lower())
            out.append({"text": t[:100], "score": o.get("score"), "hook_type": o.get("hook_type")})
    return out[-limit:]


def _set_meta(tenant_id: str, clip_id: str, patch: dict, drop: tuple[str, ...] = ()) -> None:
    minus = "".join(f" - '{k}'" for k in drop)
    with _get_session(tenant_id) as session:
        session.execute(
            text(f"UPDATE clips SET metadata = (COALESCE(metadata, '{{}}'::jsonb){minus}) || CAST(:m AS jsonb), "
                 "updated_at = NOW() WHERE id = CAST(:cid AS uuid)"),
            {"cid": clip_id, "m": json.dumps(patch)},
        )


def _suggest_clip_titles(tenant_id: str, clip_id: str) -> dict:
    from workers.tasks.video.ai import _multi_agent_clip_content
    from workers.tasks.video.game_context import with_game_context
    from workers.tasks.video.pipeline import _resolve_pipeline_language

    with _get_session(tenant_id) as session:
        row = session.execute(
            text("""
                SELECT c.title, c.start_sec, c.end_sec, c.platform, c.score, c.metadata,
                       c.video_id::text AS video_id, v.clip_config, v.metadata AS vmeta
                  FROM clips c JOIN videos v ON v.id = c.video_id
                 WHERE c.id = CAST(:cid AS uuid)
            """),
            {"cid": clip_id},
        ).fetchone()
    if not row:
        return {}
    cmeta, cfg, vmeta = row.metadata or {}, row.clip_config or {}, row.vmeta or {}
    words = _load_transcript_words(tenant_id, row.video_id)
    start, end = float(row.start_sec or 0), float(row.end_sec or 0)
    snippet = " ".join(w.word for w in words if start <= w.start <= end)
    clip = ClipResult(start=start, end=end, score=float(row.score or 0), title=row.title or "",
                      reason=cmeta.get("viral_reason", "") or "", platform=row.platform or "tiktok")
    old = cmeta.get("title_options") or []
    avoid = [o.get("text") for o in old if isinstance(o, dict)] + [cmeta.get("ai_title"), row.title]
    content = _multi_agent_clip_content(
        clip=clip, transcript_snippet=snippet[:3000],
        platforms=cfg.get("platforms", ["tiktok", "reels", "shorts"]),
        content_type=vmeta.get("content_type", "other") or "other",
        topic_focus=with_game_context(cfg.get("topic_focus", ""), vmeta.get("game")),
        language=_resolve_pipeline_language(cfg, meta_lang=vmeta.get("language_detected") or None),
        avoid_titles=[a for a in avoid if a],
    )
    if not content.get("ai_ok") or not content.get("titles"):
        _set_meta(tenant_id, clip_id, {"titles_error": "The AI didn't return any titles. Check your AI "
                                       "server (and that it isn't cut off), then try again."},
                  drop=("titles_pending",))
        return {"ok": False}
    patch: dict = {"title_options": merge_title_options(old, content["titles"])}
    # A clip the AI never titled (runner-up / manual) gets the best new one, and its
    # descriptions/tags, so it's ready to export; a chosen title is never replaced.
    if not cmeta.get("title_chosen") and not old:
        patch["ai_title"] = content["title"][:100]
        if content.get("platforms") and not cmeta.get("platforms"):
            patch["platforms"] = content["platforms"]
        if content.get("all_hashtags") and not cmeta.get("trending_hashtags"):
            patch["trending_hashtags"] = content["all_hashtags"]
    _set_meta(tenant_id, clip_id, patch, drop=("titles_pending", "titles_error"))
    if "ai_title" in patch:
        with _get_session(tenant_id) as session:
            session.execute(text("UPDATE clips SET title = :t WHERE id = CAST(:cid AS uuid)"),
                            {"t": patch["ai_title"], "cid": clip_id})
    return {"ok": True, "count": len(patch["title_options"])}


@celery_app.task(name="workers.tasks.video.suggest_clip_titles", soft_time_limit=900, time_limit=960)
def suggest_clip_titles(tenant_id: str, clip_id: str) -> dict:
    try:
        return _suggest_clip_titles(tenant_id, clip_id)
    except Exception as e:
        log.exception("suggest_clip_titles %s failed", clip_id)
        try:
            _set_meta(tenant_id, clip_id, {"titles_error": f"Couldn't get titles: {str(e)[:200]}"},
                      drop=("titles_pending",))
        except Exception:
            pass
        raise
