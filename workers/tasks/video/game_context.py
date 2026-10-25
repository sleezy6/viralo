# Added 2026 by sleezy6 (fork of sammyview80/viralo, Apache-2.0).
"""Game context from Steam, so the AI knows what game a video shows.

The game comes from the upload's "Game" field (game / game_appid in the clip config)
or, when that's empty, from the video title: the AI names the game the title refers
to, and it's only used if Steam has a closely matching title. Steam's store
description, genres and developer are then given to the AI as background for every
step (metadata, picking moments, titles, captions, hashtags) via the topic line.

Every network or AI failure is swallowed: a video without game context processes
exactly as before.
"""
import difflib
import html
import json
import logging
import os
import re

import requests
from sqlalchemy import text

from workers.tasks.video._core import _get_session, redis_client

__all__ = ["steam_search", "steam_app", "resolve_game", "game_context_text",
           "with_game_context", "_resolve_video_game"]

log = logging.getLogger(__name__)
STEAM_BASE = os.getenv("STEAM_STORE_URL", "https://store.steampowered.com").rstrip("/")
_TIMEOUT = 10
_SEARCH_TTL = 7 * 86400
_APP_TTL = 30 * 86400


def _cache_get(key: str):
    try:
        raw = redis_client.get(key)
        return json.loads(raw) if raw else None
    except Exception:
        return None


def _cache_set(key: str, value, ttl: int) -> None:
    try:
        redis_client.setex(key, ttl, json.dumps(value))
    except Exception:
        pass


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", (s or "").lower())


def steam_search(term: str) -> list[dict]:
    """Steam store search → [{appid, name, image}] (games only), cached."""
    term = (term or "").strip()
    if not term:
        return []
    key = f"steam:search:{_norm(term)}"
    cached = _cache_get(key)
    if cached is not None:
        return cached
    try:
        r = requests.get(f"{STEAM_BASE}/api/storesearch/",
                         params={"term": term, "l": "english", "cc": "US"}, timeout=_TIMEOUT)
        r.raise_for_status()
        items = [
            {"appid": int(it["id"]), "name": it.get("name", ""), "image": it.get("tiny_image", "")}
            for it in (r.json().get("items") or [])
            if it.get("type", "app") == "app" and it.get("id")
        ]
    except Exception as e:
        log.warning("[Game] Steam search failed for %r: %s", term, str(e)[:120])
        return []
    _cache_set(key, items, _SEARCH_TTL)
    return items


def _clean(text_: str, limit: int) -> str:
    t = html.unescape(re.sub(r"<[^>]+>", " ", text_ or ""))
    t = " ".join(t.split())
    return t if len(t) <= limit else t[: limit - 1].rsplit(" ", 1)[0] + "…"


def steam_app(appid: int) -> dict | None:
    """Store details for one app → compact dict, cached."""
    try:
        appid = int(appid)
    except (TypeError, ValueError):
        return None
    key = f"steam:app:{appid}"
    cached = _cache_get(key)
    if cached is not None:
        return cached or None
    try:
        r = requests.get(f"{STEAM_BASE}/api/appdetails",
                         params={"appids": appid, "l": "english"}, timeout=_TIMEOUT)
        r.raise_for_status()
        entry = (r.json() or {}).get(str(appid)) or {}
        if not entry.get("success"):
            _cache_set(key, {}, _APP_TTL)
            return None
        d = entry.get("data") or {}
        info = {
            "appid": appid,
            "name": d.get("name", ""),
            "short_description": _clean(d.get("short_description", ""), 500),
            "genres": [g.get("description", "") for g in (d.get("genres") or []) if g.get("description")],
            "developers": list(d.get("developers") or [])[:3],
            "release_date": (d.get("release_date") or {}).get("date", ""),
            "url": f"https://store.steampowered.com/app/{appid}",
            "image": d.get("header_image", ""),
        }
    except Exception as e:
        log.warning("[Game] Steam details failed for app %s: %s", appid, str(e)[:120])
        return None
    _cache_set(key, info, _APP_TTL)
    return info


