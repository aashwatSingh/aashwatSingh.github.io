"""Read the Greenhouse e-mail security code from the candidate's own Gmail over IMAP (Method A).

Used by ats/greenhouse.py in --local-blitz / --assist runs when GMAIL_APP_PASSWORD is set in
.env (a Google "app password": Google Account -> Security -> 2-Step Verification -> App passwords).
The mailbox is opened read-only and messages are fetched with BODY.PEEK, so nothing is marked
read, moved or deleted. Only messages from Greenhouse's own sending domains are looked at.

The parsing helpers (extract_code, code_from_message) are shared with the Gmail-tab fallback
in gmail_tab_otp.py.
"""
from __future__ import annotations

import email
import email.policy
import html
import imaplib
import re
import time
from email.message import Message
from email.utils import parseaddr

IMAP_HOST = "imap.gmail.com"
IMAP_PORT = 993
POLL_INTERVAL_S = 3
POLL_TIMEOUT_S = 45
CODE_LENGTH = 8
SENDER_DOMAINS = ("greenhouse-mail.io", "greenhouse.io")
CODE_SUBJECT = re.compile(r"security code|verification code", re.I)
# Gmail's clock and this machine's can differ by a few seconds.
CLOCK_SLACK_S = 10
MAILBOXES = ("INBOX", '"[Gmail]/All Mail"', '"[Gmail]/Spam"')
_MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()

# Codes already typed into a form in this run: a previous application's e-mail is never reused.
_used: set[str] = set()


def mark_used(code: str) -> None:
    _used.add(code)


def already_used(code: str) -> bool:
    return code in _used


# ---- parsing ------------------------------------------------------------------ #

_TOKEN = re.compile(r"(?<![A-Za-z0-9_\-./@#=&%+])[A-Za-z0-9]{8}(?![A-Za-z0-9_\-/@=&%+])")
_INTRODUCED = re.compile(r"\bcode\b[^.\n]{0,60}(:|\bis)\s*$", re.I)


def to_text(body: str) -> str:
    """Plain text of an e-mail body: tags, links and addresses removed, one block per line."""
    if re.search(r"<\w+[^>]*>", body):
        body = re.sub(r"(?is)<(style|script|head|title)\b.*?</\1>", " ", body)
        body = re.sub(r"(?i)<br\s*/?>|</?(p|div|tr|td|th|li|h\d|table|center)\b[^>]*>", "\n", body)
        body = re.sub(r"<[^>]+>", " ", body)
    body = html.unescape(body).replace("\xa0", " ")
    body = re.sub(r"https?://\S+|\S+@\S+", " ", body)
    return "\n".join(line.strip() for line in body.splitlines())


def extract_code(body: str) -> str | None:
    """The 8-character alphanumeric code in a Greenhouse security-code e-mail (plain text or HTML).

    Every 8-character word in the message is a candidate ("security", "received"), so one is
    only accepted when it looks like a code: letters mixed with digits or irregular capitals,
    or else standing alone on its line and/or introduced by "... code:" on that or the previous line.
    """
    lines = to_text(body or "").splitlines()
    best: tuple[int, str] | None = None
    previous = ""                                          # last non-empty line above
    for line in lines:
        if not line:
            continue
        for m in _TOKEN.finditer(line):
            token = m.group()
            alone = line.strip(" .:*\"'") == token
            introduced = bool(_INTRODUCED.search(line[:m.start()])) or \
                (alone and re.search(r"\bcode\b", previous, re.I) is not None)
            score = _randomness(token) + 2 * alone + 2 * introduced
            if score >= 3 and (best is None or score > best[0]):
                best = (score, token)
        previous = line
    return best[1] if best else None


def _randomness(token: str) -> int:
    """3: cannot be an ordinary word or number; 1: all digits; 0: reads like a word."""
    digits, letters = any(c.isdigit() for c in token), any(c.isalpha() for c in token)
    if digits and letters:
        return 3
    if letters and token not in (token.lower(), token.upper(), token.capitalize()):
        return 3
    return 1 if digits else 0


def from_greenhouse(sender: str) -> bool:
    """The From header is an address at one of Greenhouse's sending domains (or a subdomain)."""
    domain = parseaddr(sender or "")[1].rpartition("@")[2].lower()
    return any(domain == d or domain.endswith("." + d) for d in SENDER_DOMAINS)


