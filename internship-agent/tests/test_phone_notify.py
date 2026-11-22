"""phone_notify.py against a fake Discord REST API (no network): the lock to one user and channel,
stale-message flushing, option mapping, and the hand-over in headless Chromium."""
import asyncio
import json
import time

import pytest
from playwright.async_api import async_playwright

import agent_runner
import app_server
import config
import email_receipt_verifier as erv
import phone_notify
import run_state
from answers import load_custom_answers
from ats import captcha_solver as cs
from ats.base import MANUAL_REVIEW, SUBMITTED
from phone_notify import DiscordNotifier, FreezeWatchdog, resolve_multi_reply, resolve_option_reply
from tests.test_assist import home, run                                     # noqa: F401 - fixture
from tests.test_captcha_solver import page_of, widget, with_page             # noqa: F401
from tests.test_portal_submit import (LEVER_THANKS, LEVER_URL, Gate, Ledger, engine, job_for,   # noqa: F401
                                      lever_question, open_context, portals, prepared)

TOKEN, CHANNEL, USER, OTHER = "MTk4.secret-token-value", "5550001", "7770001", "7770002"


class Resp:
    def __init__(self, status=200, body=None, headers=None):
        self.status_code, self._body, self.headers = status, body, headers or {}

    def json(self):
        return self._body


class FakeDiscord:
    """Just enough of the REST API: a channel's messages (ids only go up), posting, 429s."""

    def __init__(self):
        self.messages, self.next_id = [], 1000
        self.calls, self.posts = [], []
        self.rate_limit = {}                       # method -> how many 429s to return first

    def _add(self, content, author_id, bot=False, attachments=()):
        self.next_id += 1
        m = {"id": str(self.next_id), "content": content, "author": {"id": author_id, "bot": bot},
             "attachments": list(attachments), "channel_id": CHANNEL}
        self.messages.append(m)
        return m

    def user_says(self, text, author=USER, bot=False, attachments=()):
        return self._add(text, author, bot, attachments)

    def request(self, method, url, headers=None, params=None, json=None, data=None, files=None, timeout=None):
        assert headers["Authorization"] == f"Bot {TOKEN}" and timeout == (5, 10)
        assert url.startswith("https://discord.com/api/v10/")
        path = url.removeprefix("https://discord.com/api/v10")
        self.calls.append((method, path, dict(params or {})))
        if self.rate_limit.get(method):
            self.rate_limit[method] -= 1
            return Resp(429, {"retry_after": 0.01})
        if method == "GET" and path == "/users/@me":
            return Resp(200, {"id": "bot"})
        assert path.startswith(f"/channels/{CHANNEL}"), f"left the configured channel: {path}"
        if method == "GET" and path == f"/channels/{CHANNEL}":
            return Resp(200, {"id": CHANNEL})
        if method == "GET":
            after = int(params["after"]) if params.get("after") else None
            pool = [m for m in self.messages if after is None or int(m["id"]) > after]
            pool = pool[: params["limit"]] if after else pool[-params["limit"]:]
            return Resp(200, sorted(pool, key=lambda m: -int(m["id"])))        # Discord answers newest first
        payload = json if json is not None else __import__("json").loads(data["payload_json"])
        m = self._add(payload["content"], "bot", bot=True)
        self.posts.append({"content": payload["content"], "mentions": payload["allowed_mentions"],
                           "file": files and files["files[0]"][0], "id": m["id"]})
        return Resp(200, {"id": m["id"]})

    # test helpers
    def texts(self):
        return [p["content"] for p in self.posts]

    async def wait_for(self, needle, after=0, timeout=40):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            for i, p in enumerate(self.posts[after:], after):
                if needle in p["content"]:
                    return i + 1
            await asyncio.sleep(0.05)
        raise AssertionError(f"never posted {needle!r}; posted: {self.texts()}")


def make(fake=None, **kw):
    fake = fake or FakeDiscord()
    clock = kw.pop("clock", None) or FakeClock()
    return DiscordNotifier(TOKEN, CHANNEL, USER, http=fake, clock=clock, sleep=clock.sleep, **kw), fake, clock