def _best_match(name: str, items: list[dict], strict: bool) -> dict | None:
    """Closest Steam result to `name`. Strict (for AI-guessed names) demands a near-exact
    title match, so a vague title can't produce the wrong game."""
    want = _norm(name)
    if not want or not items:
        return None
    for it in items:
        if _norm(it["name"]) == want:
            return it
    scored = sorted(((difflib.SequenceMatcher(None, want, _norm(it["name"])).ratio(), it) for it in items),
                    key=lambda x: -x[0])
    ratio, best = scored[0]
    if strict:
        return best if ratio >= 0.85 else None
    return best if ratio >= 0.5 or _norm(best["name"]).startswith(want) else None


def _game_from_title(title: str, llm_fn) -> str | None:
    prompt = (
        "Here is the title of a video:\n"
        f"\"{title[:300]}\"\n\n"
        "If the title names or unmistakably refers to one specific video game, reply with its "
        "official name. If it doesn't, or you would be guessing from genre words alone, reply null.\n"
        'Return JSON only: {"game": "<official game name>"} or {"game": null}'
    )
    try:
        out = llm_fn([{"role": "user", "content": prompt}], temperature=0.0, max_tokens=60) or {}
    except Exception as e:
        log.warning("[Game] title detection failed: %s", str(e)[:120])
        return None
    g = out.get("game") if isinstance(out, dict) else None
    return g.strip() if isinstance(g, str) and g.strip() and g.strip().lower() != "null" else None


def resolve_game(cfg: dict, title: str = "", llm_fn=None) -> dict | None:
    """The game for a video: from the config (user's choice), else detected from the title."""
    try:
        if cfg.get("game_appid"):
            info = steam_app(cfg["game_appid"])
            if info:
                return {**info, "source": "you"}
        name = (cfg.get("game") or "").strip()
        if name:
            match = _best_match(name, steam_search(name), strict=False)
            info = steam_app(match["appid"]) if match else None
            # Not on Steam (console-only, etc.): still tell the AI the game's name.
            return {**info, "source": "you"} if info else {"name": name, "source": "you"}
        if title and llm_fn:
            guess = _game_from_title(title, llm_fn)
            if guess:
                match = _best_match(guess, steam_search(guess), strict=True)
                info = steam_app(match["appid"]) if match else None
                if info:
                    log.info("[Game] detected %r from title %r", info["name"], title[:80])
                    return {**info, "source": "title"}
    except Exception as e:
        log.warning("[Game] resolve failed: %s", str(e)[:160])
    return None


def game_context_text(game: dict | None) -> str:
    """One background line for the AI prompts."""
    if not game or not game.get("name"):
        return ""
    bits = [f"The video shows gameplay of the video game \"{game['name']}\""]
    meta = []
    if game.get("genres"):
        meta.append(", ".join(game["genres"][:4]))
    if game.get("developers"):
        meta.append("by " + ", ".join(game["developers"]))
    if game.get("release_date"):
        meta.append(game["release_date"])
    if meta:
        bits.append(f" ({'; '.join(meta)})")
    bits.append(".")
    if game.get("short_description"):
        bits.append(f" About the game (Steam): {game['short_description']}")
    return "".join(bits)


def with_game_context(topic_focus: str | None, game: dict | None) -> str:
    """Topic line handed to every AI step: the user's topic, plus game background."""
    ctx = game_context_text(game)
    topic = (topic_focus or "").strip()
    if not ctx:
        return topic
    return f"{topic}. {ctx}" if topic else ctx


def _resolve_video_game(tenant_id: str, video_id: str, cfg: dict, title: str = "") -> dict | None:
    """Resolve the game for a video and save it in videos.metadata->'game'."""
    from workers.tasks.video._core import _call_llm_json
    try:
        if not title:
            with _get_session(tenant_id) as session:
                row = session.execute(text("SELECT title FROM videos WHERE id = CAST(:v AS uuid)"),
                                      {"v": video_id}).fetchone()
            title = (row[0] if row else "") or ""
        game = resolve_game(cfg, title=title, llm_fn=_call_llm_json)
        if game:
            with _get_session(tenant_id) as session:
                session.execute(
                    text("UPDATE videos SET metadata = COALESCE(metadata, '{}'::jsonb) || "
                         "jsonb_build_object('game', CAST(:g AS jsonb)) WHERE id = CAST(:v AS uuid)"),
                    {"g": json.dumps(game), "v": video_id},
                )
        return game
    except Exception as e:
        log.warning("[Game] could not resolve game for video %s: %s", video_id, str(e)[:160])
        return None
