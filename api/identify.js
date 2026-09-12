import { readFileSync } from 'fs';
import { join } from 'path';

// Load product catalogue
let products = [];
try {
  products = JSON.parse(readFileSync(join(process.cwd(), 'data', 'products.json'), 'utf8'));
} catch (e) {
  console.warn('Could not load product catalogue:', e.message);
}

// === Elta reference data (built from Elta's selection program by scripts/build_elta.py) ===
let eltaModels = [];
const eltaByKey = new Map();
try {
  eltaModels = JSON.parse(readFileSync(join(process.cwd(), 'data', 'elta.json'), 'utf8')).models || [];
  for (const m of eltaModels) if (!eltaByKey.has(m.key)) eltaByKey.set(m.key, m);
} catch (e) {
  console.warn('Could not load Elta data:', e.message);
}

function normModel(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Give stocked Elta products real airflow figures (the Shopify export has none),
// so the airflow part of the scoring can actually work.
for (const p of products) {
  if (p.airflow_m3h) continue;
  const m = eltaByKey.get(normModel(p.sku));
  if (m && m.airflow_m3h) p.airflow_m3h = m.airflow_m3h;
}

// Find the Elta model a plate reading refers to. Exact code match first, then a
// unique prefix match (plates often drop or add a suffix, e.g. "SCP250/4-1").
function findEltaModel(fields) {
  if (!eltaModels.length) return null;
  const mentionsElta = /elta|fantech/i.test([fields.manufacturer, fields.notes].filter(Boolean).join(' '));
  // Try the model, the part number, then each word of the model (typed text like "Elta SCP630/4-1")
  const words = String(fields.model || '').split(/\s+/).filter(w => /\d/.test(w));
  for (const raw of [fields.model, fields.part_number, ...words]) {
    const key = normModel(raw);
    if (key.length < 4) continue;
    if (eltaByKey.has(key)) return eltaByKey.get(key);
    if (key.length < 6 && !mentionsElta) continue;
    // Plate code is the start of an Elta code (suffix missing) — prefer current models
    const longer = eltaModels.filter(m => m.key.startsWith(key));
    const current = longer.filter(m => m.current);
    const pool = current.length ? current : longer;
    if (pool.length && new Set(pool.map(m => m.size_mm)).size === 1) return pool[0];
    // Elta code is the start of the plate code (plate has extra characters)
    const shorter = eltaModels.filter(m => m.key.length >= 6 && key.startsWith(m.key))
      .sort((a, b) => b.key.length - a.key.length);
    if (shorter.length) return shorter[0];
  }
  return null;
}

// Current Elta models that could replace a superseded one: same kind of fan,
// same duct size and supply, and at least ~85% of the airflow.
function eltaEquivalents(old) {
  const sameFamilyWord = (a, b) => (a || '').split(' ')[0] === (b || '').split(' ')[0];
  const prefix = s => (s.match(/^[A-Z]+/) || [''])[0];
  return eltaModels
    .filter(m => m.current && m.key !== old.key && m.category === old.category &&
      m.size_mm === old.size_mm && (!old.phase || !m.phase || m.phase === old.phase) &&
      (!old.airflow_m3h || !m.airflow_m3h || m.airflow_m3h >= old.airflow_m3h * 0.85))
    .map(m => {
      let score = 0;
      if (m.family === old.family) score += 4; else if (sameFamilyWord(m.family, old.family)) score += 2;
      if (prefix(m.key) === prefix(old.key)) score += 3; // same product line, e.g. SCP -> SCP
      if (m.motor_type === old.motor_type) score += 2;
      if (m.poles && m.poles === old.poles) score += 1;
      if (old.airflow_m3h && m.airflow_m3h) {
        const r = m.airflow_m3h / old.airflow_m3h;
        score -= r < 1 ? (1 - r) * 3 : (r - 1); // falling short matters more than overshooting
      }
      return { m, score };
    })
    .sort((a, b) => b.score - a.score)
    .map(x => x.m);
}

// Overwrite AI guesses with Elta's own figures
function applyEltaData(fields, elta) {
  // Once Elta's own record is in hand, drop everything the AI guessed about the
  // fan — its notes contradict the real data, and specs it invented would be
  // shown under "Manufacturer data". Only figures Elta confirms are put back.
  for (const k of ['voltage', 'power', 'current', 'ip_rating', 'speed', 'frequency', 'notes', 'date']) delete fields[k];
  fields.manufacturer = 'Elta';
  fields.model = elta.model;
  fields.elta_model = elta.model;
  fields.range = elta.range;
  if (elta.rpm) fields.speed = elta.rpm + ' RPM';
  if (elta.size_mm) fields.size_mm = elta.size_mm;
  if (elta.airflow_m3h) {
    fields.airflow = elta.airflow_m3h + ' m³/h max (Elta data)';
    fields.estimated_airflow_m3h = elta.airflow_m3h;
  }
  if (elta.max_pressure_pa) fields.max_pressure = elta.max_pressure_pa + ' Pa';
  if (elta.spec && elta.spec.voltage) fields.voltage = elta.spec.voltage + 'V';
  if (elta.spec && elta.spec.flc_a) fields.current = elta.spec.flc_a + 'A';
  if (elta.spec && elta.spec.ip) fields.ip_rating = elta.spec.ip;
  if (elta.spec && elta.spec.motor_kw) fields.power = String(elta.spec.motor_kw); // already carries its unit
  if (elta.url) fields.manufacturer_url = elta.url;
  else delete fields.manufacturer_url; // AI-guessed links are often wrong
  delete fields.product_image_url;     // likewise AI-guessed image URLs
  delete fields.estimated_specs;
  if (!elta.current) fields.notes = 'This model has been superseded by Elta.';
  return fields;
}

// === Recommendation Logic (inline to avoid module issues on Vercel) ===

function parseSizeMm(str) {
  if (!str) return null;
  str = String(str);
  const mmMatch = str.match(/(\d{2,4})\s*mm/i);
  if (mmMatch) return parseInt(mmMatch[1]);
  const inchMap = { '4': 100, '5': 125, '6': 150, '7': 180, '8': 200, '9': 225, '10': 250, '12': 315, '14': 355, '16': 400, '18': 450, '20': 500 };
  const inchMatch = str.match(/(\d{1,2})\s*(?:inch|in|"|″|'')/i);
  if (inchMatch && inchMap[inchMatch[1]]) return inchMap[inchMatch[1]];
  return null;
}

function parseAirflow(str) {
  if (!str) return null;
  str = String(str);
  const m3hMatch = str.match(/([\d,.]+)\s*m[³3]\/?h/i);
  if (m3hMatch) return parseFloat(m3hMatch[1].replace(',', ''));
  const lsMatch = str.match(/([\d,.]+)\s*l\/?s/i);
  if (lsMatch) return Math.round(parseFloat(lsMatch[1].replace(',', '')) * 3.6);
  return null;
}

function parseMotorType(fields) {
  const searchStr = [fields.notes, fields.model, fields.manufacturer]
    .filter(Boolean).join(' ').toUpperCase();
  if (/\bEC\b|ECOWATT|LO.?CARBON|LOW ENERGY/.test(searchStr)) return 'EC';
  return 'AC';
}

function inferCategory(fields) {
  const s = [fields.manufacturer, fields.model, fields.notes, fields.part_number]
    .filter(Boolean).join(' ').toLowerCase();
  if (/inline|duct fan|in-line|centrifugal duct|\b(vl|hit|rvk|vent-?\d|td-|acp|sdx)\b/i.test(s)) return 'inline-duct-fan';
  if (/plate axial|plate fan|\b(hpa|hcb[bt]|hxbr|aw \d)\b/i.test(s)) return 'plate-axial-fan';
  if (/bathroom|extractor|silent|\b(bf silent|solo|silent\d|px\d|gx\d|cv[23]|centra|revive|ecoair)\b/i.test(s)) return 'bathroom-extractor';
  if (/mixed flow|\b(td-|acm)\b/i.test(s)) return 'mixed-flow-fan';
  if (/axial|wall fan|window fan|\b(vario)\b/i.test(s)) return 'axial-fan';
  if (/roof/.test(s)) return 'roof-fan';
  return null;
}

function extractSizeFromModel(model) {
  if (!model) return null;
  const patterns = [
    /(?:VL|K|HIT|RVK|ACP|SDX|BF)[\s-]?(\d{3})/i,
    /HPA(\d{3})/i,
    /AW[\s-](\d{3})/i,
    /TD-\d+\/(\d{3})/i,
    /VENT-(\d{3})/i,
    /(?:HXBR|HCBB|HCBT)\/\d-(\d{3})/i,
    /(?:ACM|SILENT|PX|GX|FLUX)[\s-]?(\d{3})/i,
    /\b(100|125|150|160|180|200|225|250|300|315|350|355|400|450|500|560|630)\b/
  ];
  for (const pat of patterns) {
    const m = model.match(pat);
    if (m) return parseInt(m[1]);
  }
  return null;
}

// === Fan type: "if it's a plate fan, only show plate fans" ===
// Catalogue products carry a Type_ tag from Shopify; a few don't, so fall back to the name.
const TYPE_GROUP = { 'Long Cased Axial': 'Cased Axial', 'Twin Fan': 'Box Fan' };
function productType(p) {
  if (p._type !== undefined) return p._type;
  const tag = (p.tags || []).find(t => t.startsWith('Type_') && t !== 'Type_EC Fans');
  let t = tag ? tag.slice(5) : null;
  if (!t) {
    const n = (p.name || '').toLowerCase();
    t = /plate/.test(n) ? 'Plate Axial' : /cased/.test(n) ? 'Cased Axial' : /roof/.test(n) ? 'Roof Fan'
      : /box/.test(n) ? 'Box Fan' : /inline|in-line|duct fan/.test(n) ? 'Duct Fan' : null;
  }
  p._type = t ? (TYPE_GROUP[t] || t) : null;
  return p._type;
}

// The identified fan's type, in the same terms as the catalogue
function identifiedType(fields, elta) {
  if (elta) {
    const f = elta.family || '';
    if (/roof/i.test(f)) return 'Roof Fan';
    if (/plate/i.test(f)) return 'Plate Axial';
    if (/duct|cased|contra|bifurcated/i.test(f) && /axial/i.test(f)) return 'Cased Axial';
    if (/box/i.test(f)) return 'Box Fan';
    if (/inline|multiflow|jetflow|sel |sem /i.test(f + ' ')) return 'Duct Fan';
    if (/mvhr/i.test(f)) return 'Whole House';
    if (/supply & extract/i.test(f)) return 'Single Room';
    if (/piv/i.test(f)) return 'PIV';
    if (/wall fan/i.test(f)) return 'Axial Fan';
    return null;
  }
  const ft = String(fields.fan_type || '').toLowerCase();
  if (/plate/.test(ft)) return 'Plate Axial';
  if (/cased|duct axial/.test(ft)) return 'Cased Axial';
  if (/roof/.test(ft)) return 'Roof Fan';
  if (/box|twin/.test(ft)) return 'Box Fan';
  if (/inline|duct|mixed/.test(ft)) return 'Duct Fan';
  if (/mvhr|heat recovery/.test(ft)) return 'Whole House';
  if (/piv|positive input/.test(ft)) return 'PIV';
  const slug = inferCategory(fields);
  return { 'plate-axial-fan': 'Plate Axial', 'inline-duct-fan': 'Duct Fan', 'mixed-flow-fan': 'Duct Fan', 'roof-fan': 'Roof Fan' }[slug] || null;
}

function getRecommendations(fields, elta) {
  if (!products.length) return { match_type: 'none', recommendations: [], message: "Product catalogue not loaded." };

  const criteria = {
    size_mm: parseInt(fields.size_mm) || parseSizeMm(fields.model) || parseSizeMm(fields.airflow) || parseSizeMm(fields.notes) ||
             extractSizeFromModel(fields.model) || extractSizeFromModel(fields.part_number),
    airflow_m3h: parseAirflow(fields.airflow) || parseFloat(fields.estimated_airflow_m3h) || null,
    motor_type: (elta && elta.motor_type) || parseMotorType(fields),
    type: identifiedType(fields, elta),
    brand: fields.manufacturer || null
  };

  // === Cross-reference tag matching (Replaces_MODEL) — hand-curated, so shown as-is ===
  const identifiedModel = (fields.model || '').replace(/[\s-]/g, '').toUpperCase();
  const identifiedPart = (fields.part_number || '').replace(/[\s-]/g, '').toUpperCase();
  if (identifiedModel || identifiedPart) {
    const crossRefMatches = products.filter(p => {
      const tags = Array.isArray(p.tags) ? p.tags : (typeof p.tags === 'string' ? p.tags.split(',').map(t => t.trim()) : []);
      return tags.some(tag => {
        if (!tag.toLowerCase().startsWith('replaces_')) return false;
        const t = tag.replace(/^Replaces_/i, '').replace(/[\s-]/g, '').toUpperCase();
        return (identifiedModel && t === identifiedModel) || (identifiedPart && t === identifiedPart);
      });
    });
    if (crossRefMatches.length > 0) {
      return {
        match_type: 'cross_reference',
        criteria,
        recommendations: crossRefMatches.map((p, i) => ({
          ...p, match_type: 'cross_reference', highlight: i === 0 ? 'Verified replacement' : null,
          match_reason: 'Verified replacement for ' + (fields.manufacturer || '') + ' ' + (fields.model || '')
        }))
      };
    }
  }

  const inStock = products.filter(p => p.in_stock);
  const sameType = p => !criteria.type || productType(p) === criteria.type;
  const list = [];
  const listed = p => list.some(x => x.sku === p.sku);

  // 1. Exact match: the same model number (ignoring spaces, dashes and slashes)
  const keys = [fields.model, fields.part_number, elta && elta.model].map(normModel).filter(k => k.length >= 4);
  // Also accept the model appearing as whole words in the product name (e.g. "Systemair K 200 M ...")
  const nameRes = [fields.model].filter(m => m && normModel(m).length >= 4).map(m => new RegExp('\\b' +
    m.trim().split(/[\s\-\/]+/).map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\-/]*') + '\\b', 'i'));
  const exact = inStock.find(p => keys.includes(normModel(p.sku))) ||
    inStock.find(p => nameRes.some(re => re.test(p.name)) && (!criteria.type || productType(p) === criteria.type));
  if (exact) {
    list.push({ ...exact, match_type: 'exact', highlight: 'Exact match',
      match_reason: 'Same model: ' + (fields.model || fields.part_number) });
  }

  // 2. Superseded Elta model: its current equivalent(s) we stock, same fan type only
  let matchType = exact ? 'exact' : null;
  if (!exact && elta && !elta.current) {
    for (const eq of eltaEquivalents(elta)) {
      const p = inStock.find(p => normModel(p.sku) === eq.key);
      if (!p || listed(p) || !sameType(p)) continue;
      list.push({ ...p, match_type: 'elta_equivalent', highlight: list.length === 0 ? 'Direct replacement' : null,
        match_reason: 'Current Elta equivalent of ' + elta.model +
          (eq.airflow_m3h && elta.airflow_m3h ? ' — ' + eq.airflow_m3h + ' m³/h vs ' + elta.airflow_m3h + ' m³/h' : '') });
      if (list.length >= 2) break;
    }
    if (list.length) matchType = 'elta_equivalent';
  }

  // 3. Alternatives of the same fan type, ranked by size, airflow, motor and brand.
  // If we never worked out a size, same-type fans are still better than nothing.
  const typeOnly = !criteria.size_mm && !!criteria.type && !list.length;
  if (criteria.size_mm || typeOnly) {
    const loose = [fields.model, fields.part_number].map(s => (s || '').toLowerCase().replace(/[\s-]/g, '')).filter(s => s.length >= 4);
    const scored = inStock.filter(p => !listed(p) && sameType(p)).map(p => {
      let score = typeOnly ? 50 : 0;
      const reasons = [];
      const pSku = p.sku.toLowerCase().replace(/[\s-]/g, ''), pName = p.name.toLowerCase().replace(/[\s-]/g, '');
      if (loose.some(m => pSku.includes(m) || pName.includes(m) || m.includes(pSku))) { score += 40; reasons.push('Same model family'); }
      if (criteria.size_mm && p.size_mm === criteria.size_mm) { score += 50; reasons.push('Same size'); }
      else if (criteria.size_mm && p.size_mm && Math.abs(p.size_mm - criteria.size_mm) <= 25) { score += 20; reasons.push('Close size'); }
      if (criteria.airflow_m3h && p.airflow_m3h) {
        const ratio = p.airflow_m3h / criteria.airflow_m3h;
        if (ratio >= 0.8 && ratio <= 1.2) { score += 30; reasons.push('Similar airflow'); }
        else if (ratio >= 0.6 && ratio <= 1.4) { score += 15; reasons.push('Comparable airflow'); }
      }
      if (criteria.motor_type && p.motor_type === criteria.motor_type) { score += 20; reasons.push('Same motor type'); }
      if (elta && elta.phase && p.phase === elta.phase) { score += 10; reasons.push(elta.phase === 1 ? 'Single phase' : 'Three phase'); }
      if (criteria.brand && p.brand && p.brand.toLowerCase() === criteria.brand.toLowerCase()) { score += 10; reasons.push('Same brand'); }
      if (criteria.type) reasons.unshift(criteria.type);
      return { ...p, match_score: score, match_reasons: reasons };
    })
    .filter(p => p.match_score >= 50)
    .sort((a, b) => b.match_score - a.match_score);

    const seen = new Set(list.map(p => p.sku));
    for (const p of scored) {
      if (list.length >= 4) break;
      if (seen.has(p.sku)) continue; // the catalogue repeats a few SKUs
      seen.add(p.sku);
      list.push({ ...p, match_type: 'similar', match_reason: p.match_reasons.join(' · ') });
    }
    if (!matchType && list.length) matchType = 'similar';
  }

  if (!list.length) {
    return {
      match_type: 'none',
      criteria,
      recommendations: [],
      message: "We couldn't find an automatic match, but don't worry — our team can help."
    };
  }
  return { match_type: matchType, criteria, recommendations: list };
}

async function searchShopify(fields) {
  const queries = [];
  // Try model number first, then part number, then category-based search
  if (fields.model) queries.push(fields.model);
  if (fields.part_number && fields.part_number !== fields.model) queries.push(fields.part_number);
  if (fields.manufacturer) queries.push(fields.manufacturer + ' ' + (fields.model || ''));
  // Category fallback based on AI notes
  const notes = (fields.notes || '').toLowerCase();
  if (notes.includes('axial')) queries.push('axial fan');
  else if (notes.includes('centrifugal')) queries.push('centrifugal fan');
  else if (notes.includes('inline') || notes.includes('duct')) queries.push('inline duct fan');
  else if (notes.includes('bathroom') || notes.includes('extractor')) queries.push('bathroom extractor');
  else if (notes.includes('mixed flow')) queries.push('mixed flow fan');
  
  for (const q of queries) {
    try {
      const url = 'https://www.efans.co.uk/search/suggest.json?q=' + encodeURIComponent(q) + '&resources[type]=product&resources[limit]=5';
      const r = await fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'eFans-Fan-Finder/1.0' } });
      if (!r.ok) continue;
      const d = await r.json();
      const products = d.resources?.results?.products || [];
      if (products.length > 0) {
        return products.filter(p => p.available).map(p => ({
          name: p.title,
          url: 'https://www.efans.co.uk' + p.url.split('?')[0],
          price_gbp: p.price ? parseFloat(p.price) : null,
          in_stock: p.available,
          match_reason: 'Found on efans.co.uk for "' + q + '"'
        }));
      }
    } catch(e) { continue; }
  }
  return [];
}

// === Product photos ===
// A photo is only shown when we can stand behind it: our own product image, or an
// image on a manufacturer page we fetched and checked actually covers this model.
// AI-guessed URLs are treated as leads to verify, never as answers.
const BRAND_DOMAIN = {
  elta: 'eltauk.com', fantech: 'eltauk.com', hydor: 'hydor.co.uk',
  'vent-axia': 'vent-axia.com', ventaxia: 'vent-axia.com',
  systemair: 'systemair.com', 'soler & palau': 'solerpalau.com', 'soler and palau': 'solerpalau.com',
  'sandp': 'solerpalau.com', 'sp': 'solerpalau.com',
  helios: 'heliosfans.co.uk', nuaire: 'nuaire.co.uk', vortice: 'vortice.ltd.uk',
  xpelair: 'xpelair.co.uk', greenwood: 'greenwood.co.uk', domus: 'domusventilation.co.uk',
  airflow: 'airflow.com', titon: 'titon.com', blauberg: 'blaubergventilatoren.de',
  'ebm-papst': 'ebmpapst.com', ebmpapst: 'ebmpapst.com', 'ziehl-abegg': 'ziehl-abegg.com',
  ziehlabegg: 'ziehl-abegg.com', flaktgroup: 'flaktgroup.com', woods: 'flaktgroup.com',
  casals: 'casals.tv', vents: 'vents.ua', maico: 'maico-ventilatoren.com'
};
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const fetchCache = new Map();
function cached(key, fn) {
  if (!fetchCache.has(key)) fetchCache.set(key, fn().catch(() => null));
  return fetchCache.get(key);
}

// Is this URL actually an image that loads?
function checkImage(url) {
  return cached('img:' + url, async () => {
    const r = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(3500),
      headers: { 'User-Agent': 'eFans-Fan-Finder/1.0', 'Range': 'bytes=0-2047' } });
    if (!r.ok && r.status !== 206) return null;
    const type = r.headers.get('content-type') || '';
    return /^image\//i.test(type) && !/svg/i.test(type) ? url : null;
  });
}

