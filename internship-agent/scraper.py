"""Discover Summer 2027 SWE / AI-ML internship postings and build job_queue.json.

Sources
  1. SimplifyJobs/Summer2027-Internships  (structured listings.json + README tables)
  2. Pitt CSC Summer 2027 list            (README tables)
  3. vanshb03/Summer2027-Internships      (listings.json; short links resolved when reachable)
  4. speedyapply 2027 SWE and AI college-jobs lists (markdown tables)
  5. Direct ATS boards (--crawl-boards): every Greenhouse / Lever / Ashby board
     that has ever appeared in the lists (any season, open or closed) is queried
     through that ATS's public job-board API for intern postings that are open
     now. This replaces search-engine "site:" queries: it asks the three ATS
     hosts directly, so nothing depends on scraping a search results page.

Each posting is pre-qualified from list metadata (term, category, title,
degree, citizenship, location) so the runner only opens plausible roles.

    python scraper.py                  # refresh job_queue.json
    python scraper.py --crawl-boards   # also crawl ATS boards directly
"""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import sys
import time
from collections import Counter
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

import requests

import config
from dedup import canonical_url, load_queue, normalize_company, save_queue

RAW = "https://raw.githubusercontent.com"
SOURCES = [
    {"name": "simplify", "kind": "listings_json",
     "url": f"{RAW}/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json"},
    {"name": "simplify-readme", "kind": "readme_table",
     "url": f"{RAW}/SimplifyJobs/Summer2027-Internships/dev/README.md"},
    {"name": "pittcsc-readme", "kind": "readme_table",
     "url": f"{RAW}/pittcsc/Summer2027-Internships/dev/README.md"},
    {"name": "vanshb03", "kind": "listings_json",
     "url": f"{RAW}/vanshb03/Summer2027-Internships/dev/.github/scripts/listings.json"},
    {"name": "speedyapply-swe", "kind": "pipe_table", "category": "Software",
     "url": f"{RAW}/speedyapply/2027-SWE-College-Jobs/main/README.md"},
    {"name": "speedyapply-ai", "kind": "pipe_table", "category": "AI/ML/Data",
     "url": f"{RAW}/speedyapply/2027-AI-College-Jobs/main/README.md"},
    # Lists named in the spec that did not exist at time of writing are tried
    # anyway so they are picked up if they appear.
    {"name": "ouckah", "kind": "listings_json", "optional": True,
     "url": f"{RAW}/Ouckah/Summer2027-Internships/dev/.github/scripts/listings.json"},
    {"name": "zero2sudo", "kind": "readme_table", "optional": True,
     "url": f"{RAW}/zero2sudo/Summer2027-Internships/main/README.md"},
]

SESSION = requests.Session()
SESSION.headers["User-Agent"] = "Mozilla/5.0 (compatible; internship-queue-builder)"

# --------------------------------------------------------------------------- #
# Pre-qualification (spec section 2, step 3 — the metadata half)
# --------------------------------------------------------------------------- #

OK_TERMS = re.compile(r"\b(summer|spring|fall)\s+2027\b", re.I)
SWE_CATEGORIES = {"software", "software engineering", "ai/ml/data",
                  "data science, ai & machine learning"}

ENGINEERING_TITLE = re.compile(
    r"software|\bswe\b|\bsde\b|developer|full[- ]?stack|back[- ]?end|front[- ]?end|"
    r"machine learning|\bml\b|\bai\b|artificial intelligence|computer vision|deep learning|"
    r"\bnlp\b|data (engineer|scien|platform|infrastructure)|cloud|devops|\bsre\b|"
    r"site reliability|infrastructure|platform|systems?\b|web|mobile|\bios\b|android|"
    r"engineer(ing)? intern|technology|research engineer|applied scientist|firmware|embedded",
    re.I,
)
NON_ENGINEERING_TITLE = re.compile(
    r"\bsales\b|marketing|revenue|accounting|financ(e|ial) (analyst|intern)|\bhr\b|human resources|"
    r"recruit|legal|paralegal|supply chain|procurement|product manage|product owner|program manage|"
    r"project manage|business (analyst|development|operations|intelligence)|customer (success|support)|"
    r"\bmechanical\b|\belectrical\b|\bcivil\b|\bchemical\b|manufacturing|\brf\b|hardware|asic|"
    r"\bfpga\b|circuit|analog|\bpcb\b|optical|photonics|\bux\b|designer|content|communications|"
    r"policy|strategy|consult|actuar|trader|trading intern|quantitative (trad|research)|audit|\btax\b",
    re.I,
)
ADVANCED_DEGREE_TITLE = re.compile(
    r"\bph\.?d\b|doctoral|\bmasters?\b|master's|\bms\b[/ ]|\bmba\b|graduate (student|intern|program)|"
    r"\bgrad\b student|postdoc|🎓", re.I)
