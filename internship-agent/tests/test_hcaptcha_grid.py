"""Solving hCaptcha 3x3 grids from the phone (Discord), the shared CAPTCHA ping, and the browser-profile guard.
A mock of hCaptcha's challenge markup (.prompt-text, .task-grid .task-image, .button-submit, .refresh.button)
in an iframe whose URL looks like the real one, a fake Discord REST API, and headless Chromium. Nothing is
submitted anywhere."""
import asyncio
import json
import os
import subprocess
import sys
import time

import pytest
from playwright.async_api import async_playwright

import agent_runner
import phone_notify
import run_state
from ats import captcha_solver as cs
from ats import hcaptcha_grid as grid
from ats.base import MANUAL_REVIEW, SUBMITTED
from ats.lever import LeverAdapter
from tests.test_assist import home, run                                    # noqa: F401 - fixture
from tests.test_phone_notify import CHANNEL, FakeDiscord, TOKEN, USER      # noqa: F401

PARENT_URL = "https://jobs.lever.co/zoox/0b2f7f0e-1111-2222-3333-444455556666/apply"
THANKS_URL = PARENT_URL.removesuffix("/apply") + "/thanks"
CHALLENGE_URL = "https://newassets.hcaptcha.com/captcha/v1/abc123/static/hcaptcha.html"
IFRAME_SRC = CHALLENGE_URL + "#frame=challenge&id=1"
JOB = {"id": "zoox-1", "company": "Zoox", "title": "Software Engineer Intern", "ats": "Lever", "url": PARENT_URL}

PARENT_JS = """
window.__events = [];
addEventListener('message', e => {
  if (!e.data || !e.data.ia) return;
  if (e.data.event) window.__events.push(e.data.event);
  if (e.data.done) {
    document.querySelector('[name="h-captcha-response"]').value = 'tok-' + 'x'.repeat(30);
    const f = document.getElementById('ch'); if (f) f.remove();
    %s
  }
});
"""


def parent_html(*, show_now=True, on_done=""):
    iframe = f'<iframe id="ch" src="{IFRAME_SRC}" width="400" height="560" style="border:0"></iframe>'
    return f"""<html><head><title>Zoox - Software Engineer Intern</title></head><body><h1>Apply</h1>
<textarea name="h-captcha-response" style="display:none"></textarea>
<div id="h-captcha" class="h-captcha">{iframe if show_now else ''}</div>
<button id="btn-submit" type="button">Submit application</button>
<script>window.hcaptcha = {{}};
{PARENT_JS % on_done}
document.getElementById('btn-submit').addEventListener('click', () => {{
  sessionStorage.setItem('clicks', (+sessionStorage.getItem('clicks') || 0) + 1);
  if (!document.getElementById('ch')) document.getElementById('h-captcha').insertAdjacentHTML('beforeend', '{iframe}');
}});
</script></body></html>"""


