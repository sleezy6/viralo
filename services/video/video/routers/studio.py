# Modified 2026 by sleezy6 (fork of sammyview80/viralo, Apache-2.0): Project Studio endpoints.
"""Project Studio: the whole source video on one timeline, with the AI's suggested
clips as regions. Suggestions are clips with status "suggested" (no video yet);
editing them is instant and Export renders them from the stored source."""
import json
import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from shared.deps import get_current_user, get_tenant_db
from shared.schemas.auth import TokenPayload
from video.models import Clip, Video
from video.routers.videos import (
    _MAX_CLIP_SEC,
    _REGEN_READY_STATUSES,
    _claim_and_queue,
    _get_celery,
    _set_tenant,
)
from video.schemas import ClipResponse, VideoResponse

router = APIRouter()
log = logging.getLogger(__name__)

EXPORTABLE = ("suggested",) + tuple(_REGEN_READY_STATUSES)
BUSY = ("regenerating", "pending_upload", "uploading")


class StudioCaption(BaseModel):
    text: str = Field(max_length=500)
    start_sec: float = Field(ge=0)  # seconds of the original video
    end_sec: float = Field(ge=0)


class StudioClipPatch(BaseModel):
    """Studio edits. Times are seconds of the original video."""
    title: str | None = Field(default=None, max_length=100)
    start_sec: float | None = Field(default=None, ge=0)
    end_sec: float | None = Field(default=None, ge=0)
    # The clip's captions as edited; [] goes back to the transcript's own captions.
    captions: list[StudioCaption] | None = Field(default=None, max_length=1000)


class SuggestionCreate(BaseModel):
    start_sec: float = Field(ge=0)
    end_sec: float = Field(ge=0)


class ExportRequest(BaseModel):
    clip_ids: list[uuid.UUID] = Field(min_length=1, max_length=50)


async def _video(db: AsyncSession, token: TokenPayload, video_id: uuid.UUID) -> Video:
    video = (await db.execute(select(Video).where(
        Video.id == video_id, Video.tenant_id == uuid.UUID(token.tenant_id), Video.status != "deleted",
    ))).scalar_one_or_none()
    if not video:
        raise HTTPException(status_code=404, detail="Video not found.")
    return video


async def _clip(db: AsyncSession, token: TokenPayload, clip_id: uuid.UUID) -> Clip:
    clip = (await db.execute(select(Clip).where(
        Clip.id == clip_id, Clip.tenant_id == uuid.UUID(token.tenant_id), Clip.status != "deleted",
    ))).scalar_one_or_none()
    if not clip:
        raise HTTPException(status_code=404, detail="Clip not found.")
    return clip


def _check_range(start: float, end: float, duration: float | None) -> tuple[float, float]:
    if duration:
        end = min(end, float(duration))
    start, end = round(start, 2), round(end, 2)
    if end - start < 1:
        raise HTTPException(status_code=422, detail="A clip must be at least 1 second long.")
    if end - start > _MAX_CLIP_SEC:
        raise HTTPException(status_code=422, detail=f"A clip can be at most {_MAX_CLIP_SEC // 60} minutes long.")
    return start, end


def _words_from_segments(segments) -> list[list]:
    """[[word, start, end, speaker|None]] in seconds of the original video."""
    if isinstance(segments, str):
        segments = json.loads(segments)
    out: list[list] = []
    for seg in segments or []:
        saved = seg.get("words")
        if saved:
            for x in saved:
                out.append([str(x[0]), float(x[1]), float(x[2]), (str(x[3]) if len(x) > 3 and x[3] else None)])
            continue
        toks = str(seg.get("text") or "").split()
        if not toks:
            continue
        s0, s1 = float(seg.get("start") or 0), float(seg.get("end") or 0)
        weights = [max(len(t), 1) for t in toks]
        total, t = float(sum(weights)), s0
        for tok, w in zip(toks, weights):
            d = max(s1 - s0, 0.01) * w / total
            out.append([tok, round(t, 3), round(t + d, 3), seg.get("speaker")])
            t += d
    return out


