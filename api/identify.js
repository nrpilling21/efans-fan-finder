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

// === Specifications normalised out of the Shopify pdp_specifications metafield ===
// The catalogue export carries no duty figures at all, which left the "does this
// replacement actually move enough air" test unanswerable for four products in
// five. The figures were there the whole time, just under a dozen different label
// spellings; scripts/build_specs.mjs normalises them. Rebuild it when the
// catalogue changes.
let shopifySpecs = {};
try {
  shopifySpecs = JSON.parse(readFileSync(join(process.cwd(), 'data', 'shopify_specs.json'), 'utf8'));
} catch (e) {
  console.warn('Could not load Shopify specs:', e.message);
}

// Give stocked products their real figures: Shopify first, then Elta's own
// selection data, which is the better source for the Elta range.
for (const p of products) {
  const s = shopifySpecs[String(p.sku)];
  if (s) {
    if (!p.airflow_m3h && s.airflow_m3h) p.airflow_m3h = s.airflow_m3h;
    if (!p.size_mm && s.size_mm) p.size_mm = s.size_mm;
    if (!p.phase && s.phase) p.phase = s.phase;
    if (!p.poles && s.poles) p.poles = s.poles;
  }
  const m = eltaByKey.get(normModel(p.sku));
  if (m) {
    if (m.airflow_m3h) p.airflow_m3h = m.airflow_m3h;
    if (m.poles && !p.poles) p.poles = m.poles;
    if (m.phase && !p.phase) p.phase = m.phase;
  }
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

// Current Elta models that could replace a superseded one: same kind of fan, same
// duct size and supply, and at least the airflow of the fan coming out. The old
// 85% allowance meant a "direct replacement" could quietly under-perform the fan
// it replaced, which is the one thing a replacement must not do.
function eltaEquivalents(old) {
  const sameFamilyWord = (a, b) => (a || '').split(' ')[0] === (b || '').split(' ')[0];
  const prefix = s => (s.match(/^[A-Z]+/) || [''])[0];
  return eltaModels
    .filter(m => m.current && m.key !== old.key && m.category === old.category &&
      m.size_mm === old.size_mm && (!old.phase || !m.phase || m.phase === old.phase) &&
      (!old.poles || !m.poles || m.poles === old.poles) &&
      (!old.airflow_m3h || !m.airflow_m3h || m.airflow_m3h >= old.airflow_m3h))
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
// Fans that are specified for a duty no general-purpose fan can stand in for:
// smoke extract carries a fire rating, car park jet fans are sized on thrust
// rather than duct airflow, and marine fans are built to a different standard.
// Matching these on size and airflow would produce something that looks right
// and is not, so the tool declines and hands them to a person.
function isSpecialist(elta) {
  return !!elta && /smoke|f400|jetvent|jet fan|impulse|induction|marine/i.test(elta.family + ' ' + elta.range);
}

function identifiedType(fields, elta) {
  if (elta) {
    if (isSpecialist(elta)) return null;
    const f = elta.family || '';
    if (/roof/i.test(f)) return 'Roof Fan';
    if (/plate/i.test(f)) return 'Plate Axial';
    if (/duct|cased|contra|bifurcated/i.test(f) && /axial/i.test(f)) return 'Cased Axial';
    if (/box/i.test(f)) return 'Box Fan';
    if (/inline|multiflow|jetflow|miniflow|sel |sem /i.test(f + ' ')) return 'Duct Fan';
    if (/mvhr|energy recovery|heat recovery/i.test(f)) return 'Whole House';
    if (/supply & extract/i.test(f)) return 'Single Room';
    if (/piv/i.test(f)) return 'PIV';
    if (/wall fan|residential axial/i.test(f)) return 'Axial Fan';
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

// The Shopify vendor field is the supplier, not always the badge on the fan:
// Hydor products are sold to us by Elta Group, so they carry "Elta" as the vendor.
// The customer sees the name, so match on the brand the name leads with when we know it.
const brandKey = b => String(b || '').toLowerCase().replace(/[^a-z0-9]/g, '');
let knownBrands = null;
function productBrand(p) {
  if (!knownBrands) knownBrands = new Set(products.map(x => brandKey(x.brand)).filter(Boolean));
  const lead = brandKey(String(p.name || '').split(/[\s\-]/)[0]);
  return lead && knownBrands.has(lead) ? lead : brandKey(p.brand);
}

// Single-phase or three-phase, from whatever the plate or the typed text gave us.
//
// Supply voltage is NOT a phase indicator, though it reads like one. An ID plate
// carries the run capacitor's voltage rating too — "30uF/400V", "Cap 25µF 400V" —
// and reading that 400V as a three-phase supply turned two single-phase fans in
// testing into four three-phase recommendations each, none of which could be
// fitted. Elta also sell 230V three-phase fans, so 230V does not mean single
// either. Only the explicit phase notation counts.
function parsePhase(fields) {
  const t = [fields.phase, fields.voltage, fields.model, fields.notes].filter(Boolean).join(' ');
  // Plates write it both ways round: "3 PH" and "PH 3" are both common, and Roof
  // Units print "PH 1" against a 230V supply. Read the number on either side.
  if (/\b3\s*~|\b3\s*-?\s*(ph\b|phase)|(ph\b|phase)\s*:?\s*3\b|three[\s-]*phase/i.test(t)) return 3;
  if (/\b1\s*~|\b1\s*-?\s*(ph\b|phase)|(ph\b|phase)\s*:?\s*1\b|single[\s-]*phase/i.test(t)) return 1;
  // A lone tilde against the voltage is the IEC mark for single-phase AC
  // ("230V~", "V~: 230"); a three-phase plate writes 3~ and is caught above.
  if (/\d\s*V\s*~|\bV\s*~\s*:?\s*\d/i.test(t)) return 1;
  // A run capacitor is only ever fitted to a single-phase induction motor, so a
  // capacitance on the plate settles it where the notation is missing.
  if (/\d+([.,]\d+)?\s*[µu]F\b|\bcapacit|\bcap\s*\d/i.test(t)) return 1;
  return null;
}

// Pole count sets how fast the fan turns, and therefore how much air it moves.
// Two fans from the same range in the same duct size can differ fourfold on duty
// with nothing but the pole count to tell them apart, so it is not decoration.
function parsePoles(fields, elta) {
  if (elta && elta.poles) return elta.poles;
  const t = [fields.model, fields.part_number].filter(Boolean).join(' ');
  const m = t.match(/\/(\d{1,2})-\d/) || t.match(/\b(\d)\s*pole/i);
  const n = m ? parseInt(m[1]) : null;
  return n && n >= 2 && n <= 12 ? n : null;
}

// The rules a replacement has to satisfy before it is worth putting in front of
// someone. Each is checked only where we hold figures for both fans: a rule we
// cannot check is reported as unverified rather than quietly treated as passed.
// A rule we CAN check and that fails takes the product out of the running.
function checkFit(criteria, p) {
  const broken = [], unverified = [];

  if (criteria.size_mm && p.size_mm) {
    if (p.size_mm !== criteria.size_mm) broken.push('duct size ' + p.size_mm + 'mm, needs ' + criteria.size_mm + 'mm');
  } else if (criteria.size_mm) unverified.push('duct size');

  if (criteria.airflow_m3h && p.airflow_m3h) {
    if (p.airflow_m3h < criteria.airflow_m3h) {
      broken.push('moves ' + p.airflow_m3h + ' m³/h against ' + criteria.airflow_m3h + ' m³/h');
    }
  } else if (criteria.airflow_m3h) unverified.push('airflow');

  if (criteria.phase && p.phase) {
    if (p.phase !== criteria.phase) broken.push(p.phase === 3 ? 'three phase, needs single' : 'single phase, needs three');
  } else if (criteria.phase) unverified.push('phase');

  // Where duty cannot be compared directly, pole count stands in for it — but only
  // as a veto on an obvious mismatch, never as a reason to prefer one fan.
  if (!criteria.airflow_m3h || !p.airflow_m3h) {
    if (criteria.poles && p.poles && p.poles !== criteria.poles) {
      broken.push(p.poles + '-pole against ' + criteria.poles + '-pole');
    }
  }
  return { broken, unverified };
}

function getRecommendations(fields, elta) {
  if (!products.length) return { match_type: 'none', recommendations: [], message: "Product catalogue not loaded." };

  const criteria = {
    // Elta's own record of the fan beats anything read off a plate or inferred
    size_mm: (elta && elta.size_mm) || parseInt(fields.size_mm) || parseSizeMm(fields.model) ||
             parseSizeMm(fields.airflow) || parseSizeMm(fields.notes) ||
             extractSizeFromModel(fields.model) || extractSizeFromModel(fields.part_number),
    airflow_m3h: (elta && elta.airflow_m3h) || parseAirflow(fields.airflow) || parseFloat(fields.estimated_airflow_m3h) || null,
    motor_type: (elta && elta.motor_type) || parseMotorType(fields),
    type: identifiedType(fields, elta),
    phase: (elta && elta.phase) || parsePhase(fields),
    poles: parsePoles(fields, elta),
    brand: fields.manufacturer || null
  };
  // If the fan being replaced is one we stock, our own record of it beats anything
  // read off a plate or guessed — use it for every figure it can supply.
  const ownKeys = [fields.model, fields.part_number].map(normModel).filter(k => k.length >= 4);
  const original = ownKeys.length ? products.find(p => ownKeys.includes(normModel(p.sku))) : null;
  if (original) {
    if (original.airflow_m3h) criteria.airflow_m3h = original.airflow_m3h;
    if (original.size_mm) criteria.size_mm = original.size_mm;
    if (original.phase) criteria.phase = original.phase;
    if (original.poles) criteria.poles = original.poles;
  }

  // An airflow figure the AI guessed is not a safe basis for rejecting stock. Only
  // gate on duty where the number came from data we can stand behind.
  const dutyIsSolid = !!(elta && elta.airflow_m3h) || !!(original && original.airflow_m3h) ||
                      fields.spec_source === 'manufacturer page';
  if (!dutyIsSolid) criteria.airflow_m3h = null;

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

  // If we never worked out what kind of fan this is, the type filter would switch
  // itself off and start offering box fans against roof fans. Take the type from
  // our own record of the fan where we have one, and otherwise decline rather than
  // return a list nothing is filtering.
  if (!criteria.type && original) criteria.type = productType(original);

  // Whole-house heat recovery is a system, not a fan you swap out, and the units
  // run to four figures. Offering one on the strength of a type the AI inferred
  // from a plate is too big a leap: a 48W S&P OZEO extract fan read as "MVHR"
  // produced four Vent-Axia MVHR units at £922-£1,049. So for these categories we
  // want the type corroborated by Elta's data or by our own record of the fan,
  // and otherwise we say so and hand it to a person.
  const BIG_INSTALL = ['Whole House', 'Single Room', 'PIV'];
  const typeCorroborated = !!(elta || original);
  if (BIG_INSTALL.includes(criteria.type) && !typeCorroborated) {
    return {
      match_type: 'none', criteria, recommendations: [],
      message: 'This looks like a heat recovery or whole-house unit rather than a single fan. ' +
        'Those are specified around the property, not swapped like for like, so we won\u2019t suggest one ' +
        'automatically \u2014 our team will work out what you actually need.'
    };
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
      if (checkFit(criteria, p).broken.length) continue; // a "direct replacement" has to fit too
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
  const wantBrand = brandKey(criteria.brand);
  if (criteria.type && (criteria.size_mm || typeOnly)) {
    const loose = [fields.model, fields.part_number].map(s => (s || '').toLowerCase().replace(/[\s-]/g, '')).filter(s => s.length >= 4);
    // Anything that breaks one of the four rules is out, whatever else it has going
    // for it. Scoring only ever decides the order of fans that already fit — it can
    // no longer promote an undersized or underpowered one on the strength of a
    // matching duct and motor.
    const eligible = inStock.filter(p => !listed(p) && sameType(p))
      .map(p => ({ p, fit: checkFit(criteria, p) }))
      .filter(x => x.fit.broken.length === 0);

    const scored = eligible.map(({ p, fit }) => {
      let score = typeOnly ? 50 : 0;
      const reasons = [];
      const pSku = p.sku.toLowerCase().replace(/[\s-]/g, ''), pName = p.name.toLowerCase().replace(/[\s-]/g, '');
      if (loose.some(m => pSku.includes(m) || pName.includes(m) || m.includes(pSku))) { score += 40; reasons.push('Same model family'); }
      if (criteria.size_mm && p.size_mm === criteria.size_mm) { score += 50; reasons.push('Same size'); }
      // A fan we have checked all the way through outranks one we could not.
      score -= fit.unverified.length * 12;
      if (criteria.airflow_m3h && p.airflow_m3h) {
        const ratio = p.airflow_m3h / criteria.airflow_m3h;
        if (ratio >= 0.8 && ratio <= 1.2) { score += 30; reasons.push('Similar airflow'); }
        else if (ratio >= 0.6 && ratio <= 1.4) { score += 15; reasons.push('Comparable airflow'); }
      }
      if (criteria.motor_type && p.motor_type === criteria.motor_type) { score += 20; reasons.push('Same motor type'); }
      if (criteria.phase && p.phase === criteria.phase) { score += 10; reasons.push(criteria.phase === 1 ? 'Single phase' : 'Three phase'); }
      const sameBrand = !!wantBrand && productBrand(p) === wantBrand;
      if (sameBrand) { score += 10; reasons.push('Same brand'); }
      if (criteria.type) reasons.unshift(criteria.type);
      return { ...p, match_score: score, match_reasons: reasons, _unverified: fit.unverified, _same_brand: sameBrand };
    })
    .filter(p => p.match_score >= 30)
    // Everything here already fits, so the customer's own brand leads, then score.
    .sort((a, b) => (b._same_brand === true) - (a._same_brand === true) || b.match_score - a.match_score);

    const seen = new Set(list.map(p => p.sku));
    for (const p of scored) {
      if (list.length >= 4) break;
      if (seen.has(p.sku)) continue; // the catalogue repeats a few SKUs
      seen.add(p.sku);
      const { _same_brand, _unverified, ...rest } = p;
      list.push({ ...rest, match_type: 'similar', match_reason: p.match_reasons.join(' · '),
        unverified: _unverified.length ? _unverified : null });
    }
    if (!matchType && list.length) matchType = 'similar';
  }

  if (!list.length) {
    // Say which requirement nothing met, so "no match" reads as a considered answer
    // rather than a shrug — and so the team picking it up knows where to start.
    // Internal type names are not how anyone describes a fan out loud
    const SPOKEN = { 'Whole House': 'heat recovery unit', 'Single Room': 'single-room heat recovery unit',
                     'PIV': 'positive input ventilation unit', 'Plate Axial': 'plate axial fan',
                     'Cased Axial': 'cased axial fan', 'Duct Fan': 'duct fan', 'Box Fan': 'box fan',
                     'Roof Fan': 'roof fan', 'Axial Fan': 'axial fan' };
    const kind = SPOKEN[criteria.type] || (criteria.type || 'fan').toLowerCase();
    const identified = !!(elta || original);
    let message = "We couldn't match this one automatically.";
    if (isSpecialist(elta)) {
      message = 'We’ve identified your fan as ' + elta.model + ', from Elta’s ' + elta.range +
        ' range. This is a specialist fan — smoke extract, jet and marine fans are specified on more than airflow, so we won’t suggest a substitute automatically. Our team will match it properly.';
    } else if (!criteria.type && identified) {
      message = 'We’ve identified your fan as ' + ((elta && elta.model) || (original && original.name)) +
        ', but it’s not a type we can match automatically yet. Our team can source it.';
    } else if (!criteria.type) {
      message = "We couldn't tell what type of fan this is from what you sent. A photo of the ID plate usually settles it.";
    } else if (criteria.airflow_m3h && criteria.size_mm) {
      message = "We found your fan, but nothing we stock is a safe like-for-like: we'd need a " + criteria.size_mm +
        "mm " + kind + " moving at least " + criteria.airflow_m3h.toLocaleString('en-GB') +
        " m³/h. We'd rather tell you that than send you something undersized — we can source the right one.";
    } else if (criteria.size_mm) {
      message = "We found your fan, but we don't stock a " + criteria.size_mm + "mm " + kind + " we're confident is a match.";
    }
    return { match_type: 'none', criteria, recommendations: [], message };
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

// A page counts as being about this fan if every number in the model appears on it
// ("MV EC 250" -> the page must say 250) along with one of the letter groups.
function tokensOk(modelKey, flat) {
  const nums = modelKey.match(/\d+/g) || [];
  const words = (modelKey.match(/[A-Z]+/g) || []).filter(w => w.length >= 2);
  if (!nums.length) return false;
  return nums.every(n => flat.includes(n)) && (!words.length || words.some(w => flat.includes(w)));
}

// Fetch a page once; both the photo and the spec reader work from the same copy
// Manufacturer sites routinely refuse an obviously-automated request — a bare
// tool User-Agent gets a 403 from the very pages we most need. Ask the way a
// browser would, and allow longer: these are slow corporate sites, not APIs.
const PAGE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9,de;q=0.8'
};
async function fetchPage(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(9000), redirect: 'follow', headers: PAGE_HEADERS });
  return { status: r.status, html: r.ok ? (await r.text()).slice(0, 400000) : null };
}
function pageHtml(url) {
  return cached('page:' + url, async () => {
    try { return (await fetchPage(url)).html; } catch (e) { return null; }
  });
}

// Is this page really about this fan? Optionally require the manufacturer's own domain.
function isOwnDomain(url, brand) {
  if (!brand) return false;
  try {
    const host = slug(new URL(url).host);
    return host.includes(slug(brand)) || host.includes(slug(BRAND_DOMAIN[String(brand).toLowerCase()] || ''));
  } catch (e) { return false; }
}
async function pageAbout(url, brand, modelKey) {
  const html = await pageHtml(url);
  if (!html) return null;
  const flat = html.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const brandOk = !brand || isOwnDomain(url, brand);
  const modelOk = !modelKey || modelKey.length < 4 || flat.includes(modelKey) || tokensOk(modelKey, flat);
  return brandOk && modelOk ? html : null;
}

// The image a manufacturer page shows — only if the page really is about this fan
async function pageImage(url, brand, modelKey) {
  const html = await pageAbout(url, brand, modelKey);
  if (!html) return null;
  const m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
            html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) ||
            html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
  return m ? new URL(m[1], url).href : null;
}

// Specifications read off a manufacturer's own product page.
// Deliberately strict: third-party listings for old fans carry transcribed and
// mixed-up figures, and an undersized replacement is worse than saying "unknown".
// So specs are only taken from the manufacturer's own domain, never from a reseller.
// A figure on a spec page may be written either way round: "1,470.5" (English)
// or "1.470,5" (German). Guess wrong and you silently divide by a thousand —
// which is how "70.000 m3/h" became 70.
function parseNum(raw) {
  let t = String(raw).replace(/\s/g, '');
  const dot = t.lastIndexOf('.'), comma = t.lastIndexOf(',');
  if (dot >= 0 && comma >= 0) {
    // whichever separator comes last is the decimal point
    t = comma > dot ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  } else if (comma >= 0) {
    t = /^\d{1,3}(,\d{3})+$/.test(t) ? t.replace(/,/g, '') : t.replace(',', '.');
  } else if (dot >= 0) {
    if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
  }
  const v = parseFloat(t);
  return Number.isFinite(v) ? v : null;
}

// Read a figure that sits behind its own label. This is the part that matters:
// the first "m3/h" on a manufacturer's page is usually a navigation item
// ("roof fans up to 70,000 m3/h"), not the fan you asked about.
const NUM = '([0-9][0-9.,\\s]{0,11}?)';
function labelled(text, labels, unit) {
  for (const label of labels) {
    const m = text.match(new RegExp(label + '[^:]{0,40}?:\\s*' + NUM + '\\s*' + unit, 'i'));
    if (m) { const v = parseNum(m[1]); if (v != null) return v; }
  }
  return null;
}

const M3H = 'm\\s*[³_3]\\s*/\\s*h';
const AIRFLOW_LABELS = ['Luftleistung', 'Volumenstrom', 'Nennluftstrom', 'Luftvolumenstrom', 'Fördervolumen',
  'air\\s*flow', 'airflow', 'volume\\s*flow', 'air\\s*volume', 'flow\\s*rate', 'duty', 'capacity'];
const POWER_LABELS = ['Nennleistung', 'Leistungsaufnahme', 'Motorleistung', 'Leistung',
  'power\\s*(?:input|consumption|rating)?', 'motor\\s*power', 'rated\\s*power', 'wattage'];
const VOLT_LABELS = ['Spannung', 'Nennspannung', 'voltage', 'supply\\s*voltage', 'supply'];
const SIZE_LABELS = ['Anschluss\\s*DN', 'Nennweite', 'Anschluss', 'duct\\s*size', 'duct\\s*diameter',
  'diameter', 'spigot', 'connection'];

// Specifications read off a manufacturer's own product page.
// Deliberately strict: third-party listings for old fans carry transcribed and
// mixed-up figures, and an undersized replacement is worse than saying "unknown".
// So specs are only taken from the manufacturer's own domain, never from a reseller,
// and only where the page labels what the number means.
async function pageSpecs(url, brand, modelKey, expected) {
  if (!isOwnDomain(url, brand)) return null; // resellers are not a source of truth
  const html = await pageAbout(url, brand, modelKey);
  if (!html) return null;
  // Strip markup so figures in tables and spec lists read as plain text
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&#179;/gi, '³').replace(/\s+/g, ' ');
  const out = {};

  let air = labelled(text, AIRFLOW_LABELS, M3H);
  if (air == null) { const ls = labelled(text, AIRFLOW_LABELS, 'l\\s*/\\s*s\\b'); if (ls != null) air = ls * 3.6; }
  if (air != null) out.airflow_m3h = Math.round(air);

  const w = labelled(text, POWER_LABELS, '(?:W|watts)\\b');
  if (w != null) out.power_w = Math.round(w);

  const v = labelled(text, VOLT_LABELS, '(?:V|volts)\\b');
  if (v != null) out.voltage = Math.round(v) + 'V';

  const dn = labelled(text, SIZE_LABELS, 'mm\\b');
  if (dn != null) out.size_mm = Math.round(dn);

  const ip = text.match(/(?:Schutzart\s*IP|IP[-\s]?(?:rating|class)|Schutzart)[^:]{0,20}?:\s*(\d{2})\b/i) ||
             text.match(/\bIP\s?(\d{2})\b/);
  if (ip) out.ip_rating = 'IP' + ip[1];

  const pa = labelled(text, ['Druck', 'Pressung', 'pressure', 'static\\s*pressure'], 'Pa\\b');
  if (pa != null) out.max_pressure_pa = Math.round(pa);

  // Sanity bounds — a mis-parse is worse than no figure at all
  if (out.airflow_m3h && (out.airflow_m3h < 20 || out.airflow_m3h > 200000)) delete out.airflow_m3h;
  if (out.size_mm && (out.size_mm < 60 || out.size_mm > 2000)) delete out.size_mm;
  if (out.power_w && (out.power_w < 3 || out.power_w > 50000)) delete out.power_w;
  if (out.max_pressure_pa && (out.max_pressure_pa < 5 || out.max_pressure_pa > 10000)) delete out.max_pressure_pa;

  // Last guard: if we already had a rough idea of the duty and the page disagrees
  // by more than fivefold, one of the two is junk. Say nothing rather than guess.
  const est = expected && expected.airflow_m3h;
  if (out.airflow_m3h && est && (out.airflow_m3h > est * 5 || out.airflow_m3h < est / 5)) delete out.airflow_m3h;

  if (/\bEC\b/.test(text)) out.motor_type = 'EC';
  return Object.keys(out).length ? out : null;
}

// Find specs for a fan we have no data of our own for, from the maker's own site
async function searchSpecs(fields) {
  const brand = fields.manufacturer || '';
  const model = fields.model || fields.part_number;
  if (!brand || !model) return null;
  for (const url of await searchProductPages(brand, model)) {
    try {
      const specs = await pageSpecs(url, brand, normModel(model), { airflow_m3h: fields.estimated_airflow_m3h });
      if (specs) { specs._url = url; return specs; }
    } catch (e) { /* try the next result */ }
  }
  return null;
}

// Ask a web search which page on the manufacturer's own site is this product.
// Needs BRAVE_SEARCH_API_KEY (or GOOGLE_CSE_KEY + GOOGLE_CSE_CX); without a key we
// simply skip this step, so the tool keeps working, just with fewer photos.
async function searchProductPages(brand, model) {
  // The model often already carries the brand — don't repeat it in the query
  const hasBrand = brand && slug(model).startsWith(slug(brand));
  const q = (hasBrand ? String(model) : [brand, model].filter(Boolean).join(' ')).trim();
  if (!q.trim()) return [];
  const brave = (process.env.BRAVE_SEARCH_API_KEY || '').trim();
  const gKey = (process.env.GOOGLE_CSE_KEY || '').trim(), gCx = (process.env.GOOGLE_CSE_CX || '').trim();
  return cached('search:' + q, async () => {
    let urls = [];
    if (brave) {
      const r = await fetch('https://api.search.brave.com/res/v1/web/search?count=10&q=' + encodeURIComponent(q),
        { signal: AbortSignal.timeout(4000), headers: { 'Accept': 'application/json', 'X-Subscription-Token': brave } });
      if (!r.ok) return [];
      const d = await r.json();
      urls = ((d.web && d.web.results) || []).map(x => x.url).filter(Boolean);
    } else if (gKey && gCx) {
      const r = await fetch('https://www.googleapis.com/customsearch/v1?num=10&key=' + gKey + '&cx=' + gCx + '&q=' + encodeURIComponent(q),
        { signal: AbortSignal.timeout(4000) });
      if (!r.ok) return [];
      const d = await r.json();
      urls = (d.items || []).map(x => x.link).filter(Boolean);
    } else {
      return [];
    }
    // The manufacturer's own site first; then trade sites, which still carry real photos
    const want = slug(BRAND_DOMAIN[String(brand).toLowerCase()] || brand);
    const own = urls.filter(u => { try { return want && slug(new URL(u).host).includes(want); } catch (e) { return false; } });
    return [...own, ...urls.filter(u => !own.includes(u))].slice(0, 4);
  }) || [];
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
  const brandless = normModel(String(fields.model || '').replace(new RegExp(brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), ' ')) || modelKey;
  if (fields.manufacturer_url) candidates.push(['page', fields.manufacturer_url, brandless]);
  if (fields.product_image_url) candidates.push(['img', fields.product_image_url, null]);
  for (const [kind, url, key] of candidates) {
    try {
      const hit = kind === 'img' ? await checkImage(url) : await pageImage(url, brand, key);
      if (hit) return hit;
    } catch (e) { /* try the next lead */ }
  }
  // 3. Nothing yet: ask a search engine for this product's page and check those
  for (const url of await searchProductPages(brand, fields.model || fields.part_number)) {
    try {
      const hit = await pageImage(url, null, brandless);
      if (hit) { fields.manufacturer_url = url; return hit; } // the page we verified beats the guess
    } catch (e) { /* try the next result */ }
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

  // Trim: a stray newline or space picked up when the key was copied makes the
  // header malformed, and Anthropic answers "API key is invalid." with a null
  // request_id, which reads exactly like a wrong key and wastes an afternoon.
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
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
      const raw = data.content[0].text.trim();
      // Take the JSON object out of the reply rather than demanding the whole reply
      // be JSON: a code fence or a line of preamble used to fail the parse silently
      // and drop us back to "just the model", which is indistinguishable from a
      // failed identification on screen.
      const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
      const body = (fenced ? fenced[1] : raw).trim();
      const braced = body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1);
      try {
        const fields = JSON.parse(braced || body);
        cleaned = {};
        for (const [k, v] of Object.entries(fields)) {
          if (v !== null && v !== '' && v !== 'null' && v !== 'N/A') cleaned[k] = v;
        }
      } catch (parseErr) {
        console.error('Could not parse AI reply:', raw.slice(0, 300));
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
    // No manufacturer data of our own for this fan (everything except Elta, and any
    // fan we don't stock): look for the maker's own product page and read the specs
    // off it. Anything the AI guessed is dropped first — a verified figure or none.
    if (!elta) {
      const stocked = products.find(p => normModel(p.sku) === normModel(cleaned.model || cleaned.part_number));
      if (!stocked) {
        const found = await searchSpecs(cleaned);
        if (found) {
          // A figure read off the plate describes the fan actually on the wall;
          // the maker's page describes whatever they sell under that name today,
          // which for an old fan is often a revised model. So from a photo the
          // plate wins and the page only fills gaps — it was quietly replacing a
          // plate's 0.22 kW with 170 W off the current datasheet. From typed text
          // there is no plate, only the AI's guesses, so the page replaces them.
          const fromPlate = !!image;
          const keep = k => fromPlate && cleaned[k];
          for (const k of ['airflow', 'power', 'voltage', 'ip_rating', 'max_pressure']) {
            if (!keep(k)) delete cleaned[k];
          }
          if (!fromPlate) delete cleaned.estimated_specs;
          if (found.airflow_m3h && !cleaned.airflow) {
            cleaned.airflow = found.airflow_m3h + ' m³/h max';
            cleaned.estimated_airflow_m3h = found.airflow_m3h;
          }
          if (found.size_mm && !cleaned.size_mm) cleaned.size_mm = found.size_mm;
          if (found.power_w && !cleaned.power) cleaned.power = found.power_w + 'W';
          if (found.voltage && !cleaned.voltage) cleaned.voltage = found.voltage;
          if (found.ip_rating && !cleaned.ip_rating) cleaned.ip_rating = found.ip_rating;
          if (found.max_pressure_pa && !cleaned.max_pressure) cleaned.max_pressure = found.max_pressure_pa + ' Pa';
          cleaned.manufacturer_url = found._url;
          cleaned.spec_source = fromPlate ? 'plate, with gaps filled from the manufacturer page' : 'manufacturer page';
        }
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