WRONG_AUDIENCE_TITLE = re.compile(r"high school|new grad|\b(2025|2026)\b|winter 20|returning intern", re.I)
SENIORITY_TITLE = re.compile(r"\b(senior|staff|principal|lead|manager|director)\b", re.I)
CLEARANCE = re.compile(r"clearance|ts/sci|top secret|\bsecret\b|u\.?s\.? citizen", re.I)

US_STATE = (
    r"AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|"
    r"NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC"
)
US_LOCATION = re.compile(
    rf",\s*(?:{US_STATE})\b|\bUSA?\b|United States|\bRemote\b|^(?:NYC|SF|Bay Area|New York|"
    r"San Francisco|Seattle|Austin|Boston|Chicago|Los Angeles|Dallas)\b", re.I)
NON_US_LOCATION = re.compile(
    r"Canada|\bUK\b|United Kingdom|London|India|Germany|France|Ireland|Singapore|China|Japan|"
    r"Netherlands|Poland|Israel|Australia|Mexico|Brazil|Spain|Switzerland|Sweden|Korea|Taiwan|"
    r",\s*(?:ON|BC|QC|AB)\b", re.I)


def prequalify(job: dict) -> str | None:
    """Return a skip reason, or None if the listing looks eligible."""
    title = job["title"]
    terms = job.get("terms") or []
    if terms and not any(OK_TERMS.search(t) for t in terms):
        return f"term not Summer/Spring/Fall 2027 ({', '.join(terms)})"
    if job.get("sponsorship") == "U.S. Citizenship is Required" or "🇺🇸" in title:
        return "requires U.S. citizenship"
    if CLEARANCE.search(title):
        return "clearance / citizenship restricted"
    degrees = job.get("degrees") or []
    if degrees and "Bachelor's" not in degrees:
        return f"advanced degree only ({', '.join(degrees)})"
    if ADVANCED_DEGREE_TITLE.search(title):
        return "advanced degree role"
    if WRONG_AUDIENCE_TITLE.search(title):
        return "different cohort (high school / new grad / another year)"
    if SENIORITY_TITLE.search(title) and not re.search(r"intern|co-?op", title, re.I):
        return "not an internship"
    category = (job.get("category") or "").lower()
    in_swe_category = category in SWE_CATEGORIES or not category
    looks_engineering = bool(ENGINEERING_TITLE.search(title))
    if NON_ENGINEERING_TITLE.search(title) and not re.search(r"software|developer|\bswe\b", title, re.I):
        return "non-software role"
    if not looks_engineering:
        return "non-software role"
    if not in_swe_category and not re.search(r"software|developer|\bswe\b|machine learning|\bai\b", title, re.I):
        return f"category {job.get('category')}"
    locs = job.get("locations") or []
    if locs and not any(US_LOCATION.search(l) for l in locs) and all(NON_US_LOCATION.search(l) for l in locs):
        return "outside the United States"
    return None


# --------------------------------------------------------------------------- #
# URL handling
# --------------------------------------------------------------------------- #

_TRACKING = re.compile(r"^(utm_|ref$|source$|src$|gh_src$|lever-source|ashby_jid$)", re.I)


def clean_url(url: str) -> str:
    """Drop tracking params (utm_*, ref=Simplify, ...) but keep functional ones."""
    url = html.unescape(url.strip())
    p = urlparse(url)
    qs = [(k, v) for k, vs in parse_qs(p.query, keep_blank_values=True).items()
          for v in vs if not _TRACKING.match(k)]
    scheme = "https" if p.scheme in ("", "http") else p.scheme
    return urlunparse((scheme, p.netloc, p.path, "", urlencode(qs), ""))


