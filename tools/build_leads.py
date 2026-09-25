#!/usr/bin/env python3
"""Convert a lead-list CSV into a leads.js data file for the dialer/booking apps.

Usage:
  python3 tools/build_leads.py pest    path/to/pest.csv
  python3 tools/build_leads.py roofing path/to/roofing.csv

Writes <campaign>/leads.js.  Each campaign has its own file; nothing is shared.
"""
import csv, json, re, sys, datetime, pathlib

STATE_TZ = {
    "AB": "America/Edmonton",
    "AL": "America/Chicago", "AR": "America/Chicago", "CA": "America/Los_Angeles",
    "CO": "America/Denver", "GA": "America/New_York", "IA": "America/Chicago",
    "ID": "America/Boise", "IL": "America/Chicago", "IN": "America/Indiana/Indianapolis",
    "KS": "America/Chicago", "KY": "America/Chicago", "LA": "America/Chicago",
    "MI": "America/Detroit", "MN": "America/Chicago", "MO": "America/Chicago",
    "MT": "America/Denver", "ND": "America/Chicago", "NE": "America/Chicago",
    "NV": "America/Los_Angeles", "OH": "America/New_York", "OK": "America/Chicago",
    "OR": "America/Los_Angeles", "SC": "America/New_York", "SD": "America/Chicago",
    "TN": "America/New_York", "TX": "America/Chicago", "UT": "America/Denver",
    "WA": "America/Los_Angeles", "WI": "America/Chicago", "WY": "America/Denver",
    "FL": "America/New_York", "NC": "America/New_York", "VA": "America/New_York",
    "PA": "America/New_York", "NY": "America/New_York", "AZ": "America/Phoenix",
    "NM": "America/Denver", "MS": "America/Chicago", "BC": "America/Vancouver",
    "SK": "America/Regina", "MB": "America/Winnipeg", "ON": "America/Toronto",
}
# Cities that sit in a different zone than the rest of their state.
CITY_TZ = {
    ("ID", "coeur d alene"): "America/Los_Angeles", ("ID", "kellogg"): "America/Los_Angeles",
    ("ID", "hayden"): "America/Los_Angeles", ("ID", "post falls"): "America/Los_Angeles",
    ("ID", "sandpoint"): "America/Los_Angeles", ("ID", "moscow"): "America/Los_Angeles",
    ("ID", "lewiston"): "America/Los_Angeles", ("ID", "rathdrum"): "America/Los_Angeles",
    ("IN", "evansville"): "America/Chicago", ("IN", "boonville"): "America/Chicago",
    ("IN", "richland"): "America/Chicago", ("IN", "chandler"): "America/Chicago",
    ("IN", "newburgh"): "America/Chicago",
    ("TN", "memphis"): "America/Chicago", ("TN", "nashville"): "America/Chicago",
    ("SD", "rapid city"): "America/Denver",
    ("TX", "el paso"): "America/Denver",
}

def tz_for(state, city):
    return CITY_TZ.get((state, (city or "").strip().lower())) or STATE_TZ.get(state, "America/Chicago")

def digits(phone):
    return re.sub(r"\D", "", phone or "")

def clean(s):
    s = (s or "").strip()
    s = re.sub(r"<[^>]+>", " ", s)          # strip html the BBB scrape left behind
    s = re.sub(r"\s+", " ", s)
    return s

def pest_rows(reader):
    for r in reader:
        phone = clean(r.get("Main phone"))
        if not digits(phone):
            continue
        alt = re.findall(r"\(\d{3}\) \d{3}-\d{4}", r.get("Phone check", ""))
        alt = [a for a in alt if a != phone]
        yield {
            "rank": int(r.get("Rank") or 0),
            "tier": clean(r.get("Tier")),
            "owner": clean(r.get("Owner / Decision Maker")),
            "title": clean(r.get("Title")),
            "business": clean(r.get("Company")),
            "phone": phone,
            "phoneAlt": alt[0] if alt else "",
            "city": clean(r.get("City")),
            "state": "AB",
            "market": clean(r.get("Area")),
            "website": clean(r.get("Website")),
            "email": clean(r.get("Email (from site)")),
            "rating": clean(r.get("BBB rating")),
            "accredited": clean(r.get("BBB accredited")).lower() == "yes",
            "years": clean(r.get("Years in business")),
            "services": clean(r.get("Services (BBB)"))[:200],
            "notes": clean(r.get("Why qualified / notes")),
            "profile": clean(r.get("BBB / YP profile")),
        }

def roofing_rows(reader):
    for i, r in enumerate(reader, 1):
        phone = clean(r.get("Phone"))
        if not digits(phone):
            continue
        notes = clean(r.get("Notes"))
        m = re.search(r"tier ([A-Z]) \(([^)]+)\)", notes)
        rating = re.search(r"BBB ([A-F][+-]?)", notes)
        yield {
            "rank": i,
            "tier": m.group(1) if m else "",
            "owner": clean(r.get("Owner")),
            "title": "Owner" if clean(r.get("Owner")) else "",
            "business": clean(r.get("Business")),
            "phone": phone,
            "phoneAlt": "",
            "city": clean(r.get("City")),
            "state": clean(r.get("State")),
            "market": m.group(2) if m else "",
            "website": clean(r.get("Website")),
            "email": "",
            "rating": rating.group(1) if rating else "",
            "accredited": "accredited" in notes.lower(),
            "years": "",
            "services": "",
            "notes": notes + (f"; ad status: {clean(r.get('Ad Status'))}" if clean(r.get("Ad Status")) else ""),
            "profile": "",
        }

CAMPAIGNS = {
    "pest":    {"name": "Pest Control (Alberta)", "parser": pest_rows,    "prefix": "p"},
    "roofing": {"name": "Roofing (US)",           "parser": roofing_rows, "prefix": "r"},
}

def main():
    if len(sys.argv) != 3 or sys.argv[1] not in CAMPAIGNS:
        sys.exit(__doc__)
    campaign, src = sys.argv[1], sys.argv[2]
    cfg = CAMPAIGNS[campaign]
    with open(src, encoding="utf-8-sig", newline="") as f:
        leads = list(cfg["parser"](csv.DictReader(f)))
    seen = set()
    for l in leads:
        l["id"] = f"{cfg['prefix']}{digits(l['phone'])}"
        if l["id"] in seen:                       # same number twice -> keep both, distinct ids
            l["id"] += f"-{l['rank']}"
        seen.add(l["id"])
        l["tz"] = tz_for(l["state"], l["city"])
    out = pathlib.Path(__file__).resolve().parent.parent / campaign / "leads.js"
    meta = {"campaign": campaign, "name": cfg["name"], "count": len(leads),
            "generated": datetime.date.today().isoformat()}
    with open(out, "w", encoding="utf-8") as f:
        f.write("// Generated by tools/build_leads.py -- do not edit by hand.\n")
        f.write("window.LEAD_META = " + json.dumps(meta) + ";\n")
        f.write("window.LEADS = " + json.dumps(leads, ensure_ascii=False, separators=(",", ":")) + ";\n")
    print(f"wrote {out} ({len(leads)} leads)")

if __name__ == "__main__":
    main()