class FakeClock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t

    hook = None

    def sleep(self, s):
        self.t += s
        if self.hook:                              # something happens "while we wait" (e.g. you reply)
            hook, self.hook = self.hook, None
            hook()


@pytest.fixture(autouse=True)
def reset_shared(monkeypatch):
    monkeypatch.setattr(phone_notify, "MIN_POLL_S", 0.05)
    for name in ("DISCORD_BOT_TOKEN", "DISCORD_CHANNEL_ID", "DISCORD_USER_ID"):
        monkeypatch.delenv(name, raising=False)
    phone_notify.use(None)
    yield
    phone_notify.use(None)


# ---- 1. off unless fully configured ----------------------------------------------------------- #

@pytest.mark.parametrize("missing", ["token", "channel", "user"])
def test_disabled_without_all_three_settings_and_every_method_is_a_noop(missing):
    fake = FakeDiscord()
    args = {"token": TOKEN, "channel": CHANNEL, "user": USER}
    args[missing] = ""
    n = DiscordNotifier(args["token"], args["channel"], args["user"], http=fake)
    assert not n.enabled and n.missing()
    assert n.send_message("hi") is None and n.flush() is False and n.poll_reply(0) is None
    assert n.ask_question("Acme", "SWE", "Lever", {"label": "Q", "kind": "text"}) is None and n.check() is False
    assert asyncio.run(n.apoll_reply()) is None and fake.calls == []


def test_unset_environment_means_off(monkeypatch):
    assert phone_notify.notifier().enabled is False
    assert phone_notify.dashboard_status() == {"enabled": False, "connected": False, "label": "Off",
                                               "token": "", "channel": "", "user": ""}


def test_http_errors_and_rate_limits_never_raise_and_the_token_never_leaks():
    class Boom:
        def request(self, *a, **k):
            raise ConnectionError(f"failed for Bot {TOKEN} at https://discord.com/api/v10/x")
    n = DiscordNotifier(TOKEN, CHANNEL, USER, http=Boom())
    assert n.send_message("x") is None and n.poll_reply(0) is None and n.flush() is False
    assert TOKEN not in n.last_error and "••••••••" in n.last_error

    n, fake, clock = make()
    fake.rate_limit = {"POST": 1}
    assert n.send_message("after one 429") is not None and clock.t > 1000.0       # waited retry_after, then sent
    fake.rate_limit = {"GET": 3}
    n._last_poll = -1e9
    assert n.flush() is False and "rate limited" in n.last_error                  # a poll just skips this round
    fake.rate_limit = {"POST": 5}
    assert n.send_message("always limited") is None                               # gives up, no crash


# ---- 2. only you, only this channel ---------------------------------------------------------------- #

def test_only_messages_from_the_one_user_are_ever_accepted():
    n, fake, clock = make()
    n.ask_question("Acme", "SWE", "Lever", {"label": "Badge", "kind": "text"})
    fake.user_says("evil answer", author=OTHER)
    fake.user_says("also me but a bot", author=USER, bot=True)
    fake.user_says("<@bot> from a webhook", author="999")
    clock.sleep(3)
    assert n.poll_reply(0) is None
    fake.user_says("4417")
    clock.sleep(3)
    assert n.poll_reply(0) == "4417" and n.poll_reply(0) is None
    assert all(path.startswith(("/users/@me", f"/channels/{CHANNEL}")) for _, path, _ in fake.calls)


def test_replies_come_oldest_first_by_numeric_id_and_each_is_returned_once():
    n, fake, clock = make()
    n.flush()
    a, b, c = fake.user_says("first"), fake.user_says("second"), fake.user_says("third")
    fake.messages[:] = [c, a, b]                                                    # arrival order must not matter
    clock.sleep(3)
    assert [n.poll_reply(0), n.poll_reply(0), n.poll_reply(0)] == ["first", "second", "third"]
    assert n.poll_reply(0) is None


