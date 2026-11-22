"""Two-way phone notifications through a private Discord channel (REST API v10, plain `requests`).

When the automation needs you (a question the profile cannot answer, a CAPTCHA, a missing
confirmation e-mail, a frozen page) it posts to one private channel, pinging you so your phone
buzzes, with the question, the choices and a screenshot. You answer from the Discord app; the
runner fills the field, learns the answer and carries on.

No gateway, no WebSocket, no extra packages and no inbound port: the runner only makes outgoing
HTTPS calls, polling the channel at most once every 2 s (Discord allows 5 requests per 5 s).

.env (git-ignored):
    DISCORD_BOT_TOKEN=...      the bot's token (Developer Portal -> Bot -> Reset Token)
    DISCORD_CHANNEL_ID=...     a private channel the bot can read and post in
    DISCORD_USER_ID=...        your own user id: the only person whose messages are ever accepted
If any of the three is missing the notifier is disabled and every method is a fast no-op.

Reading your replies needs the bot's "Message Content Intent" switched on (Developer Portal -> Bot),
or a DM channel as DISCORD_CHANNEL_ID; without it Discord sends the bot empty message text.
`python agent_runner.py --test-phone` checks all of this in a few seconds.
"""
from __future__ import annotations

import asyncio
import difflib
import json
import os
import re
import time
from collections import deque
from datetime import datetime

import requests

API = "https://discord.com/api/v10"
TIMEOUT = (5, 10)                  # connect, read
MIN_POLL_S = 2.0                   # between GETs on the channel
MAX_CONTENT = 2000                 # Discord's message limit
MAX_RETRY_WAIT_S = 5.0             # longest 429 pause a send will sit out
USER_AGENT = "DiscordBot (internship-agent, 1.0)"
MASK = "••••••••"
HELP = ("Commands: `/status` (where the run is), `/pause` and `/resume` (hold or release the queue), "
        "`/skip` (give up on this posting), `/retry`. `!skip` works too. Anything else is taken as the answer.")


def _scrub(text: str, *secrets: str) -> str:
    for secret in secrets:
        if secret:
            text = text.replace(secret, MASK)
    return text


