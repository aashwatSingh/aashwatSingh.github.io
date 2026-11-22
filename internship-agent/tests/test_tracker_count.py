"""One definition of "total applications": the tracker's rows between the header and the Summary row."""
import csv
import hashlib
import shutil
from pathlib import Path

import openpyxl
import pytest

import config
import dedup
import tracker_rows
import tracker_sync
import verify_tracker_count
from dedup import Ledger

STATUSES = ["Rejected", "Application submitted / Awaiting response", "Application incomplete",
            "Assessment invited / Awaiting completion", None]          # None: an empty status cell


def build(path, n=249, *, blanks=(), order=None, summary_label="Summary", range_end=None, extra_after_summary=True,
          extra_rows=()):
    """The user's layout: title and subtitle (rows 1-2), blank row 3, header on row 4, data from row 5,
    a blank row, the Summary row, then label rows with =COUNTA / =COUNTIF formulas."""
    headers = order or ["Company", "Role", "Cycle", "Date Applied", "Current Status", "Status Date",
                        "Application ID / Ref", "Next Step / Notes", "Source Email Subject"]
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Internship Applications"
    ws["A1"] = "Summer 2027 SWE Internship Application Tracker"
    ws["A2"] = "Compiled from Gmail: genuine employer emails only."
    ws.append([])
    ws.append([])
    ws.cell(4, 1).value = None
    for i, h in enumerate(headers, 1):
        ws.cell(4, i).value = h
    r = 5
    data = [{"Company": f"Company {i}", "Role": f"Role {i % 40}", "Cycle": "Summer 2027", "Date Applied": "2026-09-01",
             "Current Status": STATUSES[i % len(STATUSES)]} for i in range(n)] + list(extra_rows)
    for i, row in enumerate(data):
        while r in blanks:
            r += 1                                       # blank rows inside the block
        for c, h in enumerate(headers, 1):
            ws.cell(r, c).value = row.get(h)
        r += 1
    last = r - 1
    company_letter = openpyxl.utils.get_column_letter(headers.index("Company") + 1)
    status_letter = openpyxl.utils.get_column_letter(headers.index("Current Status") + 1)
    end = range_end or last
    ws.cell(r + 1, 1).value = summary_label
    ws.cell(r + 2, 1).value = "Total applications tracked:"
    ws.cell(r + 2, 2).value = f"=COUNTA({company_letter}5:{company_letter}{end})"
    ws.cell(r + 3, 1).value = "Rejected:"
    ws.cell(r + 3, 2).value = f'=COUNTIF({status_letter}5:{status_letter}{end},"Rejected")'
    if extra_after_summary:
        ws.cell(r + 5, 1).value = "Some Company Mentioned In A Note Below The Summary"
    wb.save(path)
    return last


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


# ---- what counts ------------------------------------------------------------------------------------ #

def test_249_rows_count_as_249_whatever_their_status_and_the_summary_block_is_left_out(tmp_path):
    xlsx = tmp_path / "t.xlsx"
    last = build(xlsx)
    read = tracker_rows.read_tracker(xlsx)
    assert (read.total, read.header_row, read.first_row, read.last_row) == (249, 4, 5, last)
    assert read.summary_row == last + 2                               # located by its text, not by a number
    counts = read.status_counts()
    assert counts["Application incomplete"] > 0 and counts[tracker_rows.BLANK_STATUS] > 0
    assert sum(counts.values()) == 249                                # the breakdown adds up
    assert len(dedup.load_tracker_rows(xlsx)) == 249 and tracker_sync.summary(xlsx)["total"] == 249
    assert not any("Mentioned" in r["Company"] or r["Company"].endswith(":") for r in read.rows())


def test_blank_and_whitespace_rows_inside_the_block_are_skipped_not_treated_as_its_end(tmp_path):
    xlsx = tmp_path / "t.xlsx"
    build(xlsx, 20, blanks={9, 15})
    wb = openpyxl.load_workbook(xlsx)
    wb.active.cell(12, 1).value = "   "                             # only spaces: not an application
    wb.save(xlsx)
    read = tracker_rows.read_tracker(xlsx)
    assert read.total == 19                                            # 20 rows, one blanked to spaces
    assert read.skipped_blank_rows == 3                                # two empty rows and the spaces row
    assert [r["Company"] for r in read.rows()][-1] == "Company 19"     # rows below the gaps still counted
    assert dedup._last_data_row(openpyxl.load_workbook(xlsx).active, 4) == read.last_row


@pytest.mark.parametrize("label", ["Summary", "  SUMMARY  ", "summary"])
def test_the_summary_row_is_found_case_insensitively_after_trimming(tmp_path, label):
    xlsx = tmp_path / "t.xlsx"
    last = build(xlsx, 12, summary_label=label)
    assert tracker_rows.read_tracker(xlsx).total == 12


