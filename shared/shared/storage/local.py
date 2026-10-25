# Modified 2026 by sleezy6 (fork of sammyview80/viralo, Apache-2.0): added download(), URL-form delete, streamed upload.
import os
import hashlib
import hmac
import time
import aiofiles
from pathlib import Path
from urllib.parse import quote
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
        async with aiofiles.open(full_path, "wb") as f:
            if isinstance(data, bytes):
                await f.write(data)
            else:
                # Stream in 8 MB pieces: reading a whole upload (often >1 GB) into
                # memory first could fail on small machines and leave a partial file.
                while chunk := data.read(8 * 1024 * 1024):
                    await f.write(chunk)
        return f"/storage/{path.lstrip('/')}"

    async def get_signed_url(self, path: str, expires_in: int = 3600) -> str:
        return sign_local_url(path, expires_in)

    async def download(self, path: str, dest_path: str) -> None:
        """Copy a stored file to dest_path. Accepts a storage key ("clips/a.mp4") or the
        URL upload() returned ("/storage/clips/a.mp4", optionally signed). The other
        backends implement this; without it, publishing and clip re-export crashed
        with AttributeError on local storage."""
        import shutil
        from urllib.parse import unquote, urlsplit
        relative = unquote(urlsplit(path).path).removeprefix("/storage/").lstrip("/")
        src = _safe_local_path(relative)
        if not src.is_file():
            raise FileNotFoundError(f"Local storage file not found: {relative}")
        Path(dest_path).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dest_path)

    async def delete(self, path: str) -> None:
        """Delete a stored file. Accepts a storage key ("originals/a.mp4") or the URL
        upload() returned ("/storage/originals/a.mp4", optionally signed); the URL
        form used to be rejected as an absolute path, so deletes silently did nothing."""
        from urllib.parse import unquote, urlsplit
        relative = unquote(urlsplit(path).path).removeprefix("/storage/").lstrip("/")
        full_path = _safe_local_path(relative)
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
