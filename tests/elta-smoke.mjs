// Smoke test: runs api/identify.js with the Anthropic call mocked out.
// Usage: node tests/elta-smoke.mjs
process.env.ANTHROPIC_API_KEY = 'test';
const { default: handler } = await import('../api/identify.js');

async function run(label, plate) {
  globalThis.fetch = async (url) => {
    if (String(url).includes('anthropic')) return { json: async () => ({ content: [{ text: JSON.stringify(plate) }] }) };
    return { ok: false, json: async () => ({}) }; // no Shopify search in tests
  };
  let out;
  const res = { status() { return this; }, json(d) { out = d; return this; } };
  await handler({ method: 'POST', body: { image: 'data:image/jpeg;base64,AAAA' } }, res);
  const f = out.fields || {}, r = out.recommendations || {};
  console.log(`\n## ${label}`);
  console.log('  elta:', f.elta_model || '-', '|', f.range || '', '| size', f.size_mm, '| airflow', f.airflow, '| url', f.manufacturer_url || '-');
  if (f.current_equivalent) console.log('  current equivalent:', f.current_equivalent);
  console.log('  match:', r.match_type, (r.recommendations || []).map(p => `${p.sku} (${p.match_reason})`).slice(0, 3));
  return out;
}

await run('Stocked Elta model, exact code', { manufacturer: 'Elta Fans', model: 'SCP315/4-1AC', voltage: '230V' });
await run('Elta code with spaces, suffix missing', { manufacturer: 'Elta', model: 'SCP 450/4-1' });
await run('Superseded Elta model', { manufacturer: 'Elta Fans Ltd', model: 'SCP630/4-1' });
await run('Superseded roof fan', { manufacturer: 'Elta', model: 'SSR450/6-1ACS' });
await run('Elta inline fan', { manufacturer: 'Elta', model: 'VL200', estimated_airflow_m3h: 600 });
await run('Non-Elta fan is unaffected', { manufacturer: 'Systemair', model: 'K 200 M', size_mm: 200, estimated_airflow_m3h: 800, product_image_url: 'https://x/y.jpg' });
await run('Garbage model does not false-match', { manufacturer: 'Nuaire', model: 'MRXBOX95-WM2' });
