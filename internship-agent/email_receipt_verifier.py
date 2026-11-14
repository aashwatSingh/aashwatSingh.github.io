"""Post-submission gate: an application counts only once its confirmation e-mail is in Gmail.

A confirmation page in the browser says the form was accepted by the page; the "Thank you for
applying" e-mail says the employer's system has the application. The runner waits for that e-mail
before it writes the tracker or opens the next posting (see agent_runner.confirm_receipt).

Method A (GMAIL_APP_PASSWORD in .env): IMAP. The highest INBOX UID is noted right before the final
Submit click, and afterwards only messages with a higher UID are read. The mailbox is opened
read-only and fetched with BODY.PEEK, so nothing is marked read, moved or deleted.
Method B (no app password, or IMAP could not be opened): the Gmail tab, see gmail_tab_otp.py.

A security-code or account-verification e-mail is never a confirmation. On Greenhouse the code
e-mail ("Security code for your application to <Company>") arrives first and the "Thank you for
applying to <Company>" e-mail only after the code is submitted; only the second one passes.
"""
from __future__ import annotations

import email
import email.policy
import imaplib
import os
import re
import time
from email.message import Message
from email.utils import parseaddr, parsedate_to_datetime

from imap_otp import IMAP_HOST, IMAP_PORT, message_bodies, to_text

POLL_INTERVAL_S = 4
POLL_TIMEOUT_S = 120
EXTRA_WAIT_S = 60
MAILBOX = "INBOX"

ATS_DOMAINS = {
    "greenhouse-mail.io": "Greenhouse", "greenhouse.io": "Greenhouse",
    "ashbyhq.com": "Ashby", "hire.lever.co": "Lever",
    "myworkday.com": "Workday", "myworkdayjobs.com": "Workday",
}

CONFIRMATION = re.compile(
    r"thank you for applying|thanks for applying|thank you for your application|"
    r"thanks for your application|application received|we received your application|"
    r"we have received your application|we've received your application|"
    r"application confirmation|your application to|successfully submitted", re.I)

# Any of these makes the message a code / account e-mail, whatever else it says.
NOT_A_RECEIPT = re.compile(
    r"security code|verification code|confirm you're a human|verify your e-?mail|"
    r"activate your account", re.I)

# A rejection for an earlier application can land while this one is being verified, and it also
# says "your application to ...". It must not confirm the application just submitted.
DECISION = re.compile(
    r"unfortunately|regret to inform|not (be )?moving forward|move forward with other|"
    r"other candidates|not been selected|no longer under consideration|position has been filled|"
    r"update (regarding|on|about) your application|decided not to (move|proceed)", re.I)

_COMPANY_NOISE =re.compile(r"\b(inc|llc|ltd|corp|corporation|company|co|group|the|holdings)\b")


def _straight(text: str) -> str:
    """Curly apostrophes and non-breaking spaces as plain ones, so the phrase lists match."""
    return (text or "").replace("’", "'").replace("‘", "'").replace("\xa0", " ")


def company_slug(name: str) -> str:
    """'Burns Engineering, Inc.' -> 'burnsengineering'."""
    name = re.sub(r"\(.*?\)", " ", (name or "").lower())
    return re.sub(r"[^a-z0-9]+", "", _COMPANY_NOISE.sub(" ", name))


def sender_domain(sender: str) -> str:
    return parseaddr(sender or "")[1].rpartition("@")[2].lower()


def ats_of(sender: str) -> str:
    """The ATS a sender address belongs to ('Greenhouse'), or '' when it is not a known ATS domain."""
    domain = sender_domain(sender)
    for known, name in ATS_DOMAINS.items():
        if domain == known or domain.endswith("." + known):
            return name
    return ""


def mentions_company(company: str, sender: str, subject: str, body: str) -> bool:
    slug = company_slug(company)
    if len(slug) < 3:                                      # too short to tell apart from ordinary text
        return False
    return slug in re.sub(r"[^a-z0-9]+", "", f"{sender} {subject} {body}".lower())


def is_code_or_account_email(subject: str, body: str) -> bool:
    return bool(NOT_A_RECEIPT.search(_straight(subject) + "\n" + _straight(body)))


def is_confirmation(company: str, sender: str, subject: str, body: str) -> bool:
    """True only for an "application received" e-mail for this company or from a known ATS."""
    subject, body = _straight(subject), _straight(body)
    if is_code_or_account_email(subject, body) or DECISION.search(subject + "\n" + body):
        return False
    if not CONFIRMATION.search(subject + "\n" + body):
        return False
    return bool(ats_of(sender)) or mentions_company(company, sender, subject, body)


def receipt(sender: str, subject: str, received_at: str) -> dict:
    return {"confirmed": True, "subject": subject, "sender": sender, "received_at": received_at,
            "ats": ats_of(sender)}


NOT_CONFIRMED = {"confirmed": False, "subject": "", "sender": "", "received_at": "", "ats": ""}


