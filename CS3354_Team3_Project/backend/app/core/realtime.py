"""
@author: Saaqib Shaik (progress updates), Aashwat Singh (notification delivery)
@description: The live-update hub. Every signed-in browser keeps one WebSocket open; when a task changes
    or someone is @mentioned, the backend pushes a small JSON event to exactly the affected users so
    progress bars and the notification bell refresh within two seconds without reloading the page.
@traces: SE-FR-18, SE-FR-29, SE-NFR-10, SE-NFR-12, UC-21, UC-22
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
from collections import defaultdict
from collections.abc import Iterable
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from fastapi import WebSocket

logger = logging.getLogger("projectforge.realtime")


def _default(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat(timespec="seconds") + ("Z" if value.tzinfo is None else "")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    raise TypeError(f"Unserialisable value {type(value)!r}")


class ConnectionHub:
    def __init__(self) -> None:
        self._connections: dict[str, set[WebSocket]] = defaultdict(set)
        self._lock = threading.Lock()
        self._loop: asyncio.AbstractEventLoop | None = None

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    async def connect(self, user_id: str, websocket: WebSocket) -> None:
        await websocket.accept()
        with self._lock:
            self._connections[user_id].add(websocket)

    def disconnect(self, user_id: str, websocket: WebSocket) -> None:
        with self._lock:
            sockets = self._connections.get(user_id)
            if sockets is not None:
                sockets.discard(websocket)
                if not sockets:
                    self._connections.pop(user_id, None)

    def connection_count(self) -> int:
        with self._lock:
            return sum(len(s) for s in self._connections.values())

    async def _deliver(self, user_ids: list[str], payload: str) -> None:
        with self._lock:
            targets = [(uid, ws) for uid in user_ids for ws in self._connections.get(uid, ())]
        for uid, ws in targets:
            try:
                await ws.send_text(payload)
            except Exception:  # connection already closed
                self.disconnect(uid, ws)

    def publish(self, user_ids: Iterable[str], event_type: str, data: dict[str, Any]) -> None:
        """Thread-safe fire-and-forget broadcast; callable from sync route handlers."""
        recipients = sorted({uid for uid in user_ids if uid})
        if not recipients or self._loop is None or self._loop.is_closed():
            return
        payload = json.dumps({"type": event_type, "data": data}, default=_default)
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is self._loop:
            self._loop.create_task(self._deliver(recipients, payload))
        else:
            asyncio.run_coroutine_threadsafe(self._deliver(recipients, payload), self._loop)


hub = ConnectionHub()