def challenge_html(prompts, *, reject_first=False, kind="grid"):
    if kind == "canvas":                                   # drag / click-on-a-point style: not a 3x3 grid
        return ("<html><body><div class='challenge-container'><div class='prompt-text'><span>Click the center of the "
                "cat</span></div><canvas width=300 height=300 style='border:1px solid #888'></canvas>"
                "<div class='button-submit button'><div class='text'>Verify</div></div></div></body></html>")
    # DOM order is reversed and CSS `order` puts tile n in visual position n: numbering must follow the screen.
    tiles = "".join(f'<div class="task-image" data-idx="{i}" style="order:{i};width:100px;height:100px;'
                    f'position:relative"><div class="image" style="width:100%;height:100%;'
                    f'background-color:hsl({i * 40},70%,50%)"></div></div>' for i in range(9, 0, -1))
    return f"""<html><body style="margin:0"><div class="challenge-container" style="width:400px">
<div class="prompt-text" style="background:#00838f;color:#fff;padding:8px"><span></span></div>
<div class="task-grid" style="display:grid;grid-template-columns:repeat(3,100px);gap:6px;padding:10px">{tiles}</div>
<div class="refresh button" role="button" style="width:30px;height:30px;background:#ccc"></div>
<div class="button-submit button" style="padding:8px"><div class="text">Skip</div></div></div>
<script>
const PROMPTS = {json.dumps(prompts)};
let round = 0, seed = 0, rejected = {json.dumps(reject_first)};
const selected = new Set(), tiles = [...document.querySelectorAll('.task-image')];
const label = document.querySelector('.button-submit .text');
const say = (event) => parent.postMessage({{ia: 1, event}}, '*');
function button() {{ label.textContent = selected.size ? (round < PROMPTS.length - 1 ? 'Next' : 'Verify') : 'Skip'; }}
function render() {{
  document.querySelector('.prompt-text span').textContent = PROMPTS[round];
  tiles.forEach(t => {{ t.querySelector('.image').style.backgroundImage = `url(r${{round}}s${{seed}}t${{t.dataset.idx}}.png)`;
                       t.style.outline = ''; }});
  selected.clear(); button();
}}
tiles.forEach(t => t.addEventListener('click', () => {{
  const n = +t.dataset.idx; selected.has(n) ? selected.delete(n) : selected.add(n);
  t.style.outline = selected.has(n) ? '4px solid #00e' : ''; button();
}}));
document.querySelector('.refresh').addEventListener('click', () => {{ seed++; say({{refresh: true, round}}); render(); }});
document.querySelector('.button-submit').addEventListener('click', () => {{
  say({{round, tiles: [...selected].sort((a, b) => a - b), button: label.textContent}});
  if (rejected) {{ rejected = false; selected.clear(); tiles.forEach(t => t.style.outline = ''); button(); return; }}
  if (round < PROMPTS.length - 1) {{ round++; render(); }} else parent.postMessage({{ia: 1, done: 1}}, '*');
}});
render();
</script></body></html>"""


class Site:
    def __init__(self, prompts=("Click on every animal that appears calm and resting",), *, parent=None, **kw):
        self.parent = parent or parent_html()
        self.challenge = challenge_html(list(prompts), **kw)

    async def handle(self, route):
        url = route.request.url.split("#")[0]
        if url == PARENT_URL:
            await route.fulfill(status=200, content_type="text/html; charset=utf-8", body=self.parent)
        elif url == CHALLENGE_URL:
            await route.fulfill(status=200, content_type="text/html; charset=utf-8", body=self.challenge)
        elif url == THANKS_URL:
            await route.fulfill(status=200, content_type="text/html", body="<html><body>submitted</body></html>")
        else:
            await route.abort()


@pytest.fixture(autouse=True)
def quick(monkeypatch):
    monkeypatch.setattr(phone_notify, "MIN_POLL_S", 0.05)
    monkeypatch.setattr(grid, "CHANGE_WAIT_S", 1.5)
    monkeypatch.setattr(grid, "REPLY_POLL_S", 0.1)
    phone_notify.use(None)
    yield
    phone_notify.use(None)


def fake_phone():
    fake = FakeDiscord()
    phone_notify.use(phone_notify.DiscordNotifier(TOKEN, CHANNEL, USER, http=fake))
    return fake


async def open_site(pw, site, *, tabs_before=0, tabs_after=0, shown=True, scale=1):
    browser = await pw.chromium.launch()
    context = await browser.new_context(device_scale_factor=scale)
    await context.route("**/*", site.handle)
    for _ in range(tabs_before):
        await context.new_page()
    page = await context.new_page()
    for _ in range(tabs_after):
        await context.new_page()
    await page.goto(PARENT_URL)
    if shown:
        for _ in range(100):
            if await grid.challenge_frame(page) is not None and await grid.read_challenge(page):
                break
            await asyncio.sleep(0.1)
    return browser, context, page


async def script(fake, steps, notes=None):
    """steps: [(needle the bot must have posted, what you reply)]."""
    seen = 0
    for needle, text in steps:
        seen = await fake.wait_for(needle, seen)
        fake.user_says(text)


