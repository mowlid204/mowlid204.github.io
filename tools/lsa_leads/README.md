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
| `fixsites` | fetches the hand-verified websites named in `owner_overrides.csv` (`Website` column) for the business phone and tech signals when a row still has no phone | `out/enriched_zz_manual.jsonl` |
| `export` | dedupes by Google Ads customer id and by phone, ranks, splits round-robin across 3 callers | `out/lsa_leads.csv`, `out/caller_1..3.csv`, `out/evidence.md` |

Google shows a CAPTCHA page when it rate-limits a network. The script waits 10 minutes and retries
once, then stops with everything saved; run it again later. Keep `--wait` at 5 seconds or more.

## Ranking, removal and the workbook

Ideal lead: verified LSA advertiser, independent and local, established and growing, owner or
president still involved, a few crews rather than a giant, meaningful review volume (150 to
3,000 is the sweet spot), a verified website, 24-hour or late phones, a business line we can call.

**Removed entirely** (listed on the `Removed` tab with the reason): corporate-owned chains and
national operators (`CORPORATE_REMOVE` in the script), and companies whose notes say they were
acquired or are private-equity owned (`ACQUIRED_RE`, fed by `owner_overrides.csv` notes and the
manual owner pass). **Kept but penalised**: franchise brands (`FRANCHISE`), 5,000+ review
operations, 3+ trade multi-service shops, sites that mention an answering service.

Score = review volume (bonus in the 150 to 3,000 band, penalties above 5,000) + rating + years +
hours (24 hours best) + trade breadth + how many LSA searches the ad appears in + online booking +
reply speed + BBB / family / locally owned + verified website (+ Google Ads tag or call tracking)
+ owner-level contact known + verified phone, minus franchise and size penalties, plus any
`Adjust` from the overrides file. Every row carries `Why this lead ranks highly` and `Red flags`.

`export` writes `lsa_leads.xlsx` with tabs README, Top 50, Primary (ranks 1 to 300, `Caller`
1/2/3 round-robin), Caller 1, Caller 2, Caller 3, Backup (301 to 500), All ranked, Removed, and a
Summary of counts, plus the same as CSVs (`primary_300.csv`, `backup_200.csv`, `caller_N.csv`,
`top_50.csv`, `removed.csv`, `all_ranked.csv`, `evidence.md`). Top 50 favours rows with an
owner-level contact, 150 to 3,000 reviews, 24-hour phones and no flags. `--top` sets the total
delivered (default 500), `--primary` the size of the primary list (default 300). Nothing is padded:
if fewer advertisers survive, fewer are delivered.

Enrichment can run in parallel per city: `enrich --cities Omaha --shard omaha` writes
`out/enriched_omaha.jsonl`; export reads every `enriched*.jsonl`.

## Owner names

Owners come from three places, in order: the BBB-built lists already in this repo (roofing), the
company website's home and about pages, and `out/owner_overrides.csv`, a hand-verified file
(`Business, City, Owner, Title, Source, Note, Adjust, Exclude, Website, Phone`) that wins over
scraped values. `Adjust` is added to the score, which is how branch offices and multi-market
operators get pushed down the list without being removed; `Exclude` removes the row with the reason
shown on the Removed tab; `Website` and `Phone` are hand-verified values that replace whatever the
scrape found (a website-sourced phone from a wrong site is dropped at the same time); `Owner` set
to `-` clears a scraped owner guess when no owner name is published. The committed copy lives in
`data/owner_overrides.csv` and is used when `out/owner_overrides.csv` does not exist. BBB profile pages, the best owner source, sit behind a bot check on
cloud networks; from a home connection they open normally and `Business Management` on the profile
is the name to take.