def test_columns_are_found_by_header_name_not_letter(tmp_path):
    xlsx = tmp_path / "t.xlsx"
    build(xlsx, 30, order=["Date Applied", "Current Status", "Role", "Company", "Cycle", "Status Date",
                           "Application ID / Ref", "Next Step / Notes", "Source Email Subject"])
    read = tracker_rows.read_tracker(xlsx)
    assert (read.total, read.company_col) == (30, 4)
    assert sum(read.status_counts().values()) == 30
    assert tracker_sync.summary(xlsx)["total"] == 30 and Ledger(xlsx, xlsx.with_suffix(".csv")).total == 30


def test_a_workbook_with_no_summary_row_stops_at_the_first_label_row(tmp_path):
    xlsx = tmp_path / "t.xlsx"
    build(xlsx, 10, summary_label="", extra_after_summary=False)
    assert tracker_rows.read_tracker(xlsx).total == 10                 # "Total applications tracked:" is a label


# ---- duplicates are flagged, never dropped --------------------------------------------------------------- #

def test_same_company_and_role_is_flagged_but_still_counted_and_different_roles_are_not(tmp_path):
    xlsx = tmp_path / "t.xlsx"
    rows = [{"Company": "Acme", "Role": "SWE Intern", "Current Status": "Rejected"},
            {"Company": " acme ", "Role": "swe intern", "Current Status": "Rejected"},      # same, other case / spaces
            {"Company": "Acme", "Role": "Data Intern", "Current Status": "Rejected"},        # another role: separate
            {"Company": "Globex", "Role": "SWE Intern", "Current Status": None}]
    build(xlsx, 0, extra_rows=rows)
    read = tracker_rows.read_tracker(xlsx)
    assert read.total == 4
    assert read.duplicates() == [{"company": "Acme", "role": "SWE Intern", "rows": [5, 6]}]
    assert tracker_sync.summary(xlsx)["duplicates"] == read.duplicates() and tracker_sync.summary(xlsx)["total"] == 4


# ---- the 249 vs 264 bug: the ledger counted applied_tracker.csv as well ------------------------------------ #

def write_csv(path, rows):
    with path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=config.LEDGER_COLUMNS)
        w.writeheader()
        w.writerows(rows)


def csv_row(company, role, ats="Greenhouse"):
    return {"Timestamp": "2026-10-01 10:00:00", "Company": company, "Role": role, "Location": "",
            "ATS_Platform": ats, "URL": f"https://x.test/{company}", "Status": "Applied"}


def test_rows_in_the_csv_that_the_tracker_does_not_have_never_inflate_the_total(tmp_path):
    xlsx, ledger_csv = tmp_path / "t.xlsx", tmp_path / "a.csv"
    build(xlsx, 249)
    # the runner logged every application; then 15 Role cells were edited and 0 rows were added
    rows = tracker_rows.read_tracker(xlsx).rows()
    write_csv(ledger_csv, [csv_row(r["Company"], r["Role"]) for r in rows[:234]]
              + [csv_row(r["Company"], r["Role"] + " (original wording)") for r in rows[234:]])
    ledger = Ledger(xlsx, ledger_csv)
    assert ledger.total == 249                                          # was 264: 249 + the 15 unmatched CSV rows
    assert len(ledger.rows) == 264                                      # the dedup index still knows both spellings
    assert len(ledger.untracked_rows()) == 15                           # ...and names exactly which rows differ
    assert ledger.duplicate_reason({"company": rows[0]["Company"], "title": rows[0]["Role"], "url": ""}, "role")


def test_deleting_rows_in_excel_lowers_the_total_at_once(tmp_path):
    xlsx, ledger_csv = tmp_path / "t.xlsx", tmp_path / "a.csv"
    build(xlsx, 60)
    write_csv(ledger_csv, [csv_row(r["Company"], r["Role"]) for r in tracker_rows.read_tracker(xlsx).rows()])
    wb = openpyxl.load_workbook(xlsx)
    wb.active.delete_rows(5, 15)
    wb.save(xlsx)
    assert Ledger(xlsx, ledger_csv).total == 45 == tracker_sync.summary(xlsx)["total"]