def relay(site, steps, *, home=None, job=True, **kw):
    fake = fake_phone()
    if job:
        run_state.update(JOB, run_state.SUBMITTING, "x")

    async def go():
        async with async_playwright() as pw:
            browser, context, page = await open_site(pw, site, tabs_before=kw.pop("tabs_before", 0),
                                                     tabs_after=kw.pop("tabs_after", 0))
            talker = asyncio.create_task(script(fake, steps))
            try:
                out = await asyncio.wait_for(grid.relay_grid(page, phone_notify.notifier(), **kw), 90)
                events = await page.evaluate("window.__events") if not page.is_closed() else None
                return out, events, page
            finally:
                talker.cancel()
                await browser.close()
    out, events, _ = run(go())
    return out, events, fake


# ---- the reply parser ------------------------------------------------------------------------------- #

@pytest.mark.parametrize("text, expected", [
    ("7 8", ("tiles", [7, 8])), ("1, 4, 7", ("tiles", [1, 4, 7])), ("78", ("tiles", [7, 8])),
    ("7 7 8", ("tiles", [7, 8])), ("  3 ", ("tiles", [3])), ("1 and 5", ("tiles", [1, 5])),
    ("0", ("skip",)), ("none", ("skip",)), ("None", ("skip",)),
    ("reload", ("reload",)), ("Refresh", ("reload",)), ("/skip", ("abandon",)), ("!skip", ("abandon",)),
    ("/retry", ("retry",))])
def test_replies_map_to_actions(text, expected):
    assert grid.parse_reply(text) == expected


@pytest.mark.parametrize("text", ["10", "1 0", "0 3", "banana", "", "7 8 apples"])
def test_unusable_replies_are_rejected_not_guessed(text):
    assert grid.parse_reply(text)[0] == "invalid"


# ---- numbering: read-only, drawn on the image bytes, nothing written into hCaptcha's page ---------------- #

OBSERVE_JS = """() => { window.__mut = []; new MutationObserver(list => list.forEach(m => window.__mut.push(
  {type: m.type, attr: m.attributeName, added: m.addedNodes.length, target: m.target.className || m.target.nodeName})))
  .observe(document, {subtree: true, childList: true, attributes: true, characterData: true}); }"""


def on_challenge(fn, *, scale=1):
    async def go():
        async with async_playwright() as pw:
            browser, context, page = await open_site(pw, Site(), scale=scale)
            try:
                return await fn(page, await grid.challenge_frame(page))
            finally:
                await browser.close()
    return run(go())


def test_the_numbered_picture_is_made_without_touching_the_challenge_dom():
    async def go(page, frame):
        await frame.evaluate(OBSERVE_JS)
        shot, numbered = await grid.numbered_screenshot(page, frame)
        await asyncio.sleep(0.2)                                         # let any mutation records arrive
        layout = await frame.evaluate(grid.TILES_JS)
        idx = await frame.evaluate("[...document.querySelectorAll('.task-grid .task-image')].map(t => +t.dataset.idx)")
        marked = await frame.evaluate("document.querySelectorAll('[data-ia-tile], [data-ia-badge]').length")
        return shot, numbered, await frame.evaluate("window.__mut"), layout, idx, marked
    shot, numbered, mutations, layout, idx, marked = on_challenge(go)
    assert numbered and shot[:8] == b"\x89PNG\r\n\x1a\n"
    assert mutations == [] and marked == 0                              # not one change in hCaptcha's page
    assert [idx[t["dom"]] for t in layout["tiles"]] == list(range(1, 10))  # reading order = position on screen


@pytest.mark.parametrize("scale", [1, 2])                               # 2: Windows display scaling
def test_each_number_is_drawn_on_its_own_tile_and_nothing_else_changes(scale):
    from PIL import Image
    import io

    async def go(page, frame):
        layout = await frame.evaluate(grid.TILES_JS)
        raw = await frame.locator(grid.SEL["grid"]).first.screenshot()
        return layout, raw
    layout, raw = on_challenge(go, scale=scale)
    numbered, ok = grid.draw_numbers(raw, layout)
    a, b = Image.open(io.BytesIO(raw)).convert("RGB"), Image.open(io.BytesIO(numbered)).convert("RGB")
    assert ok and a.size == b.size and a.width == round(layout["grid"]["w"] * scale)
    g = layout["grid"]
    for t in layout["tiles"]:
        left, top = (t["x"] - g["x"]) * scale, (t["y"] - g["y"]) * scale
        r = max(12, round(min(t["w"], t["h"]) * scale * 0.14))
        badge = (int(left + r + 5 * scale), int(top + r + 5 * scale - r * 0.7))     # inside the circle, above the digit
        middle = (int(left + t["w"] * scale * 0.7), int(top + t["h"] * scale * 0.7))
        assert b.getpixel(badge) != a.getpixel(badge) and sum(b.getpixel(badge)) < 120   # dark badge drawn there
        assert b.getpixel(middle) == a.getpixel(middle)                  # the picture itself is untouched


