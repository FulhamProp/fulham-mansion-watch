# Fulham Mansion Watch

Ranks every SW6 terraced-house street by average sold price over the last
12 months (live from HM Land Registry), and flags streets that are at or
near the £2m "mansion tax" (High Value Council Tax Surcharge, effective
April 2028) threshold.

## ⚠️ Important — this has NOT been tested against live data

My sandbox here has no internet access, so I could not actually run this
against the real Land Registry SPARQL endpoint before handing it to you.
The query is built correctly against Land Registry's documented schema,
and the server code is syntax-checked, but you need to test the live
`/api/streets` endpoint after deploying before trusting any numbers on
the page. Things that could go wrong on first real run:

1. **The SPARQL endpoint can be slow** (5-15s) or occasionally times out
   under load — there's a 20s timeout set, increase if needed.
2. **Street name matching is exact-string** — Land Registry sometimes
   records the same street inconsistently (e.g. "MUNSTER ROAD" vs
   "Munster Rd"), which would split one street into two rows. Worth
   spot-checking the top 10 against Rightmove.
3. **Low sample sizes**: some streets will only have 1-2 terraced sales
   in 12 months — the average will be misleading. The footer says this
   but consider hiding streets with fewer than 2 sales once you've seen
   real output.
4. **"Average" vs "what a £2m+ buyer actually compares against"**: the
   mansion tax surcharge will apply per-property at VOA valuation, not
   street average — this tool tells you which *streets* are in the zone
   of concern, not which individual houses are liable. Make that
   distinction clear to anyone you send this to (compliance — see below).

## Compliance note (read before publishing)

This makes implied claims about individual properties' tax exposure.
Before this goes live under your name / Knight Frank's, get comfortable
that:
- The mansion tax has been announced but valuations won't happen until
  the VOA process runs in 2026-27 — be careful not to state any specific
  street/property "will" be liable, only that it's "in the range that
  could be assessed."
- This isn't financial or tax advice — the footer disclaimer should stay,
  and probably needs strengthening with your compliance team's standard
  wording.

## Local development

```bash
npm install
npm start
```

Visit http://localhost:3000 — the page calls `/api/streets`, which the
server fetches from Land Registry, aggregates, and caches in memory for
6 hours.

## Deploy to Render

Same setup as your existing Fulham Explorer app — to avoid the loose
`index.js`-at-root issue you hit before, keep this exact structure:

```
fulham-mansion-watch/
├── package.json
├── server/
│   └── index.js
└── public/
    └── index.html
```

Render settings:
- Build command: `npm install`
- Start command: `npm start`
- No loose `index.js` at the repo root.

## Possible next steps once live data is confirmed working

- Swap the in-memory cache for a small SQLite/JSON file written on a
  daily cron, so the site doesn't depend on Land Registry's uptime at
  request time.
- Add EPC floor-area data (as in your original explorer) to compute
  £/sqft per street, not just headline price — more defensible than raw
  averages for skewed streets.
- Add flats and semis as separate rankings/tabs.
- Replace the `mailto:` CTA with a real form that posts to your CRM or
  email, since mailto links are unreliable on mobile.
