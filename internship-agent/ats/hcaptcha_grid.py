"""hCaptcha 3x3 image grids, solved by the candidate from their phone, and the Discord ping for any CAPTCHA
that needs a person.

When an attended run (--local-blitz) meets an hCaptcha image-selection grid and Discord is set up, the
runner posts the prompt and a screenshot of the grid with the tiles numbered 1-9 (left to right, top to
bottom). The candidate answers from the phone and the runner only relays it:

    7 8  /  1, 4, 7     click those tiles, then Next / Verify
    0  /  none          click Skip (no tile matches)
    reload              click the refresh icon and post the new grid
    /skip               give up on this posting (manual review)

and repeats for every round hCaptcha serves, until the challenge closes, the page reaches /thanks, or time
runs out. Every decision is the person's; nothing here looks at the images, picks tiles, or imitates how a
person moves a mouse. Challenges that are not a 3x3 grid (drag, click on a point, anything unrecognized) are
never attempted: the phone is told what it is, which tab is waiting and for how long, so it can be cleared
in the browser.

Selectors follow hCaptcha's current markup (.prompt-text, .task-grid .task-image, .button-submit,
.refresh.button) and are kept in SEL; they are exercised against a mock of that markup, not the live widget.
"""
from __future__ import annotations

import asyncio
import re
import time
from urllib.parse import urlparse

import run_state

SEL = {"prompt": ".prompt-text", "grid": ".task-grid", "tile": ".task-grid .task-image",
       "submit": ".button-submit", "refresh": ".refresh.button"}
REPLY_POLL_S = 0.5
CHANGE_WAIT_S = 12.0
CLICK_PAUSE_S = 0.15
MAX_ROUNDS = 10
TOTAL_S = 1200
GRID_TILES = 9
HELP = ("Reply with the tile numbers (`1`-`9`, left to right, top to bottom), e.g. `7 8`; `0` or `none` to Skip; "
        "`reload` for a new grid; `/skip` to give up on this posting.")

# Number the tiles by where they are on screen (row by row), not by DOM order, and optionally draw big
# numbered badges over them. The badges sit in fixed-position elements, so the tiles themselves are untouched.
TAG_JS = r"""
(badges) => {
  document.querySelectorAll('[data-ia-badge]').forEach(e => e.remove());
  const tiles = [...document.querySelectorAll('.task-grid .task-image')];
  const boxes = tiles.map(t => ({t, r: t.getBoundingClientRect()}));
  const h = Math.max(1, ...boxes.map(b => b.r.height));
  const row = b => Math.round(b.r.top / (h / 2));
  boxes.sort((a, b) => (row(a) - row(b)) || (a.r.left - b.r.left));
  boxes.forEach((b, i) => {
    b.t.setAttribute('data-ia-tile', String(i + 1));
    if (!badges) return;
    const d = document.createElement('div');
    d.setAttribute('data-ia-badge', '1'); d.textContent = String(i + 1);
    Object.assign(d.style, {position: 'fixed', left: (b.r.left + 5) + 'px', top: (b.r.top + 5) + 'px', width: '30px',
      height: '30px', lineHeight: '30px', textAlign: 'center', font: '700 20px/30px Arial, sans-serif',
      color: '#fff', background: '#000', border: '2px solid #ffeb3b', borderRadius: '50%', zIndex: 2147483647,
      pointerEvents: 'none', boxShadow: '0 0 0 2px rgba(0,0,0,.55)'});
    document.body.appendChild(d);
  });
  return boxes.length;
}
"""
UNBADGE_JS = "() => document.querySelectorAll('[data-ia-badge]').forEach(e => e.remove())"
READ_JS = r"""
() => {
  const tiles = [...document.querySelectorAll('.task-grid .task-image')];
  const text = el => ((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();
  const sig = tiles.map(t => { const i = t.querySelector('.image') || t; const img = t.querySelector('img');
    return (i.style && i.style.backgroundImage) || (img && img.src) || t.innerHTML.length; }).join('|');
  const btn = document.querySelector('.button-submit');
  return {prompt: text(document.querySelector('.prompt-text')), tiles: tiles.length,
          grid: !!document.querySelector('.task-grid'), canvas: !!document.querySelector('canvas'),
          button: text(btn) || (btn && btn.getAttribute('title')) || '', sig: sig};
}
"""
TOKEN_JS = r"""() => [...document.querySelectorAll('[name="h-captcha-response"], [name="g-recaptcha-response"]')]
  .some(e => (e.value || '').trim().length > 0)"""


