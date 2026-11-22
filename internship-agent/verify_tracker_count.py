"""Check that every way of counting applications agrees with internship_tracker.xlsx.

    python verify_tracker_count.py                      # the tracker next to this file
    python verify_tracker_count.py --xlsx C:\\path\\internship_tracker.xlsx --expect 249

It prints three numbers and exits 0 only when they are equal:

  1. an independent count, written here without the automation's code: rows between the header and
     the "Summary" row whose Company is not blank;
  2. the automation's: tracker_sync.summary() (Mission Control, Internship Hunter) and the runner's
     ledger total;
  3. the workbook's own "Total applications tracked" cell, recalculated by LibreOffice on a temporary
     copy (skipped, and said so, when LibreOffice is not installed).

then the per-status breakdown ("(Blank)" for empty statuses) and checks that it adds up to the total,
the possible duplicate rows (kept in the count), rows in applied_tracker.csv that the tracker does
not have, and Summary formulas whose range no longer matches the data.

The original workbook is only ever read: the recalculation runs on a copy that is deleted afterwards,
and the file's hash is compared before and after.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections import Counter
from pathlib import Path

import openpyxl

import config

BLANK = "(Blank)"
SOFFICE_WINDOWS = (r"C:\Program Files\LibreOffice\program\soffice.exe",
                   r"C:\Program Files (x86)\LibreOffice\program\soffice.exe")


def _clean(value) -> str:
    return "" if value is None else str(value).strip()


def independent_count(path: Path) -> tuple[int, Counter]:
    """(applications, status counts) with logic of its own: header by name, rows until Summary."""
    wb = openpyxl.load_workbook(path)
    try:
        ws = wb["Internship Applications"] if "Internship Applications" in wb.sheetnames else wb.active
        header, company_col, status_col = None, None, None
        for r in range(1, 31):
            labels = {_clean(c.value).lower(): i for i, c in enumerate(ws[r], 1) if _clean(c.value)}
            if "company" in labels:
                header, company_col = r, labels["company"]
                status_col = labels.get("current status") or next((i for n, i in labels.items() if "status" in n), None)
                break
        if header is None:
            raise SystemExit("no header row with a Company column in the first 30 rows")
        total, statuses = 0, Counter()
        for r in range(header + 1, ws.max_row + 1):
            company = _clean(ws.cell(r, company_col).value).lower()
            if company == "summary":
                break
            if company:
                total += 1
                statuses[(_clean(ws.cell(r, status_col).value) if status_col else "") or BLANK] += 1
        return total, statuses
    finally:
        wb.close()


def find_soffice() -> str | None:
    for name in ("soffice", "libreoffice", "soffice.exe"):
        found = shutil.which(name)
        if found:
            return found
    return next((p for p in SOFFICE_WINDOWS if os.path.exists(p)), None)


def recalculated_summary(path: Path) -> tuple[int | None, str]:
    """The "Total applications tracked" cell after LibreOffice recalculates a temporary copy.
    (value or None, note). The copy is re-saved through openpyxl first so no cached value from Excel is
    left to be read back instead of a fresh calculation. The temporary folder is always deleted."""
    soffice = find_soffice()
    if not soffice:
        return None, "LibreOffice not found (install it from libreoffice.org, or pass --no-recalc)"
    tmp = Path(tempfile.mkdtemp(prefix="tracker_verify_"))
    try:
        copy, out = tmp / "copy.xlsx", tmp / "out"
        out.mkdir()
        shutil.copy2(path, copy)
        wb = openpyxl.load_workbook(copy)
        wb.save(copy)                                           # drops cached results: LibreOffice must calculate
        wb.close()
        run = subprocess.run([soffice, f"-env:UserInstallation={(tmp / 'profile').as_uri()}", "--headless",
                              "--convert-to", "xlsx", "--outdir", str(out), str(copy)],
                             capture_output=True, text=True, timeout=180)
        done = out / "copy.xlsx"
        if run.returncode != 0 or not done.exists():
            return None, f"LibreOffice could not recalculate ({(run.stderr or run.stdout).strip()[:120]})"
        wb = openpyxl.load_workbook(done, data_only=True)
        try:
            ws = wb["Internship Applications"] if "Internship Applications" in wb.sheetnames else wb.active
            for row in ws.iter_rows():
                label = _clean(row[0].value).lower()
                if label.startswith("total applications tracked"):
                    for cell in row[1:4]:
                        if isinstance(cell.value, (int, float)):
                            return int(cell.value), "recalculated by LibreOffice"
                    return None, "the 'Total applications tracked' cell has no number after recalculation"
            return None, "no 'Total applications tracked' row in the Summary block"
        finally:
            wb.close()
    except (OSError, subprocess.SubprocessError, ValueError) as exc:
        return None, f"recalculation failed ({type(exc).__name__}: {str(exc)[:100]})"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main(argv: list[str] | None = None, out=print) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--xlsx", default=str(config.TRACKER_XLSX), help="the tracker (default: internship_tracker.xlsx)")
    ap.add_argument("--expect", type=int, default=None, help="also require this total (e.g. 249)")
    ap.add_argument("--no-recalc", action="store_true", help="skip the LibreOffice recalculation")
    args = ap.parse_args(argv)
    path = Path(args.xlsx)
    if not path.exists():
        out(f"{path} not found")
        return 2
    before = sha256(path)

    import dedup
    import tracker_sync
    mine, statuses = independent_count(path)
    summary = tracker_sync.summary(path)
    ledger = dedup.Ledger(path)
    sheet_cell, note = (None, "skipped (--no-recalc)") if args.no_recalc else recalculated_summary(path)

    out(f"Tracker: {path}")
    out(f"  1. independent count (rows with a Company, header -> Summary): {mine}")
    out(f"  2. automation: tracker_sync.summary() = {summary['total']}, runner ledger total = {ledger.total}")
    out(f"  3. Summary cell 'Total applications tracked', recalculated:      "
        f"{sheet_cell if sheet_cell is not None else 'n/a'}  ({note})")
    out("Per-status breakdown:")
    for status, n in sorted(statuses.items(), key=lambda kv: (-kv[1], kv[0])):
        out(f"  {n:>4}  {status}")
    breakdown = sum(statuses.values())
    out(f"  {breakdown:>4}  = sum of the breakdown ({'matches' if breakdown == mine else 'DOES NOT MATCH'} the total)")
    tool = {s["status"]: s["count"] for s in summary["byStatus"]}
    if dict(statuses) != tool:
        out(f"  ! tracker_sync's breakdown differs: {tool}")

    dups = summary["duplicates"]
    out(f"Possible duplicates (same Company + Role; kept in the total): {len(dups)}")
    for d in dups:
        out(f"  ! {d['company']} — {d['role'] or '(no role)'}: rows {', '.join(map(str, d['rows']))}")
    extra = ledger.untracked_rows()
    out(f"Rows in applied_tracker.csv that the tracker does not have (not counted): {len(extra)}")
    for r in extra[:15]:
        out(f"  - {r.get('Company')} — {r.get('Role') or '(no role)'} ({r.get('Timestamp')})")
    for issue in summary["formulaIssues"]:
        out(f"  ! Summary formula out of step: {issue}")

    numbers = {"independent": mine, "tracker_sync": summary["total"], "ledger": ledger.total}
    if sheet_cell is not None:
        numbers["summary cell"] = sheet_cell
    if args.expect is not None:
        numbers["expected"] = args.expect
    unchanged = sha256(path) == before
    out(f"Original workbook unchanged: {'yes' if unchanged else 'NO'}")
    ok = len(set(numbers.values())) == 1 and breakdown == mine and unchanged
    out(("OK: " if ok else "MISMATCH: ") + ", ".join(f"{k} {v}" for k, v in numbers.items()))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
