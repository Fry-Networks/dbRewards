import 'dotenv/config';
import { connect } from '../db/connect';
import { DeviceRewardModel, TestDeviceRewardModel } from '../db/device-rewards-schema';
import { isTfryAsset, TFRY_ASSET_ID } from '../reward-totals';

const testMode = process.env.TEST_MODE === 'true';
const DRY = process.argv.includes('--dry-run');
const CUTOFF = process.env.DEDUPE_CUTOFF_ISO
  ? new Date(process.env.DEDUPE_CUTOFF_ISO)
  : undefined; // Optional limit (e.g., 2025-09-12)

const STATUS_PRIORITY: Record<string, number> = {
  claimed: 5,
  claimable: 4,
  pending: 3,
  aggregated: 2,
  accruing: 1
};

function keyOf(r: any) {
  return `${r.asset_id}__${r.date}`;
}

export async function dedupeAccruing(): Promise<void> {
  await connect();
  const model = testMode ? TestDeviceRewardModel : DeviceRewardModel;
  const cursor = model.find({}, { miner_key: 1, daily_rewards: 1 }).cursor();

  let docs = 0;
  let removed = 0;
  for await (const doc of cursor as any) {
    docs++;
    const groups = new Map<string, any[]>();
    const keepIds = new Set<string>();

    for (const reward of doc.daily_rewards || []) {
      if (!reward?._id) continue;
      if (CUTOFF && reward.created_at && new Date(reward.created_at) < CUTOFF) {
        keepIds.add(String(reward._id));
        continue;
      }
      const key = keyOf(reward);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(reward);
    }

    let removedInDoc = 0;
    for (const arr of groups.values()) {
      if (arr.length === 1) {
        keepIds.add(String(arr[0]._id));
        continue;
      }
      arr.sort((a, b) => {
        const priorityDiff = (STATUS_PRIORITY[b.status] || 0) - (STATUS_PRIORITY[a.status] || 0);
        if (priorityDiff !== 0) return priorityDiff;
        const timeA = a.created_at ? new Date(a.created_at).getTime() : 0;
        const timeB = b.created_at ? new Date(b.created_at).getTime() : 0;
        if (timeA !== timeB) return timeA - timeB;
        return (a.reward_number || 0) - (b.reward_number || 0);
      });
      keepIds.add(String(arr[0]._id));
      removedInDoc += (arr.length - 1);
    }

    if (removedInDoc === 0) continue;
    removed += removedInDoc;

    if (!DRY) {
      const newDaily: any[] = [];
      let totalPending = 0;
      let totalClaimable = 0;
      let totalClaimed = 0;
      let tfryPending = 0;
      let tfryClaimable = 0;
      let tfryClaimed = 0;

      for (const reward of doc.daily_rewards || []) {
        const hasId = reward?._id !== undefined && reward?._id !== null;
        const keep = hasId ? keepIds.has(String(reward._id)) : true;
        if (keep) {
          newDaily.push(reward);
          const amount = Number(reward.amount || 0);
          const isTfry = isTfryAsset(reward.asset_id);
          if (reward.status === 'pending') {
            if (isTfry) {
              tfryPending += amount;
            } else {
              totalPending += amount;
            }
          } else if (reward.status === 'claimable') {
            if (isTfry) {
              tfryClaimable += amount;
            } else {
              totalClaimable += amount;
            }
          } else if (reward.status === 'claimed') {
            if (isTfry) {
              tfryClaimed += amount;
            } else {
              totalClaimed += amount;
            }
          }
        }
      }

      await model.updateOne(
        { _id: doc._id },
        {
          $set: {
            daily_rewards: newDaily,
            reward_count: newDaily.length,
            total_pending: totalPending,
            total_claimable: totalClaimable,
            total_claimed: totalClaimed,
            tfry_pending: tfryPending,
            tfry_claimable: tfryClaimable,
            tfry_claimed: tfryClaimed,
            tfry_total: tfryPending + tfryClaimable + tfryClaimed
          }
        }
      );
    }
  }
  console.log(`Dedupe complete. Docs scanned: ${docs}. Entries removed${DRY ? ' (planned)' : ''}: ${removed}`);
}

if (require.main === module) {
  dedupeAccruing().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
}
