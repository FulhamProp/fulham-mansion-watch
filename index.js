'use strict'; // v4

import 'dotenv/config';
import express from 'express';
import compression from 'compression';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const possiblePaths = [
  join(__dirname, '..', 'public'),
  join(__dirname, 'public'),
  join(process.cwd(), 'public'),
  resolve('public'),
];
const PUBLIC_DIR = possiblePaths.find(p => existsSync(p)) || join(__dirname, '..', 'public');

const EPC_EMAIL      = process.env.EPC_EMAIL      || '';
const EPC_API_KEY    = process.env.EPC_API_KEY    || '';
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || '';
const EPC_B64        = Buffer.from(`${EPC_EMAIL}:${EPC_API_KEY}`).toString('base64');
const EPC_BASE       = 'https://epc.opendatacommunities.org/api/v1/domestic/search';

app.use(compression());
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Cache (6hr TTL) ────────────────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { cache.delete(key); return null; }
  return entry.data;
}
function cacheSet(key, data) { cache.set(key, { data, ts: Date.now() }); }

// ── EPC proxy ─────────────────────────────────────────────────────────────
app.get('/api/epc', async (req, res) => {
  const postcode = (req.query.postcode || '').trim().toUpperCase();
  if (!postcode) return res.status(400).json({ error: 'postcode required' });
  if (!EPC_EMAIL || !EPC_API_KEY) return res.status(503).json({ error: 'EPC credentials not configured' });
  const cacheKey = `epc:${postcode}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);
  try {
    const upstream = await fetch(`${EPC_BASE}?postcode=${encodeURIComponent(postcode)}&size=100`, {
      headers: { Authorization: `Basic ${EPC_B64}`, Accept: 'application/json' },
    });
    if (!upstream.ok) return res.status(upstream.status).json({ error: `EPC API returned ${upstream.status}` });
    const data = await upstream.json();
    cacheSet(cacheKey, data);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach EPC API', detail: err.message });
  }
});

// ── Land Registry proxy ───────────────────────────────────────────────────
app.post('/api/landregistry', async (req, res) => {
  const { query } = req.body;
  if (!query || typeof query !== 'string') return res.status(400).json({ error: 'query required' });
  const cacheKey = `lr:${query.length}:${query.slice(40, 80)}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);
  try {
    const upstream = await fetch('https://landregistry.data.gov.uk/landregistry/query?output=json&query=' + encodeURIComponent(query), {
      headers: { Accept: 'application/sparql-results+json' },
    });
    if (!upstream.ok) return res.status(upstream.status).json({ error: `Land Registry returned ${upstream.status}` });
    const data = await upstream.json();
    cacheSet(cacheKey, data);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach Land Registry', detail: err.message });
  }
});

// ── Postcodes.io batch geocode (postcode centroid fallback) ────────────────
app.post('/api/geocode', async (req, res) => {
  const { postcodes } = req.body;
  if (!Array.isArray(postcodes) || !postcodes.length) return res.status(400).json({ error: 'postcodes array required' });
  try {
    const upstream = await fetch('https://api.postcodes.io/postcodes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ postcodes: postcodes.slice(0, 100) }),
    });
    res.json(await upstream.json());
  } catch (err) {
    res.status(502).json({ error: 'Geocode failed', detail: err.message });
  }
});

// ── Google Geocoding proxy ────────────────────────────────────────────────
// POST /api/geocode-address  { addresses: ["14 Munster Road, SW6 4EN", ...] }
// Geocodes full addresses via Google Maps API server-side (key never exposed).
// Returns array of { address, lat, lng, accuracy } in same order.
// Batched with a small delay to respect Google's rate limits.
// Results cached per address for 24 hours.
app.post('/api/geocode-address', async (req, res) => {
  const { addresses } = req.body;
  if (!Array.isArray(addresses) || !addresses.length) {
    return res.status(400).json({ error: 'addresses array required' });
  }
  if (!GOOGLE_API_KEY) {
    return res.status(503).json({ error: 'Google API key not configured', fallback: true });
  }

  const results = [];
  for (const address of addresses.slice(0, 200)) {
    const cacheKey = `geo:${address}`;
    const cached = cacheGet(cacheKey);
    if (cached) { results.push(cached); continue; }

    try {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address + ', London, UK')}&key=${GOOGLE_API_KEY}&region=gb&bounds=51.45,-0.23|51.50,-0.16`;
      const r = await fetch(url);
      const j = await r.json();

      if (j.status === 'OK' && j.results?.[0]) {
        const loc = j.results[0].geometry.location;
        const type = j.results[0].geometry.location_type;
        const entry = {
          address,
          lat: loc.lat,
          lng: loc.lng,
          // ROOFTOP = exact, RANGE_INTERPOLATED = street-level, GEOMETRIC_CENTER = postcode
          accuracy: type === 'ROOFTOP' ? 'exact' : type === 'RANGE_INTERPOLATED' ? 'street' : 'approximate'
        };
        cacheSet(cacheKey, entry);
        results.push(entry);
      } else {
        results.push({ address, lat: null, lng: null, accuracy: 'failed' });
      }
    } catch {
      results.push({ address, lat: null, lng: null, accuracy: 'failed' });
    }

    // Small delay to stay within Google's QPS limit
    await new Promise(r => setTimeout(r, 20));
  }

  res.json({ results });
});

// ── Health check ──────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: 'v4',
    epcEnabled: !!(EPC_EMAIL && EPC_API_KEY),
    googleGeoEnabled: !!GOOGLE_API_KEY,
    publicDir: PUBLIC_DIR,
    publicExists: existsSync(PUBLIC_DIR),
    cwd: process.cwd(),
    cacheSize: cache.size,
    uptime: Math.round(process.uptime()) + 's',
  });
});

// ── Static frontend ───────────────────────────────────────────────────────
app.use(express.static(PUBLIC_DIR));
app.get('*', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.sendFile(join(PUBLIC_DIR, 'index.html'));
});

createServer(app).listen(PORT, () => {
  console.log(`\n  ◆ Fulham Property Explorer`);
  console.log(`  ◆ http://localhost:${PORT}`);
  console.log(`  ◆ Public dir: ${PUBLIC_DIR} (exists: ${existsSync(PUBLIC_DIR)})`);
  console.log(`  ◆ EPC: ${EPC_EMAIL ? '✓' : '✗ not configured'}`);
  console.log(`  ◆ Google Geocoding: ${GOOGLE_API_KEY ? '✓' : '✗ not configured — add GOOGLE_API_KEY to .env'}\n`);
});
