#!/usr/bin/env python3
"""LinkedIn intent-lead finder (no LinkedIn login required).

Finds public LinkedIn posts where someone is asking about, or struggling with, AI / phone
answering for a service business; scores every author and commenter for BUYER intent vs.
VENDOR noise vs. home-service ICP fit; then tries to find a phone number so the person can be
called with the dialer in this repo.

Pipeline (each step reads the previous step's file, so you can re-run any step alone):

  discover   search engines -> public LinkedIn post URLs            out/discovered.jsonl
  fetch      public post pages -> text, author, date, comments      out/posts.jsonl
  score      rules -> one row per person with intent/vendor/ICP     out/leads.csv
  enrich     headline, company, website, phone for the top rows     out/leads.csv (updated)
  export     rows with a phone, in the dialer's import format       out/dialer_import.csv
  run        all of the above in order

  python3 li_intent.py run                      # default query pack, top 40 enriched
  python3 li_intent.py run --per-query 25 --enrich-top 60
  python3 li_intent.py discover --query 'site:linkedin.com/posts "AI receptionist" "anyone"'
  python3 li_intent.py score --min-tier B

Nothing here logs into LinkedIn. Post pages are fetched the way a search-engine visitor sees
them (they carry the post text, author and comments in JSON-LD). Profile pages are login-walled,
so the author's title/company comes from a web search of their name instead.
See README.md for limits, rate-limit behaviour and the legal notes.
"""
import argparse
import csv
import hashlib
import html as htmlmod
import json
import random
import re
import sys
import time
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

import requests
from bs4 import BeautifulSoup

HERE = Path(__file__).resolve().parent
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
HEADERS = {"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9",
           "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"}

POST_URL_RE = re.compile(
    r"https?://(?:[a-z]{2,3}\.)?linkedin\.com/(?:posts/[^\s?#\"'<>]+|feed/update/urn:li:(?:activity|ugcPost|share):\d+)",
    re.I)
ACTIVITY_RE = re.compile(r"(?:activity|ugcPost|share)[-:](\d{15,25})")
PROFILE_SLUG_RE = re.compile(r"linkedin\.com/(in|company)/([^/?#]+)", re.I)

