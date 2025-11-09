/**
 * Weekly reward deduplication tool.
 *
 * What it does:
 * - Scans every document in the `device-rewards` collection looking for repeated
 *   weekly reward entries that share the same asset and unlock window.
 * - Keeps the highest-priority copy (claimed > claimable > pending, then lowest
 *   reward number, then earliest creation time) and removes the rest.
 * - Recomputes aggregate totals (`total_pending`, `total_claimable`, `total_claimed`)
 *   based on the remaining weekly entries plus existing daily rows.
 *
 * Usage:
 *   npm run dedupe-weekly -- [options]
 *
 * Options:
 *   --dry-run   Analyze and report duplicates without saving changes.
 *
 * Examples:
 *   npm run dedupe-weekly -- --dry-run   # preview changes only
 *   npm run dedupe-weekly               # clean duplicates in place
 */

import 'dotenv/config';
import { connect } from '../db/connect';
import { DeviceRewardModel, TestDeviceRewardModel, type DeviceReward } from '../db/device-rewards-schema';
import { getSimNow } from '../time-control';

const testMode = process.env.TEST_MODE === 'true';
const DRY = process.argv.includes('--dry-run');

const STATUS_PRIORITY: Record<string, number> = {
  claimed: 3,
  claimable: 2,
  pending: 1
};

type WeeklyRewardEntry = DeviceReward['weekly_rewards'][number];

function weeklyKey(reward: WeeklyRewardEntry): string {
  const asset = String(reward?.asset_id ?? 'unknown');
  const unlockIso = reward?.unlock_at ? new Date(reward.unlock_at).toISOString() : 'unknown';
  return `${asset}__${unlockIso}`;
}

function statusRank(status: string | undefined): number {
  return STATUS_PRIORITY[status || ''] ?? 0;
}

export async function dedupeWeekly(): Promise<void> {
  await connect();
  const model = testMode ? TestDeviceRewardModel : DeviceRewardModel;
  const totalDocs = await model.estimatedDocumentCount();
  const withWeekly = await model.countDocuments({ 'weekly_rewards.0': { $exists: true } });
  console.log(`Device rewards docs: ${totalDocs}. With weekly entries: ${withWeekly}.`);
  const cursor = model.find(
    {},
    { miner_key: 1, weekly_rewards: 1, daily_rewards: 1, total_pending: 1, total_claimable: 1, total_claimed: 1 }
  ).cursor();

  let devicesScanned = 0;
  let devicesCleaned = 0;
  let entriesRemoved = 0;

  for await (const doc of cursor as AsyncIterable<DeviceReward>) {
    devicesScanned++;

    const weeklyRewards = doc.weekly_rewards || [];
    if (weeklyRewards.length <= 1) {
      continue;
    }

    const groups = new Map<string, WeeklyRewardEntry[]>();
    for (const reward of weeklyRewards) {
      const key = weeklyKey(reward);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(reward);
    }

    let hasDuplicates = false;
    for (const arr of groups.values()) {
      if (arr.length > 1) {
        hasDuplicates = true;
        break;
      }
    }
    if (!hasDuplicates) continue;

    devicesCleaned++;

    const unique: WeeklyRewardEntry[] = [];
    const removed: WeeklyRewardEntry[] = [];

    groups.forEach((entries) => {
      const sorted = [...entries].sort((a, b) => {
        const statusDiff = statusRank(b.status) - statusRank(a.status);
        if (statusDiff !== 0) return statusDiff;
        const numberDiff = (a.reward_number ?? 0) - (b.reward_number ?? 0);
        if (numberDiff !== 0) return numberDiff;
        const createdDiff =
          new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime();
        if (createdDiff !== 0) return createdDiff;
        return String(a._id ?? '').localeCompare(String(b._id ?? ''));
      });
      unique.push(sorted[0]);
      removed.push(...sorted.slice(1));
    });

    entriesRemoved += removed.length;

    unique.sort((a, b) => (a.reward_number ?? 0) - (b.reward_number ?? 0));

    if (DRY) {
      continue;
    }

    const dailyPending = (doc.daily_rewards || [])
      .filter((r) => r.status === 'pending')
      .reduce((sum, r) => sum + Number(r.amount || 0), 0);
    const dailyClaimable = (doc.daily_rewards || [])
      .filter((r) => r.status === 'claimable')
      .reduce((sum, r) => sum + Number(r.amount || 0), 0);
    const dailyClaimed = (doc.daily_rewards || [])
      .filter((r) => r.status === 'claimed')
      .reduce((sum, r) => sum + Number(r.amount || 0), 0);

    const weeklyPending = unique
      .filter((r) => r.status === 'pending')
      .reduce((sum, r) => sum + Number(r.amount || 0), 0);
    const weeklyClaimable = unique
      .filter((r) => r.status === 'claimable')
      .reduce((sum, r) => sum + Number(r.amount || 0), 0);
    const weeklyClaimed = unique
      .filter((r) => r.status === 'claimed')
      .reduce((sum, r) => sum + Number(r.amount || 0), 0);

    doc.weekly_rewards = unique;
    doc.weekly_reward_count = unique.length;
    doc.total_pending = Math.round((dailyPending + weeklyPending) * 100) / 100;
    doc.total_claimable = Math.round((dailyClaimable + weeklyClaimable) * 100) / 100;
    doc.total_claimed = Math.round((dailyClaimed + weeklyClaimed) * 100) / 100;
    doc.last_updated = getSimNow();
    doc.markModified?.('weekly_rewards');

    await doc.save();
  }

  console.log(
    `Weekly dedupe complete. Devices scanned: ${devicesScanned}. Devices cleaned: ${devicesCleaned}. ` +
    `Entries removed${DRY ? ' (planned)' : ''}: ${entriesRemoved}.`
  );
}

if (require.main === module) {
  dedupeWeekly()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