def test_polling_never_goes_faster_than_every_two_seconds():
    n, fake, clock = make()
    n.flush()
    fake.calls.clear()
    monkey = phone_notify.MIN_POLL_S
    phone_notify.MIN_POLL_S = 2.0
    try:
        gets = lambda: sum(1 for m, p, _ in fake.calls if m == "GET")
        clock.sleep(2.0)
        n.poll_reply(0)
        for _ in range(19):                           # 1.9 s since the last request
            clock.sleep(0.1)
            assert n.poll_reply(0) is None            # called inside the interval: no request at all
        assert gets() == 1
        clock.sleep(0.2)
        n.poll_reply(0)
        assert gets() == 2
    finally:
        phone_notify.MIN_POLL_S = monkey


# ---- 3. stale messages ---------------------------------------------------------------------------------- #

def test_messages_sent_before_a_prompt_can_never_answer_it():
    n, fake, clock = make()
    fake.user_says("an old answer from earlier")
    fake.user_says("another one")
    n.ask_question("Acme", "SWE", "Lever", {"label": "Badge", "kind": "text"})
    clock.sleep(3)
    assert n.poll_reply(0) is None                                                   # flushed, then the prompt
    fake.user_says("4417")
    clock.sleep(3)
    assert n.poll_reply(0) == "4417"
    n.ask_question("Acme", "SWE", "Lever", {"label": "Hat", "kind": "text"})        # a typed-too-early reply
    fake.messages.insert(-1, {"id": str(int(fake.posts[-1]["id"]) - 1), "content": "late for the old question",
                              "author": {"id": USER, "bot": False}, "attachments": []})
    clock.sleep(3)
    assert n.poll_reply(0) is None


# ---- 4. what the prompt looks like, and mapping replies onto options ------------------------------------- #

def test_the_question_prompt_pings_you_and_lists_numbered_choices():
    n, fake, _ = make()
    n.ask_question("Acme *Robotics*", "SWE Intern", "Greenhouse",
                   {"label": "Initech shirt size", "kind": "select", "options": ["S", "M", "L"]}, b"\x89PNG....")
    post = fake.posts[-1]
    text = post["content"]
    assert text.startswith(f"<@{USER}> ") and post["mentions"] == {"users": [USER]} and post["file"] == "screenshot.png"
    for line in ("Acme \\*Robotics\\*", "SWE Intern", "Greenhouse", "Initech shirt size", "`select`", "`1.` S", "`2.` M",
                 "`3.` L", "Reply with your answer, or send `/skip`, `/retry`, `/pause`"):
        assert line in text
    n.send_message("quiet", ping=False)
    assert fake.posts[-1]["mentions"] == {"parse": []} and not fake.posts[-1]["content"].startswith("<@")
    n.send_message("x" * 5000)
    assert len(fake.posts[-1]["content"]) == 2000 and fake.posts[-1]["content"].endswith("…")
    n.ask_question("A", "B", "C", {"label": "Pick", "kind": "select", "options": [f"opt{i}" for i in range(60)]})
    assert "and 30 more" in fake.posts[-1]["content"]


def test_numbers_text_and_substrings_map_to_options_and_bad_replies_do_not():
    options = ["Yes, I am authorized", "No, I am not", "Prefer not to say"]
    assert resolve_option_reply("2", options) == "No, I am not"
    assert resolve_option_reply("2.", options) == "No, I am not" and resolve_option_reply("#3", options) == "Prefer not to say"
    assert resolve_option_reply("yes, i am authorized", options) == "Yes, I am authorized"
    assert resolve_option_reply("yes", options) == "Yes, I am authorized"
    assert resolve_option_reply("prefer", options) == "Prefer not to say"
    assert resolve_option_reply("yess, i am authorised", options) == "Yes, I am authorized"       # close enough
    assert resolve_option_reply("0", options) is None and resolve_option_reply("4", options) is None
    assert resolve_option_reply("maybe", options) is None and resolve_option_reply("", options) is None
    assert resolve_option_reply("no", options + ["Not applicable"]) is None                       # two options start "no"
    assert resolve_option_reply("2025", ["2024", "2025", "2026"]) == "2025"                        # exact text beats the index
    assert resolve_option_reply("  anything  ", []) == "anything"
    assert resolve_multi_reply("1, 3", ["Java", "Go", "Rust"]) == ["Java", "Rust"]
    assert resolve_multi_reply("go; rust", ["Java", "Go", "Rust"]) == ["Go", "Rust"]
    assert resolve_multi_reply("1, 9", ["Java", "Go", "Rust"]) is None


