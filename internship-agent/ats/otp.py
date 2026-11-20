"""E-mailed verification codes on any portal, in any open tab.

Greenhouse has its own flow (ats/greenhouse.py). Other portals sometimes ask for a code too:
Workday on sign-in or account creation, a portal that opens a "verify your e-mail" tab, an
Ashby / Lever step after Submit. This module:

  * finds a code prompt on any page of the browser context (newest tab first): a field marked
    autocomplete="one-time-code", a field labelled "verification code" / "passcode" / "OTP", or a
    row of four or more one-character boxes, on a page that talks about a code;
  * reads the newest unused code e-mailed by a known ATS domain after `since` over IMAP
    (GMAIL_APP_PASSWORD in .env), with the length the page asks for;
  * types it in, presses the page's Verify / Continue / Submit button, and brings the
    application tab back to the front.

When no app password is set, or no code arrives, the caller falls back to the human gate: the
candidate types the code in that tab.
"""
from __future__ import annotations

import asyncio
import time

from playwright.async_api import BrowserContext, Page

import imap_otp

DOMAINS = ("greenhouse-mail.io", "greenhouse.io", "ashbyhq.com", "lever.co", "myworkday.com",
           "myworkdayjobs.com", "workday.com", "smartrecruiters.com", "icims.com", "jobvite.com")
FETCH_TIMEOUT_S = 45

# -> null, or {sel, boxes, length, typed}. Fields get a data-ia-otp marker so Python can find them.
FIND_JS = r"""
() => {
  const shown = el => !!el && el.offsetParent !== null && !el.disabled && !el.readOnly;
  const text = el => ((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();
  const body = text(document.body).slice(0, 6000);
  if (!/\bcode\b|passcode|one[- ]time|\botp\b|verif/i.test(body)) return null;
  // a qualifier is required: "code of conduct" or "ZIP code" questions are not prompts
  const CODE = /(verification|security|one[- ]?time|confirmation|access|sign[- ]?in|log[- ]?in|e-?mail(ed)?|auth\w*|\d[- ](digit|character))\s*(pass)?code\b|\botp\b|passcode|^\s*(enter( the)?\s*)?code\s*\*?\s*$/i;
  const NOT = /zip|postal|promo|coupon|discount|referr|invite|country|area code|dial|phone|job|requisition|posting|source|campaign|tracking|voucher|gift|class|course|naics|sic\b|tax|cpt/i;
  const inputs = [...document.querySelectorAll('input')].filter(i =>
    shown(i) && !['hidden', 'checkbox', 'radio', 'file', 'submit', 'button', 'email', 'password'].includes(i.type));
  const labelOf = i => [i.id && document.querySelector(`label[for="${CSS.escape(i.id)}"]`), i.closest('label')]
    .map(text).join(' ') + ' ' + [i.name, i.id, i.getAttribute('aria-label'), i.placeholder].join(' ');
  const mark = (els, length) => {
    els.forEach((e, k) => e.setAttribute('data-ia-otp', String(k)));
    return {sel: '[data-ia-otp]', boxes: els.length, length, typed: els.map(e => e.value || '').join('').length};
  };
  document.querySelectorAll('[data-ia-otp]').forEach(e => e.removeAttribute('data-ia-otp'));
  const want = (() => {
    const m = body.match(/\b(\d{1,2}|four|five|six|seven|eight)[- ](digit|character|char|letter)\b/i);
    const words = {four: 4, five: 5, six: 6, seven: 7, eight: 8};
    return m ? (words[m[1].toLowerCase()] || parseInt(m[1], 10)) : 0;
  })();
  // a row of one-character boxes
  const singles = inputs.filter(i => i.maxLength === 1);
  const groups = new Map();
  singles.forEach(i => { const p = i.parentElement && i.parentElement.closest('div, fieldset, form') || i.parentElement;
                         if (!groups.has(p)) groups.set(p, []); groups.get(p).push(i); });
  for (const [, els] of groups) if (els.length >= 4 && els.length <= 10) return mark(els, els.length);
  // one field
  for (const i of inputs) {
    const own = [i.id && document.querySelector(`label[for="${CSS.escape(i.id)}"]`), i.closest('label')].map(text).join(' ').trim();
    const says = labelOf(i);
    if (i.autocomplete === 'one-time-code' || ((CODE.test(says) || CODE.test(own)) && !NOT.test(says))) {
      const max = i.maxLength > 3 && i.maxLength <= 10 ? i.maxLength : 0;
      return mark([i], want || max || 6);
    }
  }
  return null;
}
"""