def _truncate(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _escape(text: str) -> str:
    """Discord markdown / mention characters in a form label must not change how the prompt looks."""
    return re.sub(r"([\\*_`~|>@#])", r"\\\1", str(text or ""))


def _norm(text) -> str:
    return re.sub(r"\s+", " ", str(text or "").strip().lower())


# ---- choosing from options ----------------------------------------------------------------- #

def resolve_option_reply(reply_text: str, options: list[str]) -> str | None:
    """Map a typed reply onto one of `options`: the exact text, a 1-based number, or an unambiguous
    substring / close match. None when it matches nothing or more than one option."""
    opts = [str(o) for o in options if str(o).strip()]
    reply = _norm(reply_text)
    if not opts:
        return str(reply_text).strip() or None
    if not reply:
        return None
    for o in opts:
        if _norm(o) == reply:
            return o
    m = re.fullmatch(r"#?(\d+)[.)]?", reply)
    if m:
        n = int(m.group(1))
        return opts[n - 1] if 1 <= n <= len(opts) else None
    hits = [o for o in opts if (len(reply) >= 2 and reply in _norm(o)) or (len(_norm(o)) >= 4 and _norm(o) in reply)]
    if len(hits) > 1:
        starts = [o for o in hits if _norm(o).startswith(reply)]
        return starts[0] if len(starts) == 1 else None
    if hits:
        return hits[0]
    names = [_norm(o) for o in opts]
    close = difflib.get_close_matches(reply, names, n=2, cutoff=0.75)
    if len(close) == 1 or (len(close) == 2 and difflib.SequenceMatcher(None, reply, close[0]).ratio()
                           - difflib.SequenceMatcher(None, reply, close[1]).ratio() > 0.1):
        return opts[names.index(close[0])]
    return None


def resolve_multi_reply(reply_text: str, options: list[str]) -> list[str] | None:
    """'1, 3' or 'Python, Java' for a multi-choice field; None if any part does not match."""
    parts = [p for p in re.split(r"[,;\n]", str(reply_text)) if p.strip()]
    if not parts:
        return None
    out: list[str] = []
    for part in parts:
        hit = resolve_option_reply(part, options)
        if hit is None:
            return None
        if hit not in out:
            out.append(hit)
    return out


# ---- the notifier ---------------------------------------------------------------------------- #

class DiscordNotifier:
    def __init__(self, token: str | None = None, channel_id: str | None = None, user_id: str | None = None, *,
                 http=None, env=None, clock=time.monotonic, sleep=time.sleep):
        env = os.environ if env is None else env
        pick = lambda given, name: str(given if given is not None else env.get(name, "")).strip().strip("'\"")
        self.token = pick(token, "DISCORD_BOT_TOKEN")
        self.channel_id = pick(channel_id, "DISCORD_CHANNEL_ID")
        self.user_id = pick(user_id, "DISCORD_USER_ID")
        self.enabled = bool(self.token and self.channel_id.isdigit() and self.user_id.isdigit())
        self._http = http or requests
        self._clock, self._sleep = clock, sleep
        self.last_message_id: str | None = None
        self.last_error = ""
        self.status_provider = None                 # callable -> str, set by the runner
        self._pending: deque[str] = deque()
        self._last_poll = -1e9
        self._blocked_until = 0.0
        self._warned_empty = False

    # ---- plumbing ------------------------------------------------------------------------------
    def missing(self) -> list[str]:
        names = (("DISCORD_BOT_TOKEN", self.token), ("DISCORD_CHANNEL_ID", self.channel_id.isdigit()),
                 ("DISCORD_USER_ID", self.user_id.isdigit()))
        return [name for name, ok in names if not ok]

    def _request(self, method: str, path: str, *, params=None, json_body=None, data=None, files=None):
        """The decoded JSON reply, or None. Never raises; a 429 is waited out once (sends) or skipped (polls)."""
        if not self.enabled:
            return None
        url = API + path
        headers = {"Authorization": f"Bot {self.token}", "User-Agent": USER_AGENT}
        for attempt in range(2):
            try:
                r = self._http.request(method, url, headers=headers, params=params, json=json_body, data=data,
                                       files=files, timeout=TIMEOUT)
            except Exception as exc:                                 # noqa: BLE001 - never stop a blitz run
                self.last_error = _scrub(f"{type(exc).__name__}: {exc}", self.token)[:200]
                return None
            if r.status_code == 429:
                try:
                    wait = float(r.json().get("retry_after", 1))
                except Exception:                                    # noqa: BLE001
                    wait = 1.0
                self._blocked_until = self._clock() + wait
                if method == "GET" or attempt == 1 or wait > MAX_RETRY_WAIT_S:
                    self.last_error = f"rate limited, retry after {wait:g}s"
                    return None
                self._sleep(wait)
                continue
            if r.status_code >= 400:
                self.last_error = f"HTTP {r.status_code}"
                return None
            try:
                return r.json()
            except Exception:                                        # noqa: BLE001
                return {}
        return None

    def _advance(self, message_id) -> None:
        try:
            if self.last_message_id is None or int(message_id) > int(self.last_message_id):
                self.last_message_id = str(int(message_id))
        except (TypeError, ValueError):
            pass

    # ---- sending ---------------------------------------------------------------------------------
    def send_message(self, text: str, photo_bytes: bytes | None = None, ping: bool = True, *,
                     advance: bool = True) -> str | None:
        """Post to the channel; with ping=True it @-mentions you so the phone buzzes. Returns the new
        message's id. With advance=True (prompts) nothing posted before it can answer it afterwards;
        acknowledgements pass advance=False so a reply typed meanwhile is not skipped."""
        if not self.enabled:
            return None
        content = _truncate((f"<@{self.user_id}> " if ping else "") + str(text), MAX_CONTENT)
        body = {"content": content, "allowed_mentions": {"users": [self.user_id]} if ping else {"parse": []}}
        path = f"/channels/{self.channel_id}/messages"
        if photo_bytes:
            res = self._request("POST", path, data={"payload_json": json.dumps(body)},
                                files={"files[0]": ("screenshot.png", photo_bytes, "image/png")})
        else:
            res = self._request("POST", path, json_body=body)
        mid = str(res["id"]) if isinstance(res, dict) and res.get("id") else None
        if mid and advance:
            self._advance(mid)
        return mid

    def flush(self) -> bool:
        """Skip everything already in the channel: only messages sent after this can answer a new prompt."""
        if not self.enabled:
            return False
        res = self._request("GET", f"/channels/{self.channel_id}/messages", params={"limit": 1})
        if isinstance(res, list):
            if res:
                self._advance(res[0].get("id"))
            elif self.last_message_id is None:
                self.last_message_id = "0"                           # an empty channel: everything after is new
            self._pending.clear()
            return True
        return False

    def ask_question(self, company: str, role: str, ats: str, field_info: dict,
                     photo_bytes: bytes | None = None) -> str | None:
        """Post one unanswered form field. field_info: {label, kind, options}."""
        if not self.enabled:
            return None
        options = [str(o) for o in field_info.get("options") or [] if str(o).strip()]
        lines = [f"**❓ Needs your answer**",
                 f"**{_escape(company)}** — {_escape(role)} ({_escape(ats)})",
                 f"**Question:** {_escape(field_info.get('label', ''))}",
                 f"**Type:** `{field_info.get('kind') or 'text'}`"]
        if options:
            lines.append("**Choices** (reply with a number or the text):")
            lines += [f"`{i}.` {_escape(o)}" for i, o in enumerate(options[:30], 1)]
            if len(options) > 30:
                lines.append(f"…and {len(options) - 30} more (reply with the text)")
        lines.append("Reply with your answer, or send `/skip`, `/retry`, `/pause`")
        self.flush()
        return self.send_message("\n".join(lines), photo_bytes)

    def ask_choice(self, text: str, photo_bytes: bytes | None = None) -> str | None:
        """Post any prompt that expects a reply (flushes first, like ask_question)."""
        if not self.enabled:
            return None
        self.flush()
        return self.send_message(text, photo_bytes)

    # ---- receiving -------------------------------------------------------------------------------
    def _fetch(self) -> None:
        """New messages after last_message_id, oldest first; only your own, human messages are kept."""
        res = self._request("GET", f"/channels/{self.channel_id}/messages",
                            params={"after": self.last_message_id, "limit": 10})
        if not isinstance(res, list):
            return
        msgs = sorted((m for m in res if isinstance(m, dict) and str(m.get("id", "")).isdigit()),
                      key=lambda m: int(m["id"]))
        for m in msgs:
            self._advance(m["id"])
            author = m.get("author") or {}
            if str(author.get("id")) != self.user_id or author.get("bot"):
                continue                                             # someone else, or a bot (including this one)
            text = (m.get("content") or "").strip()
            if text:
                self._pending.append(text)
            elif not m.get("attachments") and not self._warned_empty:
                self._warned_empty = True                            # Discord hides text without the intent
                self.send_message("I can see your message but Discord is not giving me its text. Switch on "
                                  "**Message Content Intent** for this bot (Developer Portal → Bot), "
                                  "or reply in a DM.", ping=False, advance=False)

    def poll_reply(self, timeout_s: float = 1.0) -> str | None:
        """The next reply from you, or None. At most one GET per MIN_POLL_S: called sooner it returns None
        at once (it waits for the interval only when timeout_s is long enough to cover the wait).
        /status, /pause, /resume and /help are answered here; /skip and /retry are returned."""
        if not self.enabled:
            return None
        while True:
            if self._pending:
                text = self._pending.popleft()
                if self._command(text):
                    continue
                return self._canonical(text)
            now = self._clock()
            wait = max(MIN_POLL_S - (now - self._last_poll), self._blocked_until - now, 0.0)
            if wait > 0:
                if timeout_s < wait:
                    return None
                self._sleep(wait)
            self._last_poll = self._clock()
            if self.last_message_id is None:
                self.flush()                                         # first look: only what comes after counts
                return None
            before = len(self._pending)
            self._fetch()
            if len(self._pending) == before:
                return None

    async def apoll_reply(self) -> str | None:
        """poll_reply for the asyncio loops: the HTTP call runs in a thread so Playwright keeps moving."""
        if not self.enabled:
            return None
        return await asyncio.to_thread(self.poll_reply, 0.0)

    @staticmethod
    def _canonical(text: str) -> str:
        m = re.fullmatch(r"[/!](skip|retry)", text.strip().lower())
        return f"/{m.group(1)}" if m else text

    def _command(self, text: str) -> bool:
        """True when `text` was a command handled here (not an answer for the caller)."""
        m = re.fullmatch(r"[/!](\w+)", text.strip().lower())
        if not m or m.group(1) in ("skip", "retry"):
            return False
        cmd = m.group(1)
        reply = None
        if cmd == "status":
            reply = self._status_text()
        elif cmd in ("pause", "resume"):
            import run_state
            run_state.set_control(paused=(cmd == "pause"))
            reply = ("Paused: no new application starts until you send `/resume` (the current one finishes)."
                     if cmd == "pause" else "Resumed.")
        elif cmd in ("help", "start"):
            reply = HELP
        else:
            return False                                             # not one of ours: it is the answer
        self.send_message(reply, ping=False, advance=False)
        return True

    def _status_text(self) -> str:
        try:
            if self.status_provider:
                return str(self.status_provider())
        except Exception:                                            # noqa: BLE001
            pass
        import run_state
        s = run_state.read()
        job = s.get("job") or {}
        return (f"Active: {job.get('company', '-')} — {job.get('title', '-')} ({s.get('step') or 'filling'}). "
                f"{s.get('message') or ''}").strip()

    # ---- status for Mission Control ---------------------------------------------------------------
    def check(self) -> bool:
        """Can the bot see the channel? Two GETs; used by the dashboard badge and --test-phone."""
        if not self.enabled:
            return False
        return (isinstance(self._request("GET", "/users/@me"), dict)
                and isinstance(self._request("GET", f"/channels/{self.channel_id}"), dict))


# ---- the shared instance ----------------------------------------------------------------------- #

_shared: DiscordNotifier | None = None


def notifier() -> DiscordNotifier:
    global _shared
    if _shared is None:
        _shared = DiscordNotifier()
    return _shared


def use(n: DiscordNotifier | None) -> None:
    """Install (or, with None, drop) the shared notifier: the runner at start-up, and the tests."""
    global _shared
    _shared = n


_status_cache: tuple[float, bool] = (0.0, False)


def dashboard_status(ttl_s: float = 60.0) -> dict:
    """What Mission Control shows. Secrets are never returned, only a mask where one is set."""
    n = notifier()
    global _status_cache
    connected = False
    if n.enabled:
        now = time.monotonic()
        if now - _status_cache[0] > ttl_s or not _status_cache[0]:
            _status_cache = (now, n.check())
        connected = _status_cache[1]
    label = "Connected" if connected else ("Unreachable" if n.enabled else "Off")
    return {"enabled": n.enabled, "connected": connected, "label": label,
            "token": MASK if n.token else "", "channel": MASK if n.channel_id else "", "user": MASK if n.user_id else ""}


# ---- freeze watchdog ------------------------------------------------------------------------------ #

FINGERPRINT_JS = r"""
() => {
  const f = [...document.querySelectorAll('input, textarea, select')];
  return [location.href, document.title, f.length, f.filter(e => e.value).length,
          ((document.body && document.body.innerText) || '').length];
}
"""
# Steps where the run is legitimately waiting on a person or on the mailbox: never a freeze.
_EXEMPT_STEPS = {"WAITING_FOR_ANSWER", "AWAITING_EMAIL_CONFIRMATION", "UNCONFIRMED", "CONFIRMED"}
_AFTER_SUBMIT = {"SUBMITTING_FORM", "ENTERING_OTP"}


class FreezeWatchdog:
    """Notices an application that has made no progress for `stall_s` and asks you what to do.

    Progress is any change in the runner's step / message or in what the browser's tabs show (address,
    title, how many fields are filled, how much text). It stays out of the way while a person is
    being waited on. guard() returns "done", "retry", "skip" or "frozen".
    """

    def __init__(self, n: DiscordNotifier, *, stall_s: float = 120, wait_s: float = 300, tick_s: float = 3,
                 read_state=None, clock=time.monotonic):
        self.n, self.stall_s, self.wait_s, self.tick_s, self.clock = n, stall_s, wait_s, tick_s, clock
        if read_state is None:
            import run_state
            read_state = run_state.read
        self.read_state = read_state

    @staticmethod
    def exempt(state: dict) -> bool:
        message = str(state.get("message") or "")
        return bool(state.get("step") in _EXEMPT_STEPS or state.get("timed_out") or state.get("waiting")
                    or message.startswith(("Waiting for you", "Waiting for your")))

    async def fingerprint(self, context) -> list:
        out = []
        for page in list(getattr(context, "pages", []) or []):
            try:
                out.append(await asyncio.wait_for(page.evaluate(FINGERPRINT_JS), 2.0))
            except Exception:                                        # noqa: BLE001 - closed, navigating, chrome://
                out.append(None)
        return out

    async def _shot(self, context) -> bytes | None:
        for page in reversed(list(getattr(context, "pages", []) or [])):
            try:
                return await page.screenshot(timeout=4000)
            except Exception:                                        # noqa: BLE001
                continue
        return None

    async def guard(self, work: asyncio.Future, context, job: dict) -> str:
        if not self.n.enabled:
            await work
            return "done"
        last, changed_at, alerted_at = None, self.clock(), None
        while True:
            done, _ = await asyncio.wait({work}, timeout=self.tick_s)
            if done:
                return "done"
            state = self.read_state() or {}
            sig = (state.get("step"), state.get("message"), json.dumps(await self.fingerprint(context), default=str))
            if self.exempt(state) or sig != last:
                last, changed_at, alerted_at = sig, self.clock(), None
                continue
            now = self.clock()
            if alerted_at is None and now - changed_at >= self.stall_s:
                alerted_at = now
                stage = state.get("step") or state.get("message") or "filling the form"
                shot = await self._shot(context)
                await asyncio.to_thread(self.n.ask_choice,
                                        f"**⚠️ Automation appears stuck**\n**{_escape(job.get('company', ''))}** — "
                                        f"{_escape(job.get('title', ''))} ({_escape(stage)}) for {int(self.stall_s)}s.\n"
                                        "Reply `/retry` or `/skip`", shot)
            if alerted_at is None:
                continue
            reply = await self.n.apoll_reply()
            verdict = None
            if reply == "/retry":
                if state.get("step") in _AFTER_SUBMIT:               # a second Submit could duplicate the application
                    await asyncio.to_thread(self.n.send_message, "Submit was already clicked, so a retry could apply "
                                            "twice. Skipping it to manual review; check your inbox for a receipt.",
                                            None, False, advance=False)
                    verdict = "skip"
                else:
                    verdict = "retry"
            elif reply == "/skip":
                verdict = "skip"
            elif now - alerted_at >= self.wait_s:
                verdict = "frozen"
            if verdict:
                work.cancel()
                try:
                    await work
                except BaseException:                                # noqa: BLE001 - the cancellation, or its fallout
                    pass
                return verdict


# ---- `agent_runner.py --test-phone` ------------------------------------------------------------------ #

def run_self_test(n: DiscordNotifier | None = None, wait_s: float = 30, out=print, clock=time.monotonic) -> int:
    """Ping the phone and echo the reply back. 0 = works, 1 = no reply in time, 2 = not set up / unreachable."""
    n = n or DiscordNotifier()
    if not n.enabled:
        out("Phone assist is off. Add these to .env (never commit it): " + ", ".join(n.missing()))
        out("  Bot token: Discord Developer Portal -> your app -> Bot -> Reset Token. Turn on Message Content Intent.")
        out("  Channel and user ids: Discord -> Settings -> Advanced -> Developer Mode, then right-click the "
            "channel / yourself -> Copy ID. Invite the bot to a private channel with Send Messages + Read History.")
        return 2
    if not n.check():
        out(f"Could not reach the channel ({n.last_error or 'unknown error'}): check the token, the channel id, "
            "and that the bot was invited to that channel.")
        return 2
    n.flush()
    if not n.send_message(f"✅ internship-agent test. Reply with any text within {int(wait_s)}s and I will echo it back."):
        out(f"Could not post to the channel ({n.last_error}).")
        return 2
    out(f"Test message sent. Reply in Discord (waiting up to {int(wait_s)}s)...")
    deadline = clock() + wait_s
    while clock() < deadline:
        reply = n.poll_reply(timeout_s=MIN_POLL_S)
        if reply is not None:
            n.send_message(f"Got: {reply[:300]}. Phone assist works.", advance=False)
            out(f"Received {reply[:80]!r}. Phone assist works.")
            return 0
    out("No reply in time. Check that Message Content Intent is on and that you replied in that channel.")
    return 1
