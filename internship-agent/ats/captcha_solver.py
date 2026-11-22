"""CAPTCHA detection with a local checkbox click and a manual hand-over; one isolated module.

What it does, in order, on a page that may show a reCAPTCHA, hCaptcha or Cloudflare Turnstile:

  1. Detect it, fast. One short DOM probe (500 ms cap); a missing widget, a detached frame or a
     cross-origin frame can never raise, so a page with no CAPTCHA costs a few milliseconds.
     A response token that is already filled in, or a checkbox that is already ticked, returns
     immediately as solved (method "already_solved").
  2. Click the checkbox, once, in the browser window the candidate is already looking at, and wait
     up to 8 s for the token to appear or the box to tick (method "checkbox"). That is all a person
     would do, and the site decides for itself whether to accept it.
  3. If the site escalates to an image puzzle, or the click is not accepted, hand over: outline the
     widget in purple (the same look as ats/assist.py), ring the terminal bell once, and wait for
     the candidate to solve it. It resumes the moment the token appears, the widget disappears, or
     the page navigates (method "manual"). Unattended runs skip this step and return unsolved, so
     the posting goes to manual review as before.

It never sends the challenge to a solving service, never injects a token, and does nothing to make
the browser look less automated: the site's own check is the site's decision, and the image
puzzle is for the candidate.
"""
from __future__ import annotations

import asyncio
import re
import time
from dataclasses import dataclass

from playwright.async_api import Page

import phone_notify

PROBE_TIMEOUT_S = 0.5              # every DOM / frame access is capped at this
CHECKBOX_WAIT_S = 8.0
POLL_S = 0.4
MANUAL_POLL_S = 0.5
MANUAL_TIMEOUT_S = 120
HIGHLIGHT_COLOR = "#a855f7"        # ats/assist.py's outline colour
BADGE_TEXT = "Solve this CAPTCHA, then the form continues"

# -> [{kind, token, frames: [{i, src, w, h, visible}]}] for each CAPTCHA family on the page.
# Matching iframes get a data-ia-captcha marker so Python can find them again.
PROBE_JS = r"""
() => {
  document.querySelectorAll('[data-ia-captcha]').forEach(e => e.removeAttribute('data-ia-captcha'));
  const families = [
    ['hcaptcha', 'iframe[src*="hcaptcha"]', '[name="h-captcha-response"]', '.h-captcha'],
    ['turnstile', 'iframe[src*="challenges.cloudflare.com"]', '[name="cf-turnstile-response"]', '.cf-turnstile'],
    ['recaptcha', 'iframe[src*="recaptcha"]', '[name="g-recaptcha-response"]', '.g-recaptcha'],
  ];
  const shown = el => {
    try { return el.checkVisibility({checkOpacity: true, checkVisibilityCSS: true}); } catch (e) { /* older engine */ }
    return el.offsetParent !== null;
  };
  let n = 0, hcaptchaHere = false;
  const out = [];
  for (const [kind, frameSel, tokenSel, boxSel] of families) {
    const frames = [...document.querySelectorAll(frameSel)];
    const tokens = [...document.querySelectorAll(tokenSel)];
    const boxes = document.querySelectorAll(boxSel);
    // hCaptcha also fills a g-recaptcha-response field: it is not evidence of reCAPTCHA by itself.
    const present = frames.length || boxes.length || (tokens.length && !(kind === 'recaptcha' && hcaptchaHere));
    if (!present) continue;
    if (kind === 'hcaptcha') hcaptchaHere = true;
    out.push({
      kind,
      token: tokens.some(t => (t.value || '').trim().length > 0),
      frames: frames.map(f => {
        const r = f.getBoundingClientRect();
        f.setAttribute('data-ia-captcha', String(n));
        return {i: n++, src: f.src || '', w: Math.round(r.width), h: Math.round(r.height),
                visible: r.width > 0 && r.height > 0 && shown(f)};
      }),
    });
  }
  return out;
}
"""

