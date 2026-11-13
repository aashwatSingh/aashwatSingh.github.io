import imaplib
import time
from email.message import EmailMessage

import pytest

import imap_otp
from imap_otp import code_from_message, extract_code, fetch_code_imap, from_greenhouse

PLAIN = """Hi Jordan,

Copy and paste this code into the security code field on your application:

xK7mP2qR

After you enter the code, resubmit your application.
This code was requested for your application to Acme Robotics.
"""

HTML = """<html><head><style>.c{color:#1a2b3c4d}</style><title>Security code</title></head><body>
<p>Hi Jordan,</p><p>Copy and paste this code into the security code field on your application:</p>
<h1 style="letter-spacing:2px">aB3dE9gH</h1>
<p>Questions? <a href="https://www.greenhouse.io/Zx81Yq0P/help1234">Visit support</a> or write to
no-reply@us.greenhouse-mail.io</p></body></html>"""


@pytest.mark.parametrize("body, code", [
    (PLAIN, "xK7mP2qR"),
    (HTML, "aB3dE9gH"),
    ("Your verification code is: Qw3rTy8u. It expires in 10 minutes.", "Qw3rTy8u"),
    ("Your security code: 4F7H2K9M", "4F7H2K9M"),
    ("Enter this security code to continue\n\n  hGtRwQzN  \n\nThanks", "hGtRwQzN"),
    ("Here is your verification code:\n\n48201937\n", "48201937"),              # digits only, on its own line
    ("Here is your security code:\nabcdefgh\nThanks", "abcdefgh"),              # word-like, but introduced + alone
    ("<td>Security&nbsp;code:</td><td><b>Zz9Yy8Xx</b></td>", "Zz9Yy8Xx"),
    ("Use code **mN4bV7cX** to finish applying.", "mN4bV7cX"),
])
def test_extract_code(body, code):
    assert extract_code(body) == code


@pytest.mark.parametrize("body", [
    "",
    "Thank you for applying to Acme Robotics. We received your application and will be in touch.",
    "Your security code has expired. Please resubmit your application to request another.",   # 'security', 'resubmit'
    "Security\n\nPlease keep your account safe.",                                             # heading, no code
    "Order 20261113 shipped. Reference https://x.io/aB3dE9gH or mail aB3dE9gH@example.com",   # date, link, address
    "Your code is 1234567 or 123456789 or ABCD-1234",                                         # wrong lengths
])
def test_extract_code_rejects_ordinary_text(body):
    assert extract_code(body) is None


def test_extract_code_prefers_the_code_over_other_candidates():
    body = "Reference 20261113.\nYour security code is:\n\nR4nD0mC8\n\nSent by Greenhouse Software"
    assert extract_code(body) == "R4nD0mC8"


def test_sender_must_be_a_greenhouse_domain():
    assert from_greenhouse("Greenhouse <no-reply@us.greenhouse-mail.io>")
    assert from_greenhouse("no-reply@greenhouse.io")
    assert not from_greenhouse("no-reply@greenhouse-mail.io.evil.com")
    assert not from_greenhouse("Greenhouse <security@notgreenhouse.io>")
    assert not from_greenhouse("")


def _message(sender="Greenhouse <no-reply@us.greenhouse-mail.io>", subject="Security code for your application",
             plain=PLAIN, html=None) -> EmailMessage:
    msg = EmailMessage()
    msg["From"], msg["To"], msg["Subject"] = sender, "jordan@example.com", subject
    msg.set_content(plain)
    if html:
        msg.add_alternative(html, subtype="html")
    return msg


def test_code_from_message():
    assert code_from_message(_message()) == "xK7mP2qR"
    assert code_from_message(_message(html=HTML)) == "xK7mP2qR"                 # plain part wins
    assert code_from_message(_message(plain="See the HTML version.", html=HTML)) == "aB3dE9gH"
    assert code_from_message(_message(sender="phish@example.com")) is None
    assert code_from_message(_message(subject="Thanks for applying", plain="Code: xK7mP2qR")) is None


class FakeIMAP:
    """Just enough of imaplib.IMAP4_SSL: one INBOX holding (uid, arrival time, message) entries."""

    def __init__(self, mail, arrivals=()):
        self.mail, self.arrivals = list(mail), list(arrivals)       # arrivals: delivered one per later poll
        self.logged_in = self.logged_out = None
        self.selects = 0

    def __call__(self, host, port):
        assert (host, port) == ("imap.gmail.com", 993)
        return self

    def login(self, user, password):
        if password != "abcdabcdabcdabcd":
            raise imaplib.IMAP4.error("AUTHENTICATIONFAILED")
        self.logged_in = user

    def select(self, box, readonly=False):
        assert readonly
        if box != "INBOX":
            return "NO", [b"no such mailbox"]
        self.selects += 1
        if self.selects > 1 and self.arrivals:
            self.mail.append(self.arrivals.pop(0))
        return "OK", [b"1"]

    def uid(self, command, *args):
        if command == "search":
            return "OK", [b" ".join(str(uid).encode() for uid, _, _ in self.mail)]
        wanted = {int(u) for u in args[0].split(b",")}
        assert "PEEK" in args[1]                                   # never marks mail as read
        out = []
        for uid, when, msg in self.mail:
            if uid not in wanted:
                continue
            stamp = imaplib.Time2Internaldate(when)
            raw = f"From: {msg['From']}\r\n\r\n".encode() if "HEADER" in args[1] else msg.as_bytes()
            out += [(f"{uid} (UID {uid} INTERNALDATE {stamp} BODY[] {{{len(raw)}}}".encode(), raw), b")"]
        return "OK", out

    def logout(self):
        self.logged_out = True


@pytest.fixture(autouse=True)
def _fresh_used_codes():
    imap_otp._used.clear()


def fetch(fake, since, **kw):
    return fetch_code_imap("jordan@example.com", "abcd abcd abcd abcd", since, connect=fake,
                           sleep=lambda s: None, **kw)


def test_fetch_takes_the_newest_greenhouse_code_after_the_submit():
    now = time.time()
    fake = FakeIMAP([
        (1, now - 600, _message(plain=PLAIN.replace("xK7mP2qR", "oLd0C0de"))),      # an earlier application
        (2, now + 2, _message(sender="x@example.com", plain="security code: Sp00fed1")),
        (3, now + 3, _message(plain=PLAIN.replace("xK7mP2qR", "f1Rst0ne"))),
        (4, now + 9, _message()),                                                   # resent: newest wins
    ])
    assert fetch(fake, now) == "xK7mP2qR"
    assert fake.logged_in == "jordan@example.com" and fake.logged_out


def test_fetch_polls_until_the_mail_arrives():
    now = time.time()
    fake = FakeIMAP([], arrivals=[(5, now - 3600, _message(plain="Code: staleOn3")), (6, now + 5, _message())])
    assert fetch(fake, now) == "xK7mP2qR"
    assert fake.selects == 3


def test_fetch_gives_up_and_skips_used_codes():
    now = time.time()
    assert fetch(FakeIMAP([]), now, timeout=0) is None
    imap_otp.mark_used("xK7mP2qR")
    assert fetch(FakeIMAP([(7, now + 1, _message())]), now, timeout=0) is None


def test_bad_app_password_raises():
    with pytest.raises(imaplib.IMAP4.error):
        fetch_code_imap("jordan@example.com", "wrong", time.time(), connect=FakeIMAP([]))