# ---- commands ---------------------------------------------------------------------------------------------- #

def test_commands_are_answered_in_place_except_skip_and_retry(home):
    n, fake, clock = make()
    n.status_provider = lambda: "125/500 applied. Now: Acme"
    n.flush()
    for text in ("/status", "/pause", "!status"):
        fake.user_says(text)
    clock.sleep(3)
    assert n.poll_reply(0) is None
    assert any("125/500 applied" in t for t in fake.texts()) and run_state.read_control()["paused"]
    fake.user_says("/resume")
    fake.user_says("/SKIP")
    fake.user_says("!retry")
    fake.user_says("/definitely-not-a-command-we-know")
    clock.sleep(3)
    assert [n.poll_reply(0) for _ in range(4)] == ["/skip", "/retry", "/definitely-not-a-command-we-know", None]
    assert not run_state.read_control()["paused"]


def test_empty_text_from_a_bot_without_the_message_content_intent_is_explained_once():
    n, fake, clock = make()
    n.flush()
    fake.user_says("")
    clock.sleep(3)
    n.poll_reply(0)
    fake.user_says("")
    clock.sleep(3)
    n.poll_reply(0)
    assert sum("Message Content Intent" in t for t in fake.texts()) == 1


# ---- 5-6. the hand-over in headless Chromium (assist loop) ------------------------------------------------ #

SHIRT = ('<div class="application-question"><div class="application-label"><div class="text">Initech shirt size'
         '<span class="required">✱</span></div></div><select name="shirt" id="shirt"><option value="">Select...</option>'
         '<option value="S">S</option><option value="M">M</option><option value="L">L</option></select></div>')
LEVER_PHONE = (f'<html><body><form id="application-form" onsubmit="return false">'
               f'{lever_question("Full name", "name", star=True)}{lever_question("Initech badge number", "badge", star=True)}'
               f'{SHIRT}<button id="btn-submit" type="button">Submit application</button></form><script>'
               f"window.clicks = 0; document.getElementById('btn-submit').addEventListener('click', () => {{"
               f"window.clicks++; sessionStorage.setItem('clicks', window.clicks); location.href = '{LEVER_URL}/thanks'; }});"
               f'</script></body></html>')


def run_lever(home, monkeypatch, script):
    """Run a Lever application whose unknown questions are answered by `script` on the phone:
    [(text the bot must have posted, what you reply)]. Returns (result, outcome, fake, notes)."""
    fake = FakeDiscord()
    n = DiscordNotifier(TOKEN, CHANNEL, USER, http=fake)
    phone_notify.use(n)
    job, gate, notes = job_for("Lever", LEVER_URL), Gate(), {}
    prepared(monkeypatch, LEVER_URL, gate)

    async def confirm(gate_, context, job_, *, attended, timeout):           # stands in for the Gmail receipt gate
        notes["steps"] = list(gate_.steps)
        notes["clicks"] = await context.pages[-1].evaluate("window.clicks")
        return agent_runner.CONFIRMED, {"confirmed": True, "subject": "Thanks for applying"}

    async def responder():
        seen = 0
        for needle, text in script:
            seen = await fake.wait_for(needle, seen)
            if text.startswith("@pause-check"):
                notes["paused"] = run_state.read_control()["paused"]
                fake.user_says("/resume")
                continue
            fake.user_says(text)

    async def go():
        async with async_playwright() as pw:
            browser, context = await open_context(pw, {LEVER_URL + "/apply": LEVER_PHONE, LEVER_URL + "/thanks": LEVER_THANKS})
            talker = asyncio.create_task(responder())
            try:
                out = await asyncio.wait_for(agent_runner.submit_and_confirm(
                    context, job, engine(), Ledger(), gate, use_llm=False, attended=True, confirm=confirm), 120)
                talker.cancel()
                return out
            finally:
                await browser.close()
    result, outcome, _ = run(go())
    return result, outcome, fake, notes


