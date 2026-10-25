# Added 2026 by sleezy6 (fork of sammyview80/viralo, Apache-2.0).
"""Find (and optionally delete) leftover files in local storage.

Leftovers are files whose project or clip no longer exists: thumbnails and
failed/cancelled uploads left by older versions when a project was deleted, and
originals of projects deleted while originals were being kept.

    python -m video.cleanup_storage            # report only (nothing is deleted)
    python -m video.cleanup_storage --delete   # delete the leftovers listed

Also resets each account's "Cloud Storage" counter (usage_quotas.storage_bytes_used,
which only ever went up) to the size of its uploaded originals still on disk.

Safety: only known Viralo folders are touched, files changed in the last hour are
skipped, and it refuses to run if the database shows no projects while files exist.
"""
import os
import re
import sys
import time
from collections import defaultdict
from pathlib import Path

from sqlalchemy import create_engine, text

ROOT = Path(os.getenv("LOCAL_STORAGE_DIR", "/tmp/viralo-storage"))
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
MIN_AGE_SEC = 3600


def _fmt(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return str(n)


def _live_ids(engine) -> tuple[set[str], set[str], set[str]]:
    """(tenants, live video ids, live clip ids), read per tenant so row-level
    security can't hide rows (a role without RLS bypass would otherwise see none)."""
    with engine.connect() as c:
        tenants = {str(r[0]) for r in c.execute(text("SELECT id FROM tenants"))}
    videos: set[str] = set()
    clips: set[str] = set()
    for tid in tenants:
        with engine.begin() as c:
            c.execute(text("SELECT set_config('app.current_tenant', :t, true)"), {"t": tid})
            videos |= {str(r[0]) for r in c.execute(text(
                "SELECT id FROM videos WHERE tenant_id = CAST(:t AS uuid) AND status <> 'deleted'"), {"t": tid})}
            clips |= {str(r[0]) for r in c.execute(text(
                "SELECT id FROM clips WHERE tenant_id = CAST(:t AS uuid) AND status <> 'deleted'"), {"t": tid})}
    return tenants, videos, clips


def classify(rel: Path, videos: set[str], clips: set[str]) -> str | None:
    """Category name if this file is a leftover, else None (keep or not ours)."""
    parts = rel.parts
    top = parts[0] if parts else ""

    def first_uuid(s: str) -> str | None:
        m = _UUID.match(s)
        return m.group(0) if m else None

    if top == "originals" and len(parts) >= 4:          # originals/<tenant>/<video>/<file>
        return "originals" if parts[2] not in videos else None
    if top == "thumbnails" and len(parts) >= 3:         # thumbnails/<video>/thumb.jpg
        return "project thumbnails" if parts[1] not in videos else None
    if top == "clips" and len(parts) == 3:              # clips/<tenant>/<clip>[_thumb|_upscaled_x].ext
        cid = first_uuid(parts[2])
        return "clips" if cid and cid not in clips else None
    if top == "renders" and len(parts) >= 4:            # renders/<tenant>/<clip>/<render>.mp4
        return "editor exports" if parts[2] not in clips else None
    if top == "previews" and len(parts) >= 4 and _UUID.fullmatch(parts[2]):  # previews/<tenant>/<video>/...
        return "previews" if parts[2] not in videos else None
    return None


def main(argv: list[str]) -> int:
    apply = "--delete" in argv
    if os.getenv("STORAGE_PROVIDER", "local") != "local":
        print("Storage isn't local (STORAGE_PROVIDER is set) — this tool only cleans local storage.")
        return 2
    if not ROOT.is_dir():
        print(f"Storage folder not found: {ROOT}")
        return 2

    engine = create_engine(os.environ["DATABASE_URL"].replace("+asyncpg", "+psycopg2"))
    tenants, videos, clips = _live_ids(engine)

    files = [p for p in ROOT.rglob("*") if p.is_file()]
    if not videos and any(p.relative_to(ROOT).parts[:1] == ("originals",) for p in files):
        print("Refusing to run: the database shows no projects, but uploaded originals exist.\n"
              "That usually means it's connected to the wrong database. Nothing was deleted.")
        return 3

    now = time.time()
    total = 0
    by_top: dict[str, int] = defaultdict(int)
    leftovers: dict[str, list[tuple[Path, int]]] = defaultdict(list)
    skipped_recent = 0
    for p in files:
        st = p.stat()
        rel = p.relative_to(ROOT)
        total += st.st_size
        by_top[rel.parts[0] if len(rel.parts) > 1 else "(top level)"] += st.st_size
        cat = classify(rel, videos, clips)
        if not cat:
            continue
        if now - st.st_mtime < MIN_AGE_SEC:
            skipped_recent += 1
            continue
        leftovers[cat].append((p, st.st_size))

    print(f"Storage folder: {ROOT}")
    print(f"Actual disk usage: {_fmt(total)} in {len(files)} files")
    for top, size in sorted(by_top.items(), key=lambda kv: -kv[1]):
        print(f"  {top:<18} {_fmt(size):>10}")
    print()
    n_left = sum(len(v) for v in leftovers.values())
    size_left = sum(s for v in leftovers.values() for _, s in v)
    if not n_left:
        print("No leftovers found.")
    else:
        print(f"Leftovers (project or clip no longer exists): {n_left} files, {_fmt(size_left)}")
        for cat, items in sorted(leftovers.items()):
            print(f"  {cat:<18} {len(items):>5} files  {_fmt(sum(s for _, s in items)):>10}")
    if skipped_recent:
        print(f"  (skipped {skipped_recent} file(s) changed in the last hour)")

    # Counter: bytes of uploaded originals still on disk, per account.
    originals_by_tenant: dict[str, int] = defaultdict(int)
    doomed = {p for v in leftovers.values() for p, _ in v} if apply else set()
    for p in files:
        rel = p.relative_to(ROOT)
        if rel.parts[:1] == ("originals",) and len(rel.parts) >= 4 and p not in doomed:
            originals_by_tenant[rel.parts[1]] += p.stat().st_size

    if not apply:
        if n_left:
            print("\nNothing was deleted. Run again with --delete to remove the leftovers listed above")
            print("and reset the Cloud Storage counter.")
        return 0

    freed = 0
    for p in sorted(doomed):
        try:
            size = p.stat().st_size
            p.unlink()
            freed += size
        except FileNotFoundError:
            pass
    for d in sorted((d for d in ROOT.rglob("*") if d.is_dir()), key=lambda d: -len(d.parts)):
        try:
            d.rmdir()  # only succeeds when empty
        except OSError:
            pass
    print(f"\nDeleted {len(doomed)} files, freed {_fmt(freed)}.")

    with engine.begin() as c:
        for tid in tenants:
            c.execute(text("SELECT set_config('app.current_tenant', :t, true)"), {"t": tid})
            c.execute(text("UPDATE usage_quotas SET storage_bytes_used = :b WHERE tenant_id = CAST(:t AS uuid)"),
                      {"b": originals_by_tenant.get(tid, 0), "t": tid})
    for tid in sorted(tenants):
        print(f"Cloud Storage counter for account {tid[:8]}… set to {_fmt(originals_by_tenant.get(tid, 0))}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