# Outline the widget (or its container) the way ats/assist.py outlines a question; undone by CLEAR_JS.
HIGHLIGHT_JS = r"""
([index, color, text]) => {
  const f = document.querySelector(`[data-ia-captcha="${index}"]`);
  if (!f) return false;
  const p = f.parentElement;   // its wrapper, unless that is the whole page or form
  const w = p && !['BODY', 'HTML', 'FORM'].includes(p.tagName) ? p : f;
  window.__iaCaptcha = {el: w, outline: w.style.outline, offset: w.style.outlineOffset, shadow: w.style.boxShadow,
                        radius: w.style.borderRadius};
  Object.assign(w.style, {outline: '3px solid ' + color, outlineOffset: '4px', borderRadius: '6px',
                          boxShadow: '0 0 0 7px rgba(168,85,247,.16), 0 0 22px rgba(168,85,247,.45)'});
  const b = document.createElement('div');
  b.id = 'ia-captcha-badge'; b.textContent = text; b.setAttribute('role', 'status');
  const r = w.getBoundingClientRect();
  Object.assign(b.style, {position: 'absolute', zIndex: 2147483647, background: color, color: '#fff',
    font: '600 12px/1.2 system-ui, sans-serif', padding: '4px 9px', borderRadius: '6px', pointerEvents: 'none',
    top: Math.max(0, r.top + window.scrollY - 30) + 'px', left: Math.max(0, r.left + window.scrollX) + 'px'});
  document.body.appendChild(b);
  w.scrollIntoView({block: 'center', inline: 'nearest'});
  return true;
}
"""

CLEAR_JS = r"""
() => {
  const s = window.__iaCaptcha;
  if (s && s.el) Object.assign(s.el.style, {outline: s.outline, outlineOffset: s.offset, boxShadow: s.shadow,
                                            borderRadius: s.radius});
  window.__iaCaptcha = null;
  const b = document.getElementById('ia-captcha-badge');
  if (b) b.remove();
}
"""

_CHECKED = '#recaptcha-anchor, #checkbox, [role="checkbox"], input[type="checkbox"]'


@dataclass
class CaptchaResult:
    detected: bool = False
    solved: bool = False
    kind: str | None = None
    method: str = ""
    error: str | None = None
    visible: bool = False          # a widget is actually showing (an invisible one has nothing to click)


def _role(kind: str, src: str) -> str:
    """'checkbox' for the tick-box frame, 'challenge' for the image-puzzle frame, '' for anything else."""
    if kind == "recaptcha":
        return "challenge" if "bframe" in src else "checkbox" if "/anchor" in src else ""
    if kind == "hcaptcha":
        return "challenge" if "frame=challenge" in src else "checkbox" if "frame=checkbox" in src or "checkbox" in src else ""
    return "checkbox"                                       # Turnstile: one frame, the tick-box and the puzzle


async def _probe(page: Page) -> list[dict]:
    """The CAPTCHA families on the page. [] on any failure: no widget, navigating, a closed page."""
    try:
        return await asyncio.wait_for(page.evaluate(PROBE_JS), PROBE_TIMEOUT_S) or []
    except Exception:                                      # noqa: BLE001 - timeout, navigation, closed page
        return []


async def _ticked(page: Page, index: int) -> bool:
    """aria-checked="true" on the widget's own checkbox (it lives inside the iframe)."""
    try:
        handle = await asyncio.wait_for(page.locator(f'[data-ia-captcha="{index}"]').element_handle(), PROBE_TIMEOUT_S)
        frame = await asyncio.wait_for(handle.content_frame(), PROBE_TIMEOUT_S) if handle else None
        if frame is None:
            return False
        for node in await frame.locator(_CHECKED).all():
            if await node.get_attribute("aria-checked", timeout=300) == "true":
                return True
    except Exception:                                      # noqa: BLE001 - detached or cross-origin frame
        pass
    return False


def _first_checkbox(found: list[dict]) -> tuple[dict, dict] | None:
    for fam in found:
        for fr in fam["frames"]:
            if fr["visible"] and _role(fam["kind"], fr["src"]) == "checkbox" and fr["w"] >= 100 and fr["h"] <= 140:
                return fam, fr
    return None


def _challenge_showing(found: list[dict]) -> tuple[dict, dict] | None:
    for fam in found:
        for fr in fam["frames"]:
            if fr["visible"] and (_role(fam["kind"], fr["src"]) == "challenge" or (fam["kind"] == "turnstile" and fr["h"] > 140)):
                return fam, fr
    return None


async def _is_solved(page: Page, found: list[dict]) -> bool:
    if any(f["token"] for f in found):
        return True
    for fam in found:
        for fr in fam["frames"]:
            if _role(fam["kind"], fr["src"]) == "checkbox" and await _ticked(page, fr["i"]):
                return True
    return False


async def _click_checkbox(page: Page, fam: dict, fr: dict) -> bool:
    loc = page.locator(f'[data-ia-captcha="{fr["i"]}"]')
    try:
        await loc.scroll_into_view_if_needed(timeout=2000)
        await loc.click(position={"x": 28, "y": max(fr["h"], 2) / 2}, timeout=2000)    # where the box sits
        return True
    except Exception:                                      # noqa: BLE001 - covered, detached, moved
        return False