def detect_ats(url: str) -> str:
    u = url.lower()
    host = urlparse(u).netloc
    if "greenhouse.io" in host or "gh_jid=" in u:
        return "Greenhouse"
    if host.endswith("lever.co"):
        return "Lever"
    if host.endswith("ashbyhq.com"):
        return "Ashby"
    if "myworkdayjobs.com" in host or "myworkdaysite.com" in host:
        return "Workday"
    for needle, name in (("icims.com", "iCIMS"), ("smartrecruiters.com", "SmartRecruiters"),
                         ("oraclecloud.com", "Oracle"), ("taleo.net", "Taleo"),
                         ("successfactors", "SuccessFactors"), ("eightfold.ai", "Eightfold"),
                         ("workable.com", "Workable"), ("jobvite.com", "Jobvite"),
                         ("bamboohr.com", "BambooHR"), ("rippling.com", "Rippling"),
                         ("paylocity.com", "Paylocity"), ("avature.net", "Avature")):
        if needle in u:
            return name
    return "Other"


def ats_job_id(url: str) -> str:
    key = canonical_url(url)
    return key.split(":")[-1] if key.split(":")[0] in ("greenhouse", "lever", "ashby") else ""


# Adapters in agent_runner.py handle these without an LLM; they go first.
ATS_PRIORITY = {"Greenhouse": 0, "Ashby": 1, "Lever": 2}


def make_job(*, company, title, url, locations=None, terms=None, sponsorship="", category="",
             degrees=None, source="", date_posted=0) -> dict:
    url = clean_url(url)
    title = " ".join(html.unescape(title).split())
    job = {
        "id": hashlib.sha1(canonical_url(url).encode()).hexdigest()[:12],
        "company": " ".join(html.unescape(company).split()),
        "title": title,
        "locations": [l.strip() for l in (locations or []) if l and l.strip()],
        "url": url,
        "ats": detect_ats(url),
        "ats_job_id": ats_job_id(url),
        "terms": terms or [],
        "sponsorship": sponsorship or "",
        "category": category or "",
        "degrees": degrees or [],
        "source": source,
        "date_posted": int(date_posted or 0),
        "status": "pending",
    }
    reason = prequalify(job)
    if reason:
        job["status"] = "skipped_ineligible"
        job["status_detail"] = reason
    return job


# --------------------------------------------------------------------------- #
# Source parsers
# --------------------------------------------------------------------------- #

def fetch(url: str, *, optional: bool = False, retries: int = 3) -> str | None:
    for attempt in range(retries):
        try:
            r = SESSION.get(url, timeout=90)
            if r.status_code == 404:
                if not optional:
                    print(f"  ! 404 {url}", file=sys.stderr)
                return None
            r.raise_for_status()
            return r.text
        except requests.RequestException as exc:
            if attempt == retries - 1:
                print(f"  ! {url}: {exc}", file=sys.stderr)
                return None
            time.sleep(2 ** (attempt + 1))
    return None


def parse_listings_json(text: str, source: str) -> list[dict]:
    jobs = []
    for x in json.loads(text):
        if not x.get("active") or not x.get("is_visible", True) or not x.get("url"):
            continue
        terms = x.get("terms")
        if terms is None and x.get("season"):          # vanshb03 schema: season only
            terms = [f"{x['season']} 2027"]
        jobs.append(make_job(
            company=x.get("company_name", ""), title=x.get("title", ""), url=x["url"],
            locations=x.get("locations"), terms=terms, sponsorship=x.get("sponsorship", ""),
            category=x.get("category", ""), degrees=x.get("degrees"),
            source=source, date_posted=x.get("date_posted", 0)))
    return jobs


_TAG = re.compile(r"<[^>]+>")
_SECTION = re.compile(r"^##\s+\W*\s*(.+?)\s+Internship Roles", re.M)


def _text(cell: str) -> str:
    return " ".join(html.unescape(_TAG.sub(" ", cell)).split())