# ---- what the candidate sends back ----------------------------------------------------------------- #

def parse_reply(text: str) -> tuple:
    """('tiles', [n...]) | ('skip',) | ('reload',) | ('abandon',) | ('retry',) | ('invalid', why).

    Tile numbers are 1-9 with any separator (`7 8`, `1, 4, 7`, or run together as `78`); repeats are ignored.
    A lone 0 or "none" means no tile matches; a 0 among tiles, or anything else, is asked again."""
    t = (text or "").strip().lower()
    word = t.lstrip("/!").strip()
    if t in ("/skip", "!skip"):
        return ("abandon",)
    if t in ("/retry", "!retry"):
        return ("retry",)
    if word in ("reload", "refresh", "new", "r"):
        return ("reload",)
    if word in ("none", "no", "nothing", "skip tile", "0"):
        return ("skip",)
    digits = re.findall(r"\d+", t)
    if not digits or re.sub(r"\d|\s|[,;.+&-]|\band\b", "", t):
        return ("invalid", "I need tile numbers 1-9 (e.g. `7 8`), `0` for none, `reload`, or `/skip`.")
    if digits == ["0"]:
        return ("skip",)
    tiles: list[int] = []
    for chunk in digits:
        for char in chunk:                                 # "78" is tiles 7 and 8
            n = int(char)
            if n == 0:
                return ("invalid", "A `0` cannot be mixed with tile numbers: send the tiles, or `0` alone for none.")
            if n not in tiles:
                tiles.append(n)
    return ("tiles", sorted(tiles))


# ---- the challenge in the page -------------------------------------------------------------------------- #

def challenge_frame(page):
    for frame in page.frames:
        url = frame.url or ""
        if "hcaptcha.com" in url and "frame=challenge" in url and not frame.is_detached():
            return frame
    return None


async def read_challenge(page) -> dict | None:
    """{prompt, tiles, grid, canvas, button, sig} of the open challenge, or None when none is showing."""
    frame = challenge_frame(page)
    if frame is None:
        return None
    try:
        element = await frame.frame_element()
        if not await element.is_visible():
            return None
        return await asyncio.wait_for(frame.evaluate(READ_JS), 3.0)
    except Exception:                                      # noqa: BLE001 - mid-navigation, detached
        return None


async def status(page) -> str:
    """'thanks' (the page moved on), 'token' (hCaptcha issued one), 'gone' (no challenge showing) or 'open'."""
    if "/thanks" in page.url:
        return "thanks"
    try:
        if await asyncio.wait_for(page.evaluate(TOKEN_JS), 2.0):
            return "token"
    except Exception:                                      # noqa: BLE001
        pass
    return "open" if await read_challenge(page) else "gone"


async def numbered_screenshot(page, frame) -> bytes | None:
    """The grid with big numbers on the tiles, as PNG bytes. The numbers are removed again at once."""
    try:
        await frame.evaluate(TAG_JS, True)
        target = frame.locator(SEL["grid"]).first
        try:
            return await target.screenshot(timeout=4000)
        finally:
            await frame.evaluate(UNBADGE_JS)
    except Exception:                                      # noqa: BLE001 - the text prompt still goes out
        return None


async def click_tiles(frame, tiles: list[int]) -> None:
    await frame.evaluate(TAG_JS, False)                    # same numbering as the picture, right before clicking
    for n in tiles:
        await frame.locator(f'[data-ia-tile="{n}"]').first.click(timeout=4000)
        await asyncio.sleep(CLICK_PAUSE_S)


async def click_button(frame, which: str) -> str:
    """Click Next / Verify / Skip (hCaptcha uses one button for all three) or the refresh icon."""
    if which == "refresh":
        await frame.locator(SEL["refresh"]).first.click(timeout=4000)
        return "refresh"
    button = frame.locator(SEL["submit"]).first
    label = " ".join((await button.inner_text(timeout=3000)).split())
    await button.click(timeout=4000)
    return label