async def _wait_for_solution(page: Page, seconds: float, interval: float, abort=None) -> tuple[bool, str]:
    """(solved, why-it-stopped). Stops when solved, when no widget is left, on timeout / navigation, or
    when abort() (an async callable, e.g. "/skip" from the phone) returns True."""
    deadline = time.monotonic() + seconds
    start_url = page.url
    while time.monotonic() < deadline:
        if abort is not None and await abort():
            return False, "skipped"
        found = await _probe(page)
        if page.is_closed() or page.url != start_url:
            return False, "navigated"
        if found and await _is_solved(page, found):
            return True, "token"
        if not found:
            return False, "gone"
        await asyncio.sleep(interval)
    return False, "timeout"


async def notify_phone(page: Page, phone) -> None:
    """Screenshot + "CAPTCHA needs attention" on the phone; replies after this can race the browser. Best effort."""
    try:
        import run_state
        job = run_state.read().get("job") or {}
        who = f"{job.get('company', 'this posting')} ({job.get('title', '')})".replace(" ()", "")
        try:
            shot = await page.screenshot(timeout=3000)
        except Exception:                                  # noqa: BLE001
            shot = None
        await asyncio.to_thread(phone.ask_choice, f"**🧩 CAPTCHA needs attention** on {who}. "
                                "Solve it on the laptop, or reply `/skip`", shot)
    except Exception:                                      # noqa: BLE001 - never stops the hand-over
        pass


async def detect_and_solve_captcha(page: Page, *, timeout_s: float = 45, allow_manual_fallback: bool = True,
                                   on_status=None, manual_timeout_s: float = MANUAL_TIMEOUT_S) -> CaptchaResult:
    """Detect a CAPTCHA and clear it as far as the candidate's own browser can; see the module docstring.

    timeout_s caps the automatic part (the checkbox attempt). manual_timeout_s caps the hand-over.
    on_status(message) is called with "Solving CAPTCHA..." and the outcome; it must not raise.
    """
    say = on_status or (lambda message: None)
    started = time.monotonic()
    found = await _probe(page)
    if not found:
        return CaptchaResult()
    first = found[0]
    result = CaptchaResult(detected=True, kind=first["kind"],
                           visible=any(fr["visible"] and _role(f["kind"], fr["src"]) in ("checkbox", "challenge")
                                       for f in found for fr in f["frames"]))
    if await _is_solved(page, found):
        result.solved, result.method = True, "already_solved"
        return result
    if not result.visible:
        return result                                      # invisible (e.g. runs on Submit): nothing to click yet

    say("Solving CAPTCHA...")
    box = _first_checkbox(found)
    if box is not None and not _challenge_showing(found):
        fam, fr = box
        result.kind = fam["kind"]
        if await _click_checkbox(page, fam, fr):
            wait = max(0.0, min(CHECKBOX_WAIT_S, timeout_s - (time.monotonic() - started)))
            solved, _ = await _wait_for_solution(page, wait, POLL_S)
            if solved:
                result.solved, result.method = True, "checkbox"
                say(f"Solved {fam['kind']} (checkbox)")
                return result
        else:
            result.error = "could not click the checkbox"

    if not allow_manual_fallback:
        result.error = result.error or "needs a person (image challenge or the checkbox was not accepted)"
        say("CAPTCHA needs a person")
        return result

    found = await _probe(page)
    target = _challenge_showing(found) or _first_checkbox(found)
    if not found or target is None:
        result.error = "the CAPTCHA widget disappeared"
        return result
    try:
        await page.evaluate(HIGHLIGHT_JS, [target[1]["i"], HIGHLIGHT_COLOR, BADGE_TEXT])
    except Exception:                                      # noqa: BLE001 - the page moved on; waiting still works
        pass
    print(f"\a[ACTION REQUIRED] Solve the {result.kind} CAPTCHA in the browser window "
          f"(waiting up to {int(manual_timeout_s)}s; the form continues by itself)", flush=True)
    say("Waiting for you to solve the CAPTCHA")
    phone = phone_notify.notifier()
    if phone.enabled:
        await notify_phone(page, phone)

    async def skipped() -> bool:
        return (await phone.apoll_reply()) == "/skip"
    try:
        solved, why = await _wait_for_solution(page, manual_timeout_s, MANUAL_POLL_S,
                                               abort=skipped if phone.enabled else None)
    finally:
        try:
            await page.evaluate(CLEAR_JS)
        except Exception:                                  # noqa: BLE001
            pass
    if solved:
        result.solved, result.method = True, "manual"
        say(f"Solved {result.kind} (manual)")
    elif why == "skipped":
        result.method, result.error = "skipped", "skipped from the phone"
        say("CAPTCHA skipped from the phone")
    elif why in ("gone", "navigated"):
        result.method = why                                # not a token, but the page has moved on: callers re-check it
    else:
        result.error = "not solved in time"
        say("CAPTCHA not solved in time")
    return result