def test_without_pillow_the_plain_screenshot_goes_out_and_the_phone_is_told(home, monkeypatch):
    monkeypatch.setitem(sys.modules, "PIL", None)                        # as if Pillow were not installed
    assert grid.draw_numbers(b"png", {"grid": {"w": 1}, "tiles": [{}]}) == (b"png", False)
    out, events, fake = relay(Site(), [("round 1", "5")], reply_wait_s=30)
    assert out == "verified" and fake.posts[0]["file"] == "screenshot.png"
    assert "could not be drawn" in fake.posts[0]["content"] and "left to right, top to bottom" in fake.posts[0]["content"]


def test_clicks_are_plain_clicks_that_never_mark_the_page():
    async def go(page, frame):
        await frame.evaluate(OBSERVE_JS)
        await grid.click_tiles(frame, [7, 8])
        await asyncio.sleep(0.2)
        muts = await frame.evaluate("window.__mut")
        picked = await frame.evaluate("""[...document.querySelectorAll('.task-image')]
            .filter(t => t.style.outline).map(t => +t.dataset.idx).sort()""")
        return muts, picked
    mutations, picked = on_challenge(go)
    assert picked == [7, 8]                                              # the tiles the person named
    # what changes is the widget's own reaction to a click (tile outline, Skip -> Next label); nothing of ours
    assert all((m["type"] == "attributes" and m["attr"] == "style" and m["target"] == "task-image")
               or (m["type"] == "childList" and m["target"] == "text") for m in mutations), mutations
    assert not any((m["attr"] or "").startswith("data-ia") for m in mutations)


# ---- the frame: only the active challenge, never the checkbox, never a look-alike ------------------------------ #

FRAMES_PAGE = """<html><body>
<iframe id="checkbox" src="https://newassets.hcaptcha.com/captcha/v1/abc123/static/hcaptcha.html#frame=checkbox&id=1"
        width="300" height="80"></iframe>
<iframe id="hidden" src="https://newassets.hcaptcha.com/captcha/v1/abc123/static/hcaptcha.html#frame=challenge&id=2"
        width="400" height="560" style="visibility:hidden"></iframe>
<iframe id="fake" src="https://evil.example/hcaptcha.com/hcaptcha.html#frame=challenge&id=3" width="400" height="560"></iframe>
<iframe id="active" src="https://newassets.hcaptcha.com/captcha/v1/abc123/static/hcaptcha.html#frame=challenge&id=4"
        width="400" height="560"></iframe>
</body></html>"""


def frames_site(page_html):
    site = Site(parent=page_html)
    real = site.handle

    async def handle(route):
        if route.request.url.startswith("https://evil.example/"):
            await route.fulfill(status=200, content_type="text/html", body=site.challenge)
        else:
            await real(route)
    site.handle = handle
    return site


def test_only_the_visible_challenge_frame_is_used_across_origins():
    async def go():
        async with async_playwright() as pw:
            browser, context, page = await open_site(pw, frames_site(FRAMES_PAGE), shown=False)
            try:
                for _ in range(50):
                    frame = await grid.challenge_frame(page)
                    if frame:
                        break
                    await asyncio.sleep(0.1)
                prompt = await frame.evaluate("document.querySelector('.prompt-text').innerText")
                cross = await page.evaluate("document.getElementById('active').contentDocument === null")
                await page.evaluate("document.getElementById('active').remove()")
                left = await grid.challenge_frame(page)
                return frame.url, prompt, cross, left
            finally:
                await browser.close()
    url, prompt, cross, left = run(go())
    assert url.endswith("frame=challenge&id=4")                          # not the checkbox, the hidden one, or the fake
    assert prompt and cross                                              # cross-origin to the page, still readable
    assert left is None                                                  # hidden challenge + checkbox = nothing showing


