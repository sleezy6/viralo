# Modified 2026 by sleezy6 (fork of sammyview80/viralo, Apache-2.0): Studio preview proxy + waveform.
"""Studio preview assets for a project: a browser-friendly proxy of the whole source
(H.264/AAC MP4, ≤540p, a keyframe about every second for fast scrubbing, no burned
captions) and a small waveform peaks file for the timeline.

Stored in videos.metadata.studio = {"preview": url, "peaks": url, "status": ...}.
"""
import array
import asyncio
import json
import logging
import os
import subprocess
import tempfile
import uuid
from pathlib import Path

from sqlalchemy import text

from workers.celery_app import celery_app
from workers.tasks.video import hwaccel
from workers.tasks.video._core import VIDEO_TEMP_DIR, _get_session

__all__ = ["build_preview_assets", "build_video_preview", "PEAKS_PER_SEC", "compute_peaks"]

log = logging.getLogger(__name__)
PEAKS_PER_SEC = 20
_PEAK_RATE = 2000  # Hz of the mono PCM the peaks are measured from


def _set_status(tenant_id: str, video_id: str, **fields) -> None:
    with _get_session(tenant_id) as session:
        session.execute(
            text("""
                UPDATE videos
                   SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{studio}',
                                            COALESCE(metadata->'studio', '{}'::jsonb) || CAST(:p AS jsonb))
                 WHERE id = CAST(:vid AS uuid)
            """),
            {"vid": video_id, "p": json.dumps(fields)},
        )


def _encode_proxy(source_path: str, out_path: str, fps: float) -> None:
    gop = str(max(1, round(fps or 30)))
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", source_path,
           "-map", "0:v:0", "-map", "0:a:0?",
           "-vf", "scale=-2:'min(540,ih)':flags=bilinear",
           *hwaccel.ffmpeg_encoder_args(30, "veryfast"),
           "-g", gop, "-keyint_min", gop,
           "-c:a", "aac", "-b:a", "96k", "-ac", "2",
           "-movflags", "+faststart", out_path]
    res = subprocess.run(cmd, capture_output=True, timeout=3 * 3600)
    if res.returncode != 0:
        raise RuntimeError(res.stderr.decode(errors="replace")[-400:])


def compute_peaks(pcm: bytes, rate: int = _PEAK_RATE, per_sec: int = PEAKS_PER_SEC) -> list[int]:
    """Peak level (0-100) per 1/per_sec second of signed 16-bit mono PCM."""
    samples = array.array("h")
    samples.frombytes(pcm[: len(pcm) - (len(pcm) % 2)])
    step = max(1, rate // per_sec)
    out = []
    for i in range(0, len(samples), step):
        chunk = samples[i:i + step]
        out.append(round(max((abs(x) for x in chunk), default=0) * 100 / 32768))
    top = max(out, default=0)
    if top:  # normalize so quiet recordings still show a shape
        out = [min(100, round(v * 100 / top)) for v in out]
    return out


def _peaks(source_path: str) -> list[int]:
    res = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", source_path, "-vn",
         "-ac", "1", "-ar", str(_PEAK_RATE), "-f", "s16le", "-"],
        capture_output=True, timeout=1800,
    )
    if res.returncode != 0:
        raise RuntimeError(res.stderr.decode(errors="replace")[-300:])
    return compute_peaks(res.stdout)


def _upload(path: str, key: str, content_type: str) -> str:
    from shared.storage.base import get_storage

    async def _up() -> str:
        st = get_storage(os.getenv("STORAGE_PROVIDER", "local"))
        with open(path, "rb") as f:
            return await st.upload(f, key, content_type)
    return asyncio.run(_up())


def build_preview_assets(tenant_id: str, video_id: str, source_path: str, fps: float = 30.0,
                         has_audio: bool = True) -> dict:
    """Encode the proxy and peaks for one project and record them. Never raises."""
    _set_status(tenant_id, video_id, status="building")
    tmp = Path(tempfile.mkdtemp(prefix="studio_", dir=VIDEO_TEMP_DIR if Path(VIDEO_TEMP_DIR).exists() else None))
    result: dict = {}
    try:
        proxy = str(tmp / "preview.mp4")
        try:
            _encode_proxy(source_path, proxy, fps)
        except Exception as e:
            if not hwaccel.gpu_in_use():
                raise
            log.warning("[Studio] GPU preview encode failed, retrying on the CPU: %s", e)
            with hwaccel.force_cpu():
                _encode_proxy(source_path, proxy, fps)
        result["preview"] = _upload(proxy, f"previews/{tenant_id}/{video_id}/studio_540p.mp4", "video/mp4")
        if has_audio:
            try:
                peaks_path = tmp / "peaks.json"
                peaks_path.write_text(json.dumps({"per_sec": PEAKS_PER_SEC, "peaks": _peaks(source_path)}))
                result["peaks"] = _upload(str(peaks_path), f"previews/{tenant_id}/{video_id}/peaks.json",
                                          "application/json")
            except Exception as e:
                log.warning("[Studio] waveform for %s failed: %s", video_id, e)
        _set_status(tenant_id, video_id, status="ready", error=None, **result)
        log.info("[Studio] preview ready for %s", video_id)
    except Exception as e:
        log.warning("[Studio] preview for %s failed: %s", video_id, e)
        _set_status(tenant_id, video_id, status="failed", error=str(e)[:300])
    finally:
        for f in tmp.iterdir():
            f.unlink(missing_ok=True)
        tmp.rmdir()
    return result


@celery_app.task(name="workers.tasks.video.build_video_preview", soft_time_limit=4 * 3600,
                 time_limit=4 * 3600 + 120)
def build_video_preview(tenant_id: str, video_id: str) -> dict:
    """Preview assets for an existing project (made before the Studio existed)."""
    from workers.tasks.video.regenerate import _fetch_source
    from workers.tasks.video.transcribe import _probe_video

    with _get_session(tenant_id) as session:
        row = session.execute(
            text("SELECT clip_config, original_storage_key, source_type, source_url "
                 "FROM videos WHERE id = CAST(:vid AS uuid)"),
            {"vid": video_id},
        ).fetchone()
    if not row:
        return {}
    work_dir = Path(VIDEO_TEMP_DIR) / f"preview_{video_id}_{uuid.uuid4().hex[:6]}"
    work_dir.mkdir(parents=True, exist_ok=True)
    src = None
    try:
        src = _fetch_source(tenant_id, video_id, row, work_dir, row.clip_config or {})
        meta = _probe_video(src)
        if row.source_type == "youtube_url" and not row.original_storage_key:
            from workers.tasks.video.suggestions import keep_source_copy
            keep_source_copy(tenant_id, video_id, src)
        return build_preview_assets(tenant_id, video_id, src, meta.fps, meta.has_audio)
    except Exception as e:
        log.warning("[Studio] can't build a preview for %s: %s", video_id, e)
        _set_status(tenant_id, video_id, status="failed", error=str(e)[:300])
        return {}
    finally:
        for f in work_dir.glob("*"):
            f.unlink(missing_ok=True)
        work_dir.rmdir()

