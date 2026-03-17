import { readFileSync } from 'fs';
import { join } from 'path';

// Load product catalogue
let products;
try {
  products = JSON.parse(readFileSync(join(process.cwd(), 'data', 'products.json'), 'utf8'));
} catch (e) {
  products = [];
}

/**
 * Parse size in mm from various string formats
 * e.g. "250mm", "250 mm", "10 inch", "10\"", "4"", "100mm/4\""
 */
function parseSizeMm(str) {
  if (!str) return null;
  str = String(str);

  // Direct mm match
  const mmMatch = str.match(/(\d{2,4})\s*mm/i);
  if (mmMatch) return parseInt(mmMatch[1]);

  // Inch to mm conversion
  const inchMap = { '4': 100, '5': 125, '6': 150, '7': 180, '8': 200, '9': 225, '10': 250, '12': 315, '14': 355, '16': 400, '18': 450, '20': 500, '22': 560, '24': 630 };
  const inchMatch = str.match(/(\d{1,2})\s*(?:inch|in|"|â³|'')/i);
  if (inchMatch && inchMap[inchMatch[1]]) return inchMap[inchMatch[1]];

  return null;
}

/**
 * Parse airflow in mÂ³/h from various formats
 * e.g. "500 mÂ³/h", "139 l/s", "500m3/h"
 */
function parseAirflow(str) {
  if (!str) return null;
  str = String(str);

  // mÂ³/h or m3/h
  const m3hMatch = str.match(/([\d,.]+)\s*m[Â³3]\/?h/i);
  if (m3hMatch) return parseFloat(m3hMatch[1].replace(',', ''));

  // l/s â convert to mÂ³/h (multiply by 3.6)
  const lsMatch = str.match(/([\d,.]+)\s*l\/?s/i);
  if (lsMatch) return Math.round(parseFloat(lsMatch[1].replace(',', '')) * 3.6);

  // CFM â convert to mÂ³/h (multiply by 1.699)
  const cfmMatch = str.match(/([\d,.]+)\s*cfm/i);
  if (cfmMatch) return Math.round(parseFloat(cfmMatch[1].replace(',', '')) * 1.699);

  return null;
}

/**
 * Extract motor type (AC/EC) from various fields
 */
function parseMotorType(fields) {
  const searchStr = [fields.notes, fields.model, fields.manufacturer, fields.part_number]
    .filter(Boolean).join(' ').toUpperCase();

  if (searchStr.includes('EC ') || searchStr.includes('EC-') || searchStr.includes('ECOWATT') ||
      searchStr.includes('EC MOTOR') || searchStr.includes(' EC') || searchStr.includes('LO-CARBON') ||
      searchStr.includes('LO CARBON') || searchStr.includes('LOW ENERGY')) {
    return 'EC';
  }
  return 'AC'; // Default assumption for most replacement fans
}

/**
 * Try to infer the fan category from the identified fields
 */
function inferCategory(fields) {
  const searchStr = [fields.manufacturer, fields.model, fields.notes, fields.part_number]
    .filter(Boolean).join(' ').toLowerCase();

  if (searchStr.includes('inline') || searchStr.includes('duct fan') || searchStr.includes('in-line') ||
      searchStr.includes('centrifugal duct') || searchStr.match(/\b(vl|hit|rvk|vent-?\d|td-|acm|acp|sdx)\b/i)) {
    return 'inline-duct-fan';
  }
  if (searchStr.includes('plate axial') || searchStr.includes('plate fan') ||
      searchStr.match(/\b(hpa|hcb[bt]|hxbr|aw \d)\b/i)) {
    return 'plate-axial-fan';
  }
  if (searchStr.includes('bathroom') || searchStr.includes('extractor') || searchStr.includes('silent') ||
      searchStr.match(/\b(bf silent|solo|silent\d|px\d|gx\d|cv[23]|centra|revive|ecoair)\b/i)) {
    return 'bathroom-extractor';
  }
  if (searchStr.includes('mixed flow') || searchStr.match(/\b(td-|acm)\b/i)) {
    return 'mixed-flow-fan';
  }
  if (searchStr.includes('axial') || searchStr.includes('wall fan') || searchStr.includes('window fan') ||
      searchStr.match(/\b(vario)\b/i)) {
    return 'axial-fan';
  }
  if (searchStr.includes('roof')) {
    return 'roof-fan';
  }
  return null;
}

/**
 * Try to extract size from model number patterns
 * e.g. VL100 â 100mm, K250M â 250mm, HPA315/4-1A â 315mm, TD-350/125 â 125mm
 */
function extractSizeFromModel(model) {
  if (!model) return null;

  // Patterns like VL100, VL150, K100M, K250L, HIT100, HIT315
  const modelSizeMatch = model.match(/(?:VL|K|HIT|RVK|ACP|SDX|BF)[\s-]?(\d{3})/i);
  if (modelSizeMatch) return parseInt(modelSizeMatch[1]);

  // Patterns like HPA250/2-1A, HPA315/4-1A
  const hpaMatch = model.match(/HPA(\d{3})/i);
  if (hpaMatch) return parseInt(hpaMatch[1]);

  // Patterns like AW 200E4, AW 250EC
  const awMatch = model.match(/AW[\s-](\d{3})/i);
  if (awMatch) return parseInt(awMatch[1]);

  // Patterns like TD-350/125 (second number is the duct size)
  const tdMatch = model.match(/TD-\d+\/(\d{3})/i);
  if (tdMatch) return parseInt(tdMatch[1]);

  // Patterns like VENT-100NK, VENT-250-ECOWATT
  const ventMatch = model.match(/VENT-(\d{3})/i);
  if (ventMatch) return parseInt(ventMatch[1]);

  // Patterns like HXBR/4-250, HCBB/4-315
  const hxMatch = model.match(/(?:HXBR|HCBB|HCBT)\/\d-(\d{3})/i);
  if (hxMatch) return parseInt(hxMatch[1]);

  // Patterns like ACM100, SILENT100, SILENT200
  const genericMatch = model.match(/(?:ACM|SILENT|PX|GX|FLUX)[\s-]?(\d{3})/i);
  if (genericMatch) return parseInt(genericMatch[1]);

  // Generic 3-digit number that looks like a size
  const anyThreeDigit = model.match(/\b(100|125|150|160|180|200|225|250|300|315|350|355|400|450|500|560|630|710|800|900)\b/);
  if (anyThreeDigit) return parseInt(anyThreeDigit[1]);

  return null;
}

/**
 * Score how well a product matches the identified fan
 */
function scoreMatch(product, criteria) {
  let score = 0;
  let reasons = [];

  // Size match is most important (exact = 50pts, close = 20pts)
  if (criteria.size_mm && product.size_mm) {
    if (product.size_mm === criteria.size_mm) {
      score += 50;
      reasons.push('Exact size match');
    } else if (Math.abs(product.size_mm - criteria.size_mm) <= 25) {
      score += 20;
      reasons.push('Close size match');
    }
  }

  // Airflow match (within 20% = 30pts, within 40% = 15pts)
  if (criteria.airflow_m3h && product.airflow_m3h) {
    const ratio = product.airflow_m3h / criteria.airflow_m3h;
    if (ratio >= 0.8 && ratio <= 1.2) {
      score += 30;
      reasons.push('Similar airflow');
    } else if (ratio >= 0.6 && ratio <= 1.4) {
      score += 15;
      reasons.push('Comparable airflow');
    }
  }

  // Motor type match (20pts)
  if (criteria.motor_type && product.motor_type === criteria.motor_type) {
    score += 20;
    reasons.push('Same motor type');
  }

  // Category match (15pts)
  if (criteria.category && product.category === criteria.category) {
    score += 15;
    reasons.push('Same fan type');
  }

  // Brand match (10pts â nice to have)
  if (criteria.brand && product.brand &&
      product.brand.toLowerCase() === criteria.brand.toLowerCase()) {
    score += 10;
    reasons.push('Same brand');
  }

  // In stock bonus (5pts)
  if (product.in_stock) {
    score += 5;
    reasons.push('In stock');
  }

  return { score, reasons };
}

export default async function handler(req, res) {
  // Allow both GET and POST
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const fields = req.method === 'POST' ? req.body : req.query;

  if (!fields || Object.keys(fields).length === 0) {
    return res.status(400).json({ error: 'No identification data provided' });
  }

  // Build matching criteria from the AI-identified fields
  const criteria = {};

  // Extract size
  criteria.size_mm = parseSizeMm(fields.model) ||
                     parseSizeMm(fields.airflow) ||
                     parseSizeMm(fields.notes) ||
                     extractSizeFromModel(fields.model) ||
                     extractSizeFromModel(fields.part_number);

  // Extract airflow
  criteria.airflow_m3h = parseAirflow(fields.airflow);

  // Extract motor type
  criteria.motor_type = parseMotorType(fields);

  // Infer category
  criteria.category = inferCategory(fields);

  // Brand
  criteria.brand = fields.manufacturer || null;

  // Try exact model/SKU match first
  const exactMatches = products.filter(p => {
    const model = (fields.model || '').toLowerCase().replace(/[\s-]/g, '');
    const partNum = (fields.part_number || '').toLowerCase().replace(/[\s-]/g, '');
    const pSku = p.sku.toLowerCase().replace(/[\s-]/g, '');
    const pName = p.name.toLowerCase().replace(/[\s-]/g, '');

    return (model && (pSku.includes(model) || pName.includes(model) || model.includes(pSku))) ||
           (partNum && (pSku.includes(partNum) || pName.includes(partNum) || partNum.includes(pSku)));
  });

  if (exactMatches.length > 0) {
    // Found exact matches
    const results = exactMatches
      .filter(p => p.in_stock)
      .slice(0, 3)
      .map(p => ({
        ...p,
        match_type: 'exact',
        match_reason: 'Direct model/SKU match â this is likely the same fan or its current equivalent'
      }));

    if (results.length > 0) {
      return res.status(200).json({
        success: true,
        match_type: 'exact',
        criteria,
        recommendations: results
      });
    }
  }

  // Score all products and find best matches
  if (criteria.size_mm) {
    const scored = products
      .filter(p => p.in_stock)
      .map(p => {
        const { score, reasons } = scoreMatch(p, criteria);
        return { ...p, match_score: score, match_reasons: reasons };
      })
      .filter(p => p.match_score >= 50) // Must at least match on size
      .sort((a, b) => b.match_score - a.match_score)
      .slice(0, 5);

    if (scored.length > 0) {
      const results = scored.map(p => ({
        ...p,
        match_type: 'similar',
        match_reason: p.match_reasons.join(' Â· ')
      }));

      return res.status(200).json({
        success: true,
        match_type: 'similar',
        criteria,
        recommendations: results
      });
    }
  }

  // No good matches found
  return res.status(200).json({
    success: true,
    match_type: 'none',
    criteria,
    recommendations: [],
    message: "We couldn't find an automatic match, but don't worry â our team can help. Submit your enquiry below and we'll find the right replacement for you."
  });
}