@pytest.mark.parametrize("url, ok", [
    ("https://newassets.hcaptcha.com/captcha/v1/a/static/hcaptcha.html#frame=challenge&id=1", True),
    ("https://hcaptcha.com/x#frame=challenge", True),
    ("https://newassets.hcaptcha.com/captcha/v1/a/static/hcaptcha.html#frame=checkbox&id=1", False),
    ("https://evil.example/hcaptcha.com#frame=challenge", False),
    ("https://hcaptcha.com.evil.example/#frame=challenge", False),
    ("https://newassets.hcaptcha.com/captcha/v1/a/static/hcaptcha.html?frame=challenge", False), ("", False)])
def test_challenge_urls_are_matched_strictly(url, ok):
    assert grid.is_challenge_url(url) is ok


# ---- the relay: single round, multi-round, skip, reload, abandon ---------------------------------------------- #

def test_single_round_reply_clicks_those_tiles_then_verify_and_the_phone_got_prompt_and_numbered_image(home):
    out, events, fake = relay(Site(), [("round 1", "7 8")], reply_wait_s=30)
    assert out == "verified"
    assert events == [{"round": 0, "tiles": [7, 8], "button": "Verify"}]
    first = fake.posts[0]
    assert "Click on every animal that appears calm and resting" in first["content"] and first["file"] == "screenshot.png"
    assert "Zoox" in first["content"] and "Reply with the tile numbers" in first["content"]
    assert any("Clicked tiles 7, 8 and “Verify”" in t for t in fake.texts())


def test_two_rounds_go_next_then_verify_and_each_round_is_posted(home):
    site = Site(["Click on every animal that appears calm and resting", "Select all the vehicles that are moving"])
    out, events, fake = relay(site, [("round 1", "1, 4, 7"), ("round 2", "2 3")], reply_wait_s=30)
    assert out == "verified"
    assert events == [{"round": 0, "tiles": [1, 4, 7], "button": "Next"}, {"round": 1, "tiles": [2, 3], "button": "Verify"}]
    posts = [t for t in fake.texts() if "hCaptcha grid" in t]
    assert len(posts) == 2 and "moving" in posts[1] and "round 2" in posts[1]
    assert sum(1 for p in fake.posts if p["file"]) == 2                  # a fresh numbered picture each round


@pytest.mark.parametrize("answer", ["0", "none"])
def test_none_clicks_skip_and_the_next_round_is_posted(home, answer):
    site = Site(["Pick the red balloon", "Pick the calm animals"])
    out, events, fake = relay(site, [("round 1", answer), ("round 2", "5")], reply_wait_s=30)
    assert out == "verified"
    assert events[0] == {"round": 0, "tiles": [], "button": "Skip"} and events[1]["tiles"] == [5]


def test_slash_skip_abandons_the_posting_without_clicking_anything(home):
    out, events, fake = relay(Site(), [("round 1", "/skip")], reply_wait_s=30)
    assert (out, events) == ("skipped", [])


def test_reload_clicks_the_refresh_icon_and_posts_the_new_grid(home):
    out, events, fake = relay(Site(), [("round 1", "reload"), ("round 2", "7")], reply_wait_s=30)
    assert out == "verified"
    assert events[0] == {"refresh": True, "round": 0} and events[1]["tiles"] == [7]
    assert len([t for t in fake.texts() if "hCaptcha grid" in t]) == 2


def test_unusable_replies_are_answered_and_the_wait_continues(home):
    out, events, fake = relay(Site(), [("round 1", "10"), ("cannot be mixed", "banana"), ("I need tile numbers", "9")],
                              reply_wait_s=30)
    assert out == "verified" and events == [{"round": 0, "tiles": [9], "button": "Verify"}]