PRESS_JS = r"""
() => {
  const first = document.querySelector('[data-ia-otp]');
  if (!first) return false;
  const shown = el => el.offsetParent !== null && !el.disabled;
  const scope = first.closest('form, [role=dialog], main, section') || document.body;
  const label = b => (b.innerText || b.value || b.getAttribute('aria-label') || '').trim();
  const buttons = [...scope.querySelectorAll('button, input[type=submit], [role=button]')].filter(shown);
  const pick = buttons.find(b => /^(verify|confirm|continue|submit|next|sign in|log in|done)\b/i.test(label(b)))
    || buttons.find(b => b.type === 'submit');
  if (pick) { pick.click(); return true; }
  return false;
}
"""


async def find_code_prompt(context: BrowserContext, skip: Page | None = None) -> tuple[Page, dict] | None:
    """The newest open tab showing a code prompt, and what it asks for."""
    for page in reversed(context.pages):
        if page.is_closed() or page is skip:
            continue
        try:
            info = await page.evaluate(FIND_JS)
        except Exception:                                  # noqa: BLE001 - navigating, or a chrome:// page
            continue
        if info:
            return page, info
    return None


async def enter_code(page: Page, info: dict, code: str) -> bool:
    """Type the code into the prompt and press its button. True once the boxes hold the code."""
    boxes = page.locator("[data-ia-otp]")
    n = await boxes.count()
    if not n:
        return False
    await boxes.first.scroll_into_view_if_needed()
    if n == 1:
        await boxes.first.fill(code)
    else:
        for i in range(n):
            await boxes.nth(i).fill("")
        await boxes.first.click()
        await page.keyboard.type(code, delay=40)           # the boxes move focus on as each character lands
        typed = "".join([await boxes.nth(i).input_value() for i in range(n)])
        if typed != code[:n]:
            for i, ch in enumerate(code[:n]):
                await boxes.nth(i).fill(ch)
    typed = "".join([await boxes.nth(i).input_value() for i in range(n)])
    if typed != (code if n == 1 else code[:n]):
        return False
    await page.wait_for_timeout(300)
    if not await page.evaluate(PRESS_JS):
        await boxes.last.press("Enter")
    return True


async def fetch_code(since: float, length: int) -> str | None:
    """The newest unused code from a known ATS sender after `since`, over IMAP; None without an app password."""
    import email_receipt_verifier as erv
    try:
        address, password = erv.credentials()
    except Exception:                                      # noqa: BLE001 - profile missing
        return None
    if not password:
        return None
    return await asyncio.to_thread(imap_otp.fetch_code_imap, address, password, since,
                                   timeout=FETCH_TIMEOUT_S, domains=DOMAINS, length=length)


async def clear_code_prompt(context: BrowserContext, since: float, back_to: Page | None = None,
                            *, fetch=None, tried: set | None = None) -> str | None:
    """Look for a code prompt in every tab and fill it from Gmail.

    Returns None (no prompt anywhere), "entered" (typed and submitted), or "manual" (a prompt is
    showing but no code could be read: the candidate types it). `tried` remembers prompts already
    answered so a rejected code is not retyped in a loop.
    """
    found = await find_code_prompt(context)
    if not found:
        return None
    page, info = found
    key = (page.url, info.get("boxes"), int(since))
    if tried is not None and key in tried:
        return "manual"
    if tried is not None:
        tried.add(key)
    print(f"      An e-mailed code is asked for ({info.get('length')} characters, {page.url[:70]}); "
          "reading it from Gmail...", flush=True)
    try:
        code = await (fetch or fetch_code)(since, int(info.get("length") or 6))
    except Exception as exc:                               # noqa: BLE001 - bad app password, IMAP blocked
        print(f"      could not read the code ({type(exc).__name__}: {str(exc)[:80]})", flush=True)
        code = None
    if not code:
        try:
            await page.bring_to_front()                    # the candidate types it there
        except Exception:                                  # noqa: BLE001
            pass
        return "manual"
    try:
        await page.bring_to_front()
        ok = await enter_code(page, info, code)
    except Exception:                                      # noqa: BLE001 - the tab closed or navigated
        ok = False
    if ok:
        imap_otp.mark_used(code)
        print("      Code entered.", flush=True)
    if back_to is not None and back_to is not page and not back_to.is_closed():
        try:
            await page.wait_for_timeout(800)
            await back_to.bring_to_front()
        except Exception:                                  # noqa: BLE001
            pass
    return "entered" if ok else "manual"


def now() -> float:
    return time.time()
