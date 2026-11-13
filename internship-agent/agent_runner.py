"""Continuous application loop.

    python agent_runner.py --dry-run --limit 5     # fill forms, screenshot, never submit
    python agent_runner.py                         # run until the ledger reaches 500
    python agent_runner.py --ats all               # also hand other portals to the LLM agent
    python agent_runner.py --only-url <posting>    # one posting

For every posting:  dedup check -> open -> page pre-qualification -> fill from
candidate_profile.json -> submit -> record in applied_tracker.csv and
internship_tracker.xlsx. Anything that cannot be completed truthfully and
unattended (a required question the profile does not answer, a CAPTCHA
challenge, an emailed code, a timeout) is screenshotted and appended to
manual_review_queue.csv, and the loop moves straight on.
"""
from __future__ import annotations

import argparse
import asyncio
import csv
import json
import os
import re
import signal
import sys
import time
from collections import Counter
from datetime import datetime

from playwright.async_api import async_playwright

import config
import dedup
import scraper
from answers import AnswerEngine, Context, load_custom_answers, remember_answers
from ats import ADAPTERS, DEFAULT_ATS, adapter_for
from ats.base import (CLOSED, DRY_RUN_OK, ERROR, MANUAL_REVIEW, SKIPPED_INELIGIBLE, SUBMITTED, ApplyResult)

APPLICATION_TIMEOUT_S = 240       # whole form, including uploads and option lookups (+ --assist wait)
_stop = False


def log(msg: str) -> None:
    line = f"[{datetime.now():%H:%M:%S}] {msg}"
    print(line, flush=True)
    with (config.LOG_DIR / "runner.log").open("a", encoding="utf-8") as fh:
        fh.write(line + "\n")


def append_manual_review(job: dict, result: ApplyResult) -> None:
    new = not config.MANUAL_REVIEW_CSV.exists()
    with config.MANUAL_REVIEW_CSV.open("a", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=config.MANUAL_REVIEW_COLUMNS)
        if new:
            w.writeheader()
        w.writerow({
            "Timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "Company": job["company"], "Role": job["title"], "ATS_Platform": job["ats"],
            "URL": job["url"], "Reason": result.reason, "Detail": result.detail,
            "Screenshot": os.path.relpath(result.screenshot, config.BASE) if result.screenshot else "",
        })


def write_application_log(job: dict, result: ApplyResult) -> None:
    out = config.LOG_DIR / "applications"
    out.mkdir(parents=True, exist_ok=True)
    (out / f"{job['id']}.json").write_text(json.dumps({
        "when": datetime.now().isoformat(timespec="seconds"),
        "job": {k: job.get(k) for k in ("company", "title", "url", "ats", "locations")},
        "status": result.status, "reason": result.reason, "detail": result.detail,
        "answers": result.answers,
    }, indent=1, ensure_ascii=False), encoding="utf-8")


async def apply_one(context, job: dict, engine: AnswerEngine, ledger: dedup.Ledger,
                    *, dry_run: bool, use_llm: bool) -> ApplyResult:
    adapter = adapter_for(job["url"])
    shot = str(config.MANUAL_REVIEW_DIR / f"{job['id']}.png")
    ctx = Context(company=job["company"], title=job["title"], locations=list(job.get("locations") or []),
                  applied_before=ledger.has_company(job["company"]))
    page = await context.new_page()
    try:
        if adapter is None:
            if not use_llm:
                return ApplyResult(MANUAL_REVIEW, "UNSUPPORTED_ATS",
                                   f"{job['ats']} needs the LLM agent (set ANTHROPIC_API_KEY, --ats all)")
            import llm_agent                                       # optional dependency
            return await llm_agent.apply(context, job, engine.p, dry_run=dry_run, shot_path=shot)
        return await asyncio.wait_for(
            adapter.apply(page, job, engine, ctx, dry_run=dry_run, shot_path=shot),
            timeout=getattr(adapter, "timeout_s", APPLICATION_TIMEOUT_S)
            + ((8 if adapter.name == "Workday" else 2) * max(adapter.human_wait_s, 180) if adapter.human_wait_s else 0))
    except asyncio.TimeoutError:
        await _safe_shot(page, shot)
        return ApplyResult(MANUAL_REVIEW, "TIMEOUT", f"gave up after {APPLICATION_TIMEOUT_S}s", screenshot=shot)
    except LookupError as exc:
        return ApplyResult(MANUAL_REVIEW, "UNRESOLVED_URL", str(exc)[:200])
    except Exception as exc:                                       # noqa: BLE001 - never stop the loop
        await _safe_shot(page, shot)
        return ApplyResult(ERROR, type(exc).__name__, str(exc)[:300], screenshot=shot)
    finally:
        await page.close()