// The image a manufacturer page shows — only if the page really is about this fan
function pageImage(url, brand, modelKey) {
  return cached('page:' + url, async () => {
    const r = await fetch(url, { signal: AbortSignal.timeout(4000),
      headers: { 'User-Agent': 'eFans-Fan-Finder/1.0' } });
    if (!r.ok) return null;
    const html = (await r.text()).slice(0, 400000);
    const m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
              html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) ||
              html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
    if (!m) return null;
    // The page must mention the model, or be the manufacturer's own page for this range
    const flat = html.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const host = slug(new URL(url).host);
    const brandOk = !brand || host.includes(slug(brand)) || host.includes(slug(BRAND_DOMAIN[String(brand).toLowerCase()] || ''));
    const modelOk = !modelKey || modelKey.length < 4 || flat.includes(modelKey);
    if (!brandOk || !modelOk) return null;
    return new URL(m[1], url).href;
  });
}

// The best photo we can stand behind for the fan we just identified
async function fanImage(fields, elta, recommendations) {
  const modelKey = normModel((elta && elta.model) || fields.model || fields.part_number);
  // 1. Our own product photo, if we stock this exact fan
  const stocked = modelKey.length >= 4 && products.find(p => normModel(p.sku) === modelKey && p.image);
  if (stocked) return stocked.image;
  const exact = (recommendations.recommendations || []).find(p => p.match_type === 'exact' && p.image);
  if (exact) return exact.image;
  // 2. The manufacturer's own page. Elta's URL comes from their data, so it is trusted;
  //    for every other brand the AI proposes a URL and we verify it before using it.
  const brand = fields.manufacturer || '';
  const candidates = [];
  if (elta && elta.url) candidates.push(['page', elta.url, null]);
  if (fields.manufacturer_url) candidates.push(['page', fields.manufacturer_url, modelKey]);
  if (fields.product_image_url) candidates.push(['img', fields.product_image_url, null]);
  for (const [kind, url, key] of candidates) {
    try {
      const hit = kind === 'img' ? await checkImage(url) : await pageImage(url, brand, key);
      if (hit) return hit;
    } catch (e) { /* try the next lead */ }
  }
  return null;
}

