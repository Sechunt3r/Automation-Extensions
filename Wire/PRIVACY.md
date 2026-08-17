# Privacy Policy

Last updated: 2026-08-17

Wire - FinSMEs Article Collector ("the extension") is designed so that your data never leaves your browser.

## What the extension collects

The extension stores, on your own device only, the article records you choose to collect. Each record contains a date, a title, a URL, and a timestamp. If you turn on the optional enrichment feature, records may also include a company website and any email addresses published in the article body. It also stores your interface settings.

## What the extension does not do

- It does not send any data to the developer or to any third party.
- It does not include analytics, tracking, or advertising.
- It does not read pages other than finsmes.com.
- It does not collect personal information, browsing history, or credentials.

## Where data is stored

All records and settings are kept in Chrome's local extension storage (`chrome.storage.local`) on your device. You can export them to a file you control, or delete everything at any time with the "Clear all" button in the dashboard. Removing the extension also removes its stored data.

## Network activity

The extension makes requests only to `https://www.finsmes.com` in order to read public archive pages. These requests use your normal browser session. No request is ever made to any other domain.

## Permissions

- `storage`: to save your collected records and settings locally.
- `scripting`: to read the content of a finsmes.com page you are collecting from.
- `offscreen`: to parse fetched HTML locally when the fast engine is used.
- `host_permissions` limited to `https://www.finsmes.com/*`: to allow the two points above on finsmes pages only.

## Contact

For questions about this policy, open an issue on the project's repository.
