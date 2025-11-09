/**
 * Interactive reward-inspection CLI.
 *
 * What it does:
 *   • Loads `device-rewards` and the matching `devices` record for a miner key.
 *   • Recomputes tFry/legacy totals from daily + weekly rows and compares them to the stored rollups.
 *   • Displays daily/weekly breakdowns, reward counts, and legacy snapshot flags.
 *
 * Usage examples:
 *   npm run inspect-device-rewards              # production DB
 *   TEST_MODE=true npm run inspect-device-rewards  # test DB
 *
 * Follow the prompt; enter miner keys to inspect, or `exit` to quit.
 */

import 'dotenv/config';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { connect } from '../db/connect';
import { DeviceRewardModel, TestDeviceRewardModel, type DeviceReward } from '../db/device-rewards-schema';
import { DeviceModel, TestDeviceModel, type Device } from '../db/devices-schema';

const testMode = process.env.TEST_MODE === 'true';
const RewardModel = testMode ? TestDeviceRewardModel : DeviceRewardModel;
const DeviceInfoModel = testMode ? TestDeviceModel : DeviceModel;

type StatusTotals = Record<string, number>;

type ComputedBreakdown = {
  daily: StatusTotals;
  weekly: StatusTotals;
  legacyTotals: {
    claimed: number;
    pending: number;
    claimable: number;
  };
  tfryTotals: {
    claimed: number;
    pending: number;
    claimable: number;
  };
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function computeBreakdown(deviceReward: DeviceReward): ComputedBreakdown {
  const dailyStatuses = ['accruing', 'aggregated', 'pending', 'claimable', 'claimed'] as const;
  const weeklyStatuses = ['pending', 'claimable', 'claimed'] as const;

  const daily: StatusTotals = Object.fromEntries(dailyStatuses.map((status) => [status, 0]));
  const weekly: StatusTotals = Object.fromEntries(weeklyStatuses.map((status) => [status, 0]));

  let legacyClaimed = 0;
  let legacyPending = 0;
  let legacyClaimable = 0;

  let tfryClaimed = 0;
  let tfryPending = 0;
  let tfryClaimable = 0;

  const LEGACY_ASSET = '924268058';
  const TFRY_ASSET = '2681521901';

  for (const reward of deviceReward.daily_rewards ?? []) {
    const status = reward.status as typeof dailyStatuses[number];
    if (daily[status] !== undefined) {
      daily[status] += Number(reward.amount ?? 0);
    }
    if (reward.asset_id === LEGACY_ASSET) {
      if (reward.status === 'claimed') legacyClaimed += Number(reward.amount ?? 0);
      else if (reward.status === 'pending') legacyPending += Number(reward.amount ?? 0);
      else if (reward.status === 'claimable') legacyClaimable += Number(reward.amount ?? 0);
    } else if (reward.asset_id === TFRY_ASSET) {
      if (reward.status === 'claimed') tfryClaimed += Number(reward.amount ?? 0);
      else if (reward.status === 'pending') tfryPending += Number(reward.amount ?? 0);
      else if (reward.status === 'claimable') tfryClaimable += Number(reward.amount ?? 0);
    }
  }

  for (const reward of deviceReward.weekly_rewards ?? []) {
    const status = reward.status as typeof weeklyStatuses[number];
    if (weekly[status] !== undefined) {
      weekly[status] += Number(reward.amount ?? 0);
    }
    if (reward.asset_id === LEGACY_ASSET) {
      if (reward.status === 'claimed') legacyClaimed += Number(reward.amount ?? 0);
      else if (reward.status === 'pending') legacyPending += Number(reward.amount ?? 0);
      else if (reward.status === 'claimable') legacyClaimable += Number(reward.amount ?? 0);
    } else if (reward.asset_id === TFRY_ASSET) {
      if (reward.status === 'claimed') tfryClaimed += Number(reward.amount ?? 0);
      else if (reward.status === 'pending') tfryPending += Number(reward.amount ?? 0);
      else if (reward.status === 'claimable') tfryClaimable += Number(reward.amount ?? 0);
    }
  }

  const roundAll = (totals: StatusTotals): StatusTotals =>
    Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, round2(value)]));

  return {
    daily: roundAll(daily),
    weekly: roundAll(weekly),
    legacyTotals: {
      claimed: round2(legacyClaimed),
      pending: round2(legacyPending),
      claimable: round2(legacyClaimable),
    },
    tfryTotals: {
      claimed: round2(tfryClaimed),
      pending: round2(tfryPending),
      claimable: round2(tfryClaimable),
    },
  };
}

function diff(a: number, b: number): string {
  const delta = round2(a - b);
  return delta === 0 ? 'OK' : `${delta > 0 ? '+' : ''}${delta.toFixed(2)}`;
}

