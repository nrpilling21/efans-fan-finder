// Smoke test: runs api/identify.js with the Anthropic call mocked out.
// Usage: node tests/elta-smoke.mjs
process.env.ANTHROPIC_API_KEY = 'test';
const { default: handler } = await import('../api/identify.js');
const products = JSON.parse((await import('fs')).readFileSync(new URL('../data/products.json', import.meta.url)));
const typeOf = sku => { const p = products.find(p => p.sku === sku); return p ? ((p.tags || []).find(t => t.startsWith('Type_')) || '-').slice(5) : '(web)'; };

async function run(label, plate, body = { image: 'data:image/jpeg;base64,AAAA' }) {
  globalThis.fetch = async (url) => {
    if (String(url).includes('anthropic')) return { status: plate ? 200 : 500, json: async () => (plate ? { content: [{ text: JSON.stringify(plate) }] } : { type: 'error' }) };
    return { ok: false, json: async () => ({}) }; // no Shopify search in tests
  };
  let out;
  const res = { status() { return this; }, json(d) { out = d; return this; } };
  await handler({ method: 'POST', body }, res);
  const f = out.fields || {}, r = out.recommendations || {};
  console.log(`\n## ${label}`);
  console.log('  elta:', f.elta_model || '-', '| type', r.criteria && r.criteria.type, '| airflow', f.airflow || '-');
  console.log('  success:', out.success, '| source:', out.source, '| match:', r.match_type);
  for (const p of r.recommendations || []) console.log(`   ${p.highlight ? '[' + p.highlight + '] ' : ''}${p.sku} <${typeOf(p.sku)}> ${p.match_reason}`);
}

await run('Stocked Elta plate fan, exact code', { manufacturer: 'Elta Fans', model: 'SCP315/4-1AC', voltage: '230V' });
await run('Superseded Elta plate fan', { manufacturer: 'Elta Fans Ltd', model: 'SCP630/4-1' });
await run('Superseded Elta roof fan', { manufacturer: 'Elta', model: 'SSR450/6-1ACS' });
await run('Elta inline fan', { manufacturer: 'Elta', model: 'VL200' });
await run('Other-brand plate fan (AI says plate axial)', { manufacturer: 'Vent-Axia', model: 'W 350/4', fan_type: 'plate axial', size_mm: 350, estimated_airflow_m3h: 3000 });
await run('Systemair inline', { manufacturer: 'Systemair', model: 'K 200 M', fan_type: 'inline duct', size_mm: 200, estimated_airflow_m3h: 800 });
await run('Unknown brand, no match', { manufacturer: 'Nuaire', model: 'MRXBOX95-WM2', fan_type: 'MVHR' });
await run('Typed text, AI reads it', { manufacturer: 'Elta', model: 'SCP630/4-1', fan_type: 'plate axial' }, { text: 'elta scp 630/4-1 plate fan' });
await run('Typed text, AI unavailable', null, { text: 'Elta SCP630/4-1' });
await run('Nothing sent', null, {});