def test_solving_it_on_the_laptop_wins_and_the_phone_is_told(home):
    fake = fake_phone()
    run_state.update(JOB, run_state.SUBMITTING, "x")

    async def go():
        async with async_playwright() as pw:
            browser, context, page = await open_site(pw, Site())
            task = asyncio.create_task(grid.relay_grid(page, phone_notify.notifier(), reply_wait_s=30))
            await fake.wait_for("round 1")
            await page.evaluate("window.postMessage({ia: 1, done: 1}, '*')")         # the laptop solved it
            try:
                return await asyncio.wait_for(task, 20)
            finally:
                await browser.close()
    assert run(go()) == "verified" and "Solved on the laptop — continuing" in fake.texts()


def test_a_rejected_answer_shows_the_same_grid_and_the_phone_is_asked_again(home):
    out, events, fake = relay(Site(reject_first=True), [("round 1", "7"), ("same challenge again", "8")], reply_wait_s=30)
    assert out == "verified"
    assert [e["tiles"] for e in events] == [[7], [8]]


def test_no_reply_in_time_times_out_and_says_so(home):
    out, events, fake = relay(Site(), [], reply_wait_s=1.0)
    assert (out, events) == ("timeout", [])
    assert any("no answer to the grid in time" in t for t in fake.texts())


def test_a_grid_that_keeps_coming_stops_after_the_round_cap(home):
    site = Site(["a", "b", "c", "d"])
    out, events, fake = relay(site, [("round 1", "1"), ("round 2", "2")], reply_wait_s=30, max_rounds=2)
    assert out == "timeout" and len(events) == 2
    assert any("after 2 rounds" in t for t in fake.texts())


# ---- not a 3x3 grid: never attempted, the phone gets the full context ------------------------------------------- #

def test_a_non_grid_challenge_is_not_attempted_and_the_ping_says_what_where_and_how_long(home):
    out, events, fake = relay(Site(kind="canvas"), [], reply_wait_s=150, tabs_before=1, tabs_after=1)
    assert (out, events) == ("unsupported", [])
    text = next(t for t in fake.texts() if "non-grid hCaptcha" in t)
    assert "Zoox" in text and "Software Engineer Intern" in text and "(Lever)" in text
    assert PARENT_URL in text                                                    # the job URL
    assert "click or drag on the image" in text and "Time left:** 2m 30s" in text
    assert "tab 2 of 3" in text and "Zoox - Software Engineer Intern" in text and "jobs.lever.co" in text
    assert fake.posts[-1]["file"] == "screenshot.png" and "`/skip`" in text


def test_with_no_hcaptcha_challenge_showing_the_general_ping_goes_out(home):
    fake = fake_phone()
    run_state.update(JOB, run_state.SUBMITTING, "x")

    async def go():
        async with async_playwright() as pw:
            site = Site(parent="<html><head><title>Plain page</title></head><body>no captcha frame</body></html>")
            browser, context, page = await open_site(pw, site, shown=False)
            try:
                return await grid.handle_challenge(page, phone_notify.notifier(), reply_wait_s=90,
                                                   fallback_kind="reCAPTCHA puzzle")
            finally:
                await browser.close()
    assert run(go()) == "none"
    text = next(t for t in fake.texts() if "reCAPTCHA puzzle" in t)
    assert "Time left:** 1m 30s" in text and "Zoox" in text


def test_remaining_time_formatting():
    assert grid.fmt_remaining(150) == "2m 30s" and grid.fmt_remaining(45) == "45s" and grid.fmt_remaining(-3) == "0s"
    assert grid.fmt_remaining(None) == "a while"


# ---- end to end through the Lever submit loop and the solver's manual stage ----------------------------------------- #

def lever_submit(site, steps, *, human_wait=30, keep=False):
    fake = fake_phone()
    run_state.update(JOB, run_state.SUBMITTING, "x")
    adapter = LeverAdapter()
    adapter.human_wait_s = human_wait

    async def go():
        async with async_playwright() as pw:
            browser = await pw.chromium.launch()
            context = await browser.new_context()
            await context.route("**/*", site.handle)
            page = await context.new_page()
            await page.goto(PARENT_URL)
            talker = asyncio.create_task(script(fake, steps))
            try:
                return await asyncio.wait_for(adapter.submit(page), 90), await page.evaluate("sessionStorage.getItem('clicks')")
            finally:
                talker.cancel()
                await browser.close()
    return run(go()), fake, adapter


