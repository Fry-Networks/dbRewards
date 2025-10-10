// Seeds the last 21 days of device rewards (7 accruing, 7 pending, 7 claimable) for a miner.
// Usage examples:
//   npm run grant-recent-rewards
//   npm run grant-recent-rewards -- --amount 12.34
import 'dotenv/config';
import mongoose from 'mongoose';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { DeviceModel, type Device } from '../db/devices-schema';
import { DeviceRewardModel, type DeviceReward } from '../db/device-rewards-schema';
import { ProductModel, type Product } from '../db/products-schema';

interface CliOptions {
  amountOverride?: number;
}

type DailyStatus = 'accruing' | 'pending' | 'claimable';

const DAY_MS = 24 * 60 * 60 * 1000;

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  normalizeMongoEnv();

  const uri = process.env.MONGO_URI;
  if (!uri) {
    throw new Error('MONGO_URI or MONGODB_URI must be set to run this script');
  }

  await mongoose.connect(uri, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 8_000,
    socketTimeoutMS: 60_000,
    retryReads: true,
    retryWrites: true,
  });

  const rl = createInterface({ input, output });

  try {
    const minerKeyInput = (await rl.question('Enter miner key: ')).trim();
    if (!minerKeyInput) {
      throw new Error('Miner key is required');
    }

    const minerKey = minerKeyInput.toUpperCase();
    const deviceDoc = await DeviceModel.findOne({ miner_key: minerKey });
    if (!deviceDoc) {
      throw new Error(`Device with miner key ${minerKey} not found`);
    }

    const device = deviceDoc.toObject<Device>();
    const productKey = minerKey.split('-')[0];
    const productDoc = await ProductModel.findOne({ key: productKey });
    if (!productDoc) {
      throw new Error(`No product configuration found for prefix ${productKey}`);
    }

    const product = productDoc.toObject<Product>();
    const assetId = product.reward?.tokens?.reward;
    if (!assetId) {
      throw new Error(`Reward token not configured for product ${productKey}`);
    }

    let dailyAmount = options.amountOverride ?? calculateRewardAmount(device, product);
    if (!Number.isFinite(dailyAmount) || dailyAmount <= 0) {
      const manual = (await rl.question('Calculated amount is <= 0. Enter daily reward amount: ')).trim();
      const manualValue = Number(manual);
      if (!Number.isFinite(manualValue) || manualValue <= 0) {
        throw new Error('A positive numeric amount is required');
      }
      dailyAmount = manualValue;
    }

    dailyAmount = round2(dailyAmount);

    const existingDoc = await DeviceRewardModel.findOne({ miner_key: minerKey });
    const existing = existingDoc?.toObject<DeviceReward>();

    const dailyRewards = cloneDailyRewards(existing?.daily_rewards ?? []);
    const weeklyRewards = cloneWeeklyRewards(existing?.weekly_rewards ?? []);

    const todayUtc = startOfUtcDay(new Date());
    const existingIndex = buildDailyIndex(dailyRewards);

    for (let offset = 0; offset < 21; offset += 1) {
      const entryDate = new Date(todayUtc.getTime() - offset * DAY_MS);
      const dateString = formatDate(entryDate);
      const status: DailyStatus = offset < 7 ? 'accruing' : offset < 14 ? 'pending' : 'claimable';
      const key = makeDailyKey(dateString, assetId);
      const payload = {
        date: dateString,
        amount: dailyAmount,
        status,
        asset_id: assetId,
        created_at: entryDate,
        reward_number: 0,
      } as DailyRewardPayload;

      if (existingIndex.has(key)) {
        dailyRewards[existingIndex.get(key)!] = {
          ...dailyRewards[existingIndex.get(key)!],
          amount: dailyAmount,
          status,
          created_at: entryDate,
        };
      } else {
        existingIndex.set(key, dailyRewards.length);
        dailyRewards.push(payload);
      }
    }

    dailyRewards.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
    dailyRewards.forEach((reward, index) => {
      reward.reward_number = index + 1;
    });

    const totalPending = round2(sumRewardsByStatus(dailyRewards, 'pending'));
    const totalClaimable = round2(sumRewardsByStatus(dailyRewards, 'claimable'));

    const firstRewardDate = dailyRewards[0]?.created_at ?? existing?.first_reward_date ?? new Date();
    const lastRewardDate = dailyRewards[dailyRewards.length - 1]?.created_at ?? existing?.last_reward_date ?? new Date();

    const result = await DeviceRewardModel.findOneAndUpdate(
      { miner_key: minerKey },
      {
        $set: {
          miner_key: minerKey,
          daily_rewards: dailyRewards,
          weekly_rewards: weeklyRewards,
          total_pending: totalPending,
          total_claimable: totalClaimable,
          total_claimed: existing?.total_claimed ?? 0,
          reward_count: dailyRewards.length,
          weekly_reward_count: weeklyRewards.length,
          first_reward_date: firstRewardDate,
          last_reward_date: lastRewardDate,
          last_updated: new Date(),
        },
        $setOnInsert: {
          total_claimed: 0,
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );

    if (!result) {
      throw new Error('Failed to write device rewards document');
    }

    const updated = result.toObject<DeviceReward>();

    console.log('\n✅ Rewards seeded successfully');
    console.log(`Miner key         : ${minerKey}`);
    console.log(`Daily amount      : ${dailyAmount}`);
    console.log(`Total daily rows  : ${updated.daily_rewards.length}`);
    console.log(`Total pending     : ${updated.total_pending}`);
    console.log(`Total claimable   : ${updated.total_claimable}`);
    console.log(`Reward count      : ${updated.reward_count}`);
    console.log(`First reward date : ${updated.first_reward_date?.toISOString()}`);
    console.log(`Last reward date  : ${updated.last_reward_date?.toISOString()}`);
  } finally {
    rl.close();
    await mongoose.disconnect().catch(() => undefined);
  }
}

type DailyRewardPayload = {
  date: string;
  amount: number;
  status: 'accruing' | 'aggregated' | 'pending' | 'claimable' | 'claimed';
  asset_id: string;
  created_at: Date;
  claimed_at?: Date;
  tx_id?: string;
  reward_number: number;
};

type WeeklyRewardPayload = {
  week_start: Date;
  week_end: Date;
  unlock_at: Date;
  status: 'pending' | 'claimable' | 'claimed';
  asset_id: string;
  amount: number;
  created_at: Date;
  claimed_at?: Date;
  tx_id?: string;
  reward_number: number;
};

function parseCliOptions(argv: string[]): CliOptions {
  const options: CliOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else if (arg.startsWith('--amount=')) {
      options.amountOverride = parseAmount(arg.split('=')[1]);
    } else if (arg === '--amount') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error('Missing value for --amount');
      }
      options.amountOverride = parseAmount(value);
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function printUsage(): void {
  console.log('Usage: npx ts-node src/scripts/grant-recent-rewards.ts [options]\n');
  console.log('Options:');
  console.log('  --amount <value>   Override daily reward amount');
  console.log('  --help             Show this message');
}

function parseAmount(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('Amount must be a positive number');
  }
  return round2(parsed);
}