def test_phone_replies_fill_a_text_field_and_a_select_learn_and_submit(home, portals, monkeypatch):
    result, outcome, fake, notes = run_lever(home, monkeypatch, [
        ("Initech badge number", "4417"), ("Initech shirt size", "XL"), ("Didn't match", "2")])
    assert (result.status, outcome) == (SUBMITTED, agent_runner.CONFIRMED), (result.reason, result.detail)
    texts = fake.texts()
    assert any("Needs your answer" in t and "Initech badge number" in t and "`text`" in t for t in texts)
    assert any("`1.` S" in t and "`2.` M" in t and "`3.` L" in t for t in texts)
    assert "Didn't match options 1-3; reply with a number or /skip" in texts           # the invalid reply is reprompted
    assert "Filled '4417' — continuing" in texts and "Filled 'M' — continuing" in texts
    assert any(p["file"] == "screenshot.png" for p in fake.posts)                      # the prompt carried a screenshot
    assert sorted(e["answer"] for e in load_custom_answers()) == ["4417", "M"]         # learned through the atomic writer
    assert (home / "custom_answers.backup.json").exists()
    assert notes["clicks"] == 1                                                         # one Submit, after both answers
    assert fake.messages[-1]["author"]["bot"]


def test_skip_from_the_phone_ends_the_posting_cleanly_without_submitting(home, portals, monkeypatch):
    result, outcome, fake, notes = run_lever(home, monkeypatch, [("Initech badge number", "/skip")])
    assert (result.status, result.reason, outcome) == (MANUAL_REVIEW, "SKIPPED_FROM_PHONE", "")
    assert "clicks" not in notes and load_custom_answers() == []                        # never reached Submit or the gate


def test_pause_status_and_resume_are_handled_while_a_question_is_open(home, portals, monkeypatch):
    result, outcome, fake, notes = run_lever(home, monkeypatch, [
        ("Initech badge number", "/status"), ("Active:", "/pause"), ("Paused", "@pause-check"), ("Resumed", "/skip")])
    assert notes["paused"] is True and not run_state.read_control()["paused"]
    assert result.reason == "SKIPPED_FROM_PHONE"


def test_an_answer_given_on_the_laptop_is_reported_to_the_phone(home, portals, monkeypatch):
    fake = FakeDiscord()
    phone_notify.use(DiscordNotifier(TOKEN, CHANNEL, USER, http=fake))
    job, gate = job_for("Lever", LEVER_URL), Gate()
    prepared(monkeypatch, LEVER_URL, gate)

    async def confirm(*a, **k):
        return agent_runner.CONFIRMED, {"confirmed": True, "subject": "Thanks"}

    async def at_the_laptop(context):
        page = context.pages[-1]
        await page.wait_for_selector("[data-ia-assist] #badge", timeout=30000)
        await page.fill("#badge", "9001")
        await page.dispatch_event("#badge", "blur")
        await page.wait_for_selector("[data-ia-assist] #shirt", timeout=30000)
        await page.select_option("#shirt", "L")

    async def go():
        async with async_playwright() as pw:
            browser, context = await open_context(pw, {LEVER_URL + "/apply": LEVER_PHONE, LEVER_URL + "/thanks": LEVER_THANKS})
            task = asyncio.create_task(agent_runner.submit_and_confirm(
                context, job, engine(), Ledger(), gate, use_llm=False, attended=True, confirm=confirm))
            await asyncio.sleep(0.5)
            await at_the_laptop(context)
            try:
                return await asyncio.wait_for(task, 120)
            finally:
                await browser.close()
    result, outcome, _ = run(go())
    assert (result.status, outcome) == (SUBMITTED, agent_runner.CONFIRMED)
    assert fake.texts().count("Answered on laptop — continuing") == 2


# ---- CAPTCHA: race the browser against /skip --------------------------------------------------------------- #

