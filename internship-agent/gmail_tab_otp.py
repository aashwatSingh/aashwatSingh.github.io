"""Read the Greenhouse e-mail security code from a Gmail tab in the runner's own browser (Method B).

Fallback for when GMAIL_APP_PASSWORD is not set: a second tab in the persistent ./chrome_profile
context opens Gmail. The first time, Gmail is not signed in there, so the runner rings and waits
for the candidate to sign in once; the profile keeps that session for later runs. The tab stays
open for the rest of the run and is reused for every later code.

Only a search for mail from Greenhouse's sending domains is opened, and only that message is read.
"""
from __future__ import annotations

import time
from urllib.parse import quote, urlparse

from playwright.async_api import BrowserContext, Page, TimeoutError as PWTimeout

from imap_otp import CODE_SUBJECT, POLL_INTERVAL_S, POLL_TIMEOUT_S, already_used, extract_code

INBOX_URL = "https://mail.google.com/mail/u/0/#inbox"
SEARCH_URL = "https://mail.google.com/mail/u/0/#search/" + quote(
    "from:(greenhouse-mail.io OR greenhouse.io) newer_than:1h", safe="")
SIGN_IN_WAIT_S = 240
SETTLE_S = 6                      # time for the code e-mail to land once Gmail is open
MAILBOX_READY = 'input[name="q"], div[role="main"]'
ROWS = 'div[role="main"] tr.zA'               # conversation rows; .zE marks unread
MESSAGE_BODY = 'div[role="main"] div.a3s'

_tab: Page | None = None


async def _signed_in(page: Page, seconds: float) -> bool:
    deadline = time.monotonic() + seconds
    while True:
        try:
            if urlparse(page.url).hostname == "mail.google.com" and await page.locator(MAILBOX_READY).count():
                return True
        except Exception:                                  # noqa: BLE001 - mid-navigation
            pass
        if time.monotonic() >= deadline:
            return False
        await page.wait_for_timeout(1000)


async def _newest_code(page: Page) -> str | None:
    """Run the Greenhouse search, open the newest (preferably unread) conversation, read its last message."""
    if "#search/" in page.url:
        await page.reload(wait_until="domcontentloaded")    # same hash: only a reload re-runs the search
    else:
        await page.goto(SEARCH_URL, wait_until="domcontentloaded")
    rows = page.locator(ROWS)
    try:
        await rows.first.wait_for(state="visible", timeout=8000)
    except PWTimeout:
        return None                                        # nothing from Greenhouse in the last hour yet
    unread = page.locator(ROWS + ".zE")
    await (unread.first if await unread.count() else rows.first).click()
    try:
        await page.locator(MESSAGE_BODY).first.wait_for(state="visible", timeout=8000)
    except PWTimeout:
        return None
    # A conversation shows only its newest message expanded, and it is the last one on the page.
    for text in reversed(await page.locator(MESSAGE_BODY).all_inner_texts()):
        if not text.strip():
            continue
        subject = await page.title()
        if not CODE_SUBJECT.search(subject + "\n" + text):
            return None
        code = extract_code(text)
        return code if code and not already_used(code) else None
    return None


async def fetch_code_gmail_tab(context: BrowserContext, *, timeout: float = POLL_TIMEOUT_S,
                               sign_in_wait: float = SIGN_IN_WAIT_S, settle: float = SETTLE_S) -> str | None:
    """The newest unused Greenhouse code in Gmail, or None (not signed in in time / no e-mail)."""
    global _tab
    fresh = _tab is None or _tab.is_closed()
    if fresh:
        _tab = await context.new_page()
    page = _tab
    if fresh or urlparse(page.url).hostname != "mail.google.com":
        await page.goto(INBOX_URL, wait_until="domcontentloaded")
    if not await _signed_in(page, 8):
        print("\a[ACTION REQUIRED] Sign in to Gmail in the new browser tab (only needed once: the "
              f"chrome_profile keeps you signed in). Waiting up to {int(sign_in_wait)}s...", flush=True)
        await page.bring_to_front()
        if not await _signed_in(page, sign_in_wait):
            return None
    await page.wait_for_timeout(int(settle * 1000))
    deadline = time.monotonic() + timeout
    while True:
        code = await _newest_code(page)
        if code or time.monotonic() + POLL_INTERVAL_S > deadline:
            return code
        await page.wait_for_timeout(POLL_INTERVAL_S * 1000)
