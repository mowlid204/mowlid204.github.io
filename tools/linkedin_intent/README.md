# LinkedIn intent leads

Finds people on LinkedIn who are publicly asking about, or complaining about, the thing we sell
(AI receptionist / after-hours and missed-call coverage), scores them for **buyer intent** versus
**vendor noise** versus **home-service fit**, finds a phone number where it can, and writes a CSV the
dialer in this repo imports directly.

It does **not** log into LinkedIn. Public post pages are fetched the way Google sees them; they carry
the full post text, author, date and comments in structured data. That means no account to get
restricted and nothing LinkedIn is currently suing people over (fake accounts, password-wall scraping).
The trade-off is recall: only posts that search engines have indexed are found. An optional logged-in
discovery script is included for higher recall, with the risks spelled out below.

## Setup

```
pip install -r tools/linkedin_intent/requirements.txt
```

Python 3.10+. Nothing else. (Playwright is only needed for the optional logged-in script.)

## Run

```
cd tools/linkedin_intent
python3 li_intent.py run                       # whole pipeline with the default query pack
python3 li_intent.py run --per-query 25 --enrich-top 60
```

`run` is five steps; each writes a file in `out/` and can be re-run alone:

| step | what it does | writes |
|---|---|---|
| `discover` | runs every line of `queries.txt` through web search (DuckDuckGo/Bing via the `ddgs` package), keeps `linkedin.com/posts/...` URLs | `out/discovered.jsonl` |
| `fetch` | downloads each public post page, parses text, author, date, likes, comments | `out/posts.jsonl` |
| `score` | one row per **person** (post author *and* every commenter), with intent / topic / ICP / vendor scores and a tier | `out/leads.csv` |
| `enrich` | for the top rows: author title + company from a web search of their name, then the company website, phone, city/state | `out/leads.csv` (updated) |
| `export` | rows that have a phone number, in the dialer's import format | `out/dialer_import.csv` |

Everything is cached: re-running `discover` only adds new posts, `fetch` skips pages it already has,
searches are cached on disk. Delete `out/` to start over.

Useful flags: `--query '...'` (one search instead of the pack), `--min-tier B` (export cutoff),
`--enrich-top 80`, `--refetch` (retry pages that were login-walled), `--search-sleep 5`
`--fetch-sleep 4` (slow down if you see HTTP 999/429).

## Getting the leads into the dialer

Either import `out/dialer_import.csv` from the dialer's **⋯** menu (no repo change), or build the
LinkedIn campaign's lead file and push:

```
python3 tools/build_leads.py linkedin tools/linkedin_intent/out/dialer_import.csv
```

The `Notes` column carries the quote from their post, the phrases that fired, and how confident the
phone lookup was, so the caller can open with *"saw your post about..."*.

## How scoring works (and why most results are tier "vendor")

Every author and commenter gets four scores from plain phrase lists at the top of `li_intent.py`:

* **intent** – asking for help or describing the pain in first person: *how do I, anyone using,
  recommend, where do I start, goes to voicemail, we keep missing calls, thoughts?*
* **topic** – the subject: *AI receptionist, answering service, missed calls, after hours, voicemail*
* **ICP** – home-service operator language: *roofing, HVAC, plumbing, electrician, our techs, our office,
  estimates, my crew* (also applied to the headline once known, doubled)
* **vendor** – people selling: *we help, our platform, book a demo, DM me, link in comments, launching,
  #aiautomation, "your business"*, hashtag stuffing, company-page authors, AI/agency/marketing headlines

`total = intent + topic + ICP + headline bonus − vendor`. Tiers:

| tier | rule | meaning |
|---|---|---|
| A | total ≥ 10 and intent ≥ 4 | asked a real question, right subject, likely an operator. Call first. |
| B | total ≥ 6 and intent ≥ 2 | some intent. Read the snippet before calling. |
| C | total ≥ 3 and intent ≥ 1 | on topic, weak intent. Skim. |
| D | rest | noise |
| vendor | company page, or vendor signals outweigh intent | competitors and agencies. Don't call; the *commenters* on their posts can still be leads. |

The `why` column lists every phrase that fired, so a wrong tier is easy to diagnose. Edit the phrase
lists rather than the code when tuning.

What to expect: searches for "AI receptionist" on LinkedIn return mostly people **selling** AI
receptionists. That's why commenters are scored too: an owner replying "we deal with this every
day" under a vendor's post is a better lead than the post. Expect a run of ~50 queries to yield a few
hundred people, of which a few dozen are tier A/B, of which some fraction are actually home-service
operators with a findable phone. The query pack in `queries.txt` is the main lever; add local terms
(*Edmonton, Alberta, Tulsa*) and keep each line to two or three quoted phrases, because search
engines silently return nothing for long OR-chains.

## Rate limits and blocking

