// Build data/shopify_specs.json — the duty figures the Fan Finder matches on.
//
// The Shopify product export we feed the tool carries no airflow at all, which
// meant the "does this replacement actually move enough air" test could not run
// for four products in five. The figures were there all along, inside the
// custom.pdp_specifications metafield — just written a dozen different ways
// ("Max airflow", "Airflow (max, free air)", "Air delivery (max)"), with sizes
// under four more labels again. This normalises them into canonical keys.
//
//   SHOPIFY_STORE=efans-shop SHOPIFY_ADMIN_TOKEN=shpat_... node scripts/build_specs.mjs
//
// Re-run it whenever products are added or their specifications are edited, and
// commit the result. Nothing reads Shopify at request time.

import { writeFileSync } from 'fs';

const STORE = process.env.SHOPIFY_STORE || 'efans-shop';
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API = `https://${STORE}.myshopify.com/admin/api/2025-01/graphql.json`;
if (!TOKEN) {
  console.error('Set SHOPIFY_ADMIN_TOKEN (Admin API access token with read_products).');
  process.exit(1);
}

const QUERY = `query($after:String){
  products(first:50, query:"status:active", after:$after){
    nodes{ title tags variants(first:1){nodes{sku}}
           metafield(namespace:"custom", key:"pdp_specifications"){ value } }
    pageInfo{ hasNextPage endCursor }
  }
}`;

// A figure may be written 1,470 or 1.470 or 1470 — and on a German-influenced
// spec sheet "70.000" is seventy thousand, not seventy. Read the separators
// rather than trusting parseFloat, which silently divides by a thousand.
function parseNum(raw) {
  let t = String(raw).replace(/\s/g, '');
  const dot = t.lastIndexOf('.'), comma = t.lastIndexOf(',');
  if (dot >= 0 && comma >= 0) t = comma > dot ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  else if (comma >= 0) t = /^\d{1,3}(,\d{3})+$/.test(t) ? t.replace(/,/g, '') : t.replace(',', '.');
  else if (dot >= 0 && /^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
  const v = parseFloat(t);
  return Number.isFinite(v) ? v : null;
}

const AIRFLOW_LABEL = /air\s?(flow|delivery)|extract(ion)?\s*rate|volume\s*flow/i;
const SIZE_LABEL = /diameter|duct\s*connection|fan\s*size|duct\s*diameter|spigot|nominal\s*size/i;

// "100mm to 500mm" and "400/450mm" describe a range the product family covers,
// not the size of one fan. A range used as a size would wave through a 100mm fan
// for a 500mm duct, so treat it as unknown.
function sizeFrom(value) {
  const v = String(value);
  if (/\bto\b|–|—|\d\s*\/\s*\d|x/i.test(v)) return null;
  const m = v.match(/(\d{2,4})\s*mm/i);
  const n = m ? parseInt(m[1]) : null;
  return n && n >= 60 && n <= 2500 ? n : null;
}

function airflowFrom(value) {
  const v = String(value);
  const m3h = v.match(/([\d][\d,. ]{0,9})\s*m\s*[³3]\s*\/\s*h/i);
  if (m3h) { const n = parseNum(m3h[1]); if (n) return Math.round(n); }
  const m3s = v.match(/([\d][\d,. ]{0,6})\s*m\s*[³3]\s*\/\s*s/i);
  if (m3s) { const n = parseNum(m3s[1]); if (n) return Math.round(n * 3600); }
  const ls = v.match(/([\d][\d,. ]{0,7})\s*l\s*\/\s*s\b/i);
  if (ls) { const n = parseNum(ls[1]); if (n) return Math.round(n * 3.6); }
  return null;
}

function phaseFrom(specs, tags) {
  const row = specs.find(s => /^phase$/i.test(s.Label || ''));
  if (row) {
    if (/\b(3|three)\b|3~/i.test(row.Value)) return 3;
    if (/\b(1|single)\b|1~/i.test(row.Value)) return 1;
  }
  if (tags.some(t => /^Phase_Phase 3$/i.test(t))) return 3;
  if (tags.some(t => /^Phase_Phase 1$/i.test(t))) return 1;
  return null;
}

function polesFrom(specs, tags) {
  const row = specs.find(s => /^poles?$/i.test(s.Label || ''));
  if (row) { const n = parseInt(String(row.Value).match(/\d+/)?.[0]); if (n >= 2 && n <= 12) return n; }
  const tag = tags.find(t => /^Pole_/i.test(t));
  if (tag) { const n = parseInt(tag.match(/\d+/)?.[0]); if (n >= 2 && n <= 12) return n; }
  return null;
}

const out = {};
let after = null, pages = 0, scanned = 0;
do {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
    body: JSON.stringify({ query: QUERY, variables: { after } })
  });
  if (!res.ok) { console.error('Shopify returned', res.status, await res.text()); process.exit(1); }
  const body = await res.json();
  if (body.errors) { console.error(JSON.stringify(body.errors)); process.exit(1); }
  const page = body.data.products;
  for (const node of page.nodes) {
    scanned++;
    const sku = node.variants?.nodes?.[0]?.sku;
    if (!sku) continue;
    let specs = [];
    try { specs = JSON.parse(node.metafield?.value || '[]'); } catch { specs = []; }
    if (!Array.isArray(specs)) specs = [];
    const tags = node.tags || [];

    // Reversible fans quote extract and supply separately — take the higher.
    let airflow = null;
    for (const s of specs) {
      if (!AIRFLOW_LABEL.test(s.Label || '')) continue;
      const n = airflowFrom(s.Value);
      if (n && (airflow === null || n > airflow)) airflow = n;
    }
    let size = null;
    for (const s of specs) {
      if (!SIZE_LABEL.test(s.Label || '')) continue;
      size = sizeFrom(s.Value);
      if (size) break;
    }
    const row = { airflow_m3h: airflow, phase: phaseFrom(specs, tags), size_mm: size, poles: polesFrom(specs, tags) };
    const filled = r => Object.values(r).filter(v => v !== null).length;
    if (!out[sku] || filled(row) > filled(out[sku])) out[sku] = row;
  }
  after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  pages++;
} while (after);

writeFileSync(new URL('../data/shopify_specs.json', import.meta.url), JSON.stringify(out));
const n = k => Object.values(out).filter(r => r[k] !== null).length;
console.log(`${scanned} products over ${pages} pages -> ${Object.keys(out).length} SKUs`);
console.log(`airflow ${n('airflow_m3h')} · size ${n('size_mm')} · phase ${n('phase')} · poles ${n('poles')}`);
