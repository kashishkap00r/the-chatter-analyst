#!/usr/bin/env python3
"""
Download earnings call transcripts for the E-Waste Plotline.
Fetches PDFs from BSE corporate filings (Analyst/Investor Meet - Outcome).
Organizes downloads by category in transcripts/ewaste/.
"""

import os
import re
import time
import requests
from datetime import date, datetime
from pathlib import Path

# ── Configuration ─────────────────────────────────────────────────────────────

OUTPUT_DIR = Path(__file__).parent / "transcripts" / "ewaste"

BSE_ANN_URL = "https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w"
BSE_PDF_URL = "https://www.bseindia.com/xml-data/corpfiling/AttachHis/{guid}.pdf"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Referer": "https://www.bseindia.com/corporates/Ann.html",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
}

# Quarter date windows: (label, from_date_str, to_date_str)
# Concall months: Q4 results → Apr-May, Q1 → Jul-Aug, Q2 → Oct-Nov, Q3 → Jan-Feb
QUARTERS = [
    ("Q4_FY23", "20230401", "20230630"),  # concalls Apr-Jun 2023
    ("Q1_FY24", "20230701", "20230930"),  # concalls Jul-Sep 2023
    ("Q2_FY24", "20231001", "20231231"),  # concalls Oct-Dec 2023
    ("Q3_FY24", "20240101", "20240331"),  # concalls Jan-Mar 2024
    ("Q4_FY24", "20240401", "20240630"),  # concalls Apr-Jun 2024
    ("Q1_FY25", "20240701", "20240930"),  # concalls Jul-Sep 2024
    ("Q2_FY25", "20241001", "20241231"),  # concalls Oct-Dec 2024
    ("Q3_FY25", "20250101", "20250331"),  # concalls Jan-Mar 2025
    ("Q4_FY25", "20250401", "20250630"),  # concalls Apr-Jun 2025
    ("Q1_FY26", "20250701", "20250930"),  # concalls Jul-Sep 2025
    ("Q2_FY26", "20251001", "20251231"),  # concalls Oct-Dec 2025
    ("Q3_FY26", "20260101", "20260415"),  # concalls Jan-Apr 2026
]

# ── Company definitions per category ──────────────────────────────────────────

CATEGORIES = [
    {
        "name": "EMS_Players",
        "start": "Q1_FY24",
        "end": "Q3_FY26",
        "companies": [
            {"name": "Dixon_Technologies",  "bse": "540699"},
            {"name": "Amber_Enterprises",   "bse": "540902"},
            {"name": "Kaynes_Technology",   "bse": "543664"},
            {"name": "Syrma_SGS",           "bse": "543573"},
            {"name": "PG_Electroplast",     "bse": "533581"},
        ],
    },
    {
        "name": "Consumer_Electronics",
        "start": "Q4_FY23",
        "end": "Q3_FY26",
        "companies": [
            {"name": "Havells_India",       "bse": "517354"},
            {"name": "Voltas",              "bse": "500575"},
            {"name": "Blue_Star",           "bse": "500067"},
            {"name": "Whirlpool_India",     "bse": "500238"},
            {"name": "Bajaj_Electricals",   "bse": "500031"},
            {"name": "Orient_Electric",     "bse": "541301"},
            {"name": "VGuard_Industries",   "bse": "532953"},
        ],
    },
    {
        "name": "Cables_and_Wires",
        "start": "Q2_FY24",
        "end": "Q3_FY26",
        "companies": [
            {"name": "Polycab_India",       "bse": "542652"},
            {"name": "KEI_Industries",      "bse": "517569"},
            {"name": "Finolex_Cables",      "bse": "500144"},
        ],
    },
    {
        "name": "Battery_Companies",
        "start": "Q4_FY23",
        "end": "Q3_FY26",
        "companies": [
            {"name": "Exide_Industries",    "bse": "500086"},
            {"name": "Amara_Raja_Energy",   "bse": "500008"},
            {"name": "HBL_Power_Systems",   "bse": "517271"},
        ],
    },
    {
        "name": "Metals_and_Upstream",
        "start": "Q1_FY24",
        "end": "Q3_FY26",
        "companies": [
            {"name": "Vedanta",             "bse": "500295"},
            {"name": "Hindustan_Zinc",      "bse": "500188"},
            {"name": "Hindalco_Industries", "bse": "500440"},
            {"name": "MSTC",               "bse": "542597"},
        ],
    },
    {
        "name": "EV_Companies",
        "start": "Q2_FY24",
        "end": "Q3_FY26",
        # Ola Electric listed Aug 2024, so only from Q2_FY25
        "companies": [
            {"name": "Tata_Motors",         "bse": "500570"},
            {"name": "Mahindra_and_Mahindra","bse": "500520"},
            {"name": "Ola_Electric",        "bse": "544225", "start_override": "Q2_FY25"},
        ],
    },
    {
        "name": "Solar_Companies",
        "start": "Q3_FY25",
        "end": "Q3_FY26",
        "companies": [
            {"name": "Adani_Green_Energy",  "bse": "541450"},
            {"name": "Tata_Power",          "bse": "500400"},
            {"name": "Waaree_Energies",     "bse": "544277"},
            {"name": "Premier_Energies",    "bse": "544238"},
        ],
    },
]

