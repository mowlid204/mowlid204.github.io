#!/usr/bin/env python3
"""OPTIONAL logged-in discovery: LinkedIn's own content search, driven by a real browser.

Much better recall than search engines (LinkedIn lets you sort posts by date and search any
phrase), but LinkedIn's User Agreement forbids automation and accounts DO get restricted.
  * Use a secondary account you can afford to lose. Never the account you message prospects from.
  * A few searches per day, human-speed scrolling. This script does one page per search.
  * This file was written without a live account to test against; expect to adjust waits or the
    "Show more results" button text if LinkedIn changes the page.

Setup
  pip install playwright && playwright install chromium
  Log into LinkedIn in Chrome. DevTools > Application > Cookies > www.linkedin.com > copy `li_at`.

Usage
  LI_AT="AQEDAR..." python3 linkedin_login_search.py "AI receptionist" "anyone using AI to answer phones" --scrolls 12
  python3 li_intent.py fetch && python3 li_intent.py score && python3 li_intent.py enrich && python3 li_intent.py export

It appends post URLs to out/discovered.jsonl in the same format `li_intent.py discover` writes.
The post pages themselves are then fetched WITHOUT login by li_intent.py, so the account is only
used for the search page.
"""
import argparse
import json
import os
import random
import re
import sys
import time
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
URN_RE = re.compile(r"urn:li:(activity|ugcPost|share):(\d{15,25})")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("keywords", nargs="+", help="one or more search phrases (each is one LinkedIn search)")
    ap.add_argument("--out", default=str(HERE / "out"))
    ap.add_argument("--scrolls", type=int, default=10, help="how many times to scroll each results page")
    ap.add_argument("--max-posts", type=int, default=80, help="stop a search after this many posts")
    ap.add_argument("--headless", action="store_true", help="hide the browser (headed is less bot-like)")
    ap.add_argument("--recent", action="store_true", default=True, help="sort by date posted (default)")
    a = ap.parse_args()

    li_at = os.environ.get("LI_AT", "").strip()
    if not li_at:
        sys.exit("Set LI_AT to your li_at cookie value (see the docstring).")
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        sys.exit("pip install playwright && playwright install chromium")

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    disc_path = out / "discovered.jsonl"
    known = set()
    if disc_path.exists():
        for line in disc_path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                d = json.loads(line)
                known.add(d.get("activity_id") or d["url"])

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=a.headless, args=["--disable-blink-features=AutomationControlled"])
        ctx = browser.new_context(viewport={"width": 1280, "height": 900}, locale="en-US")
        ctx.add_cookies([{"name": "li_at", "value": li_at, "domain": ".linkedin.com", "path": "/",
                          "httpOnly": True, "secure": True, "sameSite": "None"}])
        page = ctx.new_page()
        total_new = 0
        for kw in a.keywords:
            url = ("https://www.linkedin.com/search/results/content/?keywords=" + urllib.parse.quote(kw)
                   + ("&sortBy=%22date_posted%22" if a.recent else ""))
            print(f"search: {kw}", flush=True)
            page.goto(url, wait_until="domcontentloaded", timeout=60000)
            time.sleep(random.uniform(4, 7))
            if any(x in page.url for x in ("/login", "/uas/", "authwall", "checkpoint")):
                sys.exit("LinkedIn asked for a login/checkpoint. The li_at cookie is invalid or the "
                         "account is being challenged. Stop and log in manually in a normal browser.")
            found = {}
            for i in range(a.scrolls):
                html = page.content()
                for kind, num in URN_RE.findall(html):
                    if num not in found:
                        found[num] = kind
                if len(found) >= a.max_posts:
                    break
                page.mouse.wheel(0, random.randint(1400, 2600))
                time.sleep(random.uniform(2.5, 5.5))
                try:
                    btn = page.get_by_role("button", name=re.compile("show more results", re.I))
                    if btn.count() and btn.first.is_visible():
                        btn.first.click()
                        time.sleep(random.uniform(2, 4))
                except Exception:
                    pass
                print(f"  scroll {i + 1}/{a.scrolls}: {len(found)} posts so far", flush=True)
            rows = []
            for num, kind in found.items():
                if num in known:
                    continue
                known.add(num)
                rows.append({"url": f"https://www.linkedin.com/feed/update/urn:li:{kind}:{num}",
                             "activity_id": num, "query": kw, "serp_title": "", "serp_snippet": "",
                             "source": "linkedin_search", "found_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")})
            with open(disc_path, "a", encoding="utf-8") as f:
                for r in rows:
                    f.write(json.dumps(r, ensure_ascii=False) + "\n")
            total_new += len(rows)
            print(f"  {len(rows)} new posts written (of {len(found)} seen)", flush=True)
            time.sleep(random.uniform(8, 15))
        browser.close()
    print(f"done: {total_new} new post URLs -> {disc_path}\nnext: python3 li_intent.py fetch")


if __name__ == "__main__":
    main()
