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
  for (const raw of [fields.model, fields.part_number]) {
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
  fields.manufacturer = fields.manufacturer || 'Elta';
  fields.elta_model = elta.model;
  fields.range = elta.range;
  if (elta.size_mm) fields.size_mm = elta.size_mm;
  if (elta.airflow_m3h) {
    fields.airflow = elta.airflow_m3h + ' m³/h max (Elta data)';
    fields.estimated_airflow_m3h = elta.airflow_m3h;
  }
  if (elta.max_pressure_pa) fields.max_pressure = elta.max_pressure_pa + ' Pa';
  if (!fields.voltage && elta.spec && elta.spec.voltage) fields.voltage = elta.spec.voltage + 'V';
  if (!fields.current && elta.spec && elta.spec.flc_a) fields.current = elta.spec.flc_a + 'A';
  if (!fields.ip_rating && elta.spec && elta.spec.ip) fields.ip_rating = elta.spec.ip;
  if (elta.url) fields.manufacturer_url = elta.url;
  else delete fields.manufacturer_url; // AI-guessed links are often wrong
  delete fields.product_image_url;     // likewise AI-guessed image URLs
  delete fields.estimated_specs;
  fields.notes = [fields.notes, elta.current ? null : 'This model has been superseded by Elta.']
    .filter(Boolean).join(' ');
  return fields;
}

const CATEGORY_MAP = {
  'inline-duct-fan': 'Duct Fans', 'mixed-flow-fan': 'Duct Fans', 'plate-axial-fan': 'Axial Fan',
  'axial-fan': 'Axial Fan', 'roof-fan': 'Roof Fans', 'bathroom-extractor': 'Ventilation Fans'
};

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