def parse_readme_tables(text: str, source: str) -> list[dict]:
    """Parse the HTML <table>s of a Simplify / Pitt CSC style README."""
    jobs: list[dict] = []
    sections = [(m.start(), m.group(1)) for m in _SECTION.finditer(text)]
    last_company = ""
    for m in re.finditer(r"<tr>(.*?)</tr>", text, re.S):
        cells = re.findall(r"<td[^>]*>(.*?)</td>", m.group(1), re.S)
        if len(cells) < 4:
            continue
        company = _text(cells[0]).lstrip("🔥 ").strip()
        if company in ("↳", ""):
            company = last_company
        last_company = company
        title = _text(cells[1])
        if "🔒" in cells[3] or "🔒" in title:
            continue
        link = re.search(r'href="([^"]+)"[^>]*>\s*<img[^>]*alt="Apply"', cells[3])
        if not link:
            hrefs = [h for h in re.findall(r'href="([^"]+)"', cells[3]) if "simplify.jobs/p/" not in h]
            if not hrefs:
                continue
            url = hrefs[0]
        else:
            url = link.group(1)
        locations = [l.strip() for l in re.split(r"</br>|<br\s*/?>|;", cells[2]) if _text(l)]
        locations = [_text(l) for l in locations]
        category = ""
        for pos, name in sections:
            if pos < m.start():
                category = name
        cat_map = {"software engineering": "Software", "data science, ai & machine learning": "AI/ML/Data",
                   "product management": "Product", "quantitative finance": "Quant",
                   "hardware engineering": "Hardware"}
        sponsorship = ""
        if "🇺🇸" in title:
            sponsorship = "U.S. Citizenship is Required"
        elif "🛂" in title:
            sponsorship = "Does Not Offer Sponsorship"
        # 🎓 is kept in the title so prequalify() sees the advanced-degree flag.
        clean_title = re.sub(r"[🛂🔥]|🇺🇸", "", title).strip()
        jobs.append(make_job(
            company=company, title=clean_title, url=url,
            locations=locations, terms=["Summer 2027"], sponsorship=sponsorship,
            category=cat_map.get(category.lower(), category), source=source))
    return jobs


def parse_pipe_tables(text: str, source: str, category: str = "") -> list[dict]:
    """Markdown pipe tables (speedyapply): | Company | Position | Location | Salary | Posting | Age |.

    Only the U.S. internship sections are read; new-grad and international tables are skipped.
    """
    jobs: list[dict] = []
    in_scope = False
    for line in text.splitlines():
        if line.startswith("#"):
            head = line.lower()
            if head.startswith("## "):
                in_scope = "internship" in head and "usa" in head
            continue
        if not in_scope or not line.startswith("|") or line.startswith("|--") or "Company" in line[:14]:
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 5:
            continue
        link = re.search(r'href="([^"]+)"[^>]*>\s*<img[^>]*alt="Apply"', line)
        if not link:
            continue
        location = re.sub(r"\s*\+\d+$", "", _text(cells[2]))
        jobs.append(make_job(company=_text(cells[0]), title=_text(cells[1]), url=link.group(1),
                             locations=[location] if location else [], terms=["Summer 2027"],
                             category=category, source=source))
    return jobs


def resolve_short_links(jobs: list[dict], limit: int = 400) -> list[dict]:
    """vanshb03 hides targets behind go.vansh.nyc; follow them when the host is reachable."""
    out, tried, dead_hosts = [], 0, set()
    for job in jobs:
        host = urlparse(job["url"]).netloc
        if host not in ("go.vansh.nyc",):
            out.append(job); continue
        if host in dead_hosts or tried >= limit:
            continue
        tried += 1
        try:
            r = SESSION.head(job["url"], allow_redirects=False, timeout=15)
            target = r.headers.get("location")
        except requests.RequestException:
            dead_hosts.add(host)
            print(f"  ! {host} unreachable — skipping its short links", file=sys.stderr)
            continue
        if not target:
            continue
        out.append(make_job(company=job["company"], title=job["title"], url=target,
                            locations=job["locations"], terms=job["terms"],
                            sponsorship=job["sponsorship"], category=job["category"],
                            degrees=job["degrees"], source=job["source"],
                            date_posted=job["date_posted"]))
    return out


# --------------------------------------------------------------------------- #
# Direct ATS board crawl (replaces the spec's site: search-engine queries)
# --------------------------------------------------------------------------- #

INTERN_TITLE = re.compile(r"\bintern(ship)?s?\b|\bco-?op\b", re.I)
# Board APIs give no category or country, so board postings must look like software AND like a U.S. role.
STRONG_SOFTWARE_TITLE = re.compile(
    r"software|\bswe\b|\bsde\b|developer|full[- ]?stack|back[- ]?end|front[- ]?end|machine learning|\bml\b|"
    r"\bai\b|artificial intelligence|computer vision|deep learning|\bnlp\b|data (engineer|scien)|"
    r"\bcloud\b|devops|site reliability|\bplatform\b|infrastructure|\bweb\b|mobile|\bios\b|android|"
    r"applied scientist|research engineer|founding engineer|forward deployed|firmware|embedded software", re.I)