def test_captcha_hand_over_posts_a_screenshot_and_skip_from_the_phone_ends_the_wait(home, monkeypatch):
    fake = FakeDiscord()
    phone_notify.use(DiscordNotifier(TOKEN, CHANNEL, USER, http=fake))
    run_state.update({"id": "j", "company": "Acme Robotics", "title": "SWE Intern"}, run_state.SUBMITTING)

    async def go(page):
        task = asyncio.create_task(cs.detect_and_solve_captcha(page, manual_timeout_s=30))
        await fake.wait_for("CAPTCHA needs attention")
        t = time.monotonic()
        fake.user_says("/skip")
        r = await asyncio.wait_for(task, 10)
        return r, time.monotonic() - t
    r, took = with_page(page_of(widget(accept=False, challenge=True)), go)
    assert (r.solved, r.method) == (False, "skipped") and took < 5
    post = next(p for p in fake.posts if "CAPTCHA needs attention" in p["content"])
    assert "Acme Robotics" in post["content"] and "SWE Intern" in post["content"] and post["file"] == "screenshot.png"


def test_solving_the_captcha_on_the_laptop_wins_the_race(home):
    fake = FakeDiscord()
    phone_notify.use(DiscordNotifier(TOKEN, CHANNEL, USER, http=fake))

    async def go(page):
        task = asyncio.create_task(cs.detect_and_solve_captcha(page, manual_timeout_s=30))
        await fake.wait_for("CAPTCHA needs attention")
        await page.evaluate("document.querySelector('[name=g-recaptcha-response]').value = 'tok-" + "x" * 30 + "'")
        return await asyncio.wait_for(task, 10)
    r = with_page(page_of(widget(accept=False, challenge=True)), go)
    assert (r.solved, r.method) == (True, "manual")


# ---- 7. the missing-receipt question ------------------------------------------------------------------------- #

JOB = {"id": "acme-1", "company": "Acme Robotics", "title": "SWE Intern", "ats": "Greenhouse"}


@pytest.mark.parametrize("reply, expected", [("1", run_state.WAIT), ("2", run_state.RETRY), ("3", run_state.SKIP),
                                              ("/skip", run_state.SKIP), ("wait", run_state.WAIT)])
def test_the_receipt_timeout_question_accepts_1_2_3_from_the_phone(home, reply, expected):
    fake = FakeDiscord()
    phone_notify.use(DiscordNotifier(TOKEN, CHANNEL, USER, http=fake))

    async def go():
        task = asyncio.create_task(agent_runner.ask_gate_choice(JOB, poll_s=0.01))
        await fake.wait_for("No confirmation e-mail")
        fake.user_says("7")                                                  # not a choice
        await fake.wait_for("Reply `1`, `2` or `3`.")
        fake.user_says(reply)
        return await asyncio.wait_for(task, 10)
    assert run(go()) == expected
    prompt = next(t for t in fake.texts() if "No confirmation e-mail" in t)
    assert "Wait 60s" in prompt and "Retry in Browser" in prompt and "Skip as Unconfirmed" in prompt


def test_the_phone_answers_in_parallel_with_the_terminal_and_the_dashboard(home):
    fake = FakeDiscord()
    phone_notify.use(DiscordNotifier(TOKEN, CHANNEL, USER, http=fake))

    async def go():
        task = asyncio.create_task(agent_runner.ask_gate_choice(JOB, poll_s=0.01))
        await fake.wait_for("No confirmation e-mail")
        run_state.post_choice(run_state.RETRY, "acme-1")                      # Mission Control's button
        return await asyncio.wait_for(task, 10)
    assert run(go()) == run_state.RETRY


class GateStub:
    def __init__(self, receipts):
        self.receipts, self.timeouts, self.job, self.otp = list(receipts), [], JOB, False

    def step(self, step, message="", **extra):
        run_state.update(JOB, step, message, **extra)

    async def wait(self, context, company, timeout):
        self.timeouts.append(timeout)
        return self.receipts.pop(0)