function printComparison(title: string, stored: number, computed: number): void {
  console.log(
    `${title.padEnd(22)} stored=${stored.toFixed(2).padStart(10)} | computed=${computed
      .toFixed(2)
      .padStart(10)} | delta=${diff(stored, computed)}`,
  );
}

async function inspectMiner(minerKeyRaw: string): Promise<void> {
  const minerKey = minerKeyRaw.trim().toUpperCase();
  if (!minerKey) {
    console.log('⚠️  Please enter a miner key.');
    return;
  }

  const [device, rewardDoc] = await Promise.all([
    DeviceInfoModel.findOne({ miner_key: minerKey }).lean<Device | null>(),
    RewardModel.findOne({ miner_key: minerKey }).lean<DeviceReward | null>(),
  ]);

  if (!rewardDoc) {
    console.log(`❌ No device-rewards document found for ${minerKey}`);
    return;
  }

  console.log('\n' + '='.repeat(70));
  console.log(`Miner: ${minerKey}`);
  if (device) {
    console.log(`Name : ${device.name ?? 'N/A'}`);
    console.log(`Type : ${device.miner_key?.split('-')[0] ?? 'N/A'}`);
    console.log(`Device verified: ${device.verified ? 'yes' : 'no'}`);
  } else {
    console.log('⚠️  Device record not found.');
  }
  console.log(`Rewards updated at: ${rewardDoc.last_updated?.toISOString() ?? 'N/A'}`);
  console.log('='.repeat(70));

  const breakdown = computeBreakdown(rewardDoc);
  const totals = rewardDoc;

  console.log('\nStored totals vs computed (tFry):');
  printComparison('tfry_pending', totals.tfry_pending ?? 0, breakdown.tfryTotals.pending);
  printComparison('tfry_claimable', totals.tfry_claimable ?? 0, breakdown.tfryTotals.claimable);
  printComparison('tfry_claimed', totals.tfry_claimed ?? 0, breakdown.tfryTotals.claimed);
  printComparison('tfry_total', totals.tfry_total ?? 0, breakdown.tfryTotals.claimed + breakdown.tfryTotals.pending + breakdown.tfryTotals.claimable);

  console.log('\nStored totals vs computed (Legacy Fry):');
  printComparison('legacy_pending', totals.legacy_fry_pending ?? 0, breakdown.legacyTotals.pending);
  printComparison('legacy_claimable', totals.legacy_fry_claimable ?? 0, breakdown.legacyTotals.claimable);
  printComparison('legacy_claimed', totals.legacy_fry_claimed ?? 0, breakdown.legacyTotals.claimed);
  printComparison(
    'legacy_total',
    totals.legacy_fry_total ?? 0,
    breakdown.legacyTotals.claimed + breakdown.legacyTotals.pending + breakdown.legacyTotals.claimable,
  );

  console.log('\nDaily rewards (tFry only):');
  Object.entries(breakdown.daily).forEach(([status, amount]) => {
    console.log(`  ${status.padEnd(12)}: ${amount.toFixed(2)}`);
  });

  console.log('\nWeekly rewards (tFry only):');
  Object.entries(breakdown.weekly).forEach(([status, amount]) => {
    console.log(`  ${status.padEnd(12)}: ${amount.toFixed(2)}`);
  });

  console.log('\nCounts:');
  console.log(
    `  daily rewards : ${rewardDoc.daily_rewards?.length ?? 0
    } (claimable=${rewardDoc.daily_rewards?.filter((r) => r.status === 'claimable').length ?? 0})`,
  );
  console.log(
    `  weekly rewards: ${rewardDoc.weekly_rewards?.length ?? 0
    } (claimable=${rewardDoc.weekly_rewards?.filter((r) => r.status === 'claimable').length ?? 0})`,
  );

  console.log('\nLegacy Fry claimed snapshot:', rewardDoc.legacy_fry_claimed_snapshot ?? 0);
  console.log('Legacy Fry claimed converted flag:', rewardDoc.legacy_fry_claimed_converted ? 'true' : 'false');
  console.log('='.repeat(70) + '\n');
}

async function main(): Promise<void> {
  await connect();
  console.log(`✅ Connected (${testMode ? 'TEST' : 'PRODUCTION'} mode).`);

  const rl = readline.createInterface({ input, output });
  try {
    let running = true;
    while (running) {
      const answer = await rl.question('Enter miner key (or "exit" to quit): ');
      if (!answer || answer.trim().toLowerCase() === 'exit') {
        running = false;
      } else {
        try {
          await inspectMiner(answer);
        } catch (error) {
          console.error('❌ Inspection error:', error);
        }
      }
    }
  } finally {
    rl.close();
    await RewardModel.db.close();
  }

  console.log('Goodbye!');
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Inspector failed:', error);
    process.exit(1);
  });
}

export {};
