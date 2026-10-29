"""Analytics ingestion worker."""
import base64
import hashlib
import logging
import os
import uuid
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone

try:
    import requests
except ImportError:
    requests = None  # type: ignore
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

from workers.celery_app import celery_app

logger = logging.getLogger(__name__)

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql+asyncpg://viralo:viralo@postgres:5432/viralo")
SYNC_DATABASE_URL = DATABASE_URL.replace("+asyncpg", "")
engine = create_engine(SYNC_DATABASE_URL, pool_pre_ping=True)


# ── Helpers ───────────────────────────────────────────────────────────────────

@contextmanager
def _get_session(tenant_id: str):
    with Session(engine) as session:
        session.execute(text("SELECT set_config('app.current_tenant', :tid, true)"), {"tid": str(tenant_id)})
        try:
            yield session
            session.commit()
        except Exception:
            session.rollback()
            raise


def _decrypt_token(enc: str) -> str:
    from cryptography.fernet import Fernet
    key = os.getenv("ENCRYPTION_KEY", "")
    if not key:
        secret = os.getenv("SECRET_KEY", "change-me-in-production")
        raw = hashlib.sha256(secret.encode()).digest()
        key = base64.urlsafe_b64encode(raw).decode()
    return Fernet(key.encode()).decrypt(enc.encode()).decode()