def captcha_site(prompts=("Pick the calm animals", "Pick the buses"), **kw):
    return Site(prompts, parent=parent_html(show_now=False, on_done=f"location.href = '{THANKS_URL}';"), **kw)


def test_lever_submit_hands_each_grid_round_to_the_phone_and_finishes_on_thanks(home):
    (out, clicks), fake, adapter = lever_submit(captcha_site(), [("round 1", "2 4"), ("round 2", "9")])
    assert out[0] == SUBMITTED and out[1] == "thanks page" and clicks == "1"             # Submit pressed exactly once
    assert len([t for t in fake.texts() if "hCaptcha grid" in t]) == 2


def test_lever_submit_slash_skip_ends_the_wait_and_marks_it_skipped(home):
    (out, clicks), fake, adapter = lever_submit(captcha_site(), [("round 1", "/skip")])
    assert out[0] == MANUAL_REVIEW and adapter.__dict__["_phone_skip"] is True and clicks == "1"


def test_lever_submit_with_a_non_grid_challenge_pings_and_keeps_waiting_for_you(home):
    site = Site(parent=parent_html(show_now=False, on_done=f"location.href = '{THANKS_URL}';"), kind="canvas")

    async def laptop(page):
        await asyncio.sleep(0.1)

    fake = fake_phone()
    run_state.update(JOB, run_state.SUBMITTING, "x")
    adapter = LeverAdapter()
    adapter.human_wait_s = 30

    async def go():
        async with async_playwright() as pw:
            browser = await pw.chromium.launch()
            context = await browser.new_context()
            await context.route("**/*", site.handle)
            page = await context.new_page()
            await page.goto(PARENT_URL)
            task = asyncio.create_task(adapter.submit(page))
            await fake.wait_for("non-grid hCaptcha")
            await page.evaluate("window.postMessage({ia: 1, done: 1}, '*')")              # you solve it on the laptop
            try:
                return await asyncio.wait_for(task, 60)
            finally:
                await browser.close()
    out = run(go())
    assert out[0] == SUBMITTED and any("non-grid hCaptcha" in t for t in fake.texts())


def test_solver_manual_stage_relays_a_grid_and_reports_it_solved(home):
    fake = fake_phone()
    run_state.update(JOB, run_state.SUBMITTING, "x")

    async def go():
        async with async_playwright() as pw:
            browser, context, page = await open_site(pw, Site())
            talker = asyncio.create_task(script(fake, [("round 1", "3 6")]))
            try:
                return await asyncio.wait_for(cs.detect_and_solve_captcha(page, manual_timeout_s=30), 60)
            finally:
                talker.cancel()
                await browser.close()
    r = run(go())
    assert r.solved and r.method == "manual"


def test_solver_manual_stage_slash_skip_is_reported_as_skipped(home):
    fake = fake_phone()
    run_state.update(JOB, run_state.SUBMITTING, "x")

    async def go():
        async with async_playwright() as pw:
            browser, context, page = await open_site(pw, Site())
            talker = asyncio.create_task(script(fake, [("round 1", "/skip")]))
            try:
                return await asyncio.wait_for(cs.detect_and_solve_captcha(page, manual_timeout_s=30), 60)
            finally:
                talker.cancel()
                await browser.close()
    r = run(go())
    assert (r.solved, r.method) == (False, "skipped")


