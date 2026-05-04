# FC AA Lookup

Cross-browser (Chrome + Firefox) extension for looking up Amazon FC associates
on the FCLM portal by **Login**, **Badge**, **Employee ID**, or **Name** — both
one-at-a-time and as CSV batch.

This extension is independent of the existing `extension/` (FC Labor Tracking
Assistant). They can be installed alongside each other in Firefox.

## Features

- **Single lookup**: scan or paste any ID; get back any subset of Login, Badge,
  Empl ID, Name, Status, Manager, Shift, Dept ID, Location, Agency.
- **Batch CSV**: drop a `.csv`, pick the input column, choose which fields to
  add, run, download an enriched CSV. Sequential, ~400ms between requests.
- **Recent log**: last 50 lookups, exportable as CSV.
- **Cache**: in-memory, 10 min TTL, 1000 entries max.

## How it works

FCLM accepts Login, Badge, or Employee ID interchangeably as the
`?employeeId=` URL parameter on
`https://fclm-portal.amazon.com/employee/timeDetails`. The content script
fetches that page in the background tab, parses the **Employee Info** box, and
returns whichever fields you asked for.

> **Name lookups** are best-effort — FCLM's `employeeId=` param doesn't reliably
> resolve names. If a name doesn't resolve you'll get an "Employee not found"
> message; use Login, Badge, or Empl ID for guaranteed results.

You must be **logged into FCLM** in the same browser. If no FCLM tab is open,
the extension opens one in the background.

## Install — Chrome

1. Go to `chrome://extensions/`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select the `lookup-extension/` folder.
4. Pin the extension; click the toolbar icon to open the side panel.

## Install — Firefox (temporary)

1. Go to `about:debugging` → **This Firefox**.
2. Click **Load Temporary Add-on…** and pick `lookup-extension/manifest.json`.
3. Click the toolbar icon, or open **View → Sidebar → FC AA Lookup**.

## File layout

```
lookup-extension/
├── manifest.json
├── background/background.js     # service worker; tab routing, cache, batch queue
├── content/fclm-lookup.js       # FCLM page scraper
├── sidebar/
│   ├── sidebar.html             # 3 tabs: Single / Batch CSV / Recent
│   ├── sidebar.css
│   ├── sidebar.js               # UI controller
│   └── csv.js                   # RFC4180-ish parser/serializer (no deps)
└── icons/
```

## Notes & limitations

- Cross-browser via a single MV3 manifest: Chrome reads `side_panel`, Firefox
  reads `sidebar_action`; each ignores the other.
- Batch is sequential with a fixed 400ms delay (in `background/background.js`,
  `REQUEST_DELAY_MS`). Adjust if FCLM rate-limits you.
- The Employee Info parser uses tolerant label matching (b/strong/th/dt). If
  FCLM changes layout, update `FIELD_LABELS` in `content/fclm-lookup.js`.
