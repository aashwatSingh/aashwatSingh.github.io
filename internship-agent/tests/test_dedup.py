import shutil
from pathlib import Path

import openpyxl
import pytest

import dedup
from dedup import Ledger, canonical_url, normalize_company, normalize_role


def make_tracker(path: Path, rows):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws["A1"] = "Tracker"
    ws.append([])
    ws.append([])
    ws.append(["Company", "Role", "Cycle", "Date Applied", "Current Status", "Status Date",
               "Application ID / Ref", "Next Step / Notes", "Source Email Subject"])
    for r in rows:
        ws.append(r)
    last = 4 + len(rows)
    ws.append([])
    ws.append(["Summary"])
    ws.append(["Total applications tracked:", f"=COUNTA(A5:A{last})"])
    ws.append(["Rejected:", f'=COUNTIF(E5:E{last},"Rejected")'])
    ws.auto_filter.ref = f"A4:I{last}"
    wb.save(path)


@pytest.fixture
def ledger(tmp_path):
    xlsx = tmp_path / "tracker.xlsx"
    make_tracker(xlsx, [
        ["Acme, Inc.", "Software Engineer Intern", "Summer 2027", "2026-09-01", "Rejected", None, None, None, None],
        ["Acme, Inc.", "Data Intern", "Summer 2027", "2026-09-02", "Rejected", None, None, None, None],
        ["Globex Corp", None, "Summer 2027", "2026-09-03", "Application submitted / Awaiting response",
         None, None, None, None],
    ])
    return Ledger(xlsx, tmp_path / "applied.csv")


def test_normalization():
    assert normalize_company("Acme, Inc.") == normalize_company("ACME inc") == "acme"
    assert normalize_company("The Voleon Group LLC") == "voleon group"
    assert normalize_role("Software Engineer Intern - Summer 2027") == normalize_role("Software Engineer Intern")


@pytest.mark.parametrize("a,b", [
    ("https://job-boards.greenhouse.io/acme/jobs/123?gh_src=x", "https://boards.greenhouse.io/acme/jobs/123"),
    ("https://acme.com/careers/job/123?gh_jid=123&utm_source=Simplify", "https://job-boards.greenhouse.io/acme/jobs/123"),
    ("https://jobs.lever.co/acme/0f6a1b2c-0000-4000-8000-000000000001/apply",
     "https://jobs.lever.co/acme/0f6a1b2c-0000-4000-8000-000000000001"),
    ("https://jobs.ashbyhq.com/acme/0f6a1b2c-0000-4000-8000-000000000001/application?embed=true",
     "https://jobs.ashbyhq.com/acme/0f6a1b2c-0000-4000-8000-000000000001"),
])
def test_canonical_url_equivalence(a, b):
    assert canonical_url(a) == canonical_url(b)


def test_ledger_counts_every_tracker_row(ledger):
    assert ledger.total == 3
    assert len(ledger.companies) == 2


def test_duplicate_levels(ledger):
    new_role_same_co = {"company": "Acme", "title": "ML Intern", "url": "https://x.io/1"}
    assert ledger.duplicate_reason(new_role_same_co, "company") == "company already applied to"
    assert ledger.duplicate_reason(new_role_same_co, "role") is None
    same_role = {"company": "ACME Inc", "title": "Software Engineer Intern (Summer 2027)", "url": "https://x.io/2"}
    assert ledger.duplicate_reason(same_role, "role") == "same company + role"
    assert ledger.duplicate_reason({"company": "Initech", "title": "SWE Intern", "url": "https://x.io/3"}) is None


def test_record_application_updates_csv_and_workbook(ledger):
    job = {"company": "Initech", "title": "SWE Intern", "locations": ["Austin, TX"], "ats": "Greenhouse",
           "url": "https://job-boards.greenhouse.io/initech/jobs/999", "ats_job_id": "999", "terms": ["Summer 2027"]}
    ledger.record_application(job)
    assert ledger.total == 4
    assert ledger.duplicate_reason(job) == "same posting URL"

    ws = openpyxl.load_workbook(ledger.xlsx).active
    assert [ws.cell(8, c).value for c in (1, 2, 5)] == ["Initech", "SWE Intern", "Application submitted / Awaiting response"]
    assert ws.cell(11, 2).value == "=COUNTA(A5:A8)"            # summary formulas extended
    assert ws.cell(12, 2).value == '=COUNTIF(E5:E8,"Rejected")'
    assert ws.auto_filter.ref == "A4:I8"

    # A fresh ledger over the same files must not double count the new row.
    again = Ledger(ledger.xlsx, ledger.csv_path)
    assert again.total == 4


def test_filter_queue_keeps_one_pending_per_company(ledger):
    queue = [
        {"company": "Acme", "title": "ML Intern", "url": "https://x.io/1", "status": "pending"},
        {"company": "Initech", "title": "SWE Intern", "url": "https://x.io/2", "status": "pending"},
        {"company": "Initech", "title": "Data Eng Intern", "url": "https://x.io/3", "status": "pending"},
    ]
    dedup.filter_queue(queue, ledger, "company")
    assert [j["status"] for j in queue] == ["duplicate", "pending", "duplicate"]


def test_locked_workbook_does_not_lose_the_application(tmp_path, monkeypatch):
    import dedup
    xlsx, csv_path = tmp_path / "t.xlsx", tmp_path / "a.csv"
    make_tracker(xlsx, [["Acme", "SWE Intern", "Summer 2027", "2026-10-01", "Rejected", "2026-10-02", None, None, None]])
    ledger = dedup.Ledger(xlsx, csv_path)
    real = dedup.append_to_tracker_xlsx
    monkeypatch.setattr(dedup, "append_to_tracker_xlsx", lambda *a, **k: (_ for _ in ()).throw(PermissionError("locked")))
    job = {"company": "=Initech", "title": "SWE Intern", "url": "https://job-boards.greenhouse.io/initech/jobs/1",
           "ats": "Greenhouse", "locations": ["Austin, TX"]}
    ledger.record_application(job)                      # must not raise
    assert ledger.total == 2 and len(ledger.pending_xlsx) == 1
    monkeypatch.setattr(dedup, "append_to_tracker_xlsx", real)
    fresh = dedup.Ledger(xlsx, csv_path)
    assert fresh.total == 2 and fresh.reconcile_xlsx() == 1 and fresh.reconcile_xlsx() == 0
    ws = openpyxl.load_workbook(xlsx).active
    assert ws.cell(6, 1).value == "'=Initech"           # listing text is never stored as a formula