def test_a_recorded_application_adds_exactly_one_to_the_total_and_a_locked_write_adds_none(tmp_path, monkeypatch):
    xlsx, ledger_csv = tmp_path / "t.xlsx", tmp_path / "a.csv"
    build(xlsx, 30)
    ledger = Ledger(xlsx, ledger_csv)
    ledger.record_application({"company": "Initech", "title": "Backend Intern", "url": "https://x.test/i", "ats": "Lever"})
    assert ledger.total == 31 == tracker_sync.summary(xlsx)["total"] == Ledger(xlsx, ledger_csv).total
    real = dedup.append_to_tracker_xlsx
    monkeypatch.setattr(dedup, "append_to_tracker_xlsx", lambda *a, **k: (_ for _ in ()).throw(PermissionError("locked")))
    ledger.record_application({"company": "Umbrella", "title": "SWE Intern", "url": "https://x.test/u", "ats": "Lever"})
    assert ledger.total == 31 and len(ledger.pending_xlsx) == 1         # waiting to be written, not yet a tracker row
    monkeypatch.setattr(dedup, "append_to_tracker_xlsx", real)
    assert ledger.flush_pending_xlsx() == 1 and ledger.total == 32


def test_an_unverified_row_is_a_row_so_it_is_counted_and_flagged(tmp_path):
    xlsx = tmp_path / "t.xlsx"
    build(xlsx, 10)
    ledger = Ledger(xlsx, tmp_path / "a.csv")
    assert ledger.record_unverified({"company": "Hooli", "title": "SWE Intern", "url": "https://x.test/h", "ats": "Ashby"})
    s = tracker_sync.summary(xlsx)
    assert (s["total"], s["unverified"], ledger.total) == (11, 1, 11)


# ---- stale Summary formulas are reported, never edited ----------------------------------------------------- #

def test_a_summary_formula_with_a_stale_range_is_reported(tmp_path):
    xlsx = tmp_path / "t.xlsx"
    last = build(xlsx, 249, range_end=262)                              # =COUNTA(A5:A262), data ends at 253
    read = tracker_rows.read_tracker(xlsx)
    issues = read.stale_formula_ranges()
    assert len(issues) == 2 and "A5:A262" in issues[0] and f"rows 5-{last}" in issues[0]
    assert tracker_sync.summary(xlsx)["formulaIssues"] == issues
    good = tmp_path / "good.xlsx"
    build(good, 249)
    assert tracker_rows.read_tracker(good).stale_formula_ranges() == []


# ---- the independent check, with LibreOffice -------------------------------------------------------------------- #

needs_soffice = pytest.mark.skipif(verify_tracker_count.find_soffice() is None, reason="LibreOffice not installed")


@needs_soffice
def test_verifier_agrees_on_249_leaves_the_original_alone_and_deletes_its_copy(tmp_path, monkeypatch):
    xlsx = tmp_path / "t.xlsx"
    build(xlsx, 249)
    made = []
    real = verify_tracker_count.tempfile.mkdtemp
    monkeypatch.setattr(verify_tracker_count.tempfile, "mkdtemp", lambda **k: made.append(real(dir=tmp_path, **k)) or made[-1])
    before, lines = digest(xlsx), []
    assert verify_tracker_count.main(["--xlsx", str(xlsx), "--expect", "249"], out=lines.append) == 0
    text = "\n".join(lines)
    assert "independent count" in text and ": 249" in text and "recalculated by LibreOffice" in text
    assert "= sum of the breakdown (matches the total)" in text and "(Blank)" in text
    assert "Original workbook unchanged: yes" in text and "OK: independent 249, tracker_sync 249, ledger 249, summary cell 249" in text
    assert digest(xlsx) == before and made and not Path(made[0]).exists()


@needs_soffice
def test_verifier_reports_a_mismatch_and_a_stale_summary_formula(tmp_path):
    xlsx = tmp_path / "t.xlsx"
    build(xlsx, 249, range_end=262)     # =COUNTA(A5:A262) also counts the 4 label rows it runs over: 253
    lines = []
    assert verify_tracker_count.main(["--xlsx", str(xlsx)], out=lines.append) == 1
    text = "\n".join(lines)
    assert "MISMATCH" in text and "summary cell 253" in text and "independent 249" in text
    assert "Summary formula out of step" in text
    lines = []
    shutil.copy(xlsx, tmp_path / "u.xlsx")
    assert verify_tracker_count.main(["--xlsx", str(tmp_path / "u.xlsx"), "--no-recalc", "--expect", "250"], out=lines.append) == 1


def test_verifier_without_libreoffice_still_compares_the_other_numbers(tmp_path, monkeypatch):
    xlsx = tmp_path / "t.xlsx"
    build(xlsx, 40)
    monkeypatch.setattr(verify_tracker_count, "find_soffice", lambda: None)
    lines = []
    assert verify_tracker_count.main(["--xlsx", str(xlsx)], out=lines.append) == 0
    assert "LibreOffice not found" in "\n".join(lines) and "OK: independent 40, tracker_sync 40, ledger 40" in "\n".join(lines)