async def wait_for_change(page, before_sig: str) -> str:
    """After a click: 'solved' (closed / token / thanks), 'changed' (a new round) or 'same' (nothing happened:
    hCaptcha may have rejected the answer)."""
    end = time.monotonic() + CHANGE_WAIT_S
    while time.monotonic() < end:
        await asyncio.sleep(0.3)
        st = await status(page)
        if st in ("thanks", "token", "gone"):
            return "solved"
        state = await read_challenge(page)
        if state and state["sig"] != before_sig:
            return "changed"
    return "same"


# ---- telling the phone -------------------------------------------------------------------------------------- #

def fmt_remaining(seconds: float | None) -> str:
    if seconds is None:
        return "a while"
    s = max(0, int(seconds))
    return f"{s // 60}m {s % 60:02d}s" if s >= 60 else f"{s}s"


async def describe_tab(page) -> str:
    """Which browser tab is waiting, e.g. 'tab 2 of 3 “Zoox - Software Engineer Intern” (jobs.lever.co)'. The
    tab is brought to the front so it is the one on screen when the candidate gets to the laptop."""
    try:
        pages = [p for p in page.context.pages if not p.is_closed()]
        index = pages.index(page) + 1 if page in pages else 1
        title = (await asyncio.wait_for(page.title(), 2.0)) or "(untitled)"
        host = urlparse(page.url).netloc or "blank"
        try:
            await page.bring_to_front()
        except Exception:                                  # noqa: BLE001
            pass
        return f"tab {index} of {len(pages)} “{title[:70]}” ({host})"
    except Exception:                                      # noqa: BLE001
        return "the application tab"


def job_lines() -> list[str]:
    job = run_state.read().get("job") or {}
    head = f"**{job.get('company', 'This posting')}** — {job.get('title', '')}".rstrip(" —")
    if job.get("ats"):
        head += f" ({job['ats']})"
    return [head] + ([job["url"]] if job.get("url") else [])


async def captcha_ping(page, kind: str, *, remaining_s: float | None, headline: str = "CAPTCHA needs attention",
                       extra: list[str] | None = None) -> str:
    """The message for any CAPTCHA a person must clear: which posting, its URL, what kind of challenge,
    how long is left before it goes to manual review, and which tab is waiting."""
    where = await describe_tab(page)
    return "\n".join([f"**🧩 {headline}**", *job_lines(), f"**What:** {kind}",
                      f"**Time left:** {fmt_remaining(remaining_s)}, then it moves on to manual review",
                      f"**Where:** {where} (brought to the front)", *(extra or []),
                      "Reply `/skip` to give up on this posting"])


async def notify_waiting(page, phone, kind: str, *, remaining_s: float | None, headline: str = "CAPTCHA needs attention",
                         extra: list[str] | None = None) -> None:
    """Post that ping with a screenshot. Best effort: never stops the hand-over."""
    try:
        text = await captcha_ping(page, kind, remaining_s=remaining_s, headline=headline, extra=extra)
        try:
            shot = await page.screenshot(timeout=3000)
        except Exception:                                  # noqa: BLE001
            shot = None
        await asyncio.to_thread(phone.ask_choice, text, shot)
    except Exception:                                      # noqa: BLE001
        pass


# ---- the relay ------------------------------------------------------------------------------------------------- #