def test_a_receipt_timeout_asks_the_phone_even_in_queue_mode_but_never_stalls_the_batch(home, monkeypatch):
    fake = FakeDiscord()
    phone_notify.use(DiscordNotifier(TOKEN, CHANNEL, USER, http=fake))
    receipt = {"confirmed": True, "subject": "Thanks", "sender": "x", "received_at": "", "ats": ""}

    async def answered():
        gate = GateStub([erv.NOT_CONFIRMED, receipt])
        task = asyncio.create_task(agent_runner.confirm_receipt(gate, None, JOB, attended=True, on_timeout="queue"))
        await fake.wait_for("No confirmation e-mail")
        fake.user_says("1")                                                  # wait another 60 s
        return await asyncio.wait_for(task, 10), gate.timeouts
    (outcome, got), timeouts = run(answered())
    assert (outcome, got) == (agent_runner.CONFIRMED, receipt) and timeouts == [erv.POLL_TIMEOUT_S, erv.EXTRA_WAIT_S]

    monkeypatch.setattr(config, "phone_ask_wait_s", lambda: 0.3)             # nobody answers: flag it and move on
    gate = GateStub([erv.NOT_CONFIRMED])
    assert run(agent_runner.confirm_receipt(gate, None, JOB, attended=True, on_timeout="queue")) == (
        agent_runner.UNCONFIRMED, {})


def test_without_the_phone_queue_mode_behaves_exactly_as_before(home):
    gate = GateStub([erv.NOT_CONFIRMED])

    async def nobody(job):
        raise AssertionError("queue mode must not ask")
    assert run(agent_runner.confirm_receipt(gate, None, JOB, attended=True, ask=nobody, on_timeout="queue")) == (
        agent_runner.UNCONFIRMED, {})


# ---- the freeze watchdog ---------------------------------------------------------------------------------------- #

class FakePage:
    def __init__(self, sig=("https://x.test", "t", 3, 0, 100)):
        self.sig = sig

    async def evaluate(self, js):
        return list(self.sig)

    async def screenshot(self, **kw):
        return b"PNG"


class FakeContext:
    def __init__(self):
        self.pages = [FakePage()]


def watchdog(fake, state, **kw):
    n = DiscordNotifier(TOKEN, CHANNEL, USER, http=fake)
    return FreezeWatchdog(n, stall_s=0.3, wait_s=kw.pop("wait_s", 5), tick_s=0.05, read_state=lambda: state, **kw), n


def guard_with(dog, fake, reply, state=None):
    async def forever():
        await asyncio.sleep(3600)

    async def go():
        work = asyncio.ensure_future(forever())
        task = asyncio.create_task(dog.guard(work, FakeContext(), JOB))
        if reply is not None:
            await fake.wait_for("appears stuck")
            fake.user_says(reply)
        verdict = await asyncio.wait_for(task, 10)
        return verdict, work.cancelled()
    return run(go())


def test_no_progress_pings_the_phone_with_a_screenshot_and_retry_or_skip_ends_it():
    fake = FakeDiscord()
    dog, _ = watchdog(fake, {"step": "", "message": "Filling the form"})
    assert guard_with(dog, fake, "/retry") == ("retry", True)
    post = next(p for p in fake.posts if "appears stuck" in p["content"])
    assert "Acme Robotics" in post["content"] and "Reply `/retry` or `/skip`" in post["content"] and post["file"]
    fake = FakeDiscord()
    dog, _ = watchdog(fake, {"step": "", "message": "Filling the form"})
    assert guard_with(dog, fake, "/skip") == ("skip", True)


def test_a_retry_after_submit_would_apply_twice_so_it_becomes_a_skip():
    fake = FakeDiscord()
    dog, _ = watchdog(fake, {"step": "SUBMITTING_FORM", "message": "Submitting the form"})
    assert guard_with(dog, fake, "/retry") == ("skip", True)
    assert any("could apply twice" in t for t in fake.texts())


def test_no_reply_times_out_cleanly():
    fake = FakeDiscord()
    dog, _ = watchdog(fake, {"step": "", "message": "x"}, wait_s=0.4)
    assert guard_with(dog, fake, None) == ("frozen", True)


@pytest.mark.parametrize("state", [{"step": "WAITING_FOR_ANSWER", "message": "Waiting for your answer: x"},
                                   {"step": "AWAITING_EMAIL_CONFIRMATION", "message": "polling"},
                                   {"step": "", "message": "Waiting for you to solve the CAPTCHA"},
                                   {"step": "", "message": "x", "timed_out": True}])
