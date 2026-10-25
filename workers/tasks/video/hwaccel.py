# Added 2026 by sleezy6 (fork of sammyview80/viralo, Apache-2.0).
"""Hardware H.264 encoding on Intel GPUs (Quick Sync), with CPU fallback.

VIDEO_HWACCEL:
  auto (default) — use Quick Sync when a GPU is passed into the container
                   (/dev/dri) and a test encode works; otherwise libx264.
  qsv            — same, but log loudly when it can't be used.
  off            — always encode on the CPU (libx264).
VIDEO_QSV_QUALITY_OFFSET (default 0) is added to the GPU quality value (higher =
smaller files, lower = better quality).

Each worker process checks once and remembers. If the GPU fails while rendering a
clip, that clip is redone on the CPU and the process stops using the GPU.

    python -m workers.tasks.video.hwaccel     # print what this container would use
"""
import glob
import logging
import os
import subprocess
import threading

__all__ = ["pyav_encoder", "ffmpeg_encoder_args", "disable", "status"]

log = logging.getLogger(__name__)
_lock = threading.Lock()
_state: dict = {}  # "pyav": bool, "ffmpeg": bool, "reason": str


def _mode() -> str:
    m = os.getenv("VIDEO_HWACCEL", "auto").strip().lower()
    return m if m in ("auto", "qsv", "off") else "auto"


def _render_nodes() -> list[str]:
    return sorted(glob.glob("/dev/dri/renderD*"))


def _quality(crf: int | str = 23) -> str:
    # ICQ quality for h264_qsv, on a scale close to libx264's CRF (lower = better).
    # VIDEO_QSV_QUALITY shifts it: e.g. 2 makes every GPU encode 2 steps smaller.
    try:
        return str(max(1, min(51, int(crf) + int(os.getenv("VIDEO_QSV_QUALITY_OFFSET", "0")))))
    except ValueError:
        return str(crf)


def _probe_pyav() -> tuple[bool, str]:
    try:
        import av
        import numpy as np
        out = av.open(os.devnull, "w", format="null")
        try:
            s = out.add_stream("h264_qsv", rate=30)
            s.width, s.height, s.pix_fmt = 256, 256, "nv12"
            s.options = {"global_quality": _quality(), "preset": "veryfast"}
            img = np.zeros((256, 256, 3), dtype=np.uint8)
            for i in range(3):
                img[:] = i * 40
                frame = av.VideoFrame.from_ndarray(img, format="rgb24")
                frame.pts = i
                for pkt in s.encode(frame):
                    out.mux(pkt)
            for pkt in s.encode(None):
                out.mux(pkt)
        finally:
            out.close()
        return True, ""
    except Exception as e:
        return False, str(e)[:200]


def _probe_ffmpeg() -> tuple[bool, str]:
    try:
        r = subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
             "color=c=gray:s=256x256:r=30:d=0.2", "-pix_fmt", "nv12", "-c:v", "h264_qsv",
             "-global_quality", _quality(), "-f", "null", "-"],
            capture_output=True, text=True, timeout=30)
        return r.returncode == 0, (r.stderr or "")[-200:]
    except Exception as e:
        return False, str(e)[:200]


def _check() -> dict:
    with _lock:
        if _state:
            return _state
        mode = _mode()
        if mode == "off":
            _state.update(pyav=False, ffmpeg=False, reason="VIDEO_HWACCEL=off")
        elif not _render_nodes():
            _state.update(pyav=False, ffmpeg=False,
                          reason="no GPU in this container (/dev/dri isn't passed in)")
        else:
            ok_av, err_av = _probe_pyav()
            ok_ff, err_ff = _probe_ffmpeg()
            reason = "; ".join(x for x in (
                "" if ok_av else f"PyAV h264_qsv: {err_av}",
                "" if ok_ff else f"ffmpeg h264_qsv: {err_ff}") if x)
            _state.update(pyav=ok_av, ffmpeg=ok_ff, reason=reason)
        level = logging.WARNING if (mode == "qsv" and not (_state["pyav"] and _state["ffmpeg"])) else logging.INFO
        if _state["pyav"] or _state["ffmpeg"]:
            log.log(level, "[HW] Intel Quick Sync encoding: renders=%s, prep pass=%s%s",
                    "GPU" if _state["pyav"] else "CPU", "GPU" if _state["ffmpeg"] else "CPU",
                    f" ({_state['reason']})" if _state["reason"] else "")
        else:
            log.log(level, "[HW] encoding on the CPU: %s", _state["reason"])
        return _state


def disable(reason: str) -> None:
    """Stop using the GPU in this process (after it failed mid-render)."""
    with _lock:
        _state.update(pyav=False, ffmpeg=False, reason=f"turned off after a failure: {reason[:160]}")
    log.warning("[HW] Quick Sync failed while rendering, using the CPU from now on: %s", reason[:200])


def pyav_encoder(crf: int | str, preset: str = "veryfast") -> tuple[str, str, dict]:
    """(codec, pix_fmt, options) for a PyAV H.264 output stream."""
    if _check()["pyav"]:
        return "h264_qsv", "nv12", {"global_quality": _quality(crf), "preset": "veryfast", "profile": "high"}
    return "h264", "yuv420p", {"crf": str(crf), "preset": preset}


def ffmpeg_encoder_args(crf: int | str, preset: str = "veryfast") -> list[str]:
    """ffmpeg CLI video encoder arguments (codec, quality, pixel format)."""
    if _check()["ffmpeg"]:
        return ["-c:v", "h264_qsv", "-global_quality", _quality(crf), "-preset", "veryfast", "-pix_fmt", "nv12"]
    return ["-c:v", "libx264", "-crf", str(crf), "-preset", preset, "-pix_fmt", "yuv420p"]


def status() -> dict:
    st = dict(_check())
    st.update(mode=_mode(), devices=_render_nodes())
    return st


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    st = status()
    print(f"VIDEO_HWACCEL={st['mode']}  GPU devices: {', '.join(st['devices']) or 'none'}")
    print(f"Clip renders (PyAV):   {'Intel Quick Sync' if st['pyav'] else 'CPU (libx264)'}")
    print(f"Prep pass (ffmpeg):    {'Intel Quick Sync' if st['ffmpeg'] else 'CPU (libx264)'}")
    if st["reason"]:
        print(f"Note: {st['reason']}")
