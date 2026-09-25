# Google Local Services Ads advertiser leads

Builds a cold-calling list of home-service companies that are **currently paying for Google Local
Services Ads** (the "Google Guaranteed" units above search results) in our target cities, with proof,
the company's real phone line, website, owner where findable, rating, review count and hours.

Why these leads: an LSA advertiser pays Google per inbound call, and from October 1, 2026 Google
also bills them for calls that ring more than 20 seconds unanswered during business hours. Our pitch
is answering the calls they are already paying to generate.

## How verification works

Google's "More providers" page, `google.com/localservices/prolist?q=<trade city state>`, lists only
paying LSA advertisers. Every card on it carries Google's own `data-test-id="paid-list-card"` marker
and the advertiser's Google Ads customer id. For each business we keep:

* the listing URL and search query it appeared in, and a full-page screenshot (`out/evidence/`)
* the raw page (`out/raw/`) so the capture can be re-parsed
* the advertiser's Google Ads customer id and LSA profile URL
* the capture time (UTC)

`out/evidence.md` is a table of all of that, one row per business.

**The phone number shown inside an LSA ad is a Google call-tracking number. Calling it bills the
business for a lead.** It is stored only as evidence in the column marked DO NOT CALL. The `Phone`
column is the company's own line taken from its website (`tel:` link or page text) or from our
BBB-built lists in this repo. Rows without a verified line say so in the notes.

## Run

```
pip install playwright requests beautifulsoup4 lxml ddgs
playwright install chromium
cd tools/lsa_leads
python3 lsa_leads.py run --cities Tulsa --top 20     # first check
python3 lsa_leads.py run                              # all 10 cities x 4 trades
```

Steps, each resumable (nothing already saved is fetched again):

| step | what | output |
|---|---|---|
| `lists` | loads every listing query: 3 search terms per trade for the main city plus the primary term for 3 suburbs (24 pages per city, ~20 advertisers each; suburbs surface advertisers the city query does not) | `out/cards.jsonl`, `out/raw/`, `out/evidence/` |
| `profiles` | opens the LSA profile of the top N advertisers for weekly hours, license number, "locally owned" style notes | `out/profiles.jsonl` |
| `enrich` | website, real phone, owner: our BBB lists first, then the company website (home + about page), tech signals (call tracking, Google Ads tag, Housecall Pro, "24/7", "answering service") | `out/enriched.jsonl` |
| `export` | dedupes by Google Ads customer id and by phone, ranks, splits round-robin across 3 callers | `out/lsa_leads.csv`, `out/caller_1..3.csv`, `out/evidence.md` |

Google shows a CAPTCHA page when it rate-limits a network. The script waits 10 minutes and retries
once, then stops with everything saved; run it again later. Keep `--wait` at 5 seconds or more.

## Ranking

Score = log(review count) + rating bonus + years in business + hours (24 hours > closes late >
normal) + listed under several trades + online booking + fast reply time + BBB / family / veteran /
local highlights + owner found + phone found, minus a franchise/national-brand penalty (flagged, not
removed) and a "very large operation" penalty above 5,000 reviews. The `Score` column and the
`Qualification notes` column explain each row.

## Columns

Business, Trade, City, State, Phone, Phone source, Website, Owner, Title, Owner source, Google rating,
Review count, Years in business, Hours (ad status), Weekly hours, Highlights, License, Ownership notes,
Booking tool, Site signals, Qualification notes, LSA proof (profile URL, Google Ads customer ID, listing
URL, screenshot), First seen, Also listed for, LSA display phone (DO NOT CALL), Score, Franchise flag,
Rank, Caller.

## Owner names

Owners come from three places, in order: the BBB-built lists already in this repo (roofing), the
company website's home and about pages, and `out/owner_overrides.csv`, a hand-verified file
(`Business, City, Owner, Title, Source, Note, Adjust`) that wins over scraped values. `Adjust` is
added to the score, which is how private-equity-owned or acquired companies get pushed down the
list without being removed. BBB profile pages, the best owner source, sit behind a bot check on
cloud networks; from a home connection they open normally and `Business Management` on the profile
is the name to take.