US_STATES_FULL = (
    "Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|"
    "Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|"
    "Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|"
    "Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|"
    "West Virginia|Wisconsin|Wyoming")
US_CITIES = (
    "San Francisco|\\bSF\\b|Bay Area|New York|NYC|Seattle|Austin|Boston|Chicago|Los Angeles|Dallas|Houston|Denver|"
    "Atlanta|Palo Alto|Mountain View|Sunnyvale|San Jose|San Mateo|Menlo Park|Santa Clara|Redwood City|San Diego|"
    "Pittsburgh|Philadelphia|Miami|Washington,? D\\.?C|Cambridge, MA|Bellevue|Redmond|Boulder|Raleigh|Durham|"
    "Salt Lake City|Portland|Phoenix|Detroit|Minneapolis|Nashville|El Segundo|Irvine|Santa Monica|Oakland|Brooklyn")
US_POSITIVE = re.compile(rf",\s*(?:{US_STATE})\b|\b(?:{US_STATES_FULL})\b|United States|\bUSA?\b|\bU\.S\.|{US_CITIES}|"
                         r"Remote[ ,(-]*(US|United States|USA|North America)", re.I)
BOARD_HOSTS = {"job-boards.greenhouse.io": "Greenhouse", "boards.greenhouse.io": "Greenhouse",
               "jobs.lever.co": "Lever", "jobs.ashbyhq.com": "Ashby"}


def board_tokens(listings: list[dict]) -> dict[str, dict[str, str]]:
    """{"Greenhouse": {token: company}, ...} from every URL ever listed (dicts with url + company)."""
    found: dict[str, dict[str, str]] = {"Greenhouse": {}, "Ashby": {}, "Lever": {}}
    for j in listings:
        p = urlparse(j.get("url") or "")
        parts = [seg for seg in p.path.split("/") if seg]
        ats = BOARD_HOSTS.get(p.netloc.lower())
        if not ats or not parts or parts[0] == "embed":
            continue
        token = parts[0].lower() if ats == "Greenhouse" else parts[0]
        found[ats].setdefault(token, j.get("company") or j.get("company_name") or token)
    return found


def _board_postings(ats: str, token: str) -> list[tuple[str, str, list[str]]] | None:
    """(title, url, locations) for every open posting on a board; None if the host is blocked."""
    try:
        if ats == "Greenhouse":
            r = SESSION.get(f"https://boards-api.greenhouse.io/v1/boards/{token}/jobs", timeout=25)
            return [(p["title"], p["absolute_url"], [(p.get("location") or {}).get("name", "")])
                    for p in r.json().get("jobs", [])] if r.ok else []
        if ats == "Lever":
            r = SESSION.get(f"https://api.lever.co/v0/postings/{token}?mode=json", timeout=25)
            out = []
            for p in (r.json() if r.ok else []):
                cat = p.get("categories") or {}
                title = p["text"] if INTERN_TITLE.search(p["text"]) or "intern" not in (cat.get("commitment") or "").lower() \
                    else f"{p['text']} (Intern)"
                out.append((title, p["hostedUrl"], [cat.get("location", "")]))
            return out
        r = SESSION.get(f"https://api.ashbyhq.com/posting-api/job-board/{token}", timeout=25)
        out = []
        for p in (r.json().get("jobs", []) if r.ok else []):
            if p.get("isListed") is False:
                continue
            title = p["title"] if INTERN_TITLE.search(p["title"]) or p.get("employmentType") != "Intern" \
                else f"{p['title']} (Intern)"
            out.append((title, p["jobUrl"], [p.get("location") or ""]))
        return out
    except requests.exceptions.ProxyError:
        return None
    except (requests.RequestException, ValueError, KeyError, TypeError):
        return []