function getRecommendations(fields, elta) {
  if (!products.length) return { match_type: 'none', recommendations: [], message: "Product catalogue not loaded." };

  const criteria = {
    size_mm: parseInt(fields.size_mm) || parseSizeMm(fields.model) || parseSizeMm(fields.airflow) || parseSizeMm(fields.notes) ||
             extractSizeFromModel(fields.model) || extractSizeFromModel(fields.part_number),
    airflow_m3h: parseAirflow(fields.airflow) || parseFloat(fields.estimated_airflow_m3h) || null,
    motor_type: (elta && elta.motor_type) || parseMotorType(fields),
    category: (elta && elta.category) || CATEGORY_MAP[inferCategory(fields)] || null,
    brand: fields.manufacturer || null
  };

  // === Cross-reference tag matching (Replaces_MODEL) ===
    const identifiedModel = (fields.model || '').replace(/[\s-]/g, '').toUpperCase();
    const identifiedPart = (fields.part_number || '').replace(/[\s-]/g, '').toUpperCase();
    if (identifiedModel || identifiedPart) {
      const crossRefMatches = products.filter(p => {
        if (!p.tags) return false;
        const tags = Array.isArray(p.tags) ? p.tags : (typeof p.tags === 'string' ? p.tags.split(',').map(t => t.trim()) : []);
        return tags.some(tag => {
          const t = tag.replace(/^Replaces_/i, '').replace(/[\s-]/g, '').toUpperCase();
          if (tag.toLowerCase().startsWith('replaces_')) {
            return (identifiedModel && t === identifiedModel) || (identifiedPart && t === identifiedPart);
          }
          return false;
        });
      });
      if (crossRefMatches.length > 0) {
        return {
          match_type: 'cross_reference',
          criteria,
          recommendations: crossRefMatches.map(p => ({
            ...p,
            match_type: 'cross_reference',
            match_reason: 'Verified replacement for ' + (fields.manufacturer || '') + ' ' + (fields.model || '')
          }))
        };
      }
    }

    // === Superseded Elta model -> current Elta equivalent we stock ===
    if (elta && !elta.current) {
      const equivalents = eltaEquivalents(elta);
      const stocked = [];
      for (const eq of equivalents) {
        const p = products.find(p => p.in_stock && normModel(p.sku) === eq.key);
        if (p && !stocked.includes(p)) stocked.push({ ...p, eq });
        if (stocked.length >= 3) break;
      }
      if (stocked.length > 0) {
        return {
          match_type: 'elta_equivalent',
          criteria,
          recommendations: stocked.map(({ eq, ...p }) => ({
            ...p,
            match_type: 'elta_equivalent',
            match_reason: 'Current Elta equivalent of ' + elta.model +
              (eq.airflow_m3h && elta.airflow_m3h ? ' \u2014 ' + eq.airflow_m3h + ' m\u00b3/h vs ' + elta.airflow_m3h + ' m\u00b3/h' : '')
          }))
        };
      }
    }

    // Exact model/SKU match
  const model = (fields.model || '').toLowerCase().replace(/[\s-]/g, '');
  const partNum = (fields.part_number || '').toLowerCase().replace(/[\s-]/g, '');

  if (model || partNum) {
    const exactMatches = products.filter(p => {
      const pSku = p.sku.toLowerCase().replace(/[\s-]/g, '');
      const pName = p.name.toLowerCase().replace(/[\s-]/g, '');
      return (model && (pSku.includes(model) || pName.includes(model) || model.includes(pSku))) ||
             (partNum && (pSku.includes(partNum) || pName.includes(partNum) || partNum.includes(pSku)));
    }).filter(p => p.in_stock).slice(0, 3);

    if (exactMatches.length > 0) {
      return {
        match_type: 'exact',
        criteria,
        recommendations: exactMatches.map(p => ({
          ...p,
          match_type: 'exact',
          match_reason: 'Direct model/SKU match — likely the same fan or its current equivalent'
        }))
      };
    }
  }

  // Score-based matching
  if (criteria.size_mm) {
    const scored = products.filter(p => p.in_stock).map(p => {
      let score = 0;
      const reasons = [];

      if (p.size_mm === criteria.size_mm) { score += 50; reasons.push('Exact size match'); }
      else if (Math.abs(p.size_mm - criteria.size_mm) <= 25) { score += 20; reasons.push('Close size match'); }

      if (criteria.airflow_m3h && p.airflow_m3h) {
        const ratio = p.airflow_m3h / criteria.airflow_m3h;
        if (ratio >= 0.8 && ratio <= 1.2) { score += 30; reasons.push('Similar airflow'); }
        else if (ratio >= 0.6 && ratio <= 1.4) { score += 15; reasons.push('Comparable airflow'); }
      }

      if (criteria.motor_type && p.motor_type === criteria.motor_type) { score += 20; reasons.push('Same motor type'); }
      if (criteria.category && p.category === criteria.category) { score += 15; reasons.push('Same fan type'); }
      if (elta && elta.phase && p.phase === elta.phase) { score += 10; reasons.push(elta.phase === 1 ? 'Single phase' : 'Three phase'); }
      if (criteria.brand && p.brand && p.brand.toLowerCase() === criteria.brand.toLowerCase()) { score += 10; reasons.push('Same brand'); }
      if (p.in_stock) { score += 5; }

      return { ...p, match_score: score, match_reasons: reasons };
    })
    .filter(p => p.match_score >= 30)
    // Elta data tells us the fan type for certain, so don't offer a duct fan for a roof fan
    .filter(p => !(elta && elta.category) || p.category === elta.category)
    .sort((a, b) => b.match_score - a.match_score)
    .slice(0, 5);

    if (scored.length > 0) {
      return {
        match_type: 'similar',
        criteria,
        recommendations: scored.map(p => ({
          ...p,
          match_type: 'similar',
          match_reason: p.match_reasons.join(' · ')
        }))
      };
    }
  }

  return {
    match_type: 'none',
    criteria,
    recommendations: [],
    message: "We couldn't find an automatic match, but don't worry — our team can help. Submit your enquiry and we'll find the right replacement."
  };
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

// === Main Handler ===

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { image } = req.body;
  if (!image) {
    return res.status(400).json({ error: 'No image provided' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ success: false, error: 'API key not configured' });
  }

  const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
  const mediaType = image.match(/^data:(image\/\w+);/)?.[1] || 'image/jpeg';

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: base64Data
              }
            },
            {
              type: 'text',
              text: `You are a ventilation equipment expert working for eFans Direct, a UK trade supplier of extractor fans, MVHR units, and ventilation equipment.

Examine this photo of a fan ID plate / data plate / nameplate and extract as much information as possible.

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

6. Add "manufacturer_url" with a likely URL for this product on the manufacturer website (e.g. nuaire.co.uk, vent-axia.com, systemair.com etc). Use your knowledge of these sites.
7. Add "product_image_url" if you know a direct image URL for this product from your training data.

Return ONLY the JSON object, no other text.`
            }
          ]
        }]
      })
    });

    const data = await response.json();

    if (data.content && data.content[0] && data.content[0].text) {
      let text = data.content[0].text.trim();
      text = text.replace(/^```json\s*/, '').replace(/\s*```$/, '');

      try {
        const fields = JSON.parse(text);
        const cleaned = {};
        for (const [k, v] of Object.entries(fields)) {
          if (v !== null && v !== '' && v !== 'null' && v !== 'N/A') {
            cleaned[k] = v;
          }
        }

        if (Object.keys(cleaned).length > 0) {
          // Get product recommendations based on identified fields
          // Enrich fields with AI estimates for better matching
          if (cleaned.size_mm && !cleaned.airflow) {
            cleaned.airflow = cleaned.estimated_airflow_m3h ? cleaned.estimated_airflow_m3h + ' m3/h' : null;
          }
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

          // Shopify fallback if no catalogue match
          if (recommendations.match_type === "none" || !recommendations.recommendations || recommendations.recommendations.length === 0) { const sq = [cleaned.model, cleaned.part_number, cleaned.manufacturer].filter(Boolean).join(" "); if (sq) { const sr = await searchShopify(sq); if (sr.length > 0) { recommendations = { match_type: "shopify", recommendations: sr.map(function(p) { return Object.assign({}, p, {match_type: "shopify"}); }) }; } } }

          return res.status(200).json({
            success: true,
            fields: cleaned,
            recommendations: recommendations
          });
        } else {
          return res.status(200).json({
            success: false,
            error: 'Could not extract any information',
            recommendations: { match_type: 'none', recommendations: [] }
          });
        }
      } catch (parseErr) {
        return res.status(200).json({ success: false, error: 'Could not parse AI response' });
      }
    }

    return res.status(200).json({ success: false, error: 'No response from AI' });

  } catch (err) {
    console.error('AI identification error:', err);
    return res.status(500).json({ success: false, error: 'AI service error' });
  }
}