async def _safe_shot(page, path: str) -> None:
    try:
        await page.screenshot(path=path, full_page=True, timeout=10000)
    except Exception:                                              # noqa: BLE001
        pass


async def launch_browser(pw, args):
    """Persistent profile so cookies and sign-ins carry over between forms and runs."""
    options = dict(headless=not args.headed, accept_downloads=False,
                   viewport=None if args.headed else {"width": 1280, "height": 1600})
    if args.browser_channel:
        try:
            return await pw.chromium.launch_persistent_context(args.profile_dir, channel=args.browser_channel, **options)
        except Exception as exc:                                   # noqa: BLE001 - e.g. Chrome not installed
            log(f"could not start '{args.browser_channel}' ({str(exc).splitlines()[0][:90]}); using bundled Chromium")
    return await pw.chromium.launch_persistent_context(args.profile_dir, **options)


def select_jobs(queue: list[dict], args) -> list[dict]:
    if args.only_url:
        key = dedup.canonical_url(args.only_url)
        hit = [j for j in queue if dedup.canonical_url(j["url"]) == key]
        if hit:
            return hit
        job = scraper.make_job(company=args.company or "Unknown", title=args.title or "Intern",
                               url=args.only_url, terms=["Summer 2027"], source="manual")
        job["status"] = "pending"
        queue.append(job)
        return [job]
    wanted = None if args.ats == "all" else {a.strip().lower() for a in args.ats.split(",")}
    statuses = {"pending"} | ({"manual_review", "error"} if args.retry_manual else set())
    jobs = [j for j in queue if j.get("status", "pending") in statuses
            and (wanted is None or j["ats"].lower() in wanted)]
    if args.skip_logged_since:                                 # resume an interrupted dry-run sweep
        import glob, json as _json
        done = set()
        for path in glob.glob(str(config.LOG_DIR / "applications" / "*.json")):
            try:
                d = _json.load(open(path, encoding="utf-8"))
            except ValueError:
                continue
            if d.get("when", "") >= args.skip_logged_since:
                done.add(dedup.canonical_url(d["job"]["url"]))
        jobs = [j for j in jobs if dedup.canonical_url(j["url"]) not in done]
    if args.only_ready:
        path = config.BASE / "ready_to_submit.csv"
        if not path.exists():
            raise SystemExit("--only-ready needs ready_to_submit.csv: run a --dry-run sweep, then `python report.py`")
        import csv
        with path.open(encoding="utf-8") as fh:
            ready = {dedup.canonical_url(r["URL"]) for r in csv.DictReader(fh)}
        jobs = [j for j in jobs if dedup.canonical_url(j["url"]) in ready]
    return jobs


