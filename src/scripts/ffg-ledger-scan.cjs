// FFG ledger scanner (CANON). Ingests U5TA inbound axfers with note prefix, buckets by UTC
// confirmation month, accrues per-slot over 2000. Idempotent via processed txids.
const https = require('https');
const { MongoClient } = require('mongodb');
const { accrue } = require('./ledger_core.cjs');
const IDX = process.env.FFG_INDEXER_URL || 'https://mainnet-idx.4160.nodely.dev';
const getJSON = (url) => new Promise((res, rej) => {
  https.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});
(async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI not set');
  const cli = new MongoClient(uri);
  await cli.connect();
  const db = cli.db('main');
  const cfg = await db.collection('fry_fee_genesis').findOne({ _id: 'config' });
  const sink = (cfg.fee_sink_addresses || [])[0];
  const prefix = cfg.fee_note_prefix || 'ffg-fee:';
  const lst = db.collection('ffg_ledger_state');
  const doc = (await lst.findOne({ _id: 'state' })) || { _id: 'state', state: {}, processed: [] };
  const state = doc.state || {};
  const processed = new Set(doc.processed || []);
  const prefixB64 = Buffer.from(prefix).toString('base64');
  const url = `${IDX}/v2/transactions?address=${sink}&address-role=receiver&tx-type=axfer&note-prefix=${encodeURIComponent(prefixB64)}&limit=1000`;
  let added = 0;
  try {
    const r = await getJSON(url);
    for (const t of (r.transactions || [])) {
      if (processed.has(t.id)) continue;
      const ax = t['asset-transfer-transaction'];
      if (!ax || !ax.amount) continue;
      const asa = String(ax['asset-id']);
      const amt = Number(ax.amount);
      const rt = t['round-time'] ? new Date(t['round-time'] * 1000) : null;
      if (!rt) continue;
      const month = `${rt.getUTCFullYear()}-${String(rt.getUTCMonth() + 1).padStart(2, '0')}`;
      accrue(state, asa, amt, month);
      processed.add(t.id);
      added++;
    }
  } catch (e) {
    console.log('indexer query note (no inflows yet is normal):', String(e).slice(0, 120));
  }
  await lst.updateOne({ _id: 'state' }, { $set: { state, processed: [...processed], last_scan: new Date() } }, { upsert: true });
  console.log(`FFG scan complete. new_inflows=${added} asas=${Object.keys(state).length} sink=${sink}`);
  for (const [asa, s] of Object.entries(state)) {
    console.log(`  asa=${asa} cumPerSlot=${s.cumPerSlot} dust=${s.dustCarry} months=${Object.keys(s.monthCum || {}).join(',')}`);
  }
  await cli.close();
})().catch(e => { console.error('scan error', e); process.exit(1); });
