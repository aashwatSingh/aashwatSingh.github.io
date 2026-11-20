"""Small Windows-safe file helpers shared by the runner and Mission Control.

Both processes write the same JSON files (the Unblock Queue, learned answers), so every
read-modify-write goes through file_lock(), and every write lands through a temporary file and an
atomic os.replace, so a reader never sees half a file.
"""
from __future__ import annotations

import json
import os
import time
from contextlib import contextmanager
from pathlib import Path

LOCK_TIMEOUT_S = 20
STALE_LOCK_S = 120


@contextmanager
def file_lock(path: Path, timeout: float = LOCK_TIMEOUT_S):
    """One writer at a time for `path`, across processes (a sibling `<name>.lock` file).

    Raises TimeoutError (an OSError, so callers treat it like a file another program holds).
    A lock older than STALE_LOCK_S is left over from a crashed writer and is taken over.
    """
    lock = Path(path).with_name(Path(path).name + ".lock")
    deadline = time.monotonic() + timeout
    while True:
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, str(os.getpid()).encode())
            os.close(fd)
            break
        except FileExistsError:
            try:
                if time.time() - lock.stat().st_mtime > STALE_LOCK_S:
                    lock.unlink()
                    continue
            except OSError:
                pass
            if time.monotonic() > deadline:
                raise TimeoutError(f"{Path(path).name} is being written by another program")
            time.sleep(0.05)
    try:
        yield
    finally:
        try:
            lock.unlink()
        except OSError:
            pass


def atomic_write_text(path: Path, text: str) -> None:
    """Write UTF-8 text so the file is either the old or the new version, never a mix.

    On Windows os.replace can fail for a moment while another process (an antivirus scanner,
    Mission Control reading) has the target open, so it is retried briefly.
    """
    path = Path(path)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(text, encoding="utf-8")
    for attempt in range(20):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            if attempt == 19:
                try:
                    tmp.unlink()
                except OSError:
                    pass
                raise
            time.sleep(0.05)


def atomic_write_json(path: Path, data) -> None:
    atomic_write_text(path, json.dumps(data, indent=1, ensure_ascii=False))


def read_json(path: Path, default=None):
    """The parsed file, or `default` when it is missing or unreadable (mid-write by an old version)."""
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default
