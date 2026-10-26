import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@localhost/test")
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")
os.environ.setdefault("RABBITMQ_URL", "amqp://guest:guest@localhost/")
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-tests-only")

import pytest
from fastapi import HTTPException

from video.routers.studio import _check_range, _words_from_segments
from video.schemas import VideoResponse


def test_words_from_segments_saved_and_estimated():
    segs = [{"start": 0, "end": 1, "text": "a b", "words": [["a", 0, 0.4, "S1"], ["b", 0.5, 1.0]]},
            {"start": 2, "end": 4, "text": "cc d", "speaker": "S2"}]
    w = _words_from_segments(segs)
    assert w[0] == ["a", 0.0, 0.4, "S1"] and w[1][3] is None
    assert [x[0] for x in w[2:]] == ["cc", "d"] and w[2][1] == 2 and w[3][2] == pytest.approx(4)
    assert w[2][3] == "S2"
    assert _words_from_segments('[{"start":0,"end":1,"text":"x"}]')[0][0] == "x"


def test_check_range_clamps_and_rejects():
    assert _check_range(10, 400, 300) == (10, 300)
    with pytest.raises(HTTPException):
        _check_range(299.5, 400, 300)
    with pytest.raises(HTTPException):
        _check_range(0, 700, None)


def test_video_response_studio_and_source():
    from datetime import datetime
    from types import SimpleNamespace
    v = SimpleNamespace(id="00000000-0000-0000-0000-000000000001", title="t", source_type="upload", status="ready",
                        pipeline_step=None, pipeline_pct=100, storage_url=None, thumbnail_url=None,
                        duration_sec=10, clip_config={}, celery_task_id=None, error_message=None,
                        created_at=datetime.now(), original_storage_key="/storage/originals/a.mp4",
                        video_metadata={"studio": {"status": "ready", "preview": "https://cdn/p.mp4"}})
    r = VideoResponse.model_validate(v)
    assert r.has_source and r.studio == {"status": "ready", "preview_url": "https://cdn/p.mp4",
                                         "peaks_url": None, "error": None, "at": None}
    v.video_metadata, v.original_storage_key = None, None
    r = VideoResponse.model_validate(v)
    assert r.studio is None and r.has_source is False