async def run(args) -> int:
    config.ensure_dirs()
    profile = config.load_profile()
    if not os.path.exists(profile["resume_path"]):
        print(f"Resume not found at {profile['resume_path']}", file=sys.stderr)
        return 2
    engine = AnswerEngine(profile)
    ledger = dedup.Ledger()
    ledger.write_csv()

    queue = dedup.load_queue()
    if args.rescrape or not queue:
        log("refreshing job_queue.json from the listing sources")
        queue, added = scraper.merge_into_queue(queue, scraper.scrape(crawl=args.crawl_boards))
        queue = scraper.sort_queue(queue)
        log(f"queue: {len(queue)} listings ({added} new)")
    queue, _ = dedup.filter_queue(queue, ledger, args.dedup_level, args.max_per_company)
    save_queue = (lambda q: None) if args.dry_run else dedup.save_queue    # a dry run never edits the queue
    save_queue(queue)

    use_llm = args.ats == "all" and bool(os.environ.get("ANTHROPIC_API_KEY"))
    for adapter in ADAPTERS.values():
        adapter.human_wait_s = args.assist
        adapter.write_essays = not args.no_essays
        if hasattr(adapter, "create_accounts"):
            adapter.create_accounts = args.workday_create_accounts
            adapter.try_sign_in = not args.workday_manual_sign_in
    if args.assist:
        args.headed = True
    if not args.dry_run and not args.assist:
        log("unattended run: postings that hit a CAPTCHA or emailed code go to manual review "
            "(use --local-blitz on your own machine to clear those in the browser)")
    jobs = select_jobs(queue, args)
    start_total = ledger.total
    log(f"ledger: {start_total} applied, target {args.target}; {len(jobs)} candidate postings "
        f"({'DRY RUN' if args.dry_run else 'LIVE'}; ats={args.ats}; dedup={args.dedup_level})")
    if not args.dry_run:
        backup = dedup.backup_tracker()
        if backup:
            log(f"tracker backed up to {backup.name}")
        try:
            restored = ledger.reconcile_xlsx()
            if restored:
                log(f"added {restored} earlier application(s) that were missing from {config.TRACKER_XLSX.name}")
        except OSError:
            log(f"! {config.TRACKER_XLSX.name} is open in another program: close it so new rows can be written")

    tally: Counter = Counter()
    deadline = time.time() + args.max_minutes * 60 if args.max_minutes else None
    async with async_playwright() as pw:
        context = await launch_browser(pw, args)
        context.set_default_timeout(15000)
        try:
            for job in jobs:
                if _stop or (deadline and time.time() > deadline):
                    break
                if not args.dry_run and ledger.total >= args.target:
                    break
                if args.limit and sum(tally.values()) >= args.limit:
                    break
                if not args.only_url:
                    dup = ledger.duplicate_reason(job, args.dedup_level)      # spec step 2
                    if dup:
                        job["status"], job["status_detail"] = "duplicate", dup
                        continue

                t0 = time.time()
                result = await apply_one(context, job, engine, ledger, dry_run=args.dry_run, use_llm=use_llm)
                tally[result.status] += 1
                write_application_log(job, result)

                if result.status in (SUBMITTED, DRY_RUN_OK) and result.screenshot \
                        and os.path.exists(result.screenshot):
                    # the filled form as it looked right before submit: audit trail, not a review item
                    os.replace(result.screenshot, config.SUBMITTED_DIR / os.path.basename(result.screenshot))
                if result.status == SUBMITTED:
                    ledger.record_application(job)
                    job["status"] = "applied"
                    if result.learned:
                        kept = remember_answers(result.learned, job["company"])
                        engine.custom = load_custom_answers()
                        log(f"  remembered {kept} answer(s) you gave in the browser (custom_answers.json)")
                elif result.status == DRY_RUN_OK:
                    pass                                   # stays pending for the live run
                elif result.status == MANUAL_REVIEW:
                    if not args.dry_run:
                        append_manual_review(job, result)
                        job["status"] = "manual_review"
                elif result.status == SKIPPED_INELIGIBLE:
                    job["status"] = "skipped_ineligible"
                elif result.status == CLOSED:
                    job["status"] = "closed"
                else:
                    if not args.dry_run:
                        append_manual_review(job, result)
                        job["status"] = "error"
                if result.status not in (SUBMITTED, DRY_RUN_OK):
                    job["status_detail"] = f"{result.reason}: {result.detail}"[:300]
                save_queue(queue)
                log(f"{result.status.upper():<18} {job['company']} — {job['title']} [{job['ats']}] "
                    f"({time.time() - t0:.0f}s) {result.reason}"
                    + (f": {result.detail[:140]}" if result.detail else "")
                    + (f"  | total {ledger.total}/{args.target}" if result.status == SUBMITTED else ""))
        finally:
            await context.close()
            save_queue(queue)

    ledger.flush_pending_xlsx()
    if ledger.pending_xlsx:
        log(f"! {len(ledger.pending_xlsx)} submitted application(s) are in applied_tracker.csv but not yet in "
            f"{config.TRACKER_XLSX.name} (it was locked). Close Excel; the next run adds them.")
    log(f"done: {dict(tally)}; ledger {start_total} -> {ledger.total} of {args.target}")
    remaining = sum(1 for j in queue if j.get("status") == "pending")
    log(f"queue: {remaining} still pending; manual review list: {config.MANUAL_REVIEW_CSV.name}")
    return 0


