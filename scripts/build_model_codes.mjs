// Build data/model_codes.json — what a fan's model code tells us on its own.
//
// The AI reads a plate well but classifies from general knowledge, and it gets
// sub-types wrong on trade codes: it called an S&P HXBR a cased axial (it is a
// plate axial), a TCBBX2 a box fan (cased axial), and an ebm-papst D2E146 a
// plate axial (it is a centrifugal). Every one of those is answered
// unambiguously by our own catalogue — so look it up instead of asking.
//
//   node scripts/build_model_codes.mjs
//
// Re-run when the catalogue changes and commit the result.

import { readFileSync, writeFileSync } from 'fs';

const ROOT = new URL('..', import.meta.url).pathname;
const products = JSON.parse(readFileSync(ROOT + 'data/products.json', 'utf8'));

const TYPE_GROUP = { 'Long Cased Axial': 'Cased Axial', 'Twin Fan': 'Box Fan' };
function productType(p) {
  const tag = (p.tags || []).find(t => t.startsWith('Type_') && t !== 'Type_EC Fans');
  let t = tag ? tag.slice(5) : null;
  if (!t) {
    const n = (p.name || '').toLowerCase();
    t = /plate/.test(n) ? 'Plate Axial' : /cased/.test(n) ? 'Cased Axial' : /roof/.test(n) ? 'Roof Fan'
      : /box/.test(n) ? 'Box Fan' : /inline|in-line|duct fan/.test(n) ? 'Duct Fan' : null;
  }
  return t ? (TYPE_GROUP[t] || t) : null;
}

// Codes we have confirmed off an actual ID plate, for makes we don't stock and
// so can't mine from the catalogue. Keep this list to things that have been
// seen and checked — a wrong entry here is worse than no entry, because the
// tool would stop asking and start asserting.
const CONFIRMED = {
  RRK: { brand: 'Helios', type: 'Duct Fan' },        // Helios RRK 315 plate, round duct fan
  EFU: { brand: 'Roof Units', type: 'Roof Fan' },    // Roof Units EFU 500/4/1 B plate
  VVX: { brand: 'Villavent', type: 'Whole House' },  // Villavent VVX-500, "heat recovery unit" on the plate
  D2E: { brand: 'ebm-papst', type: 'Centrifugal' },  // ebm-papst D2E146-AP47-75, single-inlet centrifugal
  OZEO: { brand: 'S&P', type: 'Bathroom' }           // S&P OZEO E ECOWATT RF, 48W single-room extract
};

const seen = new Map();
function note(prefix, brand, type) {
  if (!prefix || prefix.length < 2 || !brand || !type) return;
  const k = brand + '|' + type;
  if (!seen.has(prefix)) seen.set(prefix, new Map());
  const m = seen.get(prefix);
  m.set(k, (m.get(k) || 0) + 1);
}
for (const p of products) {
  const type = productType(p), brand = p.brand;
  // Match the name as written: a model code is already upper-case, which keeps
  // ordinary words ("Plate", "Fan") out even when a number follows them.
  const from = [p.name || '', String(p.sku || '')].join(' ');
  for (const m of from.matchAll(/\b([A-Z]{2,7})[ \-/]?(?=\d)/g)) note(m[1], brand, type);
}

// Look like codes, aren't
const STOP = new Set(['IP', 'RAL', 'LED', 'USB', 'PVC', 'GRP', 'MM', 'DIA', 'NO', 'PH', 'HZ', 'KW',
                      'EC', 'AC', 'UK', 'CE', 'BS', 'SW', 'LH', 'RH', 'IPX', 'ISO']);

const table = {};
for (const [prefix, counts] of seen) {
  if (STOP.has(prefix)) continue;
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [topKey, topN] = rows[0];
  const rest = rows.slice(1).reduce((a, r) => a + r[1], 0);
  // Confident only where one brand and type clearly dominate, with real support
  if (topN < 2) continue;
  if (rest > 0 && topN < rest * 3) continue;
  const [brand, type] = topKey.split('|');
  table[prefix] = { brand, type };
}
for (const [k, v] of Object.entries(CONFIRMED)) table[k] = v;

writeFileSync(ROOT + 'data/model_codes.json', JSON.stringify(table, null, 1));
console.log('model codes:', Object.keys(table).length,
            '(' + Object.keys(CONFIRMED).length + ' confirmed by hand from plates)');
