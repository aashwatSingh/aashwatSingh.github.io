"""
@author: eLeet Coderz (Team 3) - integration: Jon Sorey; security middleware: Tyler Gaines; live updates:
    Saaqib Shaik & Aashwat Singh
@description: Starts the ProjectForge API. It creates the database tables (and demo data) on first run,
    turns on the sign-up / log-in rate limiter, lets the React app call the API from another port (CORS),
    makes retried saves safe (the same Idempotency-Key never saves twice), formats validation errors as
    {"detail", "errors": {field: message}}, plugs in every feature router, hosts the WebSocket used for
    live progress and notification updates, and - after `npm run build` - also serves the website itself.
@traces: SE-NFR-04, SE-NFR-06, SE-NFR-08, SE-NFR-10, SE-NFR-12, UC-08, UC-09
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import time
from collections import OrderedDict
from contextlib import asynccontextmanager

from fastapi import FastAPI, Query, Request, WebSocket, WebSocketDisconnect, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from app import __version__
from app.core.config import get_settings
from app.core.database import SessionLocal, create_all, database_kind
from app.core.realtime import hub
from app.core.security import rate_limit_middleware, user_from_token
from app.routers import (
    auth,
    collaboration,
    costs,
    dashboard,
    exports,
    members,
    projects,
    reports,
    settings as settings_router,
    soft_deadlines,
    tasks,
    time_tracking,
)
from app.schemas.dto import FieldValidationError

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("projectforge")
settings = get_settings()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    create_all()
    if settings.seed_demo_data:
        from app.seed import seed_demo_data

        with SessionLocal() as db:
            seed_demo_data(db)
    hub.bind_loop(asyncio.get_running_loop())
    logger.info("ProjectForge API ready (database: %s, demo mode: %s)", database_kind(), settings.demo_mode)
    yield


app = FastAPI(
    title="ProjectForge API",
    version=__version__,
    description="CS 3354.001 Team 3 (eLeet Coderz) project management backend.",
    lifespan=lifespan,
)


# ---------------------------------------------------------------------------
# Idempotent retries (SE-NFR-04): the browser retries a timed-out save once with the same key.
# ---------------------------------------------------------------------------
class IdempotencyStore:
    def __init__(self, ttl_seconds: int = 600, max_entries: int = 2000) -> None:
        self.ttl = ttl_seconds
        self.max_entries = max_entries
        self._done: OrderedDict[str, tuple[float, int, list[tuple[str, str]], bytes]] = OrderedDict()
        self._inflight: dict[str, asyncio.Event] = {}

    def get(self, key: str):
        item = self._done.get(key)
        if item is None:
            return None
        if item[0] < time.monotonic():
            self._done.pop(key, None)
            return None
        return item

    def put(self, key: str, status_code: int, headers: list[tuple[str, str]], body: bytes) -> None:
        self._done[key] = (time.monotonic() + self.ttl, status_code, headers, body)
        self._done.move_to_end(key)
        while len(self._done) > self.max_entries:
            self._done.popitem(last=False)


idempotency_store = IdempotencyStore()


@app.middleware("http")
async def idempotency_middleware(request: Request, call_next):
    raw_key = request.headers.get("idempotency-key")
    if not raw_key or request.method not in {"POST", "PUT", "PATCH", "DELETE"} or len(raw_key) > 128:
        return await call_next(request)
    scope = f"{request.headers.get('authorization', '')}|{request.method}|{request.url.path}|{raw_key}"
    key = hashlib.sha256(scope.encode("utf-8")).hexdigest()

    waiter = idempotency_store._inflight.get(key)
    if waiter is not None:
        await waiter.wait()
    cached = idempotency_store.get(key)
    if cached is not None:
        _, code, headers, body = cached
        response = Response(content=body, status_code=code)
        for name, value in headers:
            if name.lower() != "content-length":
                response.headers.append(name, value)
        response.headers["Idempotent-Replayed"] = "true"
        return response

    event = asyncio.Event()
    idempotency_store._inflight[key] = event
    try:
        response = await call_next(request)
        body = b""
        async for chunk in response.body_iterator:
            body += chunk if isinstance(chunk, bytes) else chunk.encode("utf-8")
        headers = [(k, v) for k, v in response.headers.items()]
        if response.status_code < 500:
            idempotency_store.put(key, response.status_code, headers, body)
        replay = Response(content=body, status_code=response.status_code)
        for name, value in headers:
            if name.lower() != "content-length":
                replay.headers.append(name, value)
        return replay
    finally:
        event.set()
        idempotency_store._inflight.pop(key, None)


app.middleware("http")(rate_limit_middleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "Idempotency-Key"],
    expose_headers=["Content-Disposition", "X-Export-Count", "Retry-After"],
)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    return response


# ---------------------------------------------------------------------------
# Error formatting: field-level messages for forms (UC-08 and every create / edit form)
# ---------------------------------------------------------------------------
def _field_name(loc: tuple) -> str:
    parts = [str(p) for p in loc if p not in ("body", "query", "path")]
    return ".".join(parts) or "request"


@app.exception_handler(RequestValidationError)
async def validation_handler(_request: Request, exc: RequestValidationError) -> JSONResponse:
    errors: dict[str, str] = {}
    for err in exc.errors():
        field = _field_name(tuple(err.get("loc", ())))
        message = str(err.get("msg", "Invalid value")).removeprefix("Value error, ")
        errors.setdefault(field, message)
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={"detail": "Please fix the highlighted fields.", "errors": errors},
    )


@app.exception_handler(FieldValidationError)
async def field_error_handler(_request: Request, exc: FieldValidationError) -> JSONResponse:
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={"detail": exc.detail, "errors": exc.errors},
    )


for module in (
    auth,
    settings_router,
    projects,
    exports,
    dashboard,
    tasks,
    members,
    collaboration,
    soft_deadlines,
    costs,
    time_tracking,
    reports,
):
    app.include_router(module.router)


@app.get("/api/health", tags=["meta"])
def health() -> dict:
    return {"status": "ok", "version": __version__, "database": database_kind(), "demo_mode": settings.demo_mode}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket, token: str = Query(...)) -> None:
    """Live updates: progress (SE-NFR-10) and notifications (SE-NFR-12), delivered in well under 2 s."""
    with SessionLocal() as db:
        user = user_from_token(token, db)
        user_id = user.id if user else None
    if user_id is None:
        await websocket.close(code=4401)
        return
    await hub.connect(user_id, websocket)
    try:
        await websocket.send_json({"type": "connected", "data": {"user_id": user_id}})
        while True:
            message = await websocket.receive_text()
            if message == "ping":
                await websocket.send_json({"type": "pong", "data": {}})
    except WebSocketDisconnect:
        pass
    finally:
        hub.disconnect(user_id, websocket)


# ---------------------------------------------------------------------------
# Serve the built React app (web/dist) so `uvicorn app.main:app` is a one-process demo.
# ---------------------------------------------------------------------------
_dist = settings.frontend_dist
if _dist.is_dir() and (_dist / "index.html").is_file():
    if (_dist / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=_dist / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str):
        if full_path.startswith(("api/", "ws")):
            return JSONResponse(status_code=404, content={"detail": "Not found"})
        candidate = (_dist / full_path).resolve()
        if full_path and candidate.is_file() and _dist.resolve() in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(_dist / "index.html")
