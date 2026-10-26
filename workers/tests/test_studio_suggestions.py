"""Studio suggestions: title options, runner-up picking, suggestion rows."""
import json
from unittest.mock import patch

from workers.tasks.video._core import ClipResult, WordTimestamp
from workers.tasks.video import ai as ai_mod
from workers.tasks.video.ai import _pick_runners_up, _title_options
from workers.tasks.video.suggestions import suggestion_meta


def _c(start, end, score, title="t"):
    return ClipResult(start=start, end=end, score=score, title=title, reason="r")


def test_title_options_sorted_dedup_and_best_included():
    raw = [{"text": "B title", "score": 6, "hook_type": "bold"},
           {"text": "A title", "score": 9, "hook_type": "curiosity"},
           {"text": "a  title", "score": 3},  # duplicate (case/space)
           "plain string", {"text": ""}]
    out = _title_options(raw, "Best one")
    texts = [o["text"] for o in out]
    assert texts[0] == "A title"
    assert "Best one" in texts and "plain string" in texts
    assert texts.count("A title") == 1
    assert all(len(o["text"]) <= 100 for o in out)


def test_title_options_handles_garbage():
    assert _title_options(None) == []
    assert _title_options("nope", None) == []
    assert _title_options([{"text": "x", "score": "high"}])[0]["score"] is None


def test_pick_runners_up_skips_overlap_and_limits():
    picks = [_c(10, 40, 9)]
    pool = [_c(12, 38, 8.5),   # mostly inside a pick → skipped
            _c(35, 65, 8.0),   # 5s of 30 overlap → kept
            _c(100, 130, 7.0),
            _c(102, 128, 6.9), # overlaps the kept 100-130 → skipped
            _c(200, 230, 5.0)]
    out = _pick_runners_up(pool, picks, limit=2)
    assert [(c.start, c.end) for c in out] == [(35, 65), (100, 130)]


def test_ai_score_clips_fills_runners_up():
    words = [WordTimestamp(word=f"w{i}.", start=i * 1.0, end=i * 1.0 + 0.8) for i in range(300)]
    stage2 = {"clips": [
        {"start_seconds": 10, "end_seconds": 40, "score": 9, "title": "A", "reason": "a"},
        {"start_seconds": 100, "end_seconds": 130, "score": 8, "title": "B", "reason": "b"},
        {"start_seconds": 200, "end_seconds": 230, "score": 7, "title": "C", "reason": "c"},
    ]}
    signals = [{"timestamp_sec": t, "score": s, "trigger_words": f"hook {t}"}
               for t, s in ((15, 9), (105, 8), (205, 7), (150, 6.5), (250, 6))]
    with patch.object(ai_mod, "_multi_agent_viral_signals", return_value=signals), \
         patch.object(ai_mod, "_call_llm_json", return_value=stage2):
        runners: list = []
        top = ai_mod._ai_score_clips(words, 300.0, 2, 15, 60, min_score_10=0.0,
                                     content_type="gaming", runners_up_out=runners)
    assert len(top) == 2
    assert runners, "runners-up should be filled"
    for r in runners:
        assert all(ai_mod._overlap_frac(r, t) <= 0.5 for t in top)
    assert any(abs(r.start - 197) < 1 or abs(r.start - 200) < 1 for r in runners)


def test_suggestion_meta_keeps_options_and_tier():
    clip = _c(1, 20, 7.5, "fallback")
    content = {"title": "Chosen", "titles": [{"text": "Chosen", "score": 9, "hook_type": None}],
               "platforms": {"tiktok": {"description": "d", "tags": []}}, "ai_ok": True}
    meta = suggestion_meta(clip, "top", content, {"aspect_ratio": "9:16"})
    assert meta["ai_title"] == "Chosen" and meta["tier"] == "top"
    assert meta["title_options"][0]["text"] == "Chosen"
    json.dumps(meta)
    runner = suggestion_meta(clip, "runner_up", None, {})
    assert runner["ai_title"] == "fallback" and runner["title_options"] == []


def test_pipeline_studio_mode_stores_suggestions_without_rendering(tmp_path):
    from unittest.mock import MagicMock
    from workers.tasks.video import pipeline as pl
    from workers.tasks.video._core import VideoMeta

    meta = VideoMeta(duration=300.0, width=1920, height=1080, fps=30.0, codec="h264", has_audio=False)
    picks = [_c(10, 40, 9, "A"), _c(100, 130, 8, "B")]

    def fake_score(*a, runners_up_out=None, **k):
        if runners_up_out is not None:
            runners_up_out.append(_c(200, 230, 6, "R"))
        return list(picks)

    stored = {}

    def fake_store(tid, vid, job, p, r, content, *rest):
        stored["picks"], stored["runners"] = list(p), list(r)
        return ["id1", "id2"]

    finish = MagicMock()
    names = dict(
        _probe_video=MagicMock(return_value=meta), _extract_scene_frames=MagicMock(return_value=[]),
        _update_video=MagicMock(), _publish_progress=MagicMock(), _save_step_artifact=MagicMock(),
        _check_cancelled=MagicMock(return_value=False), _ai_score_clips=fake_score,
        _repair_all_clips=lambda c, *a, **k: c, _run_ai_content_step=MagicMock(return_value={}),
        _export_clip=MagicMock(side_effect=AssertionError("must not render")),
        _store_suggestions=fake_store, _finish_pipeline=finish,
        redis_client=MagicMock(get=MagicMock(return_value=None)),
        VIDEO_TEMP_DIR=str(tmp_path),
    )
    with patch.multiple(pl, **names), \
         patch("workers.tasks.video.game_context._resolve_video_game", return_value=None), \
         patch("workers.tasks.video.suggestions.keep_source_copy") as keep, \
         patch("workers.tasks.video.preview.queue_preview") as preview:
        pl.run_video_pipeline("t", "v", "/src.mp4", "job", {"max_clips": 2, "duration_min": 15,
                                                          "duration_max": 60, "render_on_ingest": False})
    assert [c.title for c in stored["picks"]] == ["A", "B"]
    assert [c.title for c in stored["runners"]] == ["R"]
    keep.assert_called_once()
    preview.assert_called_once()
    finish.assert_called_once()


def test_compute_peaks_normalizes():
    import array
    from workers.tasks.video.preview import compute_peaks
    pcm = array.array("h", [0, 1000, -2000, 0] * 100 + [0] * 400).tobytes()
    out = compute_peaks(pcm, rate=400, per_sec=2)
    assert out[0] == 100 and out[-1] == 0 and len(out) == 4


def test_studio_mode_only_when_the_upload_asks_for_it():
    from workers.tasks.video.pipeline import _studio_mode
    assert _studio_mode({"render_on_ingest": False})
    assert not _studio_mode({})                      # API / MCP / channel imports keep rendering
    assert not _studio_mode({"render_on_ingest": None})
    assert not _studio_mode({"render_on_ingest": False, "auto_publish": True})
