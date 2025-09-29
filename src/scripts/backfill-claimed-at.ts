import 'dotenv/config';
import algosdk from 'algosdk';
import { connect } from '../db/connect';
import { DeviceRewardModel, TestDeviceRewardModel } from '../db/device-rewards-schema';

const testMode = process.env.TEST_MODE === 'true';
const DRY_RUN = process.argv.includes('--dry-run');

// Tuning knobs
const CONCURRENCY = Math.max(1, Number(process.env.BACKFILL_CONCURRENCY || '3'));
const BASE_DELAY_MS = Math.max(0, Number(process.env.BACKFILL_BASE_DELAY_MS || '300')); // per request pacing + jitter
const MAX_RETRIES = Math.max(1, Number(process.env.BACKFILL_MAX_RETRIES || '5'));

// Indexer config
const INDEXER_SERVER = process.env.ALGO_INDEXER_SERVER || 'https://xna-mainnet-api.algonode.cloud/';
const INDEXER_PORT = Number(process.env.ALGO_INDEXER_PORT || 443);
const INDEXER_TOKEN = process.env.ALGO_INDEXER_TOKEN || '';
const headers = INDEXER_TOKEN ? { 'X-API-Key': INDEXER_TOKEN } : ({} as any);
const indexer = new algosdk.Indexer(headers, INDEXER_SERVER, INDEXER_PORT);

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function getOnChainTime(txId: string, retries = MAX_RETRIES, baseDelay = BASE_DELAY_MS): Promise<Date | undefined> {
  for (let i = 0; i < retries; i++) {
    try {
      const info: any = await indexer.lookupTransactionByID(txId).do();
      const roundTime = info?.transaction?.['round-time'];
      if (roundTime) return new Date(roundTime * 1000);
    } catch (e: any) {
      const status = e?.status || e?.response?.status;
      // 404 is common while indexer catches up; skip quickly
      if (status && status !== 404) {
        console.warn(`lookupTransactionByID failed (txId=${txId}) status=${status}`);
      }
      // Exponential backoff on 429/5xx
      const shouldBackoff = status === 429 || (status && status >= 500);
      const delay = shouldBackoff ? baseDelay * Math.pow(2, i) : baseDelay;
      if (i < retries - 1) await sleep(delay);
    }
  }
  return undefined;
}

export async function backfillClaimedAt(): Promise<void> {
  await connect();
  const model = testMode ? TestDeviceRewardModel : DeviceRewardModel;

  console.log('🔎 Scanning for claimed entries missing claimed_at...');
  const cursor = model.find({
    $or: [
      { 'daily_rewards': { $elemMatch: { status: 'claimed', tx_id: { $exists: true }, claimed_at: { $exists: false } } } },
      { 'weekly_rewards': { $elemMatch: { status: 'claimed', tx_id: { $exists: true }, claimed_at: { $exists: false } } } }
    ]
  }, { miner_key: 1, daily_rewards: 1, weekly_rewards: 1 }).cursor();

  const missingTx = new Set<string>();
  let docsScanned = 0;
  for await (const doc of cursor as any) {
    docsScanned++;
    (doc.daily_rewards || []).forEach((r: any) => {
      if (r?.status === 'claimed' && r?.tx_id && !r?.claimed_at) missingTx.add(r.tx_id);
    });
    (doc.weekly_rewards || []).forEach((r: any) => {
      if (r?.status === 'claimed' && r?.tx_id && !r?.claimed_at) missingTx.add(r.tx_id);
    });
  }

  const txIds = Array.from(missingTx);
  console.log(`Found ${txIds.length} txIds to backfill across ${docsScanned} docs`);
  if (txIds.length === 0) return;

  let processed = 0;
  let updated = 0;

  async function worker(workerId: number) {
    while (true) {
      const i = processed;
      if (i >= txIds.length) break;
      processed++;
      const txId = txIds[i];
      const ts = await getOnChainTime(txId);
      if (ts && !DRY_RUN) {
        const up1 = await model.updateMany(
          { 'daily_rewards.tx_id': txId, $or: [
              { 'daily_rewards.claimed_at': { $exists: false } },
              { 'daily_rewards.claimed_at': null },
              { 'daily_rewards.claimed_at': { $type: 'undefined' } }
            ]
          },
          { $set: { 'daily_rewards.$[elem].claimed_at': ts } },
          { arrayFilters: [{ 'elem.tx_id': txId, $or: [
                { 'elem.claimed_at': { $exists: false } },
                { 'elem.claimed_at': null },
                { 'elem.claimed_at': { $type: 'undefined' } }
              ] }] }
        );
        const up2 = await model.updateMany(
          {
            'weekly_rewards.tx_id': txId,
            $or: [
              { 'weekly_rewards.claimed_at': { $exists: false } },
              { 'weekly_rewards.claimed_at': null },
              { 'weekly_rewards.claimed_at': { $type: 'undefined' } }
            ]
          },
          { $set: { 'weekly_rewards.$[elem].claimed_at': ts } },
          {
            arrayFilters: [{
              'elem.tx_id': txId,
              $or: [
                { 'elem.claimed_at': { $exists: false } },
                { 'elem.claimed_at': null },
                { 'elem.claimed_at': { $type: 'undefined' } }
              ]
            }]
          }
        );
        updated += (up1.modifiedCount || 0) + (up2.modifiedCount || 0);
      }
      // Pace requests
      const jitter = Math.floor(Math.random() * BASE_DELAY_MS);
      await sleep(BASE_DELAY_MS + jitter);
      if (processed % 100 === 0) {
        console.log(`Progress: ${processed}/${txIds.length} (${Math.round(processed * 100 / txIds.length)}%)`);
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, txIds.length) }, (_, i) => worker(i));
  await Promise.all(workers);

  console.log(`✅ Backfill complete. txIds processed: ${txIds.length}${DRY_RUN ? ' (dry-run)' : ''}. Updates applied: ${updated}`);
}

if (require.main === module) {
  backfillClaimedAt()
    .then(() => process.exit(0))
    .catch(err => { console.error(err); process.exit(1); });
}
