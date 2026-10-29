"""Analytics endpoints — overview, per-post, and single post detail."""
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from shared.deps import get_current_user, get_tenant_db
from shared.schemas.auth import TokenPayload
from platform_svc.models import AnalyticsEvent, AnalyticsSnapshot, ScheduledPost
from platform_svc.schemas import (
    AnalyticsEventResponse,
    AnalyticsOverviewResponse,
    AnalyticsSnapshotResponse,
    AnalyticsTimeseriesPoint,
    AnalyticsTimeseriesResponse,
    PostAnalyticsDetail,
)

router = APIRouter(tags=["analytics"])

_PERIOD_DAYS = {"7d": 7, "30d": 30, "90d": 90}


@router.get("/analytics/overview", response_model=AnalyticsOverviewResponse)
async def analytics_overview(
    period: str = Query("30d", pattern="^(7d|30d|90d)$"),
    token: TokenPayload = Depends(get_current_user),
    db: AsyncSession = Depends(get_tenant_db),
):
    """
    Return cross-platform aggregate analytics for the current tenant.
    Aggregates the most recent analytics_event per scheduled post within the period.
    """
    days = _PERIOD_DAYS[period]
    since = datetime.now(timezone.utc) - timedelta(days=days)
    tenant_id = uuid.UUID(token.tenant_id) if isinstance(token.tenant_id, str) else token.tenant_id

    # Get all scheduled posts in period that have been posted
    # Explicit tenant_id filter — defense-in-depth, do not rely on RLS alone.
    posts_q = select(ScheduledPost.id).where(
        ScheduledPost.tenant_id == tenant_id,
        ScheduledPost.status == "posted",
        ScheduledPost.posted_at >= since,
    )
    posts_result = await db.execute(posts_q)
    post_ids = [row[0] for row in posts_result.all()]

    if not post_ids:
        return AnalyticsOverviewResponse(
            total_views=0,
            total_likes=0,
            total_comments=0,
            total_shares=0,
            engagement_rate=0.0,
            posts_count=0,
            period=period,
        )

    # For each post, get the latest analytics event
    # Use a subquery to pick max fetched_at per scheduled_post_id
    latest_sq = (
        select(
            AnalyticsEvent.scheduled_post_id,
            func.max(AnalyticsEvent.fetched_at).label("max_fetched"),
        )
        .where(AnalyticsEvent.scheduled_post_id.in_(post_ids))
        .group_by(AnalyticsEvent.scheduled_post_id)
        .subquery()
    )

    events_q = select(AnalyticsEvent).join(
        latest_sq,
        (AnalyticsEvent.scheduled_post_id == latest_sq.c.scheduled_post_id)
        & (AnalyticsEvent.fetched_at == latest_sq.c.max_fetched),
    )
    events_result = await db.execute(events_q)
    events = events_result.scalars().all()

    total_views = sum(e.views or 0 for e in events)
    total_likes = sum(e.likes or 0 for e in events)
    total_comments = sum(e.comments or 0 for e in events)
    total_shares = sum(e.shares or 0 for e in events)

    # Average engagement rate across events that have it
    eng_rates = [float(e.engagement_rate) for e in events if e.engagement_rate is not None]
    avg_engagement = sum(eng_rates) / len(eng_rates) if eng_rates else 0.0

    return AnalyticsOverviewResponse(
        total_views=total_views,
        total_likes=total_likes,
        total_comments=total_comments,
        total_shares=total_shares,
        engagement_rate=round(avg_engagement, 4),
        posts_count=len(post_ids),
        period=period,
    )


@router.get("/analytics/timeseries", response_model=AnalyticsTimeseriesResponse)
async def analytics_timeseries(
    period: str = Query("30d", pattern="^(7d|30d|90d)$"),
    token: TokenPayload = Depends(get_current_user),
    db: AsyncSession = Depends(get_tenant_db),
):
    """Return daily view totals (across all tenant posts) for the given period."""
    days = _PERIOD_DAYS[period]
    since = (datetime.now(timezone.utc) - timedelta(days=days)).date()
    tenant_id = uuid.UUID(token.tenant_id) if isinstance(token.tenant_id, str) else token.tenant_id

    # Explicit tenant_id filter — defense-in-depth, do not rely on RLS alone.
    daily_q = (
        select(
            AnalyticsSnapshot.snapshot_date,
            func.sum(AnalyticsSnapshot.views).label("views"),
        )
        .where(
            AnalyticsSnapshot.tenant_id == tenant_id,
            AnalyticsSnapshot.snapshot_date >= since,
        )
        .group_by(AnalyticsSnapshot.snapshot_date)
        .order_by(AnalyticsSnapshot.snapshot_date.asc())
    )
    result = await db.execute(daily_q)
    rows = result.all()

    points = [
        AnalyticsTimeseriesPoint(date=row.snapshot_date.isoformat(), views=int(row.views or 0))
        for row in rows
    ]
    return AnalyticsTimeseriesResponse(period=period, points=points)


def _virality(engagement_rate: float, views: int) -> float:
    """Same 0–100 score the analytics worker stores."""
    return round(min(100.0, engagement_rate * 50 + views / 10_000), 1)


def _post_title(post: ScheduledPost) -> str:
    kw = post.platform_kwargs if isinstance(post.platform_kwargs, dict) else {}
    title = (kw.get("title") or "").strip() or (post.caption or "").strip().split("\n")[0]
    return title[:120]