# Special overrides from plan notes
COMPANY_END_OVERRIDES = {
    "500238": "Q4_FY24",  # Whirlpool India – delisted 2024, stop at Q4 FY24
}

# ── Quarter helpers ────────────────────────────────────────────────────────────

QUARTER_LABELS = [q[0] for q in QUARTERS]

def quarter_index(label):
    return QUARTER_LABELS.index(label)

def quarters_in_range(start_label, end_label):
    s, e = quarter_index(start_label), quarter_index(end_label)
    return QUARTERS[s : e + 1]

# ── BSE API helpers ────────────────────────────────────────────────────────────

def fetch_announcements(bse_code, from_date, to_date, retries=3):
    """Fetch all 'Analyst / Investor Meet - Outcome' announcements for a BSE code within date range."""
    all_items = []
    for page in range(1, 30):  # max 30 pages
        params = {
            "pageno": page,
            "strCat": "-1",
            "strPrevDate": from_date,
            "strScrip": bse_code,
            "strSearch": "P",
            "strToDate": to_date,
            "strType": "C",
            "subcategory": -1,
        }
        for attempt in range(retries):
            try:
                r = requests.get(BSE_ANN_URL, params=params, headers=HEADERS, timeout=30)
                r.raise_for_status()
                items = r.json().get("Table", [])
                break
            except Exception as e:
                if attempt == retries - 1:
                    print(f"    [WARN] Page {page} failed after {retries} attempts: {e}")
                    return all_items
                time.sleep(2 ** attempt)
        if not items:
            break
        all_items.extend(items)
        if len(items) < 50:
            break
        time.sleep(0.5)
    return all_items


def is_earnings_concall(newssub):
    """Return True if the announcement subject looks like an earnings/quarterly concall."""
    s = newssub.lower()
    # Must be an outcome (not just intimation/notice)
    if "outcome" not in s and "transcript" not in s and "proceeding" not in s and "recording" not in s:
        return False
    # Must be analyst/investor meet related
    if "analyst" not in s and "investor" not in s and "con. call" not in s and "concall" not in s and "conference" not in s:
        return False
    return True


def download_pdf(guid, dest_path, retries=3):
    """Download a BSE PDF by GUID to dest_path. Returns True on success."""
    url = BSE_PDF_URL.format(guid=guid)
    for attempt in range(retries):
        try:
            r = requests.get(url, headers={**HEADERS, "Accept": "application/pdf"}, timeout=60, stream=True)
            if r.status_code == 200 and "pdf" in r.headers.get("Content-Type", "").lower():
                with open(dest_path, "wb") as f:
                    for chunk in r.iter_content(chunk_size=8192):
                        f.write(chunk)
                return True
            else:
                print(f"    [WARN] Unexpected response: {r.status_code} {r.headers.get('Content-Type')}")
        except Exception as e:
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
            else:
                print(f"    [ERROR] Download failed: {e}")
    return False

