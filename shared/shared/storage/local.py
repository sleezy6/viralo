# Modified 2026 by sleezy6 (fork of sammyview80/viralo, Apache-2.0): added download(), URL-form delete,
# streamed upload off the event loop, file names with # ? % handled.
import asyncio
import os
import hashlib
import hmac
import re
import shutil
import time
import aiofiles
from pathlib import Path
from urllib.parse import quote, unquote
from shared.storage.base import StorageAdapter
from shared.config import settings

LOCAL_STORAGE_DIR = os.getenv("LOCAL_STORAGE_DIR", "/tmp/viralo-storage")
LOCAL_STORAGE_URL_TTL_SECONDS = int(os.getenv("LOCAL_STORAGE_URL_TTL_SECONDS", "3600"))


def _safe_local_path(path: str) -> Path:
    """Resolve a storage-relative path and ensure it stays under LOCAL_STORAGE_DIR."""
    if not path or Path(path).is_absolute():
        raise ValueError("Storage path must be relative")
    base = Path(LOCAL_STORAGE_DIR).resolve()
    target = (base / path).resolve()
    if target != base and base not in target.parents:
        raise ValueError("Storage path escapes local storage root")
    return target


_SIGNED_QUERY = re.compile(r"\?(?:[^#]*&)?(?:expires|sig)=")


def storage_key(path: str) -> str:
    """Storage key ("originals/t/v/Clip #3.mp4") from a key or a /storage/ URL.

    Only a signed URL (…?expires=…&sig=…, built by sign_local_url with the path
    percent-encoded) is split at "?" and decoded. upload() returns the raw path, and
    file names may legitimately contain "#", "?" or "%"; splitting or decoding those
    cut "Clip #3.mp4" down to "Clip " so the file could be neither read nor deleted."""
    if _SIGNED_QUERY.search(path):
        path = unquote(path.split("?", 1)[0])
    return path.removeprefix("/storage/").lstrip("/")


def sign_local_url(path: str, expires_in: int = LOCAL_STORAGE_URL_TTL_SECONDS, now: int | None = None) -> str:
    relative = path.removeprefix("/storage/").lstrip("/")
    _safe_local_path(relative)
    expires = (int(time.time()) if now is None else now) + expires_in
    payload = f"{relative}\n{expires}".encode()
    signature = hmac.new(settings.secret_key.encode(), payload, hashlib.sha256).hexdigest()
    return f"/storage/{quote(relative, safe='/')}?expires={expires}&sig={signature}"


def verify_local_url(path: str, expires: int, signature: str, now: int | None = None) -> bool:
    if expires < (int(time.time()) if now is None else now):
        return False
    relative = path.lstrip("/")
    try:
        _safe_local_path(relative)
    except ValueError:
        return False
    payload = f"{relative}\n{expires}".encode()
    expected = hmac.new(settings.secret_key.encode(), payload, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


class LocalStorageAdapter(StorageAdapter):
    def __init__(self):
        Path(LOCAL_STORAGE_DIR).mkdir(parents=True, exist_ok=True)

    async def upload(self, data, path: str, content_type: str = "video/mp4") -> str:
        full_path = _safe_local_path(path)
        full_path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(data, bytes):
            async with aiofiles.open(full_path, "wb") as f:
                await f.write(data)
        else:
            # Copy in 8 MB pieces on a worker thread: reading a whole upload (often
            # several GB) into memory could fail on small machines, and a blocking copy
            # on the event loop froze every other request on this API worker meanwhile.
            def _copy() -> None:
                with open(full_path, "wb") as out:
                    shutil.copyfileobj(data, out, 8 * 1024 * 1024)
            await asyncio.to_thread(_copy)
        return f"/storage/{path.lstrip('/')}"

    async def get_signed_url(self, path: str, expires_in: int = 3600) -> str:
        return sign_local_url(path, expires_in)

    async def download(self, path: str, dest_path: str) -> None:
        """Copy a stored file to dest_path. Accepts a storage key ("clips/a.mp4") or the
        URL upload() returned ("/storage/clips/a.mp4", optionally signed). The other
        backends implement this; without it, publishing and clip re-export crashed
        with AttributeError on local storage."""
        relative = storage_key(path)
        src = _safe_local_path(relative)
        if not src.is_file():
            raise FileNotFoundError(f"Local storage file not found: {relative}")
        Path(dest_path).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dest_path)

    async def delete(self, path: str) -> None:
        """Delete a stored file. Accepts a storage key ("originals/a.mp4") or the URL
        upload() returned ("/storage/originals/a.mp4", optionally signed); the URL
        form used to be rejected as an absolute path, so deletes silently did nothing."""
        full_path = _safe_local_path(storage_key(path))
        if full_path.is_file():
            full_path.unlink()
        # Drop folders the file leaves empty (e.g. originals/<account>/<project>/).
        base = Path(LOCAL_STORAGE_DIR).resolve()
        parent = full_path.parent
        while parent != base and base in parent.parents:
            try:
                parent.rmdir()
            except OSError:
                break
            parent = parent.parent