def crawl_boards(listings: list[dict], max_boards: int = 2000, workers: int = 8) -> list[dict]:
    """Ask each known board for its open intern postings (titles are pre-qualified as usual).

    Board postings carry no term, so they are marked term_unverified: the runner
    only applies if the description itself mentions Summer or 2027.
    """
    from concurrent.futures import ThreadPoolExecutor

    tasks = [(ats, token, company) for ats, boards in board_tokens(listings).items()
             for token, company in boards.items()][:max_boards]
    blocked: set[str] = set()

    def fetch_board(task):
        ats, token, company = task
        if ats in blocked:
            return []
        posts = _board_postings(ats, token)
        if posts is None:
            blocked.add(ats)
            return []
        jobs = []
        for title, url, locs in posts:
            if not INTERN_TITLE.search(title):
                continue
            job = make_job(company=company, title=title, url=url, locations=locs, terms=[],
                           source=f"{ats.lower()}-board")
            job["term_unverified"] = True
            if job["status"] == "pending":
                where = " ; ".join(job["locations"])
                if not STRONG_SOFTWARE_TITLE.search(title):
                    job["status"], job["status_detail"] = "skipped_ineligible", "board posting: not clearly a software role"
                elif not US_POSITIVE.search(where) or NON_US_LOCATION.search(where) and not re.search(
                        r"United States|\bUSA?\b", where):
                    job["status"], job["status_detail"] = "skipped_ineligible", "board posting: not clearly in the U.S."
            jobs.append(job)
        return jobs

    new: list[dict] = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for jobs in pool.map(fetch_board, tasks):
            new.extend(jobs)
    for ats in blocked:
        print(f"  ! {ats} API host is blocked by the network policy — its boards were not crawled", file=sys.stderr)
    print(f"[ats-boards] asked {len(tasks)} boards")
    return new


# --------------------------------------------------------------------------- #
# Queue assembly
# --------------------------------------------------------------------------- #

def merge_into_queue(queue: list[dict], scraped: list[dict]) -> tuple[list[dict], int]:
    """Add unseen postings; keep the status of anything already in the queue."""
    by_key = {canonical_url(j["url"]): j for j in queue}
    added = 0
    for job in scraped:
        key = canonical_url(job["url"])
        if key in by_key:
            continue
        by_key[key] = job
        queue.append(job)
        added += 1
    return queue, added


def sort_queue(queue: list[dict]) -> list[dict]:
    """Adapter-supported ATS first, sponsoring employers first, newest first."""
    def key(j):
        return (
            ATS_PRIORITY.get(j["ats"], 9),
            1 if j.get("sponsorship") == "Does Not Offer Sponsorship" else 0,
            -j.get("date_posted", 0),
            normalize_company(j["company"]),
        )
    return sorted(queue, key=key)


def scrape(crawl: bool = False) -> list[dict]:
    scraped: list[dict] = []
    ever_listed: list[dict] = []           # every URL the lists have carried, for board discovery
    for src in SOURCES:
        text = fetch(src["url"], optional=src.get("optional", False))
        if text is None:
            if not src.get("optional"):
                print(f"[{src['name']}] unavailable")
            continue
        try:
            if src["kind"] == "listings_json":
                jobs = parse_listings_json(text, src["name"])
                ever_listed += [{"url": x.get("url"), "company": x.get("company_name")} for x in json.loads(text)]
            elif src["kind"] == "pipe_table":
                jobs = parse_pipe_tables(text, src["name"], src.get("category", ""))
            else:
                jobs = parse_readme_tables(text, src["name"])
        except (ValueError, KeyError) as exc:
            print(f"[{src['name']}] could not parse: {exc}", file=sys.stderr)
            continue
        if src["name"] == "vanshb03":
            jobs = resolve_short_links(jobs)
        print(f"[{src['name']}] {len(jobs)} active listings")
        scraped.extend(jobs)
    if crawl:
        ever_listed += [{"url": j["url"], "company": j["company"]} for j in scraped]
        extra = crawl_boards(ever_listed)
        print(f"[ats-boards] {len(extra)} open intern postings found on boards "
              f"({sum(j['status'] == 'pending' for j in extra)} pass pre-qualification)")
        scraped.extend(extra)
    return scraped


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--crawl-boards", action="store_true",
                    help="also query Greenhouse/Lever/Ashby board APIs for unlisted 2027 intern roles")
    args = ap.parse_args(argv)

    scraped = scrape(crawl=args.crawl_boards)
    queue, added = merge_into_queue(load_queue(), scraped)
    queue = sort_queue(queue)
    save_queue(queue)

    pending = [j for j in queue if j["status"] == "pending"]
    print(f"\njob_queue.json: {len(queue)} total, {added} new, {len(pending)} pending")
    print("pending by ATS:", dict(Counter(j["ats"] for j in pending).most_common()))
    skipped = Counter(j.get("status_detail", "").split(" (")[0] for j in queue
                      if j["status"] == "skipped_ineligible")
    print("skipped (ineligible):", dict(skipped.most_common(8)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