def _post_url(platform: str, ppid: str | None) -> str | None:
    if not ppid:
        return None
    return {
        "youtube": f"https://www.youtube.com/shorts/{ppid}",
        "tiktok": f"https://www.tiktok.com/@/video/{ppid}",
        "instagram": f"https://www.instagram.com/reel/{ppid}/",
        "twitter": f"https://x.com/i/status/{ppid}",
    }.get((platform or "").lower())


@router.get("/analytics/posts")
async def analytics_posts(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    token: TokenPayload = Depends(get_current_user),
    db: AsyncSession = Depends(get_tenant_db),
) -> dict:
    """Per-post stats (latest fetch of each), newest posts first, paginated."""
    tenant_id = uuid.UUID(token.tenant_id) if isinstance(token.tenant_id, str) else token.tenant_id

    # Explicit tenant_id filter — defense-in-depth, do not rely on RLS alone.
    with_stats = (
        select(AnalyticsEvent.scheduled_post_id)
        .where(AnalyticsEvent.tenant_id == tenant_id)
        .distinct()
        .subquery()
    )
    base = select(ScheduledPost).where(
        ScheduledPost.tenant_id == tenant_id,
        ScheduledPost.id.in_(select(with_stats.c.scheduled_post_id)),
    )
    total = (await db.execute(select(func.count()).select_from(base.subquery()))).scalar_one()
    posts = (await db.execute(
        base.order_by(ScheduledPost.posted_at.desc().nulls_last())
        .offset((page - 1) * per_page).limit(per_page)
    )).scalars().all()
    if not posts:
        return {"items": [], "total": total, "page": page, "per_page": per_page}

    post_ids = [p.id for p in posts]
    latest_sq = (
        select(AnalyticsEvent.scheduled_post_id, func.max(AnalyticsEvent.fetched_at).label("max_fetched"))
        .where(AnalyticsEvent.scheduled_post_id.in_(post_ids))
        .group_by(AnalyticsEvent.scheduled_post_id)
        .subquery()
    )
    events = (await db.execute(
        select(AnalyticsEvent).join(
            latest_sq,
            (AnalyticsEvent.scheduled_post_id == latest_sq.c.scheduled_post_id)
            & (AnalyticsEvent.fetched_at == latest_sq.c.max_fetched),
        )
    )).scalars().all()
    events_map = {e.scheduled_post_id: e for e in events}

    items = []
    for post in posts:
        e = events_map.get(post.id)
        if not e:
            continue
        views, likes = int(e.views or 0), int(e.likes or 0)
        er = float(e.engagement_rate or 0)
        items.append({
            "scheduled_post_id": str(post.id),
            "platform": post.platform,
            "platform_post_id": post.platform_post_id or e.platform_post_id or "",
            "title": _post_title(post),
            "url": _post_url(post.platform, post.platform_post_id or e.platform_post_id),
            "posted_at": post.posted_at.isoformat() if post.posted_at else None,
            "views": views,
            "likes": likes,
            "comments": int(e.comments or 0),
            "shares": int(e.shares or 0),
            "engagement_rate": er,
            "virality_score": _virality(er, views),
            "fetched_at": e.fetched_at.isoformat() if e.fetched_at else None,
        })
    return {"items": items, "total": total, "page": page, "per_page": per_page}


@router.get("/analytics/{post_id}", response_model=PostAnalyticsDetail)
async def analytics_post_detail(
    post_id: uuid.UUID,
    token: TokenPayload = Depends(get_current_user),
    db: AsyncSession = Depends(get_tenant_db),
):
    """Return full analytics detail for a single scheduled post."""
    tenant_id = uuid.UUID(token.tenant_id) if isinstance(token.tenant_id, str) else token.tenant_id

    # Explicit tenant_id filter — defense-in-depth, do not rely on RLS alone.
    post_result = await db.execute(
        select(ScheduledPost).where(
            ScheduledPost.id == post_id,
            ScheduledPost.tenant_id == tenant_id,
        )
    )
    post = post_result.scalar_one_or_none()
    if not post:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Scheduled post not found.")

    # Latest analytics event
    latest_event_q = (
        select(AnalyticsEvent)
        .where(
            AnalyticsEvent.scheduled_post_id == post_id,
            AnalyticsEvent.tenant_id == tenant_id,
        )
        .order_by(AnalyticsEvent.fetched_at.desc())
        .limit(1)
    )
    event_result = await db.execute(latest_event_q)
    latest_event = event_result.scalar_one_or_none()

    # All snapshots ordered oldest first
    snapshots_q = (
        select(AnalyticsSnapshot)
        .where(
            AnalyticsSnapshot.scheduled_post_id == post_id,
            AnalyticsSnapshot.tenant_id == tenant_id,
        )
        .order_by(AnalyticsSnapshot.snapshot_date.asc())
    )
    snapshots_result = await db.execute(snapshots_q)
    snapshots = snapshots_result.scalars().all()

    return PostAnalyticsDetail(
        post_id=post.id,
        platform=post.platform,
        status=post.status,
        posted_at=post.posted_at,
        caption=post.caption,
        latest_event=AnalyticsEventResponse.model_validate(latest_event) if latest_event else None,
        snapshots=[AnalyticsSnapshotResponse.model_validate(s) for s in snapshots],
    )
