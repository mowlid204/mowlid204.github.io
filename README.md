# Outreach apps

Static web apps for cold-calling and booking meetings, hosted with GitHub Pages.

| Campaign | Dialer | Booking calendar |
|---|---|---|
| Pest control (Alberta, 110 leads) | `/pest/dialer/` | `/pest/booking/` |
| Roofing (US, 1,135 leads) | `/roofing/dialer/` | `/roofing/booking/` |

The two campaigns are completely separate: separate lead files, separate saved outcomes, separate calendars.
The dialer and booking app **within** one campaign share that campaign's lead outcomes, so marking a lead
"Booked" in the dialer shows in its booking app and vice versa.

## Dialer
* One lead on screen with the owner, business, local time, phone and research notes.
* **CALL** is a `tel:` link, so on a phone it dials immediately.
* Tap an outcome (No answer, Voicemail, Callback, ...) to save it and jump to the next lead. **Booked** opens the booking app with that lead pre-filled.
* Search, filters (tier, market, state, status), a callbacks list, CSV export of results, and CSV import of a different lead list.
* Keyboard on desktop: `C` call, `N` next, `P` back, `1`-`8` outcomes, `/` search.

## Booking calendar
* Cycle through clients with the arrows; tap any time slot to book the current client (name, business, phone, email pre-filled).
* Every meeting has two confirmation toggles: **Owner confirmed** and **I confirmed**. A meeting only counts as confirmed when both are on, and unconfirmed meetings are flagged on the calendar and counted on the Meetings tab.
* Per meeting: Google Meet link field, *New Meet link*, *Add to Google Calendar*, `.ics` download, and Text / Email / Copy of a confirmation message built from a template.
* Optional one-tap Google Calendar + Meet creation if you add a Google OAuth Client ID in Settings (instructions inside the app).
* Client local time is shown next to yours whenever the lead is in another time zone.

## Data
Everything is stored in the browser's `localStorage` on the device you use. Use the export / backup buttons regularly.

## Updating a lead list
```
python3 tools/build_leads.py pest    path/to/pest.csv
python3 tools/build_leads.py roofing path/to/roofing.csv
```
The script reads the sheet's columns, adds a time zone per lead, and writes `<campaign>/leads.js`.
You can also import a CSV directly in the dialer's ⋯ menu without touching the repo.
