const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const SPARQL_ENDPOINT = 'https://landregistry.data.gov.uk/landregistry/query';
const POSTCODE_PREFIX = 'SW6';
const MONTHS_LOOKBACK = 12;
const MANSION_TAX_THRESHOLD = 2_000_000;
const APPROACHING_BAND = 0.90;
const DATA_FILE = path.join(__dirname, '..', 'public', 'data', 'streets.json');

// ---- Static file cache (fast path) --------------------------------------
// Reads pre-baked JSON written by scripts/fetch-data.js. Sub-millisecond.
function readStaticData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.streets && parsed.streets.length > 0) return parsed;
    return null;
  } catch (_) {
    return null;
  }
}

// ---- Live SPARQL fallback (slow path, only if file is missing/empty) ----
let liveCache = { data: null, fetchedAt: 0 };
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

async function fetchLive() {
  const now = Date.now();
  if (liveCache.data && now - liveCache.fetchedAt < CACHE_TTL_MS) return liveCache.data;

  const since = new Date();
  since.setMonth(since.getMonth() - MONTHS_LOOKBACK);
  const sinceStr = since.toISOString().slice(0, 10);

  const query = `
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

  const url = `${SPARQL_ENDPOINT}?query=${encodeURIComponent(query)}&output=json`;
  const res = await fetch(url, { headers: { Accept: 'application/sparql-results+json' }, timeout: 45000 });
  if (!res.ok) throw new Error(`Land Registry returned ${res.status}`);
  const json = await res.json();

  const streets = {};
  for (const row of json.results.bindings) {
    const street = row.street?.value?.trim();
    const amount = row.amount ? parseInt(row.amount.value, 10) : null;
    if (!street || !amount) continue;
    if (!streets[street]) streets[street] = { street, sales: [] };
    streets[street].sales.push(amount);
  }

  const result = Object.values(streets).map((s) => {
    const sorted = [...s.sales].sort((a, b) => a - b);
    const count = sorted.length;
    const avg = Math.round(sorted.reduce((a, b) => a + b, 0) / count);
    const median = count % 2 === 0
      ? Math.round((sorted[count / 2 - 1] + sorted[count / 2]) / 2)
      : sorted[Math.floor((count - 1) / 2)];
    let mansionTaxStatus = 'clear';
    if (avg >= MANSION_TAX_THRESHOLD) mansionTaxStatus = 'over';
    else if (avg >= MANSION_TAX_THRESHOLD * APPROACHING_BAND) mansionTaxStatus = 'approaching';
    return {
      street: s.street, count, avgPrice: avg, medianPrice: median,
      minPrice: sorted[0], maxPrice: sorted[count - 1],
      mansionTaxStatus, pctOfThreshold: Math.round((avg / MANSION_TAX_THRESHOLD) * 100),
    };
  }).sort((a, b) => b.avgPrice - a.avgPrice);

  const data = { postcode: POSTCODE_PREFIX, monthsLookback: MONTHS_LOOKBACK,
    mansionTaxThreshold: MANSION_TAX_THRESHOLD, generatedAt: new Date().toISOString(), streets: result };
  liveCache = { data, fetchedAt: now };
  return data;
}

// ---- Routes -------------------------------------------------------------
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.json());

app.get('/api/streets', async (req, res) => {
  try {
    const static_data = readStaticData();
    if (static_data) return res.json({ ...static_data, source: 'file' });
    console.log('No static data file found — falling back to live SPARQL query...');
    const data = await fetchLive();
    res.json({ ...data, source: 'live' });
  } catch (err) {
    console.error('Failed to fetch data:', err.message);
    res.status(502).json({ error: 'Could not load street data.', detail: err.message });
  }
});

const leads = [];
app.post('/api/notify', (req, res) => {
  const { email, intent, street } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please provide a valid email address.' });
  }
  leads.push({ email, intent: intent === 'selling' ? 'selling' : 'watching', street: street || null, capturedAt: new Date().toISOString() });
  console.log('New lead:', leads[leads.length - 1]);
  res.json({ ok: true });
});

app.get('/api/leads', (req, res) => res.json({ count: leads.length, leads }));
app.get('/api/health', (req, res) => res.json({ ok: true, dataFile: !!readStaticData() }));

app.listen(PORT, () => console.log(`Fulham Mansion Watch running on port ${PORT}`));
