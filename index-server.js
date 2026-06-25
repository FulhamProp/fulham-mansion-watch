const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Config -----------------------------------------------------------
const SPARQL_ENDPOINT = 'https://landregistry.data.gov.uk/landregistry/query';
const POSTCODE_PREFIX = 'SW6';
const MONTHS_LOOKBACK = 12;

// Mansion tax (High Value Council Tax Surcharge) bands — effective April 2028.
// Source: Autumn Budget 26 Nov 2025. Threshold starts at £2,000,000.
const MANSION_TAX_THRESHOLD = 2_000_000;
const APPROACHING_BAND = 0.90; // flag streets within 10% of the threshold as "approaching"

// Simple in-memory cache so we don't hammer the SPARQL endpoint on every
// page load. Refreshes once every 6 hours.
let cache = { data: null, fetchedAt: 0 };
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

// ---- SPARQL query -------------------------------------------------------
function buildQuery() {
  const since = new Date();
  since.setMonth(since.getMonth() - MONTHS_LOOKBACK);
  const sinceStr = since.toISOString().slice(0, 10);

  // ORDER BY removed — it forces Land Registry to sort 5000 rows server-side
  // before returning anything, which causes timeouts on their free endpoint.
  // We sort the results in Node instead (see aggregateByStreet).
  return `
    PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
    PREFIX ppd: <http://landregistry.data.gov.uk/def/ppi/>
    PREFIX lrcommon: <http://landregistry.data.gov.uk/def/common/>

    SELECT ?street ?amount ?date ?postcode
    WHERE {
      ?transx ppd:pricePaid ?amount ;
              ppd:transactionDate ?date ;
              ppd:propertyAddress ?addr ;
              ppd:propertyType <http://landregistry.data.gov.uk/def/common/terraced> .
      ?addr lrcommon:postcode ?postcode ;
            lrcommon:street ?street .
      FILTER(STRSTARTS(STR(?postcode), "${POSTCODE_PREFIX}"))
      FILTER(?date >= "${sinceStr}"^^xsd:date)
    }
    LIMIT 2000
  `;
}

async function fetchFromLandRegistry() {
  const query = buildQuery();
  const url = `${SPARQL_ENDPOINT}?query=${encodeURIComponent(query)}&output=json`;

  const res = await fetch(url, {
    headers: { Accept: 'application/sparql-results+json' },
    timeout: 45000,
  });

  if (!res.ok) {
    throw new Error(`Land Registry SPARQL endpoint returned ${res.status}`);
  }

  const json = await res.json();
  return json.results.bindings;
}

function aggregateByStreet(bindings) {
  const streets = {};

  for (const row of bindings) {
    const street = row.street?.value?.trim();
    const amount = row.amount ? parseInt(row.amount.value, 10) : null;
    if (!street || !amount) continue;

    if (!streets[street]) {
      streets[street] = { street, sales: [] };
    }
    streets[street].sales.push(amount);
  }

  const result = Object.values(streets).map((s) => {
    const sorted = [...s.sales].sort((a, b) => a - b);
    const count = sorted.length;
    const avg = Math.round(sorted.reduce((a, b) => a + b, 0) / count);
    const median = count % 2 === 0
      ? Math.round((sorted[count / 2 - 1] + sorted[count / 2]) / 2)
      : sorted[(count - 1) / 2];
    const min = sorted[0];
    const max = sorted[count - 1];

    let mansionTaxStatus = 'clear';
    if (avg >= MANSION_TAX_THRESHOLD) {
      mansionTaxStatus = 'over';
    } else if (avg >= MANSION_TAX_THRESHOLD * APPROACHING_BAND) {
      mansionTaxStatus = 'approaching';
    }

    return {
      street: s.street,
      count,
      avgPrice: avg,
      medianPrice: median,
      minPrice: min,
      maxPrice: max,
      mansionTaxStatus,
      pctOfThreshold: Math.round((avg / MANSION_TAX_THRESHOLD) * 100),
    };
  });

  // Only keep streets with a meaningful sample size (avoid 1-sale outliers
  // distorting a "ranking" — flag but don't hide them).
  result.sort((a, b) => b.avgPrice - a.avgPrice);
  return result;
}

async function getStreetData() {
  const now = Date.now();
  if (cache.data && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.data;
  }

  const bindings = await fetchFromLandRegistry();
  const data = aggregateByStreet(bindings);
  cache = { data, fetchedAt: now };
  return data;
}

// ---- Routes -------------------------------------------------------------
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/streets', async (req, res) => {
  try {
    const data = await getStreetData();
    res.json({
      postcode: POSTCODE_PREFIX,
      monthsLookback: MONTHS_LOOKBACK,
      mansionTaxThreshold: MANSION_TAX_THRESHOLD,
      generatedAt: new Date(cache.fetchedAt).toISOString(),
      streets: data,
    });
  } catch (err) {
    console.error('Failed to fetch/aggregate Land Registry data:', err.message);
    res.status(502).json({
      error: 'Could not fetch live data from HM Land Registry. Please try again shortly.',
      detail: err.message,
    });
  }
});

// ---- Lead capture --------------------------------------------------------
// NOTE: this stores leads in memory only. On Render's free tier the
// filesystem/process resets on redeploy or idle spin-down, so leads WILL
// be lost periodically. This is fine for testing the flow but must be
// swapped for a real store (Airtable, a Google Sheet via API, Mailchimp,
// or a proper DB) before you rely on this for real leads.
const leads = [];

app.use(express.json());

app.post('/api/notify', (req, res) => {
  const { email, intent, street } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please provide a valid email address.' });
  }
  leads.push({
    email,
    intent: intent === 'selling' ? 'selling' : 'watching',
    street: street || null,
    capturedAt: new Date().toISOString(),
  });
  console.log('New lead:', leads[leads.length - 1]);
  res.json({ ok: true });
});

// Lightweight, unauthenticated peek at captured leads — fine for early
// testing, but lock this down (basic auth / remove entirely) before
// sharing this URL with anyone.
app.get('/api/leads', (req, res) => res.json({ count: leads.length, leads }));

// ---- Debug endpoint — see raw Land Registry results with no type filter --
// Remove this before sharing the URL publicly.
app.get('/api/debug', async (req, res) => {
  const since = new Date();
  since.setMonth(since.getMonth() - 12);
  const sinceStr = since.toISOString().slice(0, 10);

  const query = `
    PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
    PREFIX ppd: <http://landregistry.data.gov.uk/def/ppi/>
    PREFIX lrcommon: <http://landregistry.data.gov.uk/def/common/>
    SELECT ?street ?amount ?propertyType ?postcode ?date
    WHERE {
      ?transx ppd:pricePaid ?amount ;
              ppd:transactionDate ?date ;
              ppd:propertyAddress ?addr ;
              ppd:propertyType ?propertyType .
      ?addr lrcommon:postcode ?postcode ;
            lrcommon:street ?street .
      FILTER(STRSTARTS(STR(?postcode), "SW6"))
      FILTER(?date >= "${sinceStr}"^^xsd:date)
    }
    LIMIT 20
  `;
  try {
    const url = `https://landregistry.data.gov.uk/landregistry/query?query=${encodeURIComponent(query)}&output=json`;
    const r = await fetch(url, { headers: { Accept: 'application/sparql-results+json' }, timeout: 25000 });
    const json = await r.json();
    res.json(json.results?.bindings || []);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Fulham Mansion Watch running on port ${PORT}`);
});