function normalizeMongoEnv(): void {
  if (!process.env.MONGO_URI && process.env.MONGODB_URI) {
    process.env.MONGO_URI = process.env.MONGODB_URI;
  }
}

function calculateRewardAmount(device: Device, product: Product): number {
  let rewardAmount = 0;
  const stakeAsset = product.reward?.tokens?.stake;

  if (!device.staked || !stakeAsset || stakeAsset === 'none' || device.staked.asset_id !== stakeAsset) {
    rewardAmount = product.reward?.verified ?? 0;
  } else if (device.verified) {
    switch (device.staked.type) {
      case 'one':
        rewardAmount = Math.round((product.reward.verified ?? 0) * 150) / 100;
        break;
      case 'two':
        rewardAmount = Math.round((product.reward.verified ?? 0) * 300) / 100;
        break;
      default:
        rewardAmount = product.reward?.verified ?? 0;
        break;
    }
  } else {
    rewardAmount = product.reward?.verified ?? 0;
  }

  if (device.byod && device.byod.length > 0) {
    rewardAmount = Math.round((rewardAmount / 2) * 100) / 100;
  }

  return rewardAmount;
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

function makeDailyKey(date: string, assetId: string): string {
  return `${assetId}::${date}`;
}

function buildDailyIndex(daily: DailyRewardPayload[]): Map<string, number> {
  const index = new Map<string, number>();
  daily.forEach((reward, position) => {
    index.set(makeDailyKey(reward.date, reward.asset_id), position);
  });
  return index;
}

function cloneDailyRewards(daily: DeviceReward['daily_rewards']): DailyRewardPayload[] {
  return daily.map((reward) => ({
    date: reward.date,
    amount: reward.amount,
    status: reward.status,
    asset_id: reward.asset_id,
    created_at: new Date(reward.created_at),
    claimed_at: reward.claimed_at ? new Date(reward.claimed_at) : undefined,
    tx_id: reward.tx_id,
    reward_number: reward.reward_number,
  }));
}

function cloneWeeklyRewards(weekly: DeviceReward['weekly_rewards']): WeeklyRewardPayload[] {
  return weekly.map((reward) => ({
    week_start: new Date(reward.week_start),
    week_end: new Date(reward.week_end),
    unlock_at: new Date(reward.unlock_at),
    status: reward.status,
    asset_id: reward.asset_id,
    amount: reward.amount,
    created_at: new Date(reward.created_at),
    claimed_at: reward.claimed_at ? new Date(reward.claimed_at) : undefined,
    tx_id: reward.tx_id,
    reward_number: reward.reward_number,
  }));
}

function sumRewardsByStatus(rewards: DailyRewardPayload[], status: DailyStatus): number {
  return rewards
    .filter((reward) => reward.status === status)
    .reduce((total, reward) => total + reward.amount, 0);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

main().catch((error) => {
  console.error('❌ Failed to seed rewards:', error.message ?? error);
  if (process.env.DEBUG === 'true') {
    console.error(error);
  }
  process.exitCode = 1;
});
