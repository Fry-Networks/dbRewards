// FFG mint watcher (CANON). Detects 'o'-prefix passes on-chain, creates ffg_passes (paid=0).
// Payout of full pending (MINT mode) self-arms once U5TA signer exists.
const https = require('https');
const { MongoClient } = require('mongodb');
const algosdk = require('algosdk');
const APP = Number(process.env.FFG_APP_ID || 3636406117);
const ALGOD = process.env.FFG_ALGOD_URL || 'https://mainnet-api.4160.nodely.dev';
const getJSON = (url) => new Promise((res, rej) => {
  https.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});
(async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI not set');
  const cli = new MongoClient(uri);
  await cli.connect();
  const db = cli.db('main');
  let boxes;
  try { boxes = await getJSON(`${ALGOD}/v2/applications/${APP}/boxes`); } catch (e) { boxes = { boxes: [] }; }
  let minted = 0, created = 0;
  for (const b of (boxes.boxes || [])) {
    const name = Buffer.from(b.name, 'base64');
    if (name.length !== 9 || name[0] !== 0x6f) continue;
    minted++;
    const idx = Number(name.readBigUInt64BE(1));
    const existing = await db.collection('ffg_passes').findOne({ _id: `pass-${idx}` });
    if (!existing) {
      let owner = null;
      try {
        const bx = await getJSON(`${ALGOD}/v2/applications/${APP}/box?name=${encodeURIComponent('b64:' + b.name)}`);
        owner = algosdk.encodeAddress(Buffer.from(bx.value, 'base64'));
      } catch (e) { /* owner unresolved; recorded null, resolved on next pass */ }
      await db.collection('ffg_passes').insertOne({ _id: `pass-${idx}`, index: idx, owner, mintedAt: new Date(), paid: {} });
      created++;
    }
  }
  console.log(`FFG mint-watch: on-chain minted=${minted} new_pass_records=${created}. (MINT payout dry-run until U5TA signer.)`);
  await cli.close();
})().catch(e => { console.error('watch error', e); process.exit(1); });