def receipt_from_message(msg: Message, company: str, fallback_date: str = "") -> dict | None:
    """The gate's payload for one message, or None when it is not this application's confirmation."""
    sender = str(msg.get("From", ""))
    subject = re.sub(r"\s+", " ", str(msg.get("Subject", ""))).strip()
    body = "\n".join(to_text(b) for b in message_bodies(msg))
    if not is_confirmation(company, sender, subject, body):
        return None
    when = fallback_date
    try:
        when = parsedate_to_datetime(str(msg.get("Date", ""))).astimezone().strftime("%Y-%m-%d %H:%M:%S")
    except (TypeError, ValueError):
        pass
    return receipt(sender, subject, when)


# ---- IMAP ----------------------------------------------------------------------- #

def _open(address: str, password: str, connect=None):
    conn = (connect or imaplib.IMAP4_SSL)(IMAP_HOST, IMAP_PORT)
    conn.login(address, password.replace(" ", ""))          # Google shows app passwords in spaced groups
    return conn


def _close(conn) -> None:
    try:
        conn.logout()
    except Exception:                                       # noqa: BLE001 - already disconnected
        pass


def highest_uid(conn) -> int:
    """The highest UID in INBOX right now (0 for an empty mailbox)."""
    typ, data = conn.status(MAILBOX, "(UIDNEXT)")
    m = re.search(rb"UIDNEXT (\d+)", data[0] if typ == "OK" and data and data[0] else b"")
    if m:
        return int(m.group(1)) - 1
    typ, _ = conn.select(MAILBOX, readonly=True)
    typ, data = conn.uid("search", None, "ALL")
    uids = data[0].split() if typ == "OK" and data and data[0] else []
    return int(uids[-1]) if uids else 0


def snapshot_uid(address: str, password: str, *, connect=None) -> int:
    """Call right before the final Submit click. Raises imaplib.IMAP4.error / OSError if IMAP is unavailable."""
    conn = _open(address, password, connect)
    try:
        return highest_uid(conn)
    finally:
        _close(conn)


def _new_uids(conn, after: int) -> list[int]:
    conn.select(MAILBOX, readonly=True)                     # re-selecting also picks up new mail
    typ, data = conn.uid("search", None, f"UID {after + 1}:*")
    if typ != "OK" or not data or not data[0]:
        return []
    # "n:*" always includes the newest message, even when its UID is below n.
    return sorted(u for u in (int(x) for x in data[0].split()) if u > after)


def _internal_date(meta: bytes) -> str:
    when = imaplib.Internaldate2tuple(meta)
    return time.strftime("%Y-%m-%d %H:%M:%S", when) if when else ""


def find_receipt(conn, company: str, pre_submit_uid: int, seen: set[int]) -> dict | None:
    """One pass over INBOX messages newer than the snapshot that have not been read yet."""
    for uid in _new_uids(conn, pre_submit_uid):
        if uid in seen:
            continue
        typ, data = conn.uid("fetch", str(uid), "(INTERNALDATE BODY.PEEK[])")
        item = next((i for i in data or [] if isinstance(i, tuple)), None)
        if typ != "OK" or not item or not item[1]:
            continue                                        # still being delivered: look again next pass
        seen.add(uid)
        hit = receipt_from_message(email.message_from_bytes(item[1], policy=email.policy.default),
                                   company, _internal_date(item[0]))
        if hit:
            return hit
    return None


def verify_submission_email(company: str, pre_submit_uid: int, *, address: str, password: str,
                            timeout: float = POLL_TIMEOUT_S, interval: float = POLL_INTERVAL_S,
                            connect=None, sleep=time.sleep, clock=time.monotonic,
                            seen: set[int] | None = None) -> dict:
    """Poll INBOX for the confirmation e-mail of the application just submitted.

    Blocking: call via asyncio.to_thread. Returns {"confirmed": True, "subject", "sender",
    "received_at", "ats"} or {"confirmed": False, ...} after `timeout` seconds. Pass the same
    `seen` set to a follow-up call ("wait another 60 s") so messages are not read twice.
    Raises imaplib.IMAP4.error / OSError when the mailbox cannot be opened.
    """
    seen = set() if seen is None else seen
    conn = _open(address, password, connect)
    try:
        deadline = clock() + timeout
        while True:
            hit = find_receipt(conn, company, pre_submit_uid, seen)
            if hit:
                return hit
            if clock() + interval > deadline:
                return dict(NOT_CONFIRMED)
            sleep(interval)
    finally:
        _close(conn)


def credentials() -> tuple[str, str]:
    """(Gmail address, app password) from .env / the profile; the password is '' when not configured."""
    import config
    password = os.environ.get("GMAIL_APP_PASSWORD", "").strip()
    address = os.environ.get("GMAIL_ADDRESS", "").strip()
    if password and not address:
        address = config.load_profile()["identity"]["email"]
    return address, password