// === Main Handler ===

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Either a photo of the ID plate, or the fan typed in (not every enquiry comes with a photo)
  const { image } = req.body;
  const typed = typeof req.body.text === 'string' ? req.body.text.trim().slice(0, 300) : '';
  if (!image && !typed) {
    return res.status(400).json({ error: 'Provide a photo or type the fan model' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ success: false, error: 'API key not configured' });
  }

  const intro = image
    ? 'Examine this photo of a fan ID plate / data plate / nameplate and extract as much information as possible.'
    : 'A customer has typed this description of their fan. It may be a model number, a part number, a brand, or a rough description:\n\n"' +
      typed.replace(/"/g, "'") + '"\n\nIdentify the fan and fill in as much as you can. Keep "model" exactly as the customer typed the model code.';
  const content = [];
  if (image) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: image.match(/^data:(image\/\w+);/)?.[1] || 'image/jpeg',
        data: image.replace(/^data:image\/\w+;base64,/, '')
      }
    });
  }
  content.push({ type: 'text', text: `You are a ventilation equipment expert working for eFans Direct, a UK trade supplier of extractor fans, MVHR units, and ventilation equipment.

${intro}

Return a JSON object with these fields (use null for any field you can't determine):

{
  "manufacturer": "Brand/manufacturer name",
  "model": "Model name/number",
  "part_number": "Part number or SKU if different from model",
  "voltage": "e.g. 230V or 400V",
  "frequency": "e.g. 50Hz",
  "power": "e.g. 150W",
  "current": "e.g. 0.65A",
  "airflow": "e.g. 500 m³/h or 139 l/s",
  "speed": "e.g. 1400 RPM",
  "ip_rating": "e.g. IP44",
  "date": "Manufacturing date if visible",
  "fan_type": "One of: plate axial, cased axial, inline duct, box, roof, wall/window axial, bathroom extractor, MVHR, PIV, unknown",
  "notes": "Any other relevant info you can see — motor type (EC/AC), class, weight, country of origin, certification marks, fan type (inline, axial, centrifugal, plate), duct size, etc."
}

If the image is NOT a fan ID plate (e.g. it's a photo of the fan housing, a random object, or unclear), still try to identify the fan type and manufacturer if possible, and note this in the "notes" field.

CRITICAL INSTRUCTION: You MUST estimate missing specs even if not on the plate. Use these rules:
1. AIRFLOW: You MUST provide an airflow estimate in m3/h. Use your knowledge of the manufacturer and model. If unsure, estimate from motor power and fan type.
2. SIZE: Extract duct/impeller size from the model number. Common patterns: AX56=560mm, K315=315mm, VL200=200mm. The number in the model usually indicates mm size.
3. FAN TYPE: AX=axial, K/VL/HIT/RVK=inline duct, HPA=plate axial, BF/Silent=bathroom, TD/ACM=mixed flow.
4. Add a field "size_mm" with the numeric duct/impeller diameter in millimetres.
5. Add a field "estimated_airflow_m3h" with your best estimate of max airflow in m3/h.
Always provide these even if approximate - they are essential for finding a replacement. Add "estimated_specs": true if you filled in specs from knowledge rather than the plate.

6. Add "manufacturer_url": the most likely URL of THIS product's own page on the manufacturer's website (e.g. vent-axia.com, systemair.com, heliosfans.co.uk, nuaire.co.uk, vortice.ltd.uk, solerpalau.com). Prefer the specific product or range page over the homepage. We fetch and check this page, so a best guess is useful — but leave it null if you have no idea of the domain.
7. Add "product_image_url" if you know a direct image URL for this product. We check that it loads before using it.

Return ONLY the JSON object, no other text.` });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6', // claude-sonnet-4-20250514 was retired on 15 June 2026
        max_tokens: 1024,
        messages: [{ role: 'user', content }]
      })
    });

    const data = await response.json();
    let cleaned = null;

    if (data.content && data.content[0] && data.content[0].text) {
      const text = data.content[0].text.trim().replace(/^```json\s*/, '').replace(/\s*```$/, '');
      try {
        const fields = JSON.parse(text);
        cleaned = {};
        for (const [k, v] of Object.entries(fields)) {
          if (v !== null && v !== '' && v !== 'null' && v !== 'N/A') cleaned[k] = v;
        }
      } catch (parseErr) {
        if (!typed) return res.status(200).json({ success: false, error: 'Could not parse AI response' });
      }
    } else {
      console.error('Anthropic API error:', response.status, JSON.stringify(data).slice(0, 500));
    }

    // If the AI couldn't help with typed text, still try the text as a model code
    if ((!cleaned || !Object.keys(cleaned).length) && typed) cleaned = { model: typed };
    if (!cleaned) return res.status(200).json({ success: false, error: 'No response from AI' });
    if (!Object.keys(cleaned).length) {
      return res.status(200).json({
        success: false,
        error: 'Could not extract any information',
        recommendations: { match_type: 'none', recommendations: [] }
      });
    }

    // Enrich fields with AI estimates for better matching
    if (cleaned.estimated_airflow_m3h && !cleaned.airflow) {
      cleaned.airflow = cleaned.estimated_airflow_m3h + ' m3/h';
    }
    // Swap AI guesses for Elta's own data when we recognise the model
    const elta = findEltaModel(cleaned);
    if (elta) {
      applyEltaData(cleaned, elta);
      if (!elta.current) {
        const eq = eltaEquivalents(elta)[0];
        if (eq) cleaned.current_equivalent = eq.model;
      }
    }
    let recommendations = getRecommendations(cleaned, elta);

    // Website search if nothing in the catalogue matched
    if (!recommendations.recommendations || recommendations.recommendations.length === 0) {
      if (cleaned.model || cleaned.part_number || cleaned.manufacturer) {
        const sr = await searchShopify(cleaned);
        if (sr.length > 0) recommendations = { match_type: 'shopify', recommendations: sr.map(p => ({ ...p, match_type: 'shopify' })) };
      }
    }

    const photo = await fanImage(cleaned, elta, recommendations);
    if (photo) cleaned.product_image_url = photo;

    return res.status(200).json({ success: true, source: image ? 'photo' : 'typed', fields: cleaned, recommendations });

  } catch (err) {
    console.error('AI identification error:', err);
    return res.status(500).json({ success: false, error: 'AI service error' });
  }
}
