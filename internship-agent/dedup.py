"""Deduplication ledger + tracker sync.

* Seeds the live ledger (``applied_tracker.csv``) from ``internship_tracker.xlsx``.
* Filters ``job_queue.json`` so nothing already applied to is opened again.
* Appends each newly submitted application to both the CSV and the workbook.

CLI:
    python dedup.py sync      # merge the workbook into applied_tracker.csv
    python dedup.py filter    # drop already-applied jobs from job_queue.json
    python dedup.py stats     # show counts
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import shutil
import sys
import unicodedata
from collections import Counter
from copy import copy
from datetime import datetime
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import openpyxl

import config

# --------------------------------------------------------------------------- #
# Normalisation
# --------------------------------------------------------------------------- #

_COMPANY_SUFFIXES = {
    "inc", "incorporated", "llc", "corp", "corporation", "ltd", "limited",
    "co", "company", "plc", "gmbh", "lp", "llp", "sa", "ag", "nv", "the",
}
_ROLE_NOISE = re.compile(
    r"\b(summer|fall|spring|winter|20\d\d|internship|intern|co-?op|program|"
    r"undergraduate|undergrad|us|usa|united states|remote|hybrid)\b"
)


def _ascii_lower(text: str) -> str:
    text = unicodedata.normalize("NFKD", text or "")
    text = text.encode("ascii", "ignore").decode("ascii")
    return text.lower()


def normalize_company(name: str | None) -> str:
    """lowercase, strip punctuation and legal suffixes ("Acme, Inc." -> "acme")."""
    text = _ascii_lower(name or "")
    text = text.replace("&", " and ")
    text = re.sub(r"[^a-z0-9 ]+", " ", text)
    tokens = [t for t in text.split() if t not in _COMPANY_SUFFIXES]
    return " ".join(tokens)


def normalize_role(title: str | None) -> str:
    text = _ascii_lower(title or "")
    text = re.sub(r"[^a-z0-9 ]+", " ", text)
    text = _ROLE_NOISE.sub(" ", text)
    return " ".join(text.split())


def canonical_url(url: str | None) -> str:
    """Stable key for a posting, independent of tracking params and /apply suffixes."""
    if not url:
        return ""
    url = url.strip()
    p = urlparse(url if "://" in url else "https://" + url)
    host = p.netloc.lower().removeprefix("www.")
    path = re.sub(r"/+$", "", p.path)
    qs = parse_qs(p.query)

    # Greenhouse job ids are globally unique, wherever the form is embedded.
    gh_jid = (qs.get("gh_jid") or qs.get("token") or [None])[0]
    if "greenhouse.io" in host:
        m = re.search(r"/jobs/(\d+)", path)
        if m:
            return f"greenhouse:{m.group(1)}"
        if gh_jid and gh_jid.isdigit():
            return f"greenhouse:{gh_jid}"
    elif (qs.get("gh_jid") or [""])[0].isdigit():
        return f"greenhouse:{qs['gh_jid'][0]}"

    if host.endswith("lever.co"):
        m = re.match(r"/([^/]+)/([0-9a-f-]{36})", path)
        if m:
            return f"lever:{m.group(1).lower()}:{m.group(2)}"
    if host.endswith("ashbyhq.com"):
        m = re.match(r"/([^/]+)/([0-9a-f-]{36})", path)
        if m:
            return f"ashby:{m.group(1).lower()}:{m.group(2)}"

    path = re.sub(r"/(apply|application)$", "", path, flags=re.I)
    return f"{host}{path}".lower()


def _token_prefix(a: str, b: str) -> bool:
    """True if one normalised company name is a whole-word prefix of the other."""
    if not a or not b:
        return False
    ta, tb = a.split(), b.split()
    short, long_ = (ta, tb) if len(ta) <= len(tb) else (tb, ta)
    return long_[: len(short)] == short


# --------------------------------------------------------------------------- #
# Workbook I/O
# --------------------------------------------------------------------------- #

def _find_header_row(ws) -> int:
    for r in range(1, min(ws.max_row, 30) + 1):
        if str(ws.cell(r, 1).value or "").strip().lower() == "company":
            return r
    raise ValueError("Could not find a header row with 'Company' in column A")


def _last_data_row(ws, header_row: int) -> int:
    """Last row of the contiguous data block under the header."""
    r = header_row
    while r + 1 <= ws.max_row and ws.cell(r + 1, 1).value not in (None, ""):
        r += 1
    return r


def load_tracker_rows(path: Path | None = None) -> list[dict]:
    """All application rows from the workbook as dicts keyed by header name."""
    path = Path(path or config.TRACKER_XLSX)
    if not path.exists():
        return []
    wb = openpyxl.load_workbook(path)
    ws = wb.active
    header_row = _find_header_row(ws)
    headers = [str(c.value or "").strip() for c in ws[header_row]]
    last = _last_data_row(ws, header_row)
    rows = []
    for r in range(header_row + 1, last + 1):
        values = [c.value for c in ws[r]]
        rows.append({h: v for h, v in zip(headers, values) if h})
    return rows


def _plain(value):
    """Listing text is untrusted: never let a cell be read as a formula."""
    if isinstance(value, str) and value[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + value
    return value


def append_to_tracker_xlsx(row: dict, path: Path | None = None) -> int:
    """Insert one application row at the end of the data block.

    Keeps the workbook's layout intact: the new row copies the previous row's
    styling, and the summary formulas / autofilter range below are extended.
    Returns the 1-based row number written.
    """
    path = Path(path or config.TRACKER_XLSX)
    wb = openpyxl.load_workbook(path)
    ws = wb.active
    header_row = _find_header_row(ws)
    headers = [str(c.value or "").strip() for c in ws[header_row]]
    last = _last_data_row(ws, header_row)
    new_row = last + 1
    first_data = header_row + 1

    ws.insert_rows(new_row)
    for col in range(1, len(headers) + 1):
        src, dst = ws.cell(last, col), ws.cell(new_row, col)
        if src.has_style:
            dst.font = copy(src.font)
            dst.border = copy(src.border)
            dst.fill = copy(src.fill)
            dst.alignment = copy(src.alignment)
            dst.number_format = src.number_format
            dst.protection = copy(src.protection)
        dst.value = _plain(row.get(headers[col - 1]))
    if ws.row_dimensions[last].height:
        ws.row_dimensions[new_row].height = ws.row_dimensions[last].height

    # insert_rows() does not rewrite formulas: extend ranges ending at `last`.
    range_re = re.compile(rf"([A-Z]+)\$?{first_data}:([A-Z]+)\$?{last}\b")
    for r in range(new_row + 1, ws.max_row + 1):
        for c in ws[r]:
            if isinstance(c.value, str) and c.value.startswith("="):
                c.value = range_re.sub(rf"\g<1>{first_data}:\g<2>{new_row}", c.value)
    if ws.auto_filter.ref:
        m = re.match(r"([A-Z]+)(\d+):([A-Z]+)(\d+)", ws.auto_filter.ref)
        if m and int(m.group(4)) == last:
            ws.auto_filter.ref = f"{m.group(1)}{m.group(2)}:{m.group(3)}{new_row}"

    tmp = path.with_suffix(".tmp.xlsx")
    wb.save(tmp)
    tmp.replace(path)
    return new_row


# --------------------------------------------------------------------------- #
# Ledger
# --------------------------------------------------------------------------- #

class Ledger:
    """In-memory view of everything already applied to (workbook + CSV)."""

    def __init__(self, xlsx: Path | None = None, csv_path: Path | None = None):
        self.xlsx = Path(xlsx or config.TRACKER_XLSX)
        self.csv_path = Path(csv_path or config.LEDGER_CSV)
        self.rows: list[dict] = []
        self.companies: set[str] = set()
        self.company_roles: set[tuple[str, str]] = set()
        self.urls: set[str] = set()
        self.pending_xlsx: list[tuple] = []                # submitted, but the workbook was locked
        self.reload()

    # -- loading ------------------------------------------------------------
    def reload(self) -> None:
        self.rows.clear(); self.companies.clear(); self.company_roles.clear()
        self.urls.clear()
        # The CSV is the live ledger; workbook rows are added only when the CSV
        # does not already hold that application (matched per company + role,
        # counting repeats, so the same row is never double counted).
        in_csv: Counter = Counter()
        for r in self._read_csv():
            self._index(r)
            in_csv[(normalize_company(r.get("Company")), normalize_role(r.get("Role")))] += 1
        for t in load_tracker_rows(self.xlsx):
            row = {
                "Timestamp": str(t.get("Date Applied") or ""),
                "Company": str(t.get("Company") or "").strip(),
                "Role": str(t.get("Role") or "").strip(),
                "Location": "",
                "ATS_Platform": "",
                "URL": _first_url(str(t.get("Next Step / Notes") or "")),
                "Status": str(t.get("Current Status") or "").strip(),
            }
            key = (normalize_company(row["Company"]), normalize_role(row["Role"]))
            if in_csv[key] > 0:
                in_csv[key] -= 1
                continue
            self._index(row)

    def _read_csv(self) -> list[dict]:
        if not self.csv_path.exists():
            return []
        with self.csv_path.open(newline="", encoding="utf-8") as fh:
            return list(csv.DictReader(fh))

    def _index(self, row: dict) -> bool:
        company = normalize_company(row.get("Company"))
        if not company:
            return False
        url = canonical_url(row.get("URL"))
        self.rows.append({c: row.get(c, "") or "" for c in config.LEDGER_COLUMNS})
        self.companies.add(company)
        self.company_roles.add((company, normalize_role(row.get("Role"))))
        if url:
            self.urls.add(url)
        return True

    # -- queries ------------------------------------------------------------
    @property
    def total(self) -> int:
        return len(self.rows)

    def has_company(self, company: str) -> bool:
        n = normalize_company(company)
        if not n:
            return False
        if n in self.companies:
            return True
        return any(_token_prefix(n, c) for c in self.companies)

    def duplicate_reason(self, job: dict, level: str = "company") -> str | None:
        """Why this job counts as already applied, or None if it is new.

        level="company": never apply to a company twice (spec section 9).
        level="role":    only skip the same company + role, or the same URL.
        """
        url = canonical_url(job.get("url"))
        if url and url in self.urls:
            return "same posting URL"
        company = normalize_company(job.get("company"))
        role = normalize_role(job.get("title"))
        if (company, role) in self.company_roles:
            return "same company + role"
        if level == "company" and self.has_company(job.get("company", "")):
            return "company already applied to"
        return None

    # -- writes -------------------------------------------------------------
    def write_csv(self) -> None:
        tmp = self.csv_path.with_suffix(".tmp")
        with tmp.open("w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=config.LEDGER_COLUMNS)
            w.writeheader()
            w.writerows([{k: _plain(v) for k, v in r.items()} for r in self.rows])
        tmp.replace(self.csv_path)

    def record_application(self, job: dict, *, when: datetime | None = None,
                           write_xlsx: bool = True, receipt: dict | None = None) -> dict:
        """Append a submitted application to the CSV and the workbook.

        `receipt` is the confirmation e-mail that proved it (email_receipt_verifier): its subject
        and date go into the workbook row.
        """
        when = when or datetime.now()
        location = "; ".join(job.get("locations") or []) or job.get("location", "")
        row = {
            "Timestamp": when.strftime("%Y-%m-%d %H:%M:%S"),
            "Company": job.get("company", ""),
            "Role": job.get("title", ""),
            "Location": location,
            "ATS_Platform": job.get("ats", ""),
            "URL": job.get("url", ""),
            "Status": config.LEDGER_APPLIED_STATUS,
        }
        self._index(row)
        self.write_csv()
        if write_xlsx and self.xlsx.exists():
            try:
                self._append_xlsx(job, row, when, location, receipt)
            except OSError as exc:                         # e.g. the workbook is open in Excel
                self.pending_xlsx.append((job, row, when, location, receipt))
                print(f"  ! could not write {self.xlsx.name} ({type(exc).__name__}): close it in Excel. "
                      "The application is saved in applied_tracker.csv and will be added on the next write.",
                      flush=True)
                return row
            self.flush_pending_xlsx()
        return row

    def reconcile_xlsx(self) -> int:
        """Add applications that are in applied_tracker.csv but never reached the workbook
        (it was open in Excel, or a run was interrupted). Returns how many rows were added."""
        if not self.xlsx.exists():
            return 0
        in_book: Counter = Counter((normalize_company(t.get("Company")), normalize_role(t.get("Role")))
                                   for t in load_tracker_rows(self.xlsx))
        added = 0
        for r in self._read_csv():
            if not r.get("ATS_Platform"):                  # rows that came from the workbook in the first place
                continue
            key = (normalize_company(r.get("Company")), normalize_role(r.get("Role")))
            if in_book[key] > 0:
                in_book[key] -= 1
                continue
            try:
                when = datetime.strptime(r.get("Timestamp") or "", "%Y-%m-%d %H:%M:%S")
            except ValueError:
                when = datetime.now()
            try:
                self._append_xlsx({}, r, when, r.get("Location") or "")
            except OSError:
                break
            added += 1
        return added

    def flush_pending_xlsx(self) -> None:
        while self.pending_xlsx:
            try:
                self._append_xlsx(*self.pending_xlsx[0])
            except OSError:
                return
            self.pending_xlsx.pop(0)

    def record_unconfirmed(self, job: dict, detail: str = "", *, when: datetime | None = None,
                           path: Path | None = None) -> dict:
        """Hold list for a submission whose confirmation e-mail never arrived.

        It is deliberately not in the ledger or the workbook, so it does not count toward the total.
        """
        path = Path(path or config.UNCONFIRMED_CSV)
        row = {
            "Timestamp": (when or datetime.now()).strftime("%Y-%m-%d %H:%M:%S"),
            "Company": job.get("company", ""), "Role": job.get("title", ""),
            "ATS_Platform": job.get("ats", ""), "URL": job.get("url", ""),
            "Status": config.UNCONFIRMED_STATUS, "Detail": detail,
        }
        new = not path.exists()
        with path.open("a", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=config.UNCONFIRMED_COLUMNS)
            if new:
                w.writeheader()
            w.writerow({k: _plain(v) for k, v in row.items()})
        return row

    def _append_xlsx(self, job: dict, row: dict, when: datetime, location: str,
                     receipt: dict | None = None) -> None:
        if True:
            day = when.strftime("%Y-%m-%d")
            if receipt and receipt.get("confirmed"):
                ats = receipt.get("ats") or row["ATS_Platform"] or "ATS"
                date = (receipt.get("received_at") or "")[:10] or day
                notes = (f"Application confirmation received via {ats} ({date}); verified by Gmail receipt."
                         + (f" {location}." if location else "") + f" {row['URL']}")
                subject = receipt.get("subject") or None
            else:
                notes = (f"Auto-applied via {row['ATS_Platform'] or 'ATS'}"
                         + (f" — {location}" if location else "") + f" — {row['URL']}")
                subject = None
            append_to_tracker_xlsx({
                "Company": row["Company"],
                "Role": row["Role"],
                "Cycle": ", ".join(job.get("terms") or []) or "Summer 2027",
                "Date Applied": day,
                "Current Status": config.XLSX_APPLIED_STATUS,
                "Status Date": day,
                "Application ID / Ref": job.get("ats_job_id") or None,
                "Next Step / Notes": notes,
                "Source Email Subject": subject,
            }, self.xlsx)


def _first_url(text: str) -> str:
    m = re.search(r"https?://\S+", text)
    return m.group(0).rstrip(").,;") if m else ""


# --------------------------------------------------------------------------- #
# Queue filtering
# --------------------------------------------------------------------------- #

def load_queue(path: Path | None = None) -> list[dict]:
    path = Path(path or config.QUEUE_JSON)
    if not path.exists():
        return []
    return json.loads(path.read_text(encoding="utf-8"))


def save_queue(queue: list[dict], path: Path | None = None) -> None:
    path = Path(path or config.QUEUE_JSON)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(queue, indent=1, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def filter_queue(queue: list[dict], ledger: Ledger, level: str = "company",
                 max_per_company: int = 0) -> tuple[list[dict], int]:
    """Mark already-applied jobs, and collapse repeats inside the queue itself.

    Jobs are never deleted (so a re-scrape does not resurrect them); they get
    status "duplicate". With level="company" only the first pending job per
    company stays pending.
    """
    changed = 0
    for job in queue:                       # re-evaluate earlier duplicate marks (the level may have changed)
        if job.get("status") == "duplicate":
            job["status"] = "pending"
            job.pop("status_detail", None)
    seen_urls: set[str] = set()
    seen_companies: set[str] = set()
    seen_roles: set[tuple[str, str]] = set()
    per_company: Counter = Counter(normalize_company(r["Company"]) for r in ledger.rows)
    for job in queue:
        if job.get("status", "pending") != "pending":
            continue
        company = normalize_company(job.get("company"))
        role = normalize_role(job.get("title"))
        url = canonical_url(job.get("url"))
        reason = ledger.duplicate_reason(job, level)
        if not reason:
            if url in seen_urls:
                reason = "repeated in queue (same URL)"
            elif (company, role) in seen_roles:
                reason = "repeated in queue (same company + role)"
            elif level == "company" and company in seen_companies:
                reason = "repeated in queue (company already queued)"
            elif max_per_company and per_company[company] >= max_per_company:
                reason = f"repeated in queue (company cap of {max_per_company} reached)"
        if reason:
            job["status"] = "duplicate"
            job["status_detail"] = reason
            changed += 1
            continue
        seen_urls.add(url); seen_companies.add(company); seen_roles.add((company, role))
        per_company[company] += 1
    return queue, changed


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def backup_tracker() -> Path | None:
    """One timestamped copy of the workbook before the first write of a run."""
    if not config.TRACKER_XLSX.exists():
        return None
    dst = config.TRACKER_XLSX.with_name(
        f"internship_tracker.backup-{datetime.now():%Y%m%d-%H%M%S}.xlsx")
    shutil.copy2(config.TRACKER_XLSX, dst)
    return dst


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["sync", "filter", "stats"])
    ap.add_argument("--dedup-level", choices=["company", "role"], default="company")
    ap.add_argument("--max-per-company", type=int, default=0,
                    help="with --dedup-level role: cap on applications per company, counting the tracker (0 = none)")
    args = ap.parse_args(argv)

    ledger = Ledger()
    if args.command == "sync":
        ledger.write_csv()
        print(f"applied_tracker.csv: {ledger.total} applications "
              f"({len(ledger.companies)} companies) merged from {config.TRACKER_XLSX.name}")
    elif args.command == "filter":
        queue = load_queue()
        queue, changed = filter_queue(queue, ledger, args.dedup_level, args.max_per_company)
        save_queue(queue)
        pending = sum(1 for j in queue if j.get("status", "pending") == "pending")
        print(f"job_queue.json: {changed} marked duplicate, {pending} pending "
              f"(dedup level: {args.dedup_level})")
    else:
        queue = load_queue()
        by_status: dict[str, int] = {}
        for j in queue:
            by_status[j.get("status", "pending")] = by_status.get(j.get("status", "pending"), 0) + 1
        print(f"applied: {ledger.total} ({len(ledger.companies)} companies); "
              f"remaining to {config.TARGET_TOTAL}: {max(0, config.TARGET_TOTAL - ledger.total)}")
        print("queue:", by_status or "empty")
    return 0


if __name__ == "__main__":
    sys.exit(main())