* Search: the `ddgs` package rotates engines; some queries legitimately return 0. If every query
  returns 0 or you see repeated errors, wait 10 minutes or raise `--search-sleep`.
* LinkedIn: post pages are fetched one every ~2.5–4 s with a normal browser user-agent. LinkedIn
  answers HTTP **999** or redirects to `/uas/login` when it rate-limits an IP; the script backs off and
  stops after 8 walled pages in a row. Run from a home connection, not a cloud server. `--refetch`
  retries walled pages later.
* Company websites: one homepage fetch per company; phone comes from a `tel:` link (**high**), a
  phone-shaped string (**medium**), or **low** when the site's title doesn't look like the company name.
  Verify low-confidence numbers before calling.

## Optional: logged-in discovery (`linkedin_login_search.py`)

LinkedIn's own content search (sort by date, any phrase) finds far more, and more recent, posts than
search engines. It requires a logged-in session, and LinkedIn's User Agreement forbids automation:
accounts get feature-restricted or locked, typically after a few hundred actions a day or any
datacenter IP. Community-reported envelopes in 2026 are roughly 20–50 actions/day on a new account,
a few hundred on a warm one, and ~80–150 profile views/day. Rules if you use it:

* A secondary account you can afford to lose. Not the one you message prospects from.
* A handful of searches per day, headed browser, home IP.
* The script only reads the search results page for post IDs. Post pages are then fetched without
  login by `li_intent.py fetch`, so the account does as little as possible.

```
pip install playwright && playwright install chromium
LI_AT="<li_at cookie value>" python3 linkedin_login_search.py "AI receptionist" "anyone using AI to answer phones" --scrolls 12
python3 li_intent.py fetch && python3 li_intent.py score && python3 li_intent.py enrich && python3 li_intent.py export
```

This script was written without a live account to test against. If LinkedIn changes the results
page, the thing most likely to need a fix is the "Show more results" button name or the waits.

## Why this isn't built on an existing GitHub scraper

Survey done 2026-09-25 of the LinkedIn scrapers on GitHub, looking specifically for keyword search of
**posts** (not profiles or jobs) plus author extraction:

| repo | status | post keyword search |
|---|---|---|
| `stickerdaniel/linkedin-mcp-server` | maintained (v4.25, Sep 2026), 3.6k★, Apache-2.0 | **yes** (`search_posts`), via a stealth browser on your logged-in account. Best option if you accept the account risk. It is an MCP server, so you drive it from an agent rather than a script. |
| `joeyism/linkedin_scraper` | maintained (v3.1.2, Apr 2026), 4.5k★, GPL-3 | no. Profiles, companies, jobs, and a company's own posts. Useful for profile enrichment only. |
| `tomquirk/linkedin-api` (Voyager API) | **repo gone** (404 / private since 2025), last PyPI release Nov 2024 | no dedicated method; generic search with a content filter is untested. Unhandled login challenges. Don't build on it. |
| `EseToni/open-linkedin-api` | re-host of the above, last commit Apr 2025 | same |
| `cullenwatson/StaffSpy` | last release Jan 2025, issues report LinkedIn API changes, CAPTCHA | no; only comments on known post IDs |
| `ismaelfi/Scrape-Linkedin-Posts`, `christophe-garon/Linkedin-Post-Scraper` | Selenium, one profile/company at a time | no |
| `toxtli/LinkedIn-feed-posts-extractor`, `ArnavBalyan/LinkedIn_Web-Scraper`, `datakund/linkedin-search-posts` | 2019–2021, dead endpoints or a cloud service | claimed, no longer works |
| the many "linkedin-post-search-scraper-no-cookies" repos | README-only wrappers for paid Apify/Bitbash actors | no code |
| `ChocoData-com/linkedin-post-scraper` | Jul 2026, mostly a paid-API client | no search, but its free script parses the public post JSON-LD the same way this tool does |

Nobody maintains an open-source "search engine → public post page → JSON-LD" pipeline, which is what
the paid no-login products do internally and what this folder implements. Legal context: hiQ v.
LinkedIn ended with hiQ paying and being permanently enjoined (2022); LinkedIn's 2025–2026 wins
against Proxycurl and ProAPIs were about fake accounts and password-wall scraping. Reading public
pages without an account is a terms-of-service question, not what those cases were about, but
personal data is still personal data (PIPEDA in Canada, GDPR/CCPA elsewhere): keep the list small,
use it for the calls, don't resell it.

## Files

```
li_intent.py               the pipeline (discover / fetch / score / enrich / export / run)
linkedin_login_search.py   optional logged-in discovery (writes into out/discovered.jsonl)
queries.txt                default query pack, one web search per line
requirements.txt
out/                       generated, git-ignored: discovered.jsonl, posts.jsonl, leads.csv, dialer_import.csv, cache/
```