# ----------------------------------------------------------------------------------------------
# Signal tables.  (phrase, weight).  Phrases are matched on lower-cased text with straight quotes.
# Keep them explainable: every lead row carries the list of phrases that fired.
# ----------------------------------------------------------------------------------------------
INTENT = [  # someone asking for help / shopping / describing the pain in first person
    ("how do i", 3), ("how do you", 2), ("how can i", 3), ("how would i", 3), ("how do we", 2),
    ("anyone using", 3), ("anyone use", 3), ("anyone tried", 3), ("anyone have", 2), ("anyone know", 3),
    ("has anyone", 3), ("does anyone", 3), ("is anyone", 2), ("anybody", 2),
    ("recommend?", 3), ("recommendations?", 3), ("any recommendations", 3), ("anyone recommend", 3),
    ("can anyone recommend", 3), ("recommend a ", 2), ("recommend an ", 2), ("who do you recommend", 3),
    ("what do you recommend", 3), ("suggestions?", 2), ("any suggestions", 2), ("any advice", 3), ("advice?", 2),
    ("thoughts?", 2), ("opinions", 1), ("pros and cons", 2),
    ("looking for", 2), ("looking into", 2), ("thinking about", 2), ("considering", 2), ("exploring", 1),
    ("evaluating", 2), ("shopping for", 3), ("comparing", 2),
    ("should i", 2), ("should we", 2), ("worth it", 2), ("is it worth", 3),
    ("where to start", 3), ("where do i start", 3), ("where do we start", 3), ("where would i start", 3),
    ("don't know where", 3), ("not sure where", 3), ("not sure how", 2), ("no idea how", 3), ("no clue", 2),
    ("help me", 2), ("need help", 3), ("what are you using", 3), ("what do you use", 3),
    ("what do you guys use", 3), ("what does everyone use", 3), ("which one", 1), ("curious", 1),
    ("trying to figure out", 3), ("figure out", 1), ("am i missing", 2), ("wondering", 2),
    ("question for", 2), ("quick question", 2), ("honest question", 3), ("dumb question", 3),
    ("we tried", 1), ("we're testing", 1), ("we are testing", 1), ("overwhelmed", 2), ("confused", 2),
    ("struggling", 2), ("frustrated", 2), ("can't keep up", 2), ("keep missing", 3), ("missing calls", 2),
    ("losing calls", 3), ("losing jobs", 3), ("lost a job", 3), ("lost jobs", 2),
    ("goes to voicemail", 3), ("went to voicemail", 3), ("straight to voicemail", 3),
    ("nobody answers", 3), ("no one answers", 3), ("can't answer", 2), ("couldn't answer", 2),
]
TOPIC = [  # the thing they would be asking about
    ("ai receptionist", 3), ("ai answering", 3), ("ai phone", 3), ("ai voice", 2), ("ai agent", 1),
    ("ai assistant", 1), ("ai for my", 3), ("ai for our", 3), ("ai in my", 2), ("ai in our", 2),
    ("use ai", 1), ("using ai", 1), ("implement ai", 2), ("implementing ai", 2), ("ai tools", 1),
    ("ai tool", 1), ("automation", 1), ("chatbot", 1), ("voice agent", 2), ("voice ai", 2),
    ("answer the phone", 3), ("answer our phones", 3), ("answer my phone", 3), ("answering the phone", 2),
    ("answer calls", 2), ("answering calls", 2), ("answering service", 3), ("virtual receptionist", 3),
    ("receptionist", 2), ("call answering", 3), ("missed call", 3), ("missed calls", 3),
    ("after hours", 2), ("after-hours", 2), ("voicemail", 2), ("phone system", 2), ("phones", 1),
    ("inbound calls", 2), ("call volume", 2), ("on hold", 1), ("front desk", 2), ("office staff", 1),
    ("csr", 1), ("dispatcher", 1), ("dispatch", 1), ("booking", 1), ("appointment", 1),
]
ICP = [  # home-service operator language (also applied to the headline, doubled)
    ("roofing", 3), ("roofer", 3), ("roofs", 1), ("hvac", 3), ("heating and cooling", 3),
    ("heating & cooling", 3), ("air conditioning", 2), ("furnace", 2), ("plumbing", 3), ("plumber", 3),
    ("drain", 1), ("water heater", 2), ("electrical", 2), ("electrician", 3), ("contractor", 2),
    ("contractors", 1), ("home service", 3), ("home services", 3), ("trades", 1), ("restoration", 1),
    ("landscaping", 1), ("pest control", 1), ("garage door", 1), ("remodel", 1), ("exteriors", 2),
    ("siding", 2), ("gutters", 2), ("mechanical", 1),
    ("our techs", 3), ("our technicians", 3), ("our crew", 3), ("our crews", 3), ("our office", 3),
    ("our csr", 3), ("our dispatcher", 3), ("our receptionist", 3), ("my office", 2), ("my techs", 3),
    ("my crew", 3), ("my guys", 2), ("in the field", 2), ("on the job", 1), ("on a roof", 3),
    ("service calls", 2), ("estimates", 2), ("estimate requests", 2), ("installs", 1), ("service area", 1),
    ("our customers", 1), ("my customers", 2), ("homeowners", 1), ("my business", 2), ("our business", 1),
    ("my company", 2), ("our company", 1), ("family-owned", 2), ("family owned", 2), ("years in business", 1),
    ("trucks", 1), ("my shop", 2), ("our shop", 2),
]
VENDOR = [  # people selling, not buying (subtracted)
    ("we help", 3), ("i help", 3), ("we built", 2), ("we build", 2), ("we've built", 2), ("i built", 2),
    ("our ai", 3), ("our platform", 3), ("our solution", 3), ("our product", 3), ("our software", 3),
    ("our clients", 3), ("my clients", 3), ("our client", 2), ("client of ours", 2),
    ("book a demo", 4), ("book a call", 3), ("free demo", 3), ("free trial", 3), ("free audit", 3),
    ("dm me", 3), ("dm us", 3), ("message me", 2), ("link in comments", 3), ("link in the comments", 3),
    ("link below", 2), ("link in bio", 3), ("introducing", 3), ("launching", 3), ("we just launched", 3),
    ("just launched", 3), ("we're launching", 3), ("now live", 2), ("case study", 2), ("get started today", 3),
    ("sign up", 2), ("schedule a call", 3), ("contact us", 2), ("learn more", 2), ("reach out", 1),
    ("we offer", 3), ("we provide", 3), ("we specialize", 3), ("our service", 2), ("our services", 2),
    ("our team can", 2), ("agency", 2), ("saas", 2), ("white label", 3), ("white-label", 3),
    ("reseller", 2), ("partner with us", 3), ("for hvac companies", 2), ("for roofing companies", 2),
    ("for plumbing companies", 2), ("for contractors", 1), ("for home service", 2),
    ("for service businesses", 2), ("for small businesses", 2), ("your business", 2), ("your team", 1),
    ("your calls", 2), ("your customers", 1), ("your phone", 1), ("your leads", 2), ("your competitors", 2),
    ("stop losing", 2), ("never miss", 2), ("24/7", 1), ("roi", 1), ("booked jobs", 1),
    ("#ai", 1), ("#aiautomation", 2), ("#aiagents", 2), ("#aiagent", 2), ("#aivoiceagent", 3),
    ("#aireceptionist", 3), ("#automation", 1), ("#saas", 2), ("#leadgeneration", 2), ("#leadgen", 2),
    ("#voiceai", 3), ("#chatbot", 1), ("founder", 1), ("co-founder", 1), ("cofounder", 1),
    ("comment \"", 2), ("comment '", 2), ("drop a", 2),  # "comment 'AI' and I'll send you..."
    # content marketing: telling owners what "the best companies" do
    ("here's the blueprint", 3), ("here's how", 2), ("here's what", 2), ("here's the", 1), ("blueprint", 2),
    ("playbook", 2), ("framework", 2), ("the shops that", 2), ("the companies that", 2), ("most owners", 2),
    ("most contractors", 2), ("most companies", 2), ("most businesses", 2), ("most hvac", 2),
    ("i spent the last", 2), ("i've worked with", 3), ("we've worked with", 3), ("i've seen", 1),
    ("we've seen", 1), ("we've helped", 3), ("helped a ", 2), ("one of my clients", 3), ("a client of mine", 3),
    ("if you're a ", 2), ("if you run a", 2), ("if you own a", 2), ("business owner and operator", 2),
    ("hemorrhaging", 2), ("leaving money on the table", 2), ("lesson", 1), ("the truth is", 1),
    ("i get asked", 2), ("people ask me", 2), ("in my experience", 1),
]
HEADLINE_OWNER = [
    ("owner", 4), ("co-owner", 4), ("president", 3), ("general manager", 3), ("operations manager", 3),
    ("ops manager", 3), ("office manager", 3), ("service manager", 2), ("managing partner", 2),
    ("principal", 1), ("ceo", 1), ("founder", 1), ("vice president", 2), ("vp ", 1), ("partner", 1),
]
HEADLINE_VENDOR = [
    ("ai ", 3), ("a.i.", 3), ("automation", 3), ("agency", 3), ("saas", 3), ("software", 2),
    ("marketing", 3), ("consultant", 2), ("consulting", 2), ("coach", 3), ("growth", 2), ("lead gen", 3),
    ("lead generation", 3), ("digital", 2), ("technology", 1), ("developer", 2), ("engineer", 1),
    ("voice", 2), ("answering service", 4), ("call center", 3), ("virtual assistant", 3), ("chatbot", 3),
    ("gpt", 3), ("llm", 3), ("recruiter", 3), ("real estate", 2), ("investor", 2), ("speaker", 2),
    ("student", 3), ("intern", 3), ("freelance", 2), ("upwork", 3), ("fiverr", 3),
    ("telecom", 3), ("intake", 2), ("capital", 2), ("ventures", 2), ("solutions", 1), ("systems", 1),
    ("helping businesses", 3), ("helping companies", 3), ("i help", 3),
]
BLOCK_DOMAINS = (
    "linkedin.", "facebook.", "instagram.", "yelp.", "bbb.org", "yellowpages", "mapquest", "indeed.",
    "glassdoor", "crunchbase", "zoominfo", "angi.", "homeadvisor", "thumbtack", "houzz", "x.com",
    "twitter.", "youtube.", "tiktok.", "wikipedia", "apollo.io", "rocketreach", "signalhire", "contactout",
    "manta.", "dnb.com", "buzzfile", "chamberofcommerce", "birdeye", "nextdoor", "porch.", "bark.com",
    "google.", "bing.", "duckduckgo", "pinterest", "reddit.", "opencorporates", "bizapedia", "buildzoom",
    "yellowpages", "superpages", "citysearch", "foursquare", "trustpilot", "sitejabber",
)