async def relay_grid(page, phone, *, reply_wait_s: float = 180.0, total_s: float = TOTAL_S, touch=None,
                     max_rounds: int = MAX_ROUNDS) -> str:
    """Post each 3x3 round to the phone and act on the replies. Returns 'verified', 'closed' (the challenge went
    away without a token), 'skipped' (/skip), 'unsupported' (not a 3x3 grid), 'timeout', or 'none' (no hCaptcha
    challenge is showing). touch() is called at the start of each round so the caller's own wait is extended."""
    started, rounds, force_repost, same_again = time.monotonic(), 0, False, False
    last_sig = None
    state = await read_challenge(page)
    if state is None:
        return "none"
    while time.monotonic() - started < total_s:
        st = await status(page)
        if st in ("thanks", "token"):
            return "verified"
        state = await read_challenge(page)
        if state is None:
            return "closed"
        if state["tiles"] != GRID_TILES or not state["grid"]:
            kind = ("non-grid hCaptcha (click or drag on the image): solve it in the browser" if state["canvas"]
                    else f"hCaptcha layout I don't recognize ({state['tiles']} tiles): solve it in the browser")
            await notify_waiting(page, phone, kind, remaining_s=reply_wait_s)
            return "unsupported"
        rounds += 1
        if rounds > max_rounds:
            await notify_waiting(page, phone, f"hCaptcha kept serving grids after {max_rounds} rounds: please finish it "
                                 "in the browser", remaining_s=reply_wait_s)
            return "timeout"
        if touch:
            touch()
        frame = challenge_frame(page)
        last_sig, force_repost = state["sig"], False
        shot = await numbered_screenshot(page, frame)
        tab = await describe_tab(page)
        text = "\n".join([f"**🧩 hCaptcha grid — round {rounds}**", *job_lines(), f"**Prompt:** {state['prompt']}",
                          *(["hCaptcha shows the same challenge again (it may have rejected that answer)."]
                            if same_again else []),
                          f"**Time left:** {fmt_remaining(reply_wait_s)} · {tab}", HELP])
        same_again = False
        await asyncio.to_thread(phone.ask_choice, text, shot)
        action = await _wait_for_action(page, phone, reply_wait_s)
        kind = action[0]
        if kind == "solved":
            await asyncio.to_thread(phone.send_message, "Solved on the laptop — continuing", None, False, advance=False)
            return "verified" if await status(page) != "gone" else "closed"
        if kind == "abandon":
            return "skipped"
        if kind == "timeout":
            await notify_waiting(page, phone, "no answer to the grid in time: solve it in the browser",
                                 remaining_s=0)
            return "timeout"
        if kind == "retry":
            force_repost = True
            continue
        try:
            if kind == "reload":
                await click_button(frame, "refresh")
                await wait_for_change(page, state["sig"])
                continue
            if kind == "tiles":
                await click_tiles(frame, action[1])
            pressed = await click_button(frame, "submit")
            await asyncio.to_thread(phone.send_message, (f"Clicked tiles {', '.join(map(str, action[1]))} and "
                                    f"“{pressed}”" if kind == "tiles" else f"Clicked “{pressed}”"), None, False,
                                    advance=False)
        except Exception as exc:                           # noqa: BLE001 - a tile or button that was not there
            await asyncio.to_thread(phone.send_message, f"Could not click that ({type(exc).__name__}). "
                                    "Reply again or finish it in the browser.", None, False, advance=False)
            force_repost = True
            continue
        result = await wait_for_change(page, state["sig"])
        if result == "solved":
            return "verified" if await status(page) in ("thanks", "token") else "closed"
        if result == "same":
            force_repost = same_again = True
    await notify_waiting(page, phone, "the grid took too long: solve it in the browser", remaining_s=0)
    return "timeout"


async def _wait_for_action(page, phone, wait_s: float) -> tuple:
    """The next usable reply ('tiles', [...]), ('skip',), ('reload',), ('abandon',), ('retry',); ('solved',) when
    it was solved on the laptop meanwhile; ('timeout',). Unusable replies are answered and ignored."""
    end = time.monotonic() + wait_s
    while time.monotonic() < end:
        if await status(page) in ("thanks", "token", "gone"):
            return ("solved",)
        reply = await phone.apoll_reply()
        if reply is not None:
            parsed = parse_reply(reply)
            if parsed[0] == "invalid":
                await asyncio.to_thread(phone.send_message, parsed[1], None, False, advance=False)
            else:
                return parsed
        await asyncio.sleep(REPLY_POLL_S)
    return ("timeout",)


async def handle_challenge(page, phone, *, reply_wait_s: float = 180.0, touch=None,
                           fallback_kind: str = "CAPTCHA (not an hCaptcha image grid)") -> str:
    """The one call the adapters make when a person is needed. Returns relay_grid's outcome; for 'none' it
    sends the general ping itself, and 'unsupported' / 'timeout' have already told the phone why."""
    outcome = await relay_grid(page, phone, reply_wait_s=reply_wait_s, touch=touch)
    if outcome == "none":
        await notify_waiting(page, phone, fallback_kind, remaining_s=reply_wait_s)
    return outcome