# ── Main ──────────────────────────────────────────────────────────────────────

def run():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    total_downloaded = 0
    total_skipped = 0
    total_missing = 0

    for category in CATEGORIES:
        cat_dir = OUTPUT_DIR / category["name"]
        cat_dir.mkdir(exist_ok=True)
        print(f"\n{'='*60}")
        print(f"Category: {category['name']}")
        print(f"{'='*60}")

        cat_start = category["start"]
        cat_end = category["end"]

        for company in category["companies"]:
            co_name = company["name"]
            bse_code = company["bse"]
            # Respect per-company overrides
            start_label = company.get("start_override", cat_start)
            end_label = COMPANY_END_OVERRIDES.get(bse_code, cat_end)

            print(f"\n  {co_name} (BSE {bse_code}) — {start_label} → {end_label}")

            qtrs = quarters_in_range(start_label, end_label)
            # Batch: fetch announcements once for the full range
            full_from = qtrs[0][1]
            full_to = qtrs[-1][2]

            print(f"    Fetching announcements {full_from}–{full_to} ...")
            time.sleep(1)
            all_ann = fetch_announcements(bse_code, full_from, full_to)
            print(f"    Total announcements found: {len(all_ann)}")

            # Filter for earnings concalls only
            concalls = [a for a in all_ann if is_earnings_concall(a.get("NEWSSUB", ""))]
            print(f"    Concall-like outcomes: {len(concalls)}")

            # For each quarter, find the best matching concall
            for q_label, q_from, q_to in qtrs:
                q_from_dt = datetime.strptime(q_from, "%Y%m%d").date()
                q_to_dt = datetime.strptime(q_to, "%Y%m%d").date()

                # Find concalls within this quarter window
                candidates = []
                for ann in concalls:
                    dt_str = ann.get("DT_TM", "")[:10]
                    try:
                        ann_dt = datetime.strptime(dt_str, "%Y-%m-%d").date()
                    except:
                        continue
                    if q_from_dt <= ann_dt <= q_to_dt:
                        candidates.append((ann_dt, ann))

                dest_path = cat_dir / f"{co_name}_{q_label}.pdf"

                if dest_path.exists():
                    print(f"    [SKIP] {dest_path.name} already exists")
                    total_skipped += 1
                    continue

                if not candidates:
                    print(f"    [MISS] {co_name} {q_label} — no concall found in BSE filings")
                    total_missing += 1
                    continue

                # Pick the most recent candidate in this window (latest announcement date)
                candidates.sort(key=lambda x: x[0], reverse=True)
                best_dt, best_ann = candidates[0]
                guid = best_ann.get("ATTACHMENTNAME", "").replace(".pdf", "").strip()
                newssub = best_ann.get("NEWSSUB", "")[:80]

                print(f"    [DL]   {dest_path.name}  ({best_dt}  {newssub})")

                if not guid:
                    print(f"    [WARN] No GUID found for {co_name} {q_label}")
                    total_missing += 1
                    continue

                success = download_pdf(guid, dest_path)
                if success:
                    size_kb = dest_path.stat().st_size // 1024
                    print(f"           → {size_kb} KB")
                    total_downloaded += 1
                else:
                    print(f"           → FAILED")
                    if dest_path.exists():
                        dest_path.unlink()
                    total_missing += 1

                time.sleep(0.75)  # be polite to BSE

    print(f"\n{'='*60}")
    print(f"DONE")
    print(f"  Downloaded : {total_downloaded}")
    print(f"  Skipped    : {total_skipped} (already existed)")
    print(f"  Missing    : {total_missing} (no BSE filing found)")
    print(f"  Output dir : {OUTPUT_DIR}")


if __name__ == "__main__":
    run()
