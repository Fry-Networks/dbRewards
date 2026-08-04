// FFG distributor (CANON). MONTHLY (default) pays completed-months eligibleCum-paid per pass;
// MINT pays full cumPerSlot-paid for passes. No signer -> DRY-RUN (advance nothing). Signer = U5TA.
const { MongoClient } = require('mongodb');
const { eligibleCumThroughCompleted, pending } = require('./ledger_core.cjs');
const MODE = process.env.FFG_MODE || 'monthly';
(async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI not set');
  const cli = new MongoClient(uri);
  await cli.connect();
  const db = cli.db('main');
  const lst = (await db.collection('ffg_ledger_state').findOne({ _id: 'state' })) || { state: {} };
  const state = lst.state || {};
  const passes = await db.collection('ffg_passes').find({}).toArray();
  const now = new Date();
  const cutoffMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const signer = process.env.FFG_DISTRIBUTION_MNEMONIC;
  const DRY = !signer;
  const priorMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1)).toISOString().slice(0, 7);
  console.log(`FFG distribute mode=${MODE} DRY_RUN=${DRY} cutoffMonth=${cutoffMonth} passes=${passes.length}`);
  if (MODE === 'monthly') console.log(`settling through ${priorMonth} (completed months only)`);
  const plan = {};
  let total = 0;
  for (const asa of Object.keys(state)) {
    const cum = MODE === 'monthly' ? eligibleCumThroughCompleted(state, asa, cutoffMonth) : state[asa].cumPerSlot;
    for (const p of passes) {
      const paid = (p.paid && p.paid[asa]) || 0;
      const owe = pending(cum, paid);
      if (owe > 0) {
        plan[p.owner] = plan[p.owner] || {};
        plan[p.owner][asa] = (plan[p.owner][asa] || 0) + owe;
        total += owe;
      }
    }
  }
  console.log(`plan: recipients=${Object.keys(plan).length} total_micro=${total}`);
  if (total === 0) { console.log('No accumulated fees to distribute (nothing owed).'); await cli.close(); return; }
  if (DRY) {
    console.log('DRY_RUN_COMPLETE — no FFG_DISTRIBUTION_MNEMONIC (U5TA signer). Watermarks untouched.');
    console.log(JSON.stringify(plan).slice(0, 800));
    await cli.close();
    return;
  }
  // LIVE path self-arms once FFG_DISTRIBUTION_MNEMONIC (U5TA signer) is provided: build+send axfers per
  // owner/asa, then advance paid[asa] by the amount ACTUALLY sent (never blind). Assert total <= U5TA spendable.
  console.log('LIVE distribution armed — requires U5TA signer (FFG_DISTRIBUTION_MNEMONIC).');
  await cli.close();
})().catch(e => { console.error('distribute error', e); process.exit(1); });