def _fetch_youtube_metrics(platform_post_id: str, access_token: str) -> dict:
    url = "https://www.googleapis.com/youtube/v3/videos"
    resp = requests.get(
        url,
        params={"part": "statistics", "id": platform_post_id},
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    items = data.get("items", [])
    if not items:
        return {}
    stats = items[0].get("statistics", {})
    views = int(stats.get("viewCount", 0))
    likes = int(stats.get("likeCount", 0))
    comments = int(stats.get("commentCount", 0))
    return {
        "views": views,
        "likes": likes,
        "comments": comments,
        "shares": 0,
        "saves": 0,
        "reach": views,
        "impressions": views,
    }


def _fetch_instagram_metrics(platform_post_id: str, access_token: str) -> dict:
    url = f"https://graph.instagram.com/v21.0/{platform_post_id}/insights"
    resp = requests.get(
        url,
        params={
            "metric": "views,likes,comments,shares,saved,reach,impressions",
            "access_token": access_token,
        },
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    metrics: dict[str, int] = {}
    for item in data.get("data", []):
        name = item.get("name", "")
        value = item.get("values", [{}])[0].get("value", 0) if item.get("values") else item.get("value", 0)
        metrics[name] = int(value or 0)
    return {
        "views": metrics.get("views", 0),
        "likes": metrics.get("likes", 0),
        "comments": metrics.get("comments", 0),
        "shares": metrics.get("shares", 0),
        "saves": metrics.get("saved", 0),
        "reach": metrics.get("reach", 0),
        "impressions": metrics.get("impressions", 0),
    }


def _fetch_tiktok_metrics(platform_post_id: str, access_token: str) -> dict:
    url = "https://open.tiktokapis.com/v2/video/query/"
    resp = requests.post(
        url,
        params={"fields": "view_count,like_count,comment_count,share_count"},
        json={"filters": {"video_ids": [platform_post_id]}},
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    videos = data.get("data", {}).get("videos", [])
    if not videos:
        return {}
    v = videos[0]
    views = int(v.get("view_count", 0))
    likes = int(v.get("like_count", 0))
    comments = int(v.get("comment_count", 0))
    shares = int(v.get("share_count", 0))
    return {
        "views": views,
        "likes": likes,
        "comments": comments,
        "shares": shares,
        "saves": 0,
        "reach": views,
        "impressions": views,
    }


def _fetch_twitter_metrics(platform_post_id: str, access_token: str) -> dict:
    url = f"https://api.twitter.com/2/tweets/{platform_post_id}"
    resp = requests.get(
        url,
        params={"tweet.fields": "public_metrics"},
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    pm = data.get("data", {}).get("public_metrics", {})
    views = int(pm.get("impression_count", 0))
    likes = int(pm.get("like_count", 0))
    replies = int(pm.get("reply_count", 0))
    retweets = int(pm.get("retweet_count", 0))
    quotes = int(pm.get("quote_count", 0))
    return {
        "views": views,
        "likes": likes,
        "comments": replies,
        "shares": retweets + quotes,
        "saves": int(pm.get("bookmark_count", 0)),
        "reach": views,
        "impressions": views,
    }


def _fetch_linkedin_metrics(platform_post_id: str, access_token: str) -> dict:
    # Try organizationalEntityShareStatistics first, fall back to socialMetadata
    headers = {
        "Authorization": f"Bearer {access_token}",
        "LinkedIn-Version": "202401",
    }
    try:
        url = f"https://api.linkedin.com/rest/socialMetadata/{platform_post_id}"
        resp = requests.get(url, headers=headers, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        likes = int(data.get("totalSocialActivityCounts", {}).get("numLikes", 0))
        comments = int(data.get("totalSocialActivityCounts", {}).get("numComments", 0))
        shares = int(data.get("totalSocialActivityCounts", {}).get("numShares", 0))
        impressions = int(data.get("totalSocialActivityCounts", {}).get("numImpressions", 0))
        return {
            "views": impressions,
            "likes": likes,
            "comments": comments,
            "shares": shares,
            "saves": 0,
            "reach": impressions,
            "impressions": impressions,
        }
    except Exception:
        pass

    try:
        url = "https://api.linkedin.com/v2/organizationalEntityShareStatistics"
        resp = requests.get(
            url,
            params={"q": "organizationalEntity", "shares[0]": platform_post_id},
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        elements = data.get("elements", [])
        if elements:
            stats = elements[0].get("totalShareStatistics", {})
            impressions = int(stats.get("impressionCount", 0))
            likes = int(stats.get("likeCount", 0))
            comments = int(stats.get("commentCount", 0))
            shares = int(stats.get("shareCount", 0))
            return {
                "views": impressions,
                "likes": likes,
                "comments": comments,
                "shares": shares,
                "saves": 0,
                "reach": int(stats.get("uniqueImpressionsCount", impressions)),
                "impressions": impressions,
            }
    except Exception:
        pass

    return {}


def _fetch_facebook_metrics(platform_post_id: str, access_token: str) -> dict:
    url = f"https://graph.facebook.com/v21.0/{platform_post_id}"
    resp = requests.get(
        url,
        params={
            "fields": "views,likes.summary(true),comments.summary(true)",
            "access_token": access_token,
        },
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    views = int(data.get("views", 0))
    likes = int(data.get("likes", {}).get("summary", {}).get("total_count", 0))
    comments = int(data.get("comments", {}).get("summary", {}).get("total_count", 0))
    return {
        "views": views,
        "likes": likes,
        "comments": comments,
        "shares": 0,
        "saves": 0,
        "reach": views,
        "impressions": views,
    }


_PLATFORM_FETCHERS = {
    "youtube": _fetch_youtube_metrics,
    "instagram": _fetch_instagram_metrics,
    "tiktok": _fetch_tiktok_metrics,
    "twitter": _fetch_twitter_metrics,
    "linkedin": _fetch_linkedin_metrics,
    "facebook": _fetch_facebook_metrics,
}


def _compute_virality_score(engagement_rate: float, views: int) -> float:
    """Simple virality score: 0–100."""
    return min(100.0, (engagement_rate * 50) + (views / 10_000))


# ── Beat task: refresh all analytics ─────────────────────────────────────────

# Posts older than this aren't refreshed (the page shows at most 90 days; this keeps
# API quota use bounded).
REFRESH_WINDOW_DAYS = 120


@celery_app.task(name="workers.tasks.analytics.refresh_analytics")
def refresh_analytics():
    """Celery Beat task — enqueue an analytics fetch for every recently posted post."""
    with engine.connect() as conn:
        rows = conn.execute(
            text("""
                SELECT id, tenant_id
                FROM scheduled_posts
                WHERE status = 'posted'
                  AND platform_post_id IS NOT NULL
                  AND COALESCE(posted_at, created_at) >= NOW() - make_interval(days => :days)
                ORDER BY posted_at DESC
                LIMIT 5000
            """),
            {"days": REFRESH_WINDOW_DAYS},
        ).fetchall()

    for row in rows:
        fetch_post_analytics.apply_async(args=[str(row[1]), str(row[0])], queue="viralo.analytics.ingest")
    logger.info("refresh_analytics: enqueued %d analytics tasks", len(rows))
    return {"enqueued": len(rows)}


def _fresh_access_token(tenant_id: str, account_id: str, platform: str, access_token: str,
                        refresh_token_enc: str | None, expires_at) -> str:
    """The account's access token, renewed first (and saved) when it expires within 5
    minutes — YouTube's expire after an hour. Same renewal as publishing uses."""
    if not expires_at:
        return access_token
    now = datetime.now(timezone.utc)
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at > now + timedelta(minutes=5):
        return access_token
    if not refresh_token_enc:
        raise RuntimeError("access token expired and no refresh token — reconnect the account")
    from workers.publishers.registry import get_publisher
    from workers.tasks.post import _encrypt_token
    refresh_token = _decrypt_token(refresh_token_enc)
    new = get_publisher(platform).refresh_token(refresh_token)
    new_access = (new or {}).get("access_token") if isinstance(new, dict) else None
    if not new_access:
        return access_token  # static tokens (no refresh) keep working as they are
    new_refresh = new.get("refresh_token") or refresh_token
    with _get_session(tenant_id) as session:
        session.execute(
            text("""
                UPDATE social_accounts
                   SET access_token_enc = :at, refresh_token_enc = :rt, token_expires_at = :exp,
                       updated_at = NOW()
                 WHERE id = CAST(:aid AS uuid)
            """),
            {"at": _encrypt_token(new_access), "rt": _encrypt_token(new_refresh),
             "exp": now + timedelta(seconds=int(new.get("expires_in") or 3600)), "aid": account_id},
        )
    logger.info("fetch_post_analytics: refreshed the %s token for account %s", platform, account_id)
    return new_access


# ── Fetch analytics for a single post ────────────────────────────────────────

@celery_app.task(
    bind=True,
    name="workers.tasks.analytics.fetch_post_analytics",
    queue="viralo.analytics.ingest",
    acks_late=True,
    max_retries=2,
    time_limit=120,
)
def fetch_post_analytics(self, tenant_id: str, post_id: str):
    """Fetch metrics for a posted video from the platform API and persist them."""
    try:
        with _get_session(tenant_id) as session:
            row = session.execute(
                text("""
                    SELECT sp.platform, sp.platform_post_id, sa.id::text AS account_id,
                           sa.access_token_enc, sa.refresh_token_enc, sa.token_expires_at
                    FROM scheduled_posts sp
                    JOIN social_accounts sa ON sa.id = sp.social_account_id
                    WHERE sp.id = CAST(:pid AS uuid)
                      AND sp.status = 'posted'
                      AND sp.platform_post_id IS NOT NULL
                """),
                {"pid": post_id},
            ).fetchone()
        if not row:
            logger.warning("fetch_post_analytics: post %s not found or not posted", post_id)
            return

        platform = (row.platform or "").lower()
        fetcher = _PLATFORM_FETCHERS.get(platform)
        if not fetcher:
            logger.info("fetch_post_analytics: no stats fetcher for platform %s", platform)
            return

        access_token = _decrypt_token(row.access_token_enc) if row.access_token_enc else ""
        access_token = _fresh_access_token(tenant_id, row.account_id, platform, access_token,
                                           row.refresh_token_enc, row.token_expires_at)

        raw = fetcher(row.platform_post_id, access_token)
        if not raw:
            logger.warning("fetch_post_analytics: no stats for post %s on %s (deleted or private?)",
                           post_id, platform)
            return

        m = {k: int(raw.get(k, 0) or 0) for k in
             ("views", "likes", "comments", "shares", "saves", "reach", "impressions")}
        engagement_rate = (m["likes"] + m["comments"] + m["shares"]) / max(m["views"], 1)
        virality_score = _compute_virality_score(engagement_rate, m["views"])
        er = round(min(engagement_rate, 99.0), 4)

        with _get_session(tenant_id) as session:
            session.execute(
                text("""
                    INSERT INTO analytics_events (
                        id, tenant_id, scheduled_post_id, platform, platform_post_id,
                        views, likes, comments, shares, saves, reach, impressions,
                        engagement_rate, fetched_at
                    ) VALUES (
                        CAST(:id AS uuid), CAST(:tid AS uuid), CAST(:pid AS uuid), :platform, :ppid,
                        :views, :likes, :comments, :shares, :saves, :reach, :impressions,
                        :er, NOW()
                    )
                """),
                {"id": str(uuid.uuid4()), "tid": tenant_id, "pid": post_id, "platform": platform,
                 "ppid": row.platform_post_id, "er": er, **m},
            )
            # One row per post per day: today's latest numbers.
            session.execute(
                text("""
                    INSERT INTO analytics_snapshots (
                        id, tenant_id, scheduled_post_id, platform, snapshot_date,
                        views, likes, comments, shares, engagement_rate, virality_score
                    ) VALUES (
                        CAST(:id AS uuid), CAST(:tid AS uuid), CAST(:pid AS uuid), :platform, CAST(:sdate AS date),
                        :views, :likes, :comments, :shares, :er, :vs
                    )
                    ON CONFLICT (tenant_id, scheduled_post_id, snapshot_date)
                    DO UPDATE SET views = EXCLUDED.views, likes = EXCLUDED.likes,
                                  comments = EXCLUDED.comments, shares = EXCLUDED.shares,
                                  engagement_rate = EXCLUDED.engagement_rate,
                                  virality_score = EXCLUDED.virality_score
                """),
                {"id": str(uuid.uuid4()), "tid": tenant_id, "pid": post_id, "platform": platform,
                 "sdate": date.today().isoformat(), "views": m["views"], "likes": m["likes"],
                 "comments": m["comments"], "shares": m["shares"], "er": er,
                 "vs": round(virality_score, 2)},
            )

        logger.info("fetch_post_analytics: post=%s platform=%s views=%d er=%.4f virality=%.1f",
                    post_id, platform, m["views"], engagement_rate, virality_score)
        return {"views": m["views"]}

    except Exception as exc:
        # Analytics is non-critical — log and do not blow up the worker
        logger.warning("fetch_post_analytics: failed for post %s: %s", post_id, exc, exc_info=True)
