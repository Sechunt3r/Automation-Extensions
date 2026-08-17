# <img width="25" height="25" alt="icon128" src="https://github.com/user-attachments/assets/9a0703d8-a914-4818-9ae3-9d0dd0c99a73" /> Wire - FinSMEs Article Collector


A Chrome extension that collects and deduplicates article URLs from [finsmes.com](https://www.finsmes.com) across any date range, then exports them to CSV or JSON. Everything runs inside your own browser. Nothing is uploaded.

This is a browser-native rewrite of a Playwright based Python scraper. The scraper worked in principle but kept getting stopped by Cloudflare: headless runs were served the "Just a moment..." challenge, and headed runs forced a manual solve on every run. Running the same extraction logic inside a real, already-cleared browser session removes that problem, because the requests carry your genuine cookies, TLS fingerprint, and headers.

## Why an extension solves the Cloudflare problem

Cloudflare's managed challenge fingerprints automation frameworks (the `navigator.webdriver` flag, TLS/JA3 signatures, header ordering, headless signals). `playwright-stealth` patches some of these, but the arms race favors Cloudflare. An extension does not fight that fight at all: it drives a normal Chrome tab that looks exactly like a human browsing, so the site treats it like any other visit.

## How dates and ranges work

FinSMEs permalinks look like `/YYYY/MM/slug.html`: they carry the month but not the day, and the site has no daily archive pages. So every date-bounded mode (since, last N days, date range) pages the month archives that cover the range and keeps the articles whose real published date falls inside it. The real date is read from each article's date shown in the listing, so results are dated correctly per article rather than all sharing one date.

## Features

- Six date-range modes: since a date (inclusive), last N days, an explicit from/to range, a single month, a whole year, and the current month.
- Real per-article published dates.
- Optional enrichment: visit each new article to capture the company website and any email addresses. Off by default because it is one page load per article.
- Incremental early-stop so daily re-runs finish quickly.
- Website and email columns, "with site" / "with email" filters, and copy-to-clipboard for URLs, sites, and emails.
- Two engines:
  - Reliable (tab): drives a real background tab and scrapes the live DOM. Clears Cloudflare like a person would. This is the default.
  - Fast (background): tries a quiet `fetch` first and parses it in an offscreen document, falling back to the tab engine automatically if Cloudflare blocks the request.
- Automatic Cloudflare handling: if a challenge appears, the tab is brought to the front so you can solve it once, then collection resumes on its own.
- Deduplication against everything already collected, so re-runs are cheap and only add what is new.
- Persistent local storage of every record (date, title, url, scraped_at).
- CSV export that is a drop-in replacement for the Python script's `finsmes_master_urls.csv`, plus JSON export.
- CSV import to seed the dedup set from an existing master file, so you can pick up exactly where the old script left off.
- Live console, progress, and counters in a full dashboard, plus a compact popup for quick runs.

## Install (unpacked, for development)

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome.
3. Turn on Developer mode (top right).
4. Click "Load unpacked" and select the project folder (the one containing `manifest.json`).
5. Pin the extension. Click the icon for the popup, or open the dashboard from the popup's "Open dashboard" link.

## Screenshots

<img width="998" height="637" alt="screenshot" src="https://github.com/user-attachments/assets/38781e21-3534-4e88-822b-b1e2a3c59c65" />

## Usage

1. Open the dashboard.
2. Pick a range. "Since date" is the usual incremental mode: it collects every article on and after the date you choose, inclusive.
3. Pick an engine. Leave it on Reliable unless you know your session is already Cloudflare-cleared and you want speed.
4. Click "Start collecting". Watch the console and counters.
5. If a Cloudflare check appears, complete it in the tab that pops to the front. Collection continues automatically once it clears. You can also press "Complete check" after solving it to resume immediately.
6. Export to CSV or JSON when you are done.

### Continuing from your existing master CSV

If you already have `finsmes_master_urls.csv` from the Python script, click "Import CSV" once. The extension merges those URLs into its dedup set, so future runs only add genuinely new articles.

## How it works

```
popup / dashboard  <--port-->  background service worker
                                   |  builds a task queue from the date range
                                   |
                     +-------------+--------------------------+
                     |                                        |
             Fast engine (fetch)                     Reliable engine (tab)
             background fetch                         drive a real tab
                     |                                        |
             offscreen document                      chrome.scripting
             DOMParser + extractor                   inject extractor into page
                     |                                        |
                     +----------------> extractor.js <--------+
                                    (one shared function,
                                     runs in both contexts)
```

- `src/config.js` holds the site selectors and turns a date range into a set of month-archive pages plus an inclusive date filter.
- `src/extractor.js` is a single classic script that extracts articles (with their listing dates) from a document, and, for enrichment, pulls the published date, company website, and emails from an article page. It runs both in the offscreen parser and injected into a live tab, so the logic never drifts between engines.
- `src/background.js` is the orchestrator: queue, dedup, both engines, Cloudflare handling, persistence, and progress messaging.
- `src/offscreen.js` parses fetched HTML with `DOMParser` (service workers cannot use `DOMParser`, so this runs in an offscreen document).
- The dashboard and popup are plain HTML/CSS/JS with no build step.

## Permissions

The extension asks for the minimum it needs:

- `storage`: save collected records and settings locally.
- `scripting`: inject the extractor into a finsmes tab to read the page.
- `offscreen`: parse fetched HTML with `DOMParser` for the fast engine.
- `host_permissions: https://www.finsmes.com/*`: only finsmes pages, nothing else.

There is no `tabs` permission and no broad host access. See [PRIVACY.md](./PRIVACY.md).

## Adapting to another site

The target lives entirely in `SITE_CONFIG` in `src/config.js` (base URL, link selector, exclude patterns, minimum title length). Most WordPress-style archives use the same `/YYYY/MM/DD/` and `/page/N/` structure, so pointing this at a different site is usually a matter of editing that object and the `host_permissions` entry in `manifest.json`.

## Development and tests

There is no build step. The logic that can be tested without a browser (the date range planner, the CSV round-trip, and the DOM extractor) was validated with Node and jsdom during development. To re-run those checks, install `jsdom` as a dev dependency and adapt the small test scripts in the commit history, or write your own against `buildTasks`, `toCSV`/`parseCSV`, and `extractArticles`.

## Legal and ethical use

This tool is for collecting publicly available article URLs at a polite rate. You are responsible for using it within finsmes.com's terms of service and `robots.txt`, and for keeping the request delay reasonable. Do not use it to overload the site or to collect content you are not permitted to collect.