def test_the_script_failed_ping_carries_the_same_context(home, monkeypatch):
    from ats import lever
    monkeypatch.setattr(lever, "HCAPTCHA_LOAD_RETRY_S", 0.5)
    monkeypatch.setattr(lever, "HCAPTCHA_MIN_WAIT_S", 90)
    fake = fake_phone()
    run_state.update(JOB, run_state.SUBMITTING, "x")
    adapter = LeverAdapter()
    adapter.human_wait_s = 5
    page_html = parent_html(show_now=False).replace("window.hcaptcha = {};", "")      # the script never defines hcaptcha

    async def go():
        async with async_playwright() as pw:
            browser = await pw.chromium.launch()
            context = await browser.new_context()
            await context.route("**/*", Site(parent=page_html).handle)
            page = await context.new_page()
            await page.goto(PARENT_URL)
            task = asyncio.create_task(adapter.submit(page))
            await fake.wait_for("hCaptcha did not load")
            fake.user_says("/skip")
            try:
                return await asyncio.wait_for(task, 30)
            finally:
                await browser.close()
    assert run(go())[:2] == (MANUAL_REVIEW, "SKIPPED_FROM_PHONE")
    text = next(t for t in fake.texts() if "hCaptcha did not load" in t)
    assert "Zoox" in text and PARENT_URL in text and "script failed to load" in text
    assert "Time left:** 1m 30s" in text and "tab 1 of 1" in text and "Allow js.hcaptcha.com" in text


# ---- the browser profile ---------------------------------------------------------------------------------------------- #

def test_the_profile_lock_lets_one_runner_in_and_names_the_other(tmp_path):
    profile = tmp_path / "chrome_profile"
    other = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    try:
        lock_path = tmp_path / "chrome_profile.runner.lock"
        lock_path.write_text(f"{other.pid} 2026-11-22 10:00:00")
        with pytest.raises(agent_runner.ProfileBusy) as err:
            agent_runner.ProfileLock(profile).acquire()
        assert str(other.pid) in str(err.value) and "chrome_profile" in str(err.value) and "Stop" in str(err.value)
    finally:
        other.kill()
        other.wait()
    first = agent_runner.ProfileLock(profile).acquire()                  # that process is gone: its lock is stale
    assert first.held and lock_path.read_text().split()[0] == str(os.getpid())
    again = agent_runner.ProfileLock(profile).acquire()                  # our own pid never locks us out
    assert again.held
    first.release()
    assert not lock_path.exists()
    first.release()                                                      # releasing twice is harmless


def test_a_lock_from_a_crashed_runner_is_taken_over_and_garbage_is_ignored(tmp_path):
    profile = tmp_path / "chrome_profile"
    (tmp_path / "chrome_profile.runner.lock").write_text("999999 2026-01-01 00:00:00")
    assert agent_runner.ProfileLock(profile, pid_alive=lambda pid: False).acquire().held
    (tmp_path / "chrome_profile.runner.lock").write_text("not a pid")
    assert agent_runner.ProfileLock(profile).acquire().held


class FakeChromium:
    def __init__(self, fail_channel):
        self.calls, self.fail_channel = [], fail_channel

    async def launch_persistent_context(self, user_dir, **kw):
        self.calls.append((str(user_dir), kw.get("channel"), kw.get("args")))
        if kw.get("channel") and self.fail_channel:
            raise RuntimeError("Chromium distribution 'chrome' is not found")
        return "context"


class FakePw:
    def __init__(self, fail_channel):
        self.chromium = FakeChromium(fail_channel)


class Args:
    headed, browser_channel, profile_dir = True, "chrome", str("/data/chrome_profile")


def test_the_launch_is_always_persistent_and_the_chromium_fallback_never_touches_the_chrome_profile(home):
    pw = FakePw(fail_channel=False)
    assert run(agent_runner.launch_browser(pw, Args())) == "context"
    assert pw.chromium.calls == [("/data/chrome_profile", "chrome", agent_runner.PROFILE_ARGS)]
    pw = FakePw(fail_channel=True)
    assert run(agent_runner.launch_browser(pw, Args())) == "context"
    assert [c[0] for c in pw.chromium.calls] == ["/data/chrome_profile", "/data/chrome_profile-chromium"]
    assert pw.chromium.calls[1][1] is None                               # bundled Chromium, its own folder


def test_nothing_in_the_runner_or_adapters_clears_cookies_or_opens_a_throwaway_context():
    import pathlib
    root = pathlib.Path(agent_runner.__file__).parent
    sources = [root / "agent_runner.py", *sorted((root / "ats").glob("*.py")), root / "gmail_tab_otp.py"]
    for path in sources:
        text = path.read_text(encoding="utf-8")
        for bad in ("clear_cookies", "new_context(", "incognito", "storage_state"):
            assert bad not in text, f"{path.name} uses {bad}"