def message_bodies(msg: Message) -> list[str]:
    """Text parts of a message, plain text first."""
    parts = []
    for part in msg.walk():
        if part.get_content_maintype() != "text" or part.get_filename():
            continue
        try:
            content = part.get_content()
        except (LookupError, ValueError, AttributeError):
            raw = part.get_payload(decode=True) or b""
            content = raw.decode(part.get_content_charset() or "utf-8", "replace")
        parts.append((part.get_content_subtype() != "plain", content))
    return [content for _, content in sorted(parts, key=lambda p: p[0])]


def code_from_message(msg: Message) -> str | None:
    """The code in one message, or None if it is not a Greenhouse security-code e-mail."""
    if not from_greenhouse(str(msg.get("From", ""))):
        return None
    bodies = message_bodies(msg)
    subject = str(msg.get("Subject", ""))
    if not CODE_SUBJECT.search(subject + "\n" + "\n".join(to_text(b) for b in bodies)):
        return None
    for body in bodies:
        code = extract_code(body)
        if code:
            return code
    return None


# ---- IMAP ----------------------------------------------------------------------- #

def _imap_date(ts: float) -> str:
    t = time.gmtime(ts)
    return f"{t.tm_mday:02d}-{_MONTHS[t.tm_mon - 1]}-{t.tm_year}"


def _recent_greenhouse_uids(conn, since: float) -> list[bytes]:
    """UIDs in the selected mailbox from Greenhouse that arrived after `since`, newest first."""
    # SINCE only has day resolution (and uses the server's timezone): search a day wide, filter exactly below.
    typ, data = conn.uid("search", None, "SINCE", _imap_date(since - 86400))
    uids = data[0].split()[-25:] if typ == "OK" and data and data[0] else []
    if not uids:
        return []
    typ, data = conn.uid("fetch", b",".join(uids), "(INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM)])")
    if typ != "OK":
        return []
    hits = []
    for item in data or []:
        if not isinstance(item, tuple):
            continue
        meta, header = item[0], item[1] or b""
        uid = re.search(rb"UID (\d+)", meta)
        when = imaplib.Internaldate2tuple(meta)
        if not uid or not when:
            continue
        arrived = time.mktime(when)
        sender = email.message_from_bytes(header, policy=email.policy.default).get("From", "")
        if arrived >= since - CLOCK_SLACK_S and from_greenhouse(str(sender)):
            hits.append((arrived, uid.group(1)))
    return [uid for _, uid in sorted(hits, reverse=True)]


def newest_code(conn, since: float) -> str | None:
    """One pass over the mailboxes for an unused Greenhouse code received after `since`."""
    for box in MAILBOXES:
        try:
            typ, _ = conn.select(box, readonly=True)        # re-selecting also picks up new mail
        except imaplib.IMAP4.error:
            continue
        if typ != "OK":
            continue
        for uid in _recent_greenhouse_uids(conn, since):
            typ, data = conn.uid("fetch", uid, "(BODY.PEEK[])")
            raw = next((item[1] for item in data or [] if isinstance(item, tuple)), None)
            if typ != "OK" or not raw:
                continue
            code = code_from_message(email.message_from_bytes(raw, policy=email.policy.default))
            if code and not already_used(code):
                return code
    return None


def fetch_code_imap(address: str, password: str, since: float, *, timeout: float = POLL_TIMEOUT_S,
                    interval: float = POLL_INTERVAL_S, connect=None, sleep=time.sleep) -> str | None:
    """Poll Gmail for the code e-mailed after `since` (epoch seconds). Blocking: call via asyncio.to_thread.

    Raises imaplib.IMAP4.error / OSError when the mailbox cannot be opened (wrong app password,
    IMAP unreachable); returns None when no code arrived within `timeout`.
    """
    conn = (connect or imaplib.IMAP4_SSL)(IMAP_HOST, IMAP_PORT)
    try:
        conn.login(address, password.replace(" ", ""))      # Google shows app passwords in spaced groups
        deadline = time.monotonic() + timeout
        while True:
            code = newest_code(conn, since)
            if code or time.monotonic() + interval > deadline:
                return code
            sleep(interval)
    finally:
        try:
            conn.logout()
        except Exception:                                   # noqa: BLE001 - already disconnected
            pass