@router.get("/videos/{video_id}/transcript")
async def get_transcript(video_id: uuid.UUID, token: TokenPayload = Depends(get_current_user),
                         db: AsyncSession = Depends(get_tenant_db)):
    """The whole video's words with timings and speakers (seconds of the original)."""
    await _video(db, token, video_id)
    row = (await db.execute(text("SELECT segments FROM transcripts WHERE video_id = CAST(:v AS uuid)"),
                            {"v": str(video_id)})).fetchone()
    return {"words": _words_from_segments(row[0] if row else [])}


@router.post("/videos/{video_id}/studio-preview", response_model=VideoResponse,
             status_code=status.HTTP_202_ACCEPTED)
async def queue_studio_preview(video_id: uuid.UUID, token: TokenPayload = Depends(get_current_user),
                               db: AsyncSession = Depends(get_tenant_db)):
    """Build the timeline preview for a project made before the Studio existed."""
    video = await _video(db, token, video_id)
    studio = (video.video_metadata or {}).get("studio") or {}
    if studio.get("preview") or studio.get("status") in ("queued", "building"):
        return VideoResponse.model_validate(video)
    await db.execute(text("""
        UPDATE videos SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{studio}',
                 COALESCE(metadata->'studio', '{}'::jsonb) || '{"status": "queued"}'::jsonb)
         WHERE id = CAST(:v AS uuid)"""), {"v": str(video_id)})
    await db.commit()
    await _set_tenant(db, token.tenant_id)
    try:
        _get_celery().send_task("workers.tasks.video.build_video_preview",
                                args=[str(uuid.UUID(token.tenant_id)), str(video_id)])
    except Exception as e:
        log.error("Could not queue the Studio preview for %s: %s", video_id, e)
        await db.execute(text("UPDATE videos SET metadata = metadata #- '{studio,status}' WHERE id = CAST(:v AS uuid)"),
                         {"v": str(video_id)})
        await db.commit()
        await _set_tenant(db, token.tenant_id)
        raise HTTPException(status_code=503, detail="Couldn't start the preview (the task queue isn't reachable).")
    await db.refresh(video)
    return VideoResponse.model_validate(video)


@router.post("/videos/{video_id}/suggestions", response_model=ClipResponse, status_code=status.HTTP_201_CREATED)
async def create_suggestion(video_id: uuid.UUID, body: SuggestionCreate,
                            token: TokenPayload = Depends(get_current_user),
                            db: AsyncSession = Depends(get_tenant_db)):
    """A clip of your own on the timeline (not rendered until you export it). The AI
    is asked for title options for it straight away."""
    video = await _video(db, token, video_id)
    start, end = _check_range(body.start_sec, body.end_sec, video.duration_sec)
    cfg = video.clip_config or {}
    clip = Clip(
        id=uuid.uuid4(), tenant_id=uuid.UUID(token.tenant_id), video_id=video.id, title="New clip",
        start_sec=start, end_sec=end, start_ms=int(start * 1000), end_ms=int(end * 1000),
        duration_ms=int((end - start) * 1000), platform=(cfg.get("platforms") or ["tiktok"])[0][:20],
        score=None, status="suggested",
        clip_metadata={"tier": "manual", "ai_title": "", "title_options": [], "viral_reason": "",
                       "aspect_ratio": cfg.get("aspect_ratio", "9:16"), "titles_pending": True},
    )
    db.add(clip)
    await db.commit()
    await _set_tenant(db, token.tenant_id)
    try:
        _get_celery().send_task("workers.tasks.video.suggest_clip_titles",
                                args=[str(uuid.UUID(token.tenant_id)), str(clip.id)])
    except Exception as e:  # the clip is still usable; titles can be asked for again
        log.warning("Could not queue titles for new clip %s: %s", clip.id, e)
        clip.clip_metadata = {**clip.clip_metadata, "titles_pending": False}
        await db.commit()
        await _set_tenant(db, token.tenant_id)
    await db.refresh(clip)
    return clip