# ----------------------------------------------------------------------------------------------
# small helpers
# ----------------------------------------------------------------------------------------------
def log(msg):
    try:
        print(msg, flush=True)
    except BrokenPipeError:        # output piped into `head` etc.
        sys.exit(0)


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def norm(text):
    t = htmlmod.unescape(text or "")
    t = t.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    t = re.sub(r"\s+", " ", t).strip().lower()
    return t


def digits(s):
    return re.sub(r"\D", "", s or "")


def read_jsonl(path):
    if not Path(path).exists():
        return []
    out = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out


def append_jsonl(path, rows):
    with open(path, "a", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


def write_jsonl(path, rows):
    with open(path, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


def read_csv(path):
    if not Path(path).exists():
        return []
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def write_csv(path, rows, cols):
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow({c: r.get(c, "") for c in cols})


def polite_sleep(base):
    time.sleep(base + random.uniform(0, base * 0.6))


def normalize_post_url(url):
    url = htmlmod.unescape(url).split("?")[0].split("#")[0].rstrip("/")
    url = re.sub(r"^https?://(?:[a-z]{2,3}\.)?linkedin\.com", "https://www.linkedin.com", url, flags=re.I)
    return url


def activity_id(url):
    m = ACTIVITY_RE.search(url or "")
    return m.group(1) if m else ""


def profile_slug(url):
    m = PROFILE_SLUG_RE.search(url or "")
    return m.group(2) if m else ""


# ----------------------------------------------------------------------------------------------
# network
# ----------------------------------------------------------------------------------------------
class Net:
    def __init__(self, out_dir, search_sleep=3.0, fetch_sleep=2.5):
        self.cache = Path(out_dir) / "cache"
        self.cache.mkdir(parents=True, exist_ok=True)
        self.search_sleep = search_sleep
        self.fetch_sleep = fetch_sleep
        self.session = requests.Session()
        self.session.headers.update(HEADERS)
        self._ddgs = None
        self.search_calls = 0
        self.fetch_calls = 0

    def search(self, query, n=20):
        """Web search via the ddgs package (rotates several engines). Cached on disk per query."""
        key = hashlib.md5(f"{query}|{n}".encode()).hexdigest()
        cf = self.cache / f"search_{key}.json"
        if cf.exists():
            return json.loads(cf.read_text(encoding="utf-8"))
        if self._ddgs is None:
            from ddgs import DDGS  # imported lazily so fetch/score work without it
            self._ddgs = DDGS()
        last_err = ""
        # "auto" rotates engines; when it reports no results, Bing alone often still answers
        # operator-heavy queries (site: + several quoted phrases), so try it explicitly.
        for backend in ("auto", "bing"):
            for attempt in range(2):
                try:
                    self.search_calls += 1
                    res = self._ddgs.text(query, max_results=n, backend=backend)
                    out = [{"title": r.get("title", ""), "href": r.get("href", ""), "body": r.get("body", "")}
                           for r in res]
                    if out:
                        cf.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
                        polite_sleep(self.search_sleep)
                        return out
                    break
                except Exception as e:  # ddgs raises on "No results" and on rate limits
                    last_err = f"{type(e).__name__}: {e}"
                    if "no results" in str(e).lower():
                        break
                    wait = 8 * (attempt + 1)
                    log(f"    search error ({last_err[:80]}), retrying in {wait}s")
                    time.sleep(wait)
            polite_sleep(self.search_sleep / 2)
        # empty results are not cached, so a later run retries them
        return []

    def get(self, url, timeout=25, sleep=True, backoff=True):
        """GET with browser headers, backoff on 429/999/403. Returns Response or None.
        backoff=False returns the blocked response immediately instead of waiting."""
        for attempt in range(3):
            try:
                self.fetch_calls += 1
                r = self.session.get(url, timeout=timeout, allow_redirects=True)
            except requests.RequestException as e:
                log(f"    network error {type(e).__name__} on {url[:80]}")
                time.sleep(3)
                continue
            if r.status_code in (429, 999, 403):
                if not backoff:
                    return r
                wait = 30 * (attempt + 1)
                log(f"    HTTP {r.status_code} from {urllib.parse.urlsplit(url).netloc}: backing off {wait}s")
                time.sleep(wait)
                continue
            if sleep:
                polite_sleep(self.fetch_sleep)
            return r
        return None


# ----------------------------------------------------------------------------------------------
# discover
# ----------------------------------------------------------------------------------------------
def load_queries(path):
    qs = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            qs.append(line)
    return qs


def cmd_discover(a, net):
    out = Path(a.out) / "discovered.jsonl"
    known = {d.get("activity_id") or d["url"]: d for d in read_jsonl(out)}
    queries = [a.query] if a.query else load_queries(a.queries)
    log(f"discover: {len(queries)} queries, {a.per_query} results each, {len(known)} posts already known")
    new = []
    for i, q in enumerate(queries, 1):
        res = net.search(q, a.per_query)
        hits, batch = 0, []
        for r in res:
            m = POST_URL_RE.search(r.get("href", ""))
            if not m:
                continue
            url = normalize_post_url(m.group(0))
            aid = activity_id(url)
            key = aid or url
            if key in known:
                continue
            row = {"url": url, "activity_id": aid, "query": q, "serp_title": r.get("title", ""),
                   "serp_snippet": r.get("body", ""), "source": "web_search", "found_at": now_iso()}
            known[key] = row
            new.append(row)
            batch.append(row)
            hits += 1
        if batch:
            append_jsonl(out, batch)          # save after every query so a crash loses nothing
        log(f"  [{i}/{len(queries)}] {len(res):2d} results, {hits:2d} new posts  <- {q[:70]}")
    log(f"discover: {len(new)} new post URLs (total {len(known)}) -> {out}")


# ----------------------------------------------------------------------------------------------
# fetch
# ----------------------------------------------------------------------------------------------
def _ld_posting(soup):
    for s in soup.find_all("script", type="application/ld+json"):
        try:
            d = json.loads(s.string or "")
        except Exception:
            continue
        items = d.get("@graph", [d]) if isinstance(d, dict) else (d if isinstance(d, list) else [])
        for it in items:
            if isinstance(it, dict) and it.get("@type") in ("SocialMediaPosting", "DiscussionForumPosting"):
                return it
    return None


def _count(stat, kind):
    if isinstance(stat, dict):
        stat = [stat]
    for s in stat or []:
        if isinstance(s, dict) and kind.lower() in str(s.get("interactionType", "")).lower():
            try:
                return int(s.get("userInteractionCount") or 0)
            except (TypeError, ValueError):
                return 0
    return 0


def parse_post(url, html_text):
    soup = BeautifulSoup(html_text, "lxml")
    ld = _ld_posting(soup) or {}
    title = ""
    og = soup.find("meta", property="og:title")
    if og:
        title = og.get("content", "")
    cands = [ld.get("articleBody", ""), ld.get("text", ""), ld.get("headline", "")]
    md = soup.find("meta", attrs={"name": "description"})
    if md:
        cands.append(md.get("content", ""))
    for sel in ('p[data-test-id="main-feed-activity-card__commentary"]', "p.attributed-text-segment-list__content"):
        el = soup.select_one(sel)
        if el:
            cands.append(el.get_text("\n", strip=True))
    text = max((htmlmod.unescape(c or "") for c in cands), key=len, default="").strip()

    author = ld.get("author") or {}
    if isinstance(author, list):
        author = author[0] if author else {}
    a_name = (author.get("name") or "").strip()
    a_url = normalize_profile(author.get("url") or "")
    a_type = author.get("@type") or ""
    if not a_name:
        el = soup.select_one('a[data-tracking-control-name="public_post_feed-actor-name"]')
        if el:
            a_name = el.get_text(" ", strip=True)
            a_url = normalize_profile(el.get("href", ""))
            a_type = "Organization" if "/company/" in a_url else "Person"
    if not a_type and a_url:
        a_type = "Organization" if "/company/" in a_url else "Person"

    comments = []
    for sec in soup.select("section.comment"):
        link = sec.select_one('a[data-tracking-control-name="public_post_comment_actor-name"]')
        body = sec.select_one("p.attributed-text-segment-list__content")
        if not link:
            continue
        c_url = normalize_profile(link.get("href", ""))
        comments.append({"name": link.get_text(" ", strip=True), "url": c_url,
                         "type": "Organization" if "/company/" in c_url else "Person",
                         "text": htmlmod.unescape(body.get_text("\n", strip=True)) if body else ""})
    if not comments:  # fall back to JSON-LD comments (no profile URL there)
        for c in ld.get("comment") or []:
            if isinstance(c, dict):
                au = c.get("author") or {}
                comments.append({"name": au.get("name", ""), "url": "", "type": au.get("@type", ""),
                                 "text": htmlmod.unescape(c.get("text", ""))})

    lnkd = soup.find("meta", attrs={"name": "lnkd:url"})
    aid = activity_id(url) or activity_id(lnkd.get("content", "") if lnkd else "")
    return {
        "url": url, "activity_id": aid, "title": title, "text": text,
        "author_name": a_name, "author_url": a_url, "author_type": a_type,
        "date": (ld.get("datePublished") or "")[:10],
        "likes": _count(ld.get("interactionStatistic"), "Like"),
        "comment_count": _count(ld.get("interactionStatistic"), "Comment") or int(ld.get("commentCount") or 0),
        "comments": comments, "walled": not (text or a_name), "fetched_at": now_iso(),
    }


def normalize_profile(url):
    url = htmlmod.unescape(url or "").split("?")[0].rstrip("/")
    return re.sub(r"^https?://(?:[a-z]{2,3}\.)?linkedin\.com", "https://www.linkedin.com", url, flags=re.I)


def cmd_fetch(a, net):
    disc = read_jsonl(Path(a.out) / "discovered.jsonl")
    posts_path = Path(a.out) / "posts.jsonl"
    posts = read_jsonl(posts_path)
    have = {p.get("activity_id") or p["url"] for p in posts if not (a.refetch and p.get("walled"))}
    todo = [d for d in disc if (d.get("activity_id") or d["url"]) not in have]
    todo = todo[: a.max_posts]
    log(f"fetch: {len(todo)} posts to fetch ({len(have)} already fetched)")
    walled_streak = 0
    new = []
    for i, d in enumerate(todo, 1):
        r = net.get(d["url"])
        if r is None:
            log(f"  [{i}] gave up on {d['url'][:90]}")
            continue
        final = r.url or d["url"]
        if r.status_code != 200 or "/uas/login" in final or "authwall" in final or "/login" in final:
            p = {"url": d["url"], "activity_id": d.get("activity_id", ""), "walled": True,
                 "http": r.status_code, "final_url": final, "fetched_at": now_iso()}
            walled_streak += 1
        else:
            p = parse_post(d["url"], r.text)
            walled_streak = walled_streak + 1 if p["walled"] else 0
        p["query"] = d.get("query", "")
        p["serp_title"] = d.get("serp_title", "")
        p["source"] = d.get("source", "")
        new.append(p)
        tag = "WALLED" if p.get("walled") else f"{(p.get('author_name') or '?')[:28]:28s} {len(p.get('text', '')):4d} chars {len(p.get('comments', [])):2d} comments"
        log(f"  [{i}/{len(todo)}] {tag}  {d['url'][:80]}")
        if walled_streak >= 8:
            log("fetch: 8 login-walled pages in a row. LinkedIn is probably rate-limiting this IP; "
                "stopping now. Wait an hour (or change network) and run fetch again.")
            break
    if new:
        append_jsonl(posts_path, new)
    ok = sum(1 for p in new if not p.get("walled"))
    log(f"fetch: {ok} posts parsed, {len(new) - ok} walled/failed -> {posts_path}")


# ----------------------------------------------------------------------------------------------
# score
# ----------------------------------------------------------------------------------------------
def signals(text, table, cap=2):
    t = " " + norm(text) + " "
    score, hits = 0, []
    for phrase, w in table:
        n = t.count(phrase)
        if n:
            score += w * min(n, cap)
            hits.append(phrase)
    return score, hits


def score_text(text):
    """Intent / topic / ICP / vendor scores for one piece of text."""
    i, ih = signals(text, INTENT)
    t, th = signals(text, TOPIC)
    c, ch = signals(text, ICP)
    v, vh = signals(text, VENDOR)
    q = min(text.count("?"), 3)
    if q:
        i += q
        ih.append(f"{q}x?")
    bullets = len(re.findall(r"(?:^|\n)\s*(?:\d{1,2}[.):]|[-•▪️➡️✅→])\s", text))
    if bullets >= 4:
        v += 2
        vh.append(f"{bullets} list items")
    tags = len(re.findall(r"#\w+", text))
    if tags >= 8:
        v += 3
        vh.append(f"{tags} hashtags")
    elif tags >= 4:
        v += 2
        vh.append(f"{tags} hashtags")
    return {"intent": i, "topic": t, "icp": c, "vendor": v,
            "why": ih + [f"topic:{x}" for x in th] + [f"icp:{x}" for x in ch] + [f"VENDOR:{x}" for x in vh]}


def score_headline(headline):
    if not headline:
        return 0, 0, []
    o, oh = signals(headline, HEADLINE_OWNER, cap=1)
    c, ch = signals(headline, ICP, cap=1)
    v, vh = signals(headline, HEADLINE_VENDOR, cap=1)
    why = [f"hl:{x}" for x in oh] + [f"hl-icp:{x}" for x in ch] + [f"hl-VENDOR:{x}" for x in vh]
    return o + 2 * c, v, why


def tier_for(row):
    intent, vendor = int(row["intent_score"]), int(row["vendor_score"])
    total = int(row["total"])
    if row.get("author_type") == "Organization" and row.get("role") == "author":
        return "vendor"
    if vendor >= 6 and intent < 6:
        return "vendor"
    if vendor > intent + 4:
        return "vendor"
    if intent <= 1 and vendor >= 2:
        return "vendor"
    if total >= 10 and intent >= 4:
        return "A"
    if total >= 6 and intent >= 2:
        return "B"
    if total >= 3 and intent >= 1:
        return "C"
    return "D"


def rescore(row):
    """Recompute totals and tier from the stored component scores plus the (maybe new) headline."""
    hb, hv, hwhy = score_headline(row.get("headline", ""))
    base_why = [w for w in (row.get("why") or "").split(" | ") if w and not w.startswith(("hl", "hl-"))]
    row["headline_bonus"] = hb
    row["vendor_score"] = int(row.get("vendor_text", 0)) + hv
    row["total"] = (int(row["intent_score"]) + int(row["topic_score"]) + int(row["icp_score"])
                    + hb - int(row["vendor_score"]))
    row["why"] = " | ".join(base_why + hwhy)
    row["tier"] = tier_for(row)
    return row


def build_leads(posts):
    leads = {}

    def add(person_url, name, ptype, role, text, post, comp):
        key = person_url or f"{name}|{post['url']}"
        row = {
            "name": name, "profile_url": person_url, "author_type": ptype, "role": role,
            "headline": "", "company": "",
            "intent_score": comp["intent"], "topic_score": comp["topic"], "icp_score": comp["icp"],
            "vendor_text": comp["vendor"], "vendor_score": comp["vendor"], "headline_bonus": 0,
            "total": 0, "tier": "", "why": " | ".join(comp["why"]),
            "post_url": post["url"], "post_date": post.get("date", ""), "likes": post.get("likes", 0),
            "comments": post.get("comment_count", 0), "snippet": re.sub(r"\s+", " ", text)[:400],
            "phone": "", "phone_confidence": "", "website": "", "city": "", "state": "", "email": "",
            "query": post.get("query", ""), "notes": "",
        }
        rescore(row)
        old = leads.get(key)
        if old is None or int(row["total"]) > int(old["total"]):
            leads[key] = row

    for p in posts:
        if p.get("walled") or not p.get("text"):
            continue
        comp = score_text(p["text"])
        if p.get("author_name"):
            add(p.get("author_url", ""), p["author_name"], p.get("author_type", "Person"), "author",
                p["text"], p, comp)
        post_comp = comp
        for c in p.get("comments", []):
            if not c.get("name") or c.get("url") == p.get("author_url"):
                continue
            cc = score_text(c.get("text", ""))
            # a commenter inherits half the post's topic/ICP context (they are replying to it)
            cc["topic"] += post_comp["topic"] // 2
            cc["icp"] += post_comp["icp"] // 2
            cc["why"] = cc["why"] + [f"on-post-topic:{post_comp['topic']}", f"on-post-icp:{post_comp['icp']}"]
            add(c.get("url", ""), c["name"], c.get("type", "Person"), "commenter", c.get("text", ""), p, cc)
    return list(leads.values())


LEAD_COLS = ["rank", "tier", "name", "headline", "company", "role", "profile_url", "phone", "phone_confidence",
             "website", "city", "state", "email", "total", "intent_score", "topic_score", "icp_score",
             "vendor_score", "headline_bonus", "why", "snippet", "post_url", "post_date", "likes", "comments",
             "author_type", "query", "notes", "vendor_text"]
TIER_ORDER = {"A": 0, "B": 1, "C": 2, "D": 3, "vendor": 4}


def finalize(leads):
    leads.sort(key=lambda r: (TIER_ORDER.get(r["tier"], 9), -int(r["total"]), -int(r.get("likes") or 0)))
    for i, r in enumerate(leads, 1):
        r["rank"] = i
    return leads


def cmd_score(a, net=None):
    posts = read_jsonl(Path(a.out) / "posts.jsonl")
    prev = {r["profile_url"] or f"{r['name']}|{r['post_url']}": r for r in read_csv(Path(a.out) / "leads.csv")}
    leads = build_leads(posts)
    # keep enrichment already done on earlier runs
    for r in leads:
        old = prev.get(r["profile_url"] or f"{r['name']}|{r['post_url']}")
        if old:
            for k in ("headline", "company", "phone", "phone_confidence", "website", "city", "state", "email", "notes"):
                if old.get(k):
                    r[k] = old[k]
            rescore(r)
    leads = finalize(leads)
    write_csv(Path(a.out) / "leads.csv", leads, LEAD_COLS)
    tiers = {}
    for r in leads:
        tiers[r["tier"]] = tiers.get(r["tier"], 0) + 1
    log(f"score: {len(leads)} people from {sum(1 for p in posts if not p.get('walled'))} posts -> "
        + ", ".join(f"{k}:{v}" for k, v in sorted(tiers.items(), key=lambda kv: TIER_ORDER.get(kv[0], 9))))
    show = [r for r in leads if r["tier"] in ("A", "B")][:15]
    for r in show:
        log(f"  {r['tier']} {int(r['total']):3d}  {r['name'][:26]:26s} {r['role']:9s} {r['snippet'][:70]}")


# ----------------------------------------------------------------------------------------------
# enrich
# ----------------------------------------------------------------------------------------------
def parse_serp_title(title, name):
    """'Jane Doe - Owner at Acme Roofing | LinkedIn' -> ('Owner at Acme Roofing', 'Acme Roofing')."""
    t = re.sub(r"\s*[|\-–—]\s*LinkedIn\s*$", "", title or "").strip()
    if not t.lower().startswith(name.lower()):
        return "", ""
    rest = t[len(name):].strip()
    rest = re.sub(r"^[\s\-–—:|,]+", "", rest).strip()
    if rest.lower().startswith("on linkedin") or not rest:
        return "", ""
    low = rest.lower()
    if ("professional profile" in low or "| linkedin" in low or "posted on the topic" in low
            or re.search(r",\s*(united states|canada|united kingdom|australia|india)\b", low)):
        return "", ""                      # a location/profile-listing title, not a headline
    headline = rest[:160]
    company = ""
    m = (re.search(r"\b(?:at|@)\s+(.+?)$", headline)
         or re.search(r"^(?:co-)?(?:owner|president|ceo|founder|gm|general manager|operations manager|"
                      r"office manager|managing partner)[\s,|:-]+(?:of|at|@)?\s*(.+?)$", headline, re.I))
    if m:
        company = m.group(1)
    elif " | " in headline:
        company = headline.split(" | ")[-1]
    elif " - " in headline:
        company = headline.split(" - ")[-1]
    company = re.sub(r"\s*[|(].*$", "", company)
    company = re.sub(r"[^\w&'.,\- ]+", " ", company)          # drop emojis and symbols
    company = re.sub(r"\s+", " ", company).strip(" .,-")
    if len(company) > 60 or len(company.split()) > 7 or len(company) < 2:
        company = ""
    if not company and len(headline.split()) <= 5 and not re.search(
            r"\b(owner|president|manager|director|ceo|founder|specialist|consultant|engineer|"
            r"marketing|sales|coach|head|lead|partner|advisor|expert|helping|help)\b", headline, re.I):
        company = re.sub(r"[^\w&'.,\- ]+", " ", headline).strip(" .,-")   # "Jane Doe - Acme Roofing"
    return headline, company


def fetch_public_profile(net, profile_url):
    """Try the public /in/ page. Returns (headline, company, city, still_allowed).
    LinkedIn serves these to ordinary visitors from residential IPs but answers 999 or an
    authwall redirect from cloud IPs; the first block disables further tries this run."""
    r = net.get(profile_url, timeout=20, backoff=False)
    if r is None:
        return "", "", "", True
    if r.status_code != 200 or "authwall" in r.url or "/login" in r.url:
        return "", "", "", False
    soup = BeautifulSoup(r.text, "lxml")
    headline = company = city = ""
    for sc in soup.find_all("script", type="application/ld+json"):
        try:
            d = json.loads(sc.string or "")
        except Exception:
            continue
        items = d.get("@graph", [d]) if isinstance(d, dict) else []
        for it in items:
            if isinstance(it, dict) and it.get("@type") == "Person":
                jt = it.get("jobTitle") or []
                jt = jt[0] if isinstance(jt, list) and jt else (jt if isinstance(jt, str) else "")
                wf = it.get("worksFor") or []
                wf = wf[0] if isinstance(wf, list) and wf else (wf if isinstance(wf, dict) else {})
                company = (wf.get("name") or "") if isinstance(wf, dict) else ""
                addr = it.get("address") or {}
                city = addr.get("addressLocality", "") if isinstance(addr, dict) else ""
                headline = f"{jt} at {company}".strip(" at") if jt or company else ""
    h2 = soup.select_one("h2.top-card-layout__headline")
    if h2 and not headline:
        headline = h2.get_text(" ", strip=True)[:160]
        _, company = parse_serp_title(f"X - {headline}", "X")
    return headline, company, city, True


def lookup_headline(net, name, slug, hint=""):
    if not name:
        return "", ""
    q = f'"{name}" linkedin' + (f" {hint}" if hint else "")
    res = net.search(q, 8)
    best = None
    for r in res:
        href = r.get("href", "")
        if "/in/" not in href:
            continue
        if slug and slug.lower() in href.lower():
            best = r
            break
        if best is None and r.get("title", "").lower().startswith(name.lower()):
            best = r
    if not best:
        return "", ""
    return parse_serp_title(best.get("title", ""), name)


PHONE_RE = re.compile(r"(?<!\d)(?:\+?1[\s.-]?)?\(?([2-9]\d{2})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})(?!\d)")
US_ADDR_RE = re.compile(r"\b([A-Z][A-Za-z.' ]{2,30}),\s*([A-Z]{2})\s+\d{5}(?:-\d{4})?\b")
CA_ADDR_RE = re.compile(r"\b([A-Z][A-Za-z.' ]{2,30}),\s*(AB|BC|SK|MB|ON|QC|NB|NS|PE|NL)\s+[A-Z]\d[A-Z]\s?\d[A-Z]\d\b")


def extract_contact(html_text):
    phone, conf = "", ""
    m = re.search(r'href="tel:([^"]+)"', html_text, re.I)
    if m:
        d = digits(m.group(1))
        if len(d) == 11 and d.startswith("1"):
            d = d[1:]
        if len(d) == 10:
            phone, conf = f"({d[:3]}) {d[3:6]}-{d[6:]}", "high"
    if not phone:
        text = re.sub(r"<[^>]+>", " ", html_text)
        m = PHONE_RE.search(text)
        if m:
            phone, conf = f"({m.group(1)}) {m.group(2)}-{m.group(3)}", "medium"
    text = re.sub(r"<[^>]+>", " ", html_text)
    city = state = ""
    m = US_ADDR_RE.search(text) or CA_ADDR_RE.search(text)
    if m:
        city, state = m.group(1).strip(), m.group(2)
    em = re.search(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", text)
    email = em.group(0) if em and not em.group(0).lower().endswith((".png", ".jpg", ".svg")) else ""
    return phone, conf, city, state, email


def find_company_site(net, company, hint=""):
    """Search for the company, open the first non-directory result, pull phone/city/state."""
    if not company:
        return {}
    q = f'"{company}" {hint} phone'.replace("  ", " ")
    for r in net.search(q, 8):
        href = r.get("href", "")
        dom = urllib.parse.urlsplit(href).netloc.lower()
        if not dom or any(b in dom for b in BLOCK_DOMAINS):
            continue
        resp = net.get(href, timeout=15)
        if resp is None or resp.status_code != 200:
            continue
        phone, conf, city, state, email = extract_contact(resp.text)
        root = f"{urllib.parse.urlsplit(href).scheme}://{dom}"
        title = re.search(r"<title[^>]*>([^<]{0,200})", resp.text, re.I)
        title = htmlmod.unescape(title.group(1)) if title else ""
        first_word = re.sub(r"[^a-z0-9]", "", company.lower().split()[0]) if company.split() else ""
        name_match = bool(first_word) and (first_word in re.sub(r"[^a-z0-9]", "", title.lower())
                                           or first_word in re.sub(r"[^a-z0-9]", "", dom))
        if phone and not name_match:
            conf = "low"
        return {"website": root, "phone": phone, "phone_confidence": conf if phone else "",
                "city": city, "state": state, "email": email, "site_title": title[:80]}
    return {}


def cmd_enrich(a, net):
    path = Path(a.out) / "leads.csv"
    leads = read_csv(path)
    if not leads:
        sys.exit("enrich: no leads.csv yet, run score first")
    order = {"A": 0, "B": 1, "C": 2, "D": 3, "vendor": 4}
    cand = [r for r in leads if r["tier"] in ("A", "B", "C") and r.get("author_type") != "Organization"]
    cand.sort(key=lambda r: (order.get(r["tier"], 9), -int(r["total"])))
    cand = cand[: a.enrich_top]
    log(f"enrich: {len(cand)} people (tier A/B/C, top {a.enrich_top})")
    profiles_ok = True
    for i, r in enumerate(cand, 1):
        changed = False
        if not r.get("headline") and r.get("profile_url"):
            hl = co = ""
            if profiles_ok and "/in/" in r["profile_url"]:
                hl, co, city, profiles_ok = fetch_public_profile(net, r["profile_url"])
                if not profiles_ok:
                    log("    LinkedIn is blocking public profile pages from this network; "
                        "falling back to web search for titles (run from a home connection for better results)")
                if city and not r.get("city"):
                    r["city"] = city
            if not hl:
                hl, co = lookup_headline(net, r["name"], profile_slug(r["profile_url"]))
            if hl:
                r["headline"], changed = hl, True
                if co and not r.get("company"):
                    r["company"] = co
        if not r.get("company"):
            # "Owner at Acme" style mention inside the post text itself
            m = re.search(r"\b(?:owner|president|gm|ceo|founder)\s+(?:of|at|@)\s+([A-Z][\w&'.-]*(?:\s+[A-Z][\w&'.-]*){0,4})",
                          r.get("snippet", ""))
            if m:
                r["company"] = m.group(1).strip(" .,")
                changed = True
        if r.get("company") and not r.get("phone"):
            info = find_company_site(net, r["company"], r.get("state", ""))
            if info:
                for k in ("website", "phone", "phone_confidence", "city", "state", "email"):
                    if info.get(k) and not r.get(k):
                        r[k] = info[k]
                if info.get("site_title"):
                    r["notes"] = (r.get("notes", "") + f" site: {info['site_title']}").strip()
                changed = True
        rescore(r)
        log(f"  [{i}/{len(cand)}] {r['tier']:6s} {int(r['total']):3d} {r['name'][:24]:24s} | {r.get('headline', '')[:45]:45s} | {r.get('company', '')[:22]:22s} | {r.get('phone', '') or '-'} {r.get('phone_confidence', '')}")
        if changed and i % 5 == 0:
            write_csv(path, finalize(leads), LEAD_COLS)
    leads = finalize(leads)
    write_csv(path, leads, LEAD_COLS)
    n_phone = sum(1 for r in cand if r.get("phone"))
    log(f"enrich: {n_phone}/{len(cand)} got a phone number -> {path}")


# ----------------------------------------------------------------------------------------------
# export (dialer import format)
# ----------------------------------------------------------------------------------------------
DIALER_COLS = ["Rank", "Tier", "Owner", "Title", "Business", "Phone", "City", "State", "Market", "Website",
               "Email", "Notes", "LinkedIn", "Post"]


def cmd_export(a, net=None):
    leads = read_csv(Path(a.out) / "leads.csv")
    order = {"A": 0, "B": 1, "C": 2, "D": 3}
    keep = [r for r in leads if r.get("phone") and order.get(r["tier"], 9) <= order.get(a.min_tier, 2)]
    rows = []
    for i, r in enumerate(keep, 1):
        note = (f"LinkedIn {r['role']} ({r['post_date']}): \"{r['snippet'][:220]}\" | why: {r['why'][:160]}"
                f" | phone {r.get('phone_confidence', '')} confidence via {r.get('website', '')}")
        rows.append({"Rank": i, "Tier": r["tier"], "Owner": r["name"], "Title": r.get("headline", "")[:80],
                     "Business": r.get("company", ""), "Phone": r["phone"], "City": r.get("city", ""),
                     "State": r.get("state", ""), "Market": r.get("city", "") or "LinkedIn",
                     "Website": r.get("website", ""), "Email": r.get("email", ""), "Notes": note,
                     "LinkedIn": r.get("profile_url", ""), "Post": r["post_url"]})
    out = Path(a.out) / "dialer_import.csv"
    write_csv(out, rows, DIALER_COLS)
    log(f"export: {len(rows)} callable leads (tier {a.min_tier} or better, with phone) -> {out}")
    log("        import it in the dialer's ... menu, or: python3 tools/build_leads.py linkedin " + str(out))


# ----------------------------------------------------------------------------------------------
def cmd_run(a, net):
    cmd_discover(a, net)
    cmd_fetch(a, net)
    cmd_score(a, net)
    cmd_enrich(a, net)
    cmd_export(a, net)
    log(f"done: {net.search_calls} searches, {net.fetch_calls} page fetches")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["discover", "fetch", "score", "enrich", "export", "run"])
    ap.add_argument("--out", default=str(HERE / "out"), help="output folder (default: tools/linkedin_intent/out)")
    ap.add_argument("--queries", default=str(HERE / "queries.txt"), help="query pack, one search per line")
    ap.add_argument("--query", help="run a single search instead of the query pack")
    ap.add_argument("--per-query", type=int, default=20, help="results to ask for per search")
    ap.add_argument("--max-posts", type=int, default=400, help="max post pages to fetch in one run")
    ap.add_argument("--refetch", action="store_true", help="retry posts that were login-walled last time")
    ap.add_argument("--enrich-top", type=int, default=40, help="how many top people to look up")
    ap.add_argument("--min-tier", default="C", choices=["A", "B", "C", "D"], help="export cutoff")
    ap.add_argument("--search-sleep", type=float, default=3.0, help="seconds between web searches")
    ap.add_argument("--fetch-sleep", type=float, default=2.5, help="seconds between LinkedIn page fetches")
    a = ap.parse_args(argv)
    Path(a.out).mkdir(parents=True, exist_ok=True)
    net = Net(a.out, a.search_sleep, a.fetch_sleep)
    {"discover": cmd_discover, "fetch": cmd_fetch, "score": cmd_score, "enrich": cmd_enrich,
     "export": cmd_export, "run": cmd_run}[a.cmd](a, net)


if __name__ == "__main__":
    main()
