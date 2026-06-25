# Fulham Property Intelligence
### SW6 Land Registry + EPC Sales Explorer

An interactive property sales map for Fulham (SW6), pulling live data from HM Land Registry and the EPC Open Data register to show real sold prices, actual floor areas, and accurate £PSF for every transaction in the past 5 years.

---

## Quick start

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
```

Edit `.env`:
```
EPC_EMAIL=your-email@example.com
EPC_API_KEY=your-epc-api-key
PORT=3000
```

**Getting your free EPC API key:**
1. Go to [epc.opendatacommunities.org](https://epc.opendatacommunities.org/)
2. Click **Register** — it's free, no payment required
3. Confirm your email — your API key arrives immediately
4. Paste into `.env`

### 3. Run
```bash
# Production
npm start

# Development (auto-restart on file changes, Node 18+)
npm run dev
```

Open **http://localhost:3000**

---

## What it does

### Landing page
Full-screen illustrated landing with a hand-drawn SVG skyline of Fulham Victorian terraces and the Thames — no external images, no copyright issues.

### Data pipeline
1. **Land Registry SPARQL** — queries `landregistry.data.gov.uk` for all SW6 transactions in the past 5 years (up to 3,000 results), proxied server-side to avoid CORS issues
2. **Postcodes.io geocoding** — batch-geocodes all postcodes to accurate lat/lng, proxied server-side
3. **EPC register** — fetches floor area (m²), EPC band, SAP score, and construction age for each postcode from `epc.opendatacommunities.org`, using your API key stored securely in `.env` — never exposed to the browser

### Caching
All three upstream APIs are cached server-side with a 6-hour TTL to avoid hammering rate limits.

### £PSF
- **Green badge** = actual floor area from EPC register → real £PSF
- **Grey badge** = estimated using typical sqft by type (flat: 650, terraced: 1,100, semi: 1,200, detached: 1,500) until EPC data loads

---

## Project structure

```
fulham-explorer/
├── server/
│   └── index.js          Express server + API proxy routes
├── public/
│   └── index.html        Full frontend (landing + app)
├── .env.example          Environment variable template
├── .gitignore
└── package.json
```

---

## API routes

| Method | Route | Description |
|--------|-------|-------------|
| `POST` | `/api/landregistry` | Proxy to Land Registry SPARQL |
| `GET`  | `/api/epc?postcode=SW6+1AA` | Proxy to EPC register (auth server-side) |
| `POST` | `/api/geocode` | Proxy to postcodes.io |
| `GET`  | `/api/health` | Server status + EPC credential check |

---

## Deploying

### Render / Railway / Fly.io
Set the environment variables `EPC_EMAIL`, `EPC_API_KEY`, and `PORT` in your platform's dashboard and deploy the repo root. The `npm start` command starts the server.

### Netlify / Vercel
These are serverless platforms — the Express server won't run as-is. You'd need to convert `server/index.js` to serverless functions, or use a separate API host.

### Caddy / nginx reverse proxy
Set `PORT=3000` and proxy `yourdomain.com → localhost:3000`.

---

## Data sources & licences

- **HM Land Registry Price Paid Data** — Open Government Licence v3.0
- **EPC Open Data** (DLUHC) — Open Government Licence v3.0
- **Postcodes.io** — MIT licence, free public API
- **CartoDB Positron** tiles — © OpenStreetMap contributors, © CARTO
- **Leaflet.js** — BSD 2-Clause
