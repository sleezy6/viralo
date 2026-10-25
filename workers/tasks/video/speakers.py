# Added 2026 by sleezy6 (fork of sammyview80/viralo, Apache-2.0).
"""Speakers of a video: names and caption colours.

Stored in videos.metadata->'speakers':
    {"colors": true, "list": [{"id": "S1", "name": "Rich", "color": "#FFFFFF"}, ...]}
ids come from the transcript (diarizing speech models); names and colours are the
user's. With colours on and two or more speakers, each caption is drawn in its
speaker's colour; names are what the AI sees in the transcript ("Rich: …").
"""
import json
import logging
import re

from sqlalchemy import text

from workers.tasks.video._core import _get_session

__all__ = ["PALETTE", "speakers_in", "init_speakers", "load_speakers",
           "apply_speaker_colors", "speaker_names"]

log = logging.getLogger(__name__)

# First speaker keeps the style's own text colour (white); the rest avoid the
# yellow most caption styles use for the active word.
PALETTE = ["#FFFFFF", "#4FD1FF", "#FF7AC6", "#5CF08A", "#FF9F43", "#B38CFF", "#FF6B6B", "#9AE6B4"]
_META = ("(CASE jsonb_typeof(metadata) WHEN 'object' THEN metadata "
         "WHEN 'string' THEN (metadata #>> '{}')::jsonb ELSE '{}'::jsonb END)")
_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")


def speakers_in(words: list) -> list[str]:
    """Speaker ids in order of first appearance."""
    seen: list[str] = []
    for w in words:
        spk = getattr(w, "speaker", None)
        if spk and spk not in seen:
            seen.append(spk)
    return seen


def _read(tenant_id: str, video_id: str) -> dict:
    with _get_session(tenant_id) as session:
        row = session.execute(text(f"SELECT {_META}->'speakers' FROM videos WHERE id = CAST(:v AS uuid)"),
                              {"v": video_id}).fetchone()
    val = row[0] if row else None
    if isinstance(val, str):
        try:
            val = json.loads(val)
        except ValueError:
            val = None
    return val if isinstance(val, dict) else {}


def load_speakers(tenant_id: str, video_id: str) -> dict:
    """The video's speaker settings ({} when it has none). Never raises."""
    try:
        return _read(tenant_id, video_id)
    except Exception as e:
        log.warning("[Speakers] could not load for %s: %s", video_id, str(e)[:120])
        return {}


def init_speakers(tenant_id: str, video_id: str, words: list) -> dict:
    """Record the transcript's speakers on the video, keeping names/colours already set."""
    ids = speakers_in(words)
    if not ids:
        return {}
    try:
        cur = _read(tenant_id, video_id)
        by_id = {s.get("id"): s for s in cur.get("list") or [] if isinstance(s, dict)}
        out = []
        for i, sid in enumerate(ids):
            old = by_id.get(sid) or {}
            out.append({"id": sid, "name": old.get("name") or None,
                        "color": old.get("color") if _HEX.match(str(old.get("color") or "")) else PALETTE[i % len(PALETTE)]})
        settings = {"colors": cur.get("colors", True) is not False, "list": out}
        with _get_session(tenant_id) as session:
            session.execute(
                text(f"UPDATE videos SET metadata = {_META} || jsonb_build_object('speakers', CAST(:s AS jsonb)) "
                     "WHERE id = CAST(:v AS uuid)"),
                {"s": json.dumps(settings), "v": video_id},
            )
        return settings
    except Exception as e:
        log.warning("[Speakers] could not save for %s: %s", video_id, str(e)[:120])
        return {}


def _rgb(hex_: str) -> tuple[int, int, int] | None:
    if not _HEX.match(hex_ or ""):
        return None
    return tuple(int(hex_[i:i + 2], 16) for i in (1, 3, 5))


def apply_speaker_colors(captions: list, settings: dict) -> list:
    """Set each caption's colour from its speaker. Only when colours are on and the
    video has two or more speakers; otherwise captions keep the style's colour."""
    lst = [s for s in (settings or {}).get("list") or [] if isinstance(s, dict)]
    if not settings or settings.get("colors") is False or len(lst) < 2:
        return captions
    colors = {s.get("id"): _rgb(str(s.get("color") or "")) for s in lst}
    for cap in captions:
        spk = getattr(cap, "speaker", None)
        if spk and colors.get(spk):
            cap.color = colors[spk]
    return captions


def speaker_names(settings: dict) -> dict[str, str]:
    """{"S1": "Rich", …} for the speakers the user named."""
    return {s["id"]: str(s["name"]).strip() for s in (settings or {}).get("list") or []
            if isinstance(s, dict) and s.get("id") and str(s.get("name") or "").strip()}