def prefetch_schemas() -> None:
    """Cache Greenhouse question schemas for coverage_report.py (no browser, no submissions)."""
    import requests
    from urllib.parse import urlparse
    out = config.CACHE_DIR / "gh"
    out.mkdir(parents=True, exist_ok=True)
    n = 0
    for job in dedup.load_queue():
        p = urlparse(job["url"])
        parts = [s for s in p.path.split("/") if s]
        if job["ats"] != "Greenhouse" or job.get("status") != "pending" or "greenhouse.io" not in p.netloc or not parts:
            continue
        if not re.fullmatch(r"[\w.-]+", f"{parts[0]}_{job.get('ats_job_id') or ''}") or ".." in parts[0]:
            continue                                       # names come from listing URLs: plain file names only
        target = out / f"{parts[0]}_{job['ats_job_id']}.json"
        if target.exists():
            continue
        try:
            r = requests.get(f"https://boards-api.greenhouse.io/v1/boards/{parts[0]}/jobs/"
                             f"{job['ats_job_id']}?questions=true", timeout=20)
        except requests.RequestException as exc:
            print(f"  ! {exc}", file=sys.stderr)
            break
        if r.ok:
            target.write_text(r.text, encoding="utf-8")
            n += 1
    print(f"cached {n} new schemas in {out}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="fill and screenshot, never click submit")
    ap.add_argument("--target", type=int, default=config.TARGET_TOTAL, help="stop when the ledger reaches this")
    ap.add_argument("--limit", type=int, default=0, help="stop after this many postings (0 = no limit)")
    ap.add_argument("--max-minutes", type=float, default=0, help="stop after this long (0 = no limit)")
    ap.add_argument("--ats", default=DEFAULT_ATS,
                    help=f"comma list of portals (adapters: {', '.join(ADAPTERS)}), or 'all'. Workday is "
                         "experimental past its login screen and must be named explicitly")
    ap.add_argument("--workday-manual-sign-in", action="store_true",
                    help="Workday only: never type the portal password; wait for you to sign in yourself "
                         "(use this if you sign in with Google or use different passwords per site)")
    ap.add_argument("--workday-create-accounts", action="store_true",
                    help="Workday only: when your portal password is not accepted on a site, create an "
                         "account there with the profile's e-mail and password (off by default)")
    ap.add_argument("--dedup-level", choices=["company", "role"], default="company",
                    help="company: never apply to a company twice; role: only skip the same role/URL")
    ap.add_argument("--max-per-company", type=int, default=0,
                    help="with --dedup-level role: cap applications per company, counting the tracker (0 = none)")
    ap.add_argument("--retry-manual", action="store_true", help="re-attempt postings in manual review")
    ap.add_argument("--rescrape", action="store_true", help="refresh the queue before starting")
    ap.add_argument("--crawl-boards", action="store_true", help="with --rescrape: crawl ATS boards too")
    ap.add_argument("--headed", action="store_true", help="show the browser window")
    ap.add_argument("--no-essays", action="store_true",
                    help="never draft open-ended answers; send those postings to manual review")
    ap.add_argument("--assist", type=int, nargs="?", const=300, default=0, metavar="SECONDS",
                    help="human-in-the-loop: when a site asks to confirm you are human (CAPTCHA, emailed "
                         "code), wait this long for you to do it in the visible browser (implies --headed)")
    ap.add_argument("--profile-dir", default=str(config.BROWSER_PROFILE_DIR),
                    help="Chromium user-data directory (one runner per directory)")
    ap.add_argument("--browser-channel", default="", metavar="NAME",
                    help="use an installed browser instead of bundled Chromium, e.g. 'chrome' or 'msedge'")
    ap.add_argument("--local-blitz", action="store_true",
                    help="run on your own machine: visible browser with a persistent ./chrome_profile, fill and "
                         "submit everything, read the Greenhouse e-mail code from your Gmail (GMAIL_APP_PASSWORD in "
                         ".env, else a Gmail tab), and when a site asks for a CAPTCHA ring the bell and wait "
                         "up to 120 s for you to do that one step, then record and move on")
    ap.add_argument("--skip-logged-since", metavar="ISO_TIME",
                    help="skip postings already attempted at or after this time (resume a dry-run sweep)")
    ap.add_argument("--only-ready", action="store_true",
                    help="only postings listed in ready_to_submit.csv (fully filled in the last dry-run sweep)")
    ap.add_argument("--only-url", help="apply to this single posting")
    ap.add_argument("--company", help="company name for --only-url postings not in the queue")
    ap.add_argument("--title", help="role title for --only-url postings not in the queue")
    ap.add_argument("--prefetch", action="store_true", help="cache Greenhouse schemas and exit")
    args = ap.parse_args(argv)

    if args.prefetch:
        prefetch_schemas()
        return 0

    if args.local_blitz:
        args.headed = True
        args.assist = args.assist or 120
        if args.profile_dir == str(config.BROWSER_PROFILE_DIR):
            args.profile_dir = str(config.BASE / "chrome_profile")
        args.browser_channel = args.browser_channel or "chrome"

    def _sigint(*_):
        global _stop
        _stop = True
        print("\nfinishing the current application, then stopping…", flush=True)
    signal.signal(signal.SIGINT, _sigint)
    signal.signal(signal.SIGTERM, _sigint)
    return asyncio.run(run(args))


if __name__ == "__main__":
    sys.exit(main())
