"""The one definition of "an application row" in internship_tracker.xlsx.

Everything that counts or lists applications (the runner's ledger, tracker_sync.py, Mission Control,
verify_tracker_count.py) reads the workbook through read_tracker(), so they can only disagree if
the workbook does.

  * The header row is the first row (of the first 30) that has a "Company" header; the Company, Role
    and Status columns are found by header name, not by column letter.
  * Data rows run from the row under the header to the row before the first row whose Company cell
    is "Summary" (case-insensitive, trimmed). Nothing is hard-coded: no row numbers, no ranges.
  * A data row is an application when its Company cell is non-empty after trimming. One row is one
    application whatever its status ("Application incomplete" counts). Blank rows inside the block
    are skipped, not treated as its end. The title row, the header, the Summary row and every label
    row below it are never counted.
  * Rows that repeat both Company and Role (case-insensitive, trimmed) are flagged as possible
    duplicates but stay in the count: different roles at one company are separate applications.

It only reads. The workbook is opened read-only-style (never saved).
"""
from __future__ import annotations

import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path

import openpyxl

SHEET = "Internship Applications"
HEADER_SCAN_ROWS = 30
BLANK_STATUS = "(Blank)"
_RANGE = re.compile(r"\$?([A-Z]{1,3})\$?(\d+):\$?([A-Z]{1,3})\$?(\d+)")


def clean(value) -> str:
    return "" if value is None else str(value).strip()


def find_header(ws) -> tuple[int, dict[str, int]]:
    """(header row, {lower-cased header: 1-based column}) for the first row with a Company header."""
    for r in range(1, min(ws.max_row, HEADER_SCAN_ROWS) + 1):
        names: dict[str, int] = {}
        for idx, cell in enumerate(ws[r], 1):
            name = clean(cell.value).lower()
            if name and name not in names:
                names[name] = idx
        if "company" in names:
            return r, names
    raise ValueError("Could not find a header row with a 'Company' column in the first "
                     f"{HEADER_SCAN_ROWS} rows")


def pick_sheet(wb, sheet: str | None = None):
    if sheet and sheet in wb.sheetnames:
        return wb[sheet]
    return wb[SHEET] if SHEET in wb.sheetnames else wb.active


@dataclass
class TrackerRead:
    path: Path
    sheet: str
    header_row: int
    company_col: int
    role_col: int | None
    status_col: int | None
    headers: list[str]
    summary_row: int | None
    first_row: int                 # the row under the header
    last_row: int                  # the last application row (header_row when there are none)
    entries: list[tuple[int, dict]] = field(default_factory=list)       # (sheet row, {header: value})
    skipped_blank_rows: int = 0    # blank rows inside the block (not counted, did not end it)
    formulas: list[tuple[int, str, str]] = field(default_factory=list)  # (row, label, formula) below Summary

    @property
    def total(self) -> int:
        return len(self.entries)

    def rows(self) -> list[dict]:
        return [row for _, row in self.entries]

    def status_of(self, row: dict) -> str:
        name = self.headers[self.status_col - 1] if self.status_col else ""
        return clean(row.get(name)) or BLANK_STATUS

    def status_counts(self) -> Counter:
        return Counter(self.status_of(row) for _, row in self.entries)

    def duplicates(self) -> list[dict]:
        """Groups of rows with the same Company and Role: [{company, role, rows: [sheet rows]}]."""
        role_name = self.headers[self.role_col - 1] if self.role_col else ""
        company_name = self.headers[self.company_col - 1]
        groups: dict[tuple[str, str], list[int]] = defaultdict(list)
        shown: dict[tuple[str, str], tuple[str, str]] = {}
        for sheet_row, row in self.entries:
            key = (clean(row.get(company_name)).lower(), clean(row.get(role_name)).lower())
            groups[key].append(sheet_row)
            shown.setdefault(key, (clean(row.get(company_name)), clean(row.get(role_name))))
        return [{"company": shown[k][0], "role": shown[k][1], "rows": rows}
                for k, rows in groups.items() if len(rows) > 1]

    def stale_formula_ranges(self) -> list[str]:
        """Summary formulas whose range does not match the data block (a hard-coded A5:A262 that was
        right once). Reported, never edited: the workbook is not ours to rewrite here."""
        problems = []
        for row, label, formula in self.formulas:
            for m in _RANGE.finditer(formula):
                start, end = int(m.group(2)), int(m.group(4))
                if (start, end) != (self.first_row, self.last_row):
                    problems.append(f"row {row} '{label}': {m.group(0)} covers rows {start}-{end}, "
                                    f"the data is rows {self.first_row}-{self.last_row}")
                    break
        return problems


def read_tracker(path, sheet: str | None = None) -> TrackerRead:
    path = Path(path)
    wb = openpyxl.load_workbook(path)
    try:
        ws = pick_sheet(wb, sheet)
        header_row, names = find_header(ws)
        company_col = names["company"]
        role_col = names.get("role")
        status_col = names.get("current status") or next((c for n, c in names.items() if n.endswith("status")), None)
        headers = [clean(c.value) for c in ws[header_row]]

        summary_row = None
        for r in range(header_row + 1, ws.max_row + 1):
            if clean(ws.cell(r, company_col).value).lower() == "summary":
                summary_row = r
                break
        end = (summary_row - 1) if summary_row else ws.max_row

        read = TrackerRead(path=path, sheet=ws.title, header_row=header_row, company_col=company_col,
                           role_col=role_col, status_col=status_col, headers=headers, summary_row=summary_row,
                           first_row=header_row + 1, last_row=header_row)
        for r in range(header_row + 1, end + 1):
            company = clean(ws.cell(r, company_col).value)
            if not summary_row and company.endswith(":"):
                break                                   # no Summary row: a label row ("Total ...:") ends the block
            if not company:
                read.skipped_blank_rows += 1
                continue
            read.entries.append((r, {h: ws.cell(r, i).value for i, h in enumerate(headers, 1) if h}))
            read.last_row = r
        if summary_row:
            for r in range(summary_row + 1, ws.max_row + 1):
                label = clean(ws.cell(r, company_col).value)
                for c in range(company_col + 1, min(ws.max_column, company_col + 3) + 1):
                    value = ws.cell(r, c).value
                    if isinstance(value, str) and value.startswith("="):
                        read.formulas.append((r, label, value))
        # blank rows after the last application are not "inside" the block
        read.skipped_blank_rows = sum(1 for r in range(header_row + 1, read.last_row + 1)
                                      if not clean(ws.cell(r, company_col).value))
        return read
    finally:
        wb.close()
