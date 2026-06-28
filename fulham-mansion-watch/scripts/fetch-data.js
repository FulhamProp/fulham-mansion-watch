#!/usr/bin/env node
/**
 * fetch-data.js — run this locally once a month to refresh the street data.
 *
 * Usage:
 *   node scripts/fetch-data.js
 *
 * It queries HM Land Registry for all SW6 terraced house sales in the last
 * 12 months, aggregates by street, and writes the result to:
 *   public/data/streets.json
 *
 * Commit that file to GitHub and Render will serve the fresh data instantly
 * with no SPARQL query at runtime.
 */

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const SPARQL_ENDPOINT = 'https://landregistry.data.gov.uk/landregistry/query';
const POSTCODE_PREFIX = 'SW6';
const MONTHS_LOOKBACK = 12;
const MANSION_TAX_THRESHOLD = 2_000_000;
const APPROACHING_BAND = 0.90;
const OUT_PATH = path.join(__dirname, '..', 'public', 'data', 'streets.json');

async function main() {
  console.log('Fetching SW6 terraced house sales from HM Land Registry...');
  console.log('(This can take 15–30 seconds — their SPARQL endpoint is slow)\n');

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
  const res = await fetch(url, {
    headers: { Accept: 'application/sparql-results+json' },
    timeout: 60000,
  });

  if (!res.ok) throw new Error(`SPARQL endpoint returned ${res.status}`);
  const json = await res.json();
  const bindings = json.results.bindings;

  console.log(`Got ${bindings.length} raw transactions. Aggregating by street...`);

  const streets = {};
  for (const row of bindings) {
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
      street: s.street,
      count,
      avgPrice: avg,
      medianPrice: median,
      minPrice: sorted[0],
      maxPrice: sorted[count - 1],
      mansionTaxStatus,
      pctOfThreshold: Math.round((avg / MANSION_TAX_THRESHOLD) * 100),
    };
  }).sort((a, b) => b.avgPrice - a.avgPrice);

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  const output = {
    postcode: POSTCODE_PREFIX,
    monthsLookback: MONTHS_LOOKBACK,
    mansionTaxThreshold: MANSION_TAX_THRESHOLD,
    generatedAt: new Date().toISOString(),
    streets: result,
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));

  console.log(`\n✓ Done. ${result.length} streets written to ${OUT_PATH}`);
  console.log(`✓ Commit public/data/streets.json to GitHub to publish the update.`);
  console.log('\nTop 5 streets:');
  result.slice(0, 5).forEach((s, i) => {
    const flag = s.mansionTaxStatus === 'over' ? '🔴' : s.mansionTaxStatus === 'approaching' ? '🟡' : '🟢';
    console.log(`  ${i + 1}. ${s.street} — £${s.avgPrice.toLocaleString()} ${flag}`);
  });
}

main().catch((err) => {
  console.error('\n✗ Failed:', err.message);
  process.exit(1);
});
