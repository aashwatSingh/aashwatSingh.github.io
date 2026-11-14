"""The piece of the confirmation gate that the adapters and the runner share.

One ReceiptGate lives for the whole run. For each posting it:

  1. notes where the inbox stood right before the final Submit click (adapters call before_submit),
  2. waits for the confirmation e-mail after the browser shows the post-submit screen (the runner
     calls wait), using IMAP when GMAIL_APP_PASSWORD is set and the Gmail tab otherwise,
  3. keeps run_state.json current so the dashboard can show which step the posting is on.

Nothing here may fail an application: a mailbox that cannot be read shows up as "not confirmed",
and the runner then asks the candidate what to do.
"""
from __future__ import annotations

import asyncio

import email_receipt_verifier as erv
import run_state


class ReceiptGate:
    def __init__(self, *, log=print, credentials=erv.credentials):
        self.log = log
        self._credentials = credentials
        self.job: dict | None = None
        self.pre_uid: int | None = None            # IMAP snapshot
        self.known_threads: set[str] | None = None  # Gmail-tab snapshot
        self.seen: set[int] = set()
        self.otp = False                            # this posting asked for an e-mailed code

    # ---- per posting -----------------------------------------------------------
    def start(self, job: dict) -> None:
        self.job, self.pre_uid, self.known_threads, self.seen, self.otp = job, None, None, set(), False
        run_state.clear_choice()
        run_state.update(job, "", "Filling the form")

    def step(self, step: str, message: str = "", **extra) -> None:
        self.otp = self.otp or step == run_state.ENTERING_OTP
        run_state.update(self.job, step, message, otp=self.otp, **extra)

    async def snapshot(self, context) -> str:
        """Note the inbox position. Returns the method used: 'imap', 'gmail-tab' or '' (unreadable)."""
        address, password = self._safe_credentials()
        if password:
            try:
                self.pre_uid = await asyncio.to_thread(erv.snapshot_uid, address, password)
                self.known_threads = None
                self.seen = set()
                return "imap"
            except Exception as exc:                       # noqa: BLE001 - bad app password, IMAP blocked
                self.log(f"      IMAP snapshot failed ({type(exc).__name__}: {str(exc)[:100]}); using the Gmail tab")
        try:
            import gmail_tab_otp
            threads = await gmail_tab_otp.snapshot_inbox_threads(context)
        except Exception as exc:                           # noqa: BLE001
            self.log(f"      Could not read the Gmail tab ({type(exc).__name__}: {str(exc)[:100]})")
            threads = None
        if threads is None:
            return ""
        self.pre_uid, self.known_threads = None, threads
        return "gmail-tab"

    async def before_submit(self, context, step: str = run_state.SUBMITTING) -> None:
        """Adapters call this right before the click that sends the application."""
        try:
            self.step(step, "Submitting the form" if step == run_state.SUBMITTING else "Entering the e-mailed code")
            await self.snapshot(context)
        except Exception as exc:                           # noqa: BLE001 - never fail the application on this
            self.log(f"      Inbox snapshot skipped ({type(exc).__name__}: {str(exc)[:100]})")

    async def wait(self, context, company: str, timeout: float = erv.POLL_TIMEOUT_S,
                   interval: float = erv.POLL_INTERVAL_S) -> dict:
        """The confirmation e-mail for this posting, or {"confirmed": False, ...} after `timeout` seconds."""
        if self.pre_uid is not None:
            address, password = self._safe_credentials()
            try:
                return await asyncio.to_thread(
                    erv.verify_submission_email, company, self.pre_uid, address=address, password=password,
                    timeout=timeout, interval=interval, seen=self.seen)
            except Exception as exc:                       # noqa: BLE001
                self.log(f"      IMAP check failed ({type(exc).__name__}: {str(exc)[:100]})")
                return dict(erv.NOT_CONFIRMED)
        if self.known_threads is not None:
            try:
                import gmail_tab_otp
                return await gmail_tab_otp.fetch_receipt_gmail_tab(context, company, self.known_threads,
                                                                   timeout=timeout, interval=interval)
            except Exception as exc:                       # noqa: BLE001
                self.log(f"      Gmail tab check failed ({type(exc).__name__}: {str(exc)[:100]})")
                return dict(erv.NOT_CONFIRMED)
        self.log("      No inbox snapshot was taken before Submit, so the confirmation e-mail cannot be told apart "
                 "from older mail. Set GMAIL_APP_PASSWORD in .env, or sign in to Gmail in the runner's browser.")
        return dict(erv.NOT_CONFIRMED)

    def _safe_credentials(self) -> tuple[str, str]:
        try:
            return self._credentials()
        except Exception:                                  # noqa: BLE001 - profile missing in a test or dry run
            return "", ""