def test_waiting_on_a_person_or_the_mailbox_is_never_a_freeze(state):
    fake = FakeDiscord()
    dog, _ = watchdog(fake, state)

    async def go():
        work = asyncio.ensure_future(asyncio.sleep(1.0))
        return await dog.guard(work, FakeContext(), JOB)
    assert run(go()) == "done" and fake.posts == []


def test_progress_resets_the_clock_and_a_disabled_notifier_just_awaits_the_work():
    fake = FakeDiscord()
    states = {"message": 0}
    dog, _ = watchdog(fake, states)

    async def go():
        async def ticking():
            for i in range(14):
                states["message"] = i                                        # the runner keeps moving
                await asyncio.sleep(0.1)
        return await dog.guard(asyncio.ensure_future(ticking()), FakeContext(), JOB)
    assert run(go()) == "done" and fake.posts == []

    off = FreezeWatchdog(DiscordNotifier("", "", "", http=fake))

    async def disabled():
        return await off.guard(asyncio.ensure_future(asyncio.sleep(0.05)), FakeContext(), JOB)
    assert run(disabled()) == "done"


def test_run_guarded_skip_is_a_manual_review_and_retry_runs_the_posting_once_more(home, monkeypatch):
    calls = []

    async def fake_submit(context, job, engine_, ledger, gate, *, use_llm, attended):
        calls.append(1)
        await asyncio.sleep(3600)
    monkeypatch.setattr(agent_runner, "submit_and_confirm", fake_submit)
    verdicts = iter(["retry", "skip"])

    class Dog:
        stall_s, wait_s = 120, 300

        async def guard(self, work, context, job):
            await asyncio.sleep(0.01)                                       # let the posting start, then stop it
            work.cancel()
            try:
                await work
            except BaseException:                                          # noqa: BLE001
                pass
            return next(verdicts)
    result, outcome, receipt = run(agent_runner.run_guarded(None, JOB, None, None, None, use_llm=False, attended=True,
                                                            dog=Dog()))
    assert (result.status, result.reason, outcome, receipt) == (MANUAL_REVIEW, "SKIPPED_FROM_PHONE", "", {})
    assert len(calls) == 2


# ---- Mission Control and the setup helper ---------------------------------------------------------------------------- #

def test_mission_control_shows_the_phone_status_and_never_the_secrets(home, monkeypatch):
    for name, value in (("DISCORD_BOT_TOKEN", TOKEN), ("DISCORD_CHANNEL_ID", CHANNEL), ("DISCORD_USER_ID", USER)):
        monkeypatch.setenv(name, value)
    fake = FakeDiscord()
    n = DiscordNotifier(http=fake)
    phone_notify.use(n)
    monkeypatch.setattr(phone_notify, "_status_cache", (0.0, False))
    state = app_server.build_state()
    assert state["phone"] == {"enabled": True, "connected": True, "label": "Connected",
                              "token": "••••••••", "channel": "••••••••", "user": "••••••••"}
    blob = json.dumps(state)
    assert TOKEN not in blob and CHANNEL not in blob and USER not in blob
    phone_notify.use(DiscordNotifier("", "", ""))
    assert app_server.build_state()["phone"]["label"] == "Off"


def test_test_phone_echoes_your_reply_and_explains_what_is_missing(capsys):
    n, fake, clock = make()
    clock.hook = lambda: fake.user_says("hello from my phone")            # you reply after the test message
    lines = []
    assert phone_notify.run_self_test(n, wait_s=30, out=lines.append, clock=clock) == 0
    assert any("Got: hello from my phone" in t for t in fake.texts()) and any("Phone assist works" in l for l in lines)

    n, fake, clock = make()
    lines = []
    assert phone_notify.run_self_test(n, wait_s=4, out=lines.append, clock=clock) == 1      # nobody answers
    lines = []
    assert phone_notify.run_self_test(DiscordNotifier("tok", "", "", http=fake), out=lines.append) == 2
    assert "DISCORD_CHANNEL_ID" in " ".join(lines) and "tok" not in " ".join(lines).replace("token", "")