@router.patch("/clips/{clip_id}/studio", response_model=ClipResponse)
async def patch_studio_clip(clip_id: uuid.UUID, body: StudioClipPatch,
                            token: TokenPayload = Depends(get_current_user),
                            db: AsyncSession = Depends(get_tenant_db)):
    """Pick a title, move the clip's start/end, or edit its captions. Instant for
    suggestions; an exported clip is marked as needing a re-export."""
    clip = await _clip(db, token, clip_id)
    if clip.status in BUSY:
        raise HTTPException(status_code=409, detail="This clip is being exported; try again when it's done.")
    meta = dict(clip.clip_metadata or {})
    changed = False
    if body.title is not None:
        title = " ".join(body.title.split())[:100]
        if not title:
            raise HTTPException(status_code=422, detail="The title can't be empty.")
        if title != (meta.get("ai_title") or clip.title):
            changed = True
        clip.title, meta["ai_title"], meta["title_chosen"] = title, title, True
    if body.start_sec is not None or body.end_sec is not None:
        video = (await db.execute(select(Video).where(Video.id == clip.video_id))).scalar_one()
        start = body.start_sec if body.start_sec is not None else float(clip.start_sec or 0)
        end = body.end_sec if body.end_sec is not None else float(clip.end_sec or 0)
        start, end = _check_range(start, end, video.duration_sec)
        if (start, end) != (float(clip.start_sec or 0), float(clip.end_sec or 0)):
            changed = True
            clip.start_sec, clip.end_sec = start, end
            clip.start_ms, clip.end_ms, clip.duration_ms = int(start * 1000), int(end * 1000), int((end - start) * 1000)
    if body.captions is not None:
        items = []
        for c in body.captions:
            t = " ".join(c.text.split())
            if t and c.end_sec - c.start_sec >= 0.05:
                items.append({"text": t, "start": round(c.start_sec, 3), "end": round(c.end_sec, 3)})
        items.sort(key=lambda it: it["start"])
        if items:
            meta["custom_captions"] = {"range": [items[0]["start"], items[-1]["end"]], "items": items}
        else:
            meta.pop("custom_captions", None)
        changed = True
    if changed and clip.storage_url:
        meta["dirty"] = True
    clip.clip_metadata = meta
    await db.commit()
    await _set_tenant(db, token.tenant_id)
    await db.refresh(clip)
    return clip


@router.post("/clips/{clip_id}/titles", response_model=ClipResponse, status_code=status.HTTP_202_ACCEPTED)
async def request_titles(clip_id: uuid.UUID, token: TokenPayload = Depends(get_current_user),
                         db: AsyncSession = Depends(get_tenant_db)):
    """Ask the AI for more title options (added to the list; the chosen title stays)."""
    clip = await _clip(db, token, clip_id)
    meta = dict(clip.clip_metadata or {})
    if meta.get("titles_pending"):
        return clip
    meta.pop("titles_error", None)
    clip.clip_metadata = {**meta, "titles_pending": True}
    await db.commit()
    await _set_tenant(db, token.tenant_id)
    try:
        _get_celery().send_task("workers.tasks.video.suggest_clip_titles",
                                args=[str(uuid.UUID(token.tenant_id)), str(clip_id)])
    except Exception as e:
        log.error("Could not queue titles for %s: %s", clip_id, e)
        clip.clip_metadata = meta
        await db.commit()
        await _set_tenant(db, token.tenant_id)
        raise HTTPException(status_code=503, detail="Couldn't ask the AI (the task queue isn't reachable).")
    await db.refresh(clip)
    return clip


@router.post("/videos/{video_id}/export", status_code=status.HTTP_202_ACCEPTED)
async def export_clips(video_id: uuid.UUID, body: ExportRequest,
                       token: TokenPayload = Depends(get_current_user),
                       db: AsyncSession = Depends(get_tenant_db)):
    """Render the chosen clips (suggestions, or exported clips again after edits) at
    their current start/end, with the chosen title and captions. One job renders them
    in order, so the source is fetched once."""
    await _video(db, token, video_id)
    clips = (await db.execute(
        select(Clip).where(Clip.id.in_(body.clip_ids), Clip.video_id == video_id,
                           Clip.tenant_id == uuid.UUID(token.tenant_id), Clip.status.in_(EXPORTABLE))
        .order_by(Clip.start_sec)
    )).scalars().all()
    ids = await _claim_and_queue(db, token.tenant_id, str(video_id), list(clips), "render",
                                 allowed=EXPORTABLE) if clips else []
    if not ids:
        raise HTTPException(status_code=409, detail="None of those clips can be exported right now.")
    return {"queued": len(ids), "clip_ids": ids}
