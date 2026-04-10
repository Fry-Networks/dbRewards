// Seeds the last 30 days of device rewards (14 aggregated, 16 pending)
// for every device that passes the normal eligibility checks.
// Usage examples:
//   npm run grant-recent-rewards
//   npm run grant-recent-rewards -- --amount 12.34
//   npm run grant-recent-rewards -- --miner RDN-XXXX

import 'dotenv/config';
import mongoose, { type FilterQuery, Types } from 'mongoose';
import { DeviceModel, type Device } from '../db/devices-schema';
import { DeviceRewardModel, type DeviceReward } from '../db/device-rewards-schema';
import { ProductModel, type Product } from '../db/products-schema';
import { isNodeStaked, isRegistrationStaked } from '../reward';
import { getSimNow } from '../time-control';

interface CliOptions {
  amountOverride?: number;
  minerKey?: string;
  startDate?: Date;
}

type DailyStatus = 'accruing' | 'aggregated' | 'pending' | 'claimable' | 'claimed';

type DeviceEligibilityResult = {
  eligible: boolean;
  hasVerificationMultiplier: boolean;
  reason?: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;

type SkipCounters = {
  noProduct: number;
  noRewardToken: number;
  notEligible: number;
  noWallet: number;
  registrationMismatch: number;
  nodeMismatch: number;
  invalidAmount: number;
};

type SeedStats = {
  processed: number;
  eligible: number;
  seeded: number;
  dailyRows: number;
  totalPending: number;
  totalClaimable: number;
  skipped: SkipCounters;
};

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

  try {
    const products = await ProductModel.find({});
    const productMap = new Map<string, Product>();
    products.forEach((doc) => {
      productMap.set(doc.key, doc.toObject<Product>());
    });

    if (productMap.size === 0) {
      throw new Error('No product configurations found');
    }

    const runTimestamp = getSimNow();
    const baseDate = options.startDate
      ? addDays(startOfUtcDay(options.startDate), 29)
      : startOfUtcDay(runTimestamp);
    const earliestDate = addDays(baseDate, -29);
    console.log(`📅 Seeding rewards from ${formatDate(earliestDate)} through ${formatDate(baseDate)}.`);
    const tokensCollection = mongoose.connection.collection('tokens');

    // Fetch tFRY token for all non-node rewards (pending + claimable)
    const tfryToken = await tokensCollection.findOne({ name: /^tFRY$/i }) as { asset_id?: unknown } | null;
    if (!tfryToken?.asset_id) {
      throw new Error('tFRY asset_id not found in tokens collection');
    }
    const tfryAssetId = String(tfryToken.asset_id);

    const deviceQuery: FilterQuery<Device> = { is_registered: true };
    if (options.minerKey) {
      deviceQuery.miner_key = options.minerKey;
    }
    const totalRegistered = await DeviceModel.countDocuments(deviceQuery);
    console.log(`📊 Devices to evaluate: ${totalRegistered}${options.minerKey ? ` (filter: ${options.minerKey})` : ''}`);
    if (totalRegistered === 0) {
      console.log('ℹ️  No devices matched the criteria. Nothing to do.');
      return;
    }

    const stats: SeedStats = {
      processed: 0,
      eligible: 0,
      seeded: 0,
      dailyRows: 0,
      totalPending: 0,
      totalClaimable: 0,
      skipped: {
        noProduct: 0,
        noRewardToken: 0,
        notEligible: 0,
        noWallet: 0,
        registrationMismatch: 0,
        nodeMismatch: 0,
        invalidAmount: 0,
      },
    };

    const cursor = DeviceModel.find(deviceQuery).cursor();

    for await (const deviceDoc of cursor as AsyncIterable<Device>) {
      stats.processed += 1;

      const device = deviceDoc.toObject<Device>();
      const minerKey = device.miner_key.toUpperCase();
      device.miner_key = minerKey;
      const product = resolveProductForDevice(minerKey, productMap);
      if (!product) {
        stats.skipped.noProduct += 1;
        continue;
      }

      const rewardToken = product.reward?.tokens?.reward;
      if (!rewardToken || rewardToken === 'none') {
        stats.skipped.noRewardToken += 1;
        continue;
      }

      const eligibility = isDeviceCurrentlyEligible(device, product);
      if (!eligibility.eligible) {
        stats.skipped.notEligible += 1;
        continue;
      }
      stats.eligible += 1;

      if (!device.reward_wallet) {
        stats.skipped.noWallet += 1;
        continue;
      }

      if (
        isRegistrationStaked(device) &&
        device.registration?.asset_id &&
        product.reward?.tokens?.register &&
        device.registration.asset_id !== product.reward.tokens.register
      ) {
        stats.skipped.registrationMismatch += 1;
        continue;
      }

      if (
        isNodeStaked(device) &&
        device.node?.asset_id &&
        product.reward?.tokens?.node &&
        device.node.asset_id !== product.reward.tokens.node
      ) {
        stats.skipped.nodeMismatch += 1;
        continue;
      }

      const dailyAmount = resolveDailyAmount(device, product, eligibility, options.amountOverride);
      
      // Debug logging for first few devices
      if (stats.processed <= 3) {
        console.log(`\n🔍 Debug for ${minerKey}:`);
        console.log(`  Product: ${product.key}, verified reward: ${product.reward.verified}`);
        console.log(`  Device verified: ${device.verified}, staked type: ${device.staked?.type}`);
        console.log(`  Eligibility: ${JSON.stringify(eligibility)}`);
        console.log(`  Calculated amount: ${dailyAmount}`);
      }
      
      if (!Number.isFinite(dailyAmount) || dailyAmount <= 0) {
        stats.skipped.invalidAmount += 1;
        continue;
      }

      const existing = await DeviceRewardModel.findOne(
        { miner_key: minerKey },
        {
          daily_rewards: 1,
          reward_count: 1,
          total_claimed: 1,
          total_pending: 1,
          total_claimable: 1,
          weekly_rewards: 1,
          weekly_reward_count: 1,
          first_reward_date: 1,
        },
      ).lean<DeviceReward>();

      const deviceType = getDeviceType(minerKey);
      const isNodeOrAem = deviceType === 'node' || deviceType === 'aem';

      const existingDaily = (existing?.daily_rewards ?? []).map((reward) => ({
        ...reward,
        created_at: new Date(reward.created_at),
        claimed_at: reward.claimed_at ? new Date(reward.claimed_at) : undefined,
      }));

      const targetDates = new Set<string>();
      const updatedDaily = buildRecentDailyRewards({
        baseDate,
        amount: dailyAmount,
        baseAssetId: rewardToken,
        tfryAssetId,
        isNodeOrAem,
        existingDaily,
        targetDates,
      });

      if (updatedDaily.length === 0 && existingDaily.length === 0) {
        continue;
      }

      const preservedDaily = existingDaily.filter((reward) => !targetDates.has(reward.date));
      const combinedDaily = [...preservedDaily, ...updatedDaily];
      combinedDaily.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
      combinedDaily.forEach((reward, index) => {
        reward.reward_number = index + 1;
      });

      const existingWeekly = cloneWeeklyRewards(existing?.weekly_rewards ?? []);
      
      // Generate weekly aggregations for the seeded period
      const weeklyRewards = generateWeeklyAggregations({
        dailyRewards: updatedDaily,
        existingWeekly,
        now: runTimestamp,
      });
      
      const totalPending = round2(
        sumRewardsByStatus(combinedDaily, ['aggregated', 'pending']) +
        sumWeeklyByStatus(weeklyRewards, ['pending'])
      );
      const totalClaimable = round2(
        sumRewardsByStatus(combinedDaily, ['claimable']) +
        sumWeeklyByStatus(weeklyRewards, ['claimable'])
      );
      const totalClaimedFromWeekly = sumWeeklyByStatus(weeklyRewards, ['claimed']);
      const totalClaimed =
        typeof existing?.total_claimed === 'number'
          ? existing.total_claimed
          : round2(sumRewardsByStatus(combinedDaily, ['claimed']) + totalClaimedFromWeekly);

      const weeklyRewardCount = weeklyRewards.length;
      const firstRewardEntry = combinedDaily[0];
      const lastRewardEntry = combinedDaily[combinedDaily.length - 1];
      const firstRewardDate = determineFirstRewardDate(existing?.first_reward_date, firstRewardEntry?.created_at);

      await DeviceRewardModel.findOneAndUpdate(
        { miner_key: minerKey },
        {
          $set: {
            miner_key: minerKey,
            daily_rewards: combinedDaily,
            weekly_rewards: weeklyRewards,
            total_pending: totalPending,
            total_claimable: totalClaimable,
            total_claimed: totalClaimed,
            reward_count: combinedDaily.length,
            weekly_reward_count: weeklyRewardCount,
            first_reward_date: firstRewardDate ?? runTimestamp,
            last_reward_date: lastRewardEntry?.created_at ?? runTimestamp,
            last_updated: runTimestamp,
          },
        },
        { new: false, upsert: true, setDefaultsOnInsert: true },
      );

      stats.seeded += 1;
      stats.dailyRows += updatedDaily.length;
      stats.totalPending = round2(stats.totalPending + totalPending);
      stats.totalClaimable = round2(stats.totalClaimable + totalClaimable);

      if (stats.seeded % 100 === 0) {
        console.log(`✅ Seeded ${stats.seeded} devices (${stats.processed} processed)...`);
      }
    }

    logSummary(stats);
  } finally {
    await mongoose.disconnect().catch(() => undefined);
  }
}

function resolveProductForDevice(
  minerKey: string,
  productMap: Map<string, Product>,
): Product | undefined {
  const prefix = minerKey.split('-')[0];
  return productMap.get(prefix);
}

function resolveDailyAmount(
  device: Device,
  product: Product,
  eligibility: DeviceEligibilityResult,
  override?: number,
): number {
  if (override !== undefined) {
    return round2(override);
  }

  return round2(calculateCurrentRewardAmount(device, product, eligibility));
}

function getDeviceType(minerKey: string): 'regular' | 'node' | 'aem' {
  const prefix = minerKey.split('-')[0];
  if (prefix === 'AEM') {
    return 'aem';
  } else if (['RDN', 'SDN', 'SVN', 'CN'].includes(prefix)) {
    return 'node';
  }
  return 'regular';
}

function isDeviceCurrentlyEligible(
  device: Device,
  product: Product,
): DeviceEligibilityResult {
  const currentDate = getSimNow();
  const deviceType = getDeviceType(device.miner_key);

  try {
    switch (deviceType) {
      case 'regular': {
        if (!device.created_at || currentDate < device.created_at) {
          return {
            eligible: false,
            hasVerificationMultiplier: false,
            reason: `Device created on ${device.created_at?.toISOString()} after current date`,
          };
        }
        const hasMultiplier = device.staked?.time && currentDate >= device.staked.time;
        return {
          eligible: true,
          hasVerificationMultiplier: Boolean(hasMultiplier),
          reason: hasMultiplier ? 'Eligible with verification multiplier' : 'Eligible with base reward',
        };
      }
      case 'node': {
        if (!device.registration?.time || currentDate < device.registration.time) {
          return {
            eligible: false,
            hasVerificationMultiplier: false,
            reason: `Registration staking not completed. Registration: ${device.registration?.time?.toISOString() || 'none'}`,
          };
        }
        if (!device.node?.time || currentDate < device.node.time) {
          return {
            eligible: false,
            hasVerificationMultiplier: false,
            reason: `Node staking not completed. Node: ${device.node?.time?.toISOString() || 'none'}`,
          };
        }
        const hasMultiplier = device.staked?.time && currentDate >= device.staked.time;
        return {
          eligible: true,
          hasVerificationMultiplier: Boolean(hasMultiplier),
          reason: hasMultiplier ? 'Node eligible with verification multiplier' : 'Node eligible with base reward',
        };
      }
      case 'aem': {
        if (!device.registration?.time || currentDate < device.registration.time) {
          return {
            eligible: false,
            hasVerificationMultiplier: false,
            reason: `AEM registration staking not completed. Registration: ${device.registration?.time?.toISOString() || 'none'}`,
          };
        }
        const hasMultiplier = device.staked?.time && currentDate >= device.staked.time;
        return {
          eligible: true,
          hasVerificationMultiplier: Boolean(hasMultiplier),
          reason: hasMultiplier ? 'AEM eligible with verification multiplier' : 'AEM eligible with base reward',
        };
      }
      default: {
        return {
          eligible: false,
          hasVerificationMultiplier: false,
          reason: `Unknown device type: ${deviceType}`,
        };
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      eligible: false,
      hasVerificationMultiplier: false,
      reason: `Eligibility check failed: ${message}`,
    };
  }
}

function calculateCurrentRewardAmount(
  device: Device,
  product: Product,
  eligibilityResult: DeviceEligibilityResult,
): number {
  if (!eligibilityResult.eligible) {
    return 0;
  }

  let rewardAmount = 0;

  if (eligibilityResult.hasVerificationMultiplier && device.verified) {
    switch (device.staked?.type) {
      case 'one':
        rewardAmount = Math.round(product.reward.verified * 100 * 1.5) / 100;
        break;
      case 'two':
        rewardAmount = Math.round(product.reward.verified * 100 * 3.0) / 100;
        break;
      default:
        rewardAmount = product.reward.verified;
        break;
    }
  } else {
    rewardAmount = product.reward.verified;
  }

  if (device.byod !== undefined && device.byod.length > 0) {
    rewardAmount = Math.round((rewardAmount / 2) * 100) / 100;
  }

  return rewardAmount;
}

function buildRecentDailyRewards(params: {
  baseDate: Date;
  amount: number;
  baseAssetId: string;
  tfryAssetId: string;
  isNodeOrAem: boolean;
  existingDaily: Array<DailyRewardPayload>;
  targetDates: Set<string>;
}): DailyRewardPayload[] {
  const {
    baseDate,
    amount,
    baseAssetId,
    tfryAssetId,
    isNodeOrAem,
    existingDaily,
    targetDates,
  } = params;

  const rewards: DailyRewardPayload[] = [];
  const existingByDate = new Map<string, DailyRewardPayload[]>();
  existingDaily.forEach((reward) => {
    const key = reward.date;
    const list = existingByDate.get(key) ?? [];
    list.push(reward);
    existingByDate.set(key, list);
  });

  for (let dayIndex = 0; dayIndex < 30; dayIndex += 1) {
    const dayOffset = 29 - dayIndex;
    const entryDate = new Date(baseDate.getTime() - dayOffset * DAY_MS);
    const dateString = formatDate(entryDate);
    targetDates.add(dateString);

    const status = computeDailyStatus(dayOffset);
    // Asset ID rules:
    // - Nodes/AEM: use configured device token (fNode: 2485202024)
    // - All other miners: always use tFRY (2681521901)
    const assetId = isNodeOrAem ? baseAssetId : tfryAssetId;
    const createdAt = computeCreatedAt(entryDate);

    const existingEntryList = existingByDate.get(dateString);
    const existingEntry = existingEntryList?.shift();

    const payload: DailyRewardPayload = {
      _id: existingEntry?._id ?? new Types.ObjectId(),
      date: dateString,
      amount,
      status,
      asset_id: assetId,
      created_at: createdAt,
      reward_number: existingEntry?.reward_number ?? 0,
    };

    if (status === 'claimed' && existingEntry?.claimed_at) {
      payload.claimed_at = existingEntry.claimed_at;
    }
    if (status === 'claimed' && existingEntry?.tx_id) {
      payload.tx_id = existingEntry.tx_id;
    }

    rewards.push(payload);
  }

  return rewards;
}

function computeDailyStatus(daysAgo: number): DailyStatus {
  // Status distribution for 30 days:
  // - Days 0-15 (last 16 days): pending (remain in daily collection)
  // - Days 16-29 (oldest 14 days): aggregated (rolled into weekly entries)
  if (daysAgo <= 15) {
    return 'pending';
  }
  return 'aggregated';
}

function generateWeeklyAggregations(params: {
  dailyRewards: DailyRewardPayload[];
  existingWeekly: WeeklyRewardPayload[];
  now: Date;
}): WeeklyRewardPayload[] {
  const { dailyRewards, existingWeekly, now } = params;
  const thirtyDaysAgo = addDays(startOfUtcDay(now), -30);

  // Update existing weekly rewards: anything more than 30 days old becomes claimable
  const normalizedExisting = existingWeekly.map<WeeklyRewardPayload>((reward) => {
    if (reward.status === 'claimed') {
      return reward;
    }
    const status: WeeklyRewardPayload['status'] =
      reward.week_end <= thirtyDaysAgo ? 'claimable' : 'pending';
    return { ...reward, status };
  });

  // Filter to only aggregated rewards for weekly aggregation
  const aggregatedRewards = dailyRewards.filter((r) => r.status === 'aggregated');
  
  if (aggregatedRewards.length === 0) {
    return normalizedExisting;
  }
  
  // Group aggregated rewards by week (Friday-Thursday)
  const weekMap = new Map<string, { rewards: DailyRewardPayload[]; weekStart: Date }>();
  
  aggregatedRewards.forEach((reward) => {
    const rewardDate = new Date(reward.date);
    const weekStart = getWeekStart(rewardDate);
    const weekKey = formatDate(weekStart);
    
    if (!weekMap.has(weekKey)) {
      weekMap.set(weekKey, { rewards: [], weekStart });
    }
    weekMap.get(weekKey)!.rewards.push(reward);
  });

  // Create weekly aggregation entries
  const newWeeklyRewards: WeeklyRewardPayload[] = [];
  let weeklyRewardNumber = normalizedExisting.length;
  
  // Sort weeks chronologically
  const sortedWeeks = Array.from(weekMap.entries()).sort(
    (a, b) => a[1].weekStart.getTime() - b[1].weekStart.getTime(),
  );
  
  sortedWeeks.forEach(([weekKey, { rewards, weekStart }]) => {
    weeklyRewardNumber += 1;
    
    const weekEnd = new Date(weekStart);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
    weekEnd.setUTCHours(23, 59, 59, 999);
    
    const unlockAt = new Date(weekStart);
    unlockAt.setUTCDate(unlockAt.getUTCDate() + 7);
    unlockAt.setUTCHours(0, 5, 0, 0);
    
    // Sum amounts and use the first reward's asset_id
    const totalAmount = rewards.reduce((sum, r) => sum + r.amount, 0);
    const assetId = rewards[0].asset_id;
    
    const status: WeeklyRewardPayload['status'] =
      weekEnd <= thirtyDaysAgo ? 'claimable' : 'pending';

    newWeeklyRewards.push({
      _id: new Types.ObjectId(),
      week_start: weekStart,
      week_end: weekEnd,
      unlock_at: unlockAt,
      status,
      asset_id: assetId,
      amount: round2(totalAmount),
      created_at: unlockAt,
      reward_number: weeklyRewardNumber,
    });
  });
  
  // Combine existing and new weekly rewards
  return [...normalizedExisting, ...newWeeklyRewards];
}

function getWeekStart(date: Date): Date {
  // Get the Friday that starts the week containing this date
  // Week runs Friday 00:00:00 to Thursday 23:59:59
  const dayOfWeek = date.getUTCDay(); // 0 = Sunday, 5 = Friday
  const daysFromFriday = (dayOfWeek + 2) % 7; // Days since last Friday
  
  const weekStart = new Date(date);
  weekStart.setUTCDate(weekStart.getUTCDate() - daysFromFriday);
  weekStart.setUTCHours(0, 0, 0, 0);
  
  return weekStart;
}

function computeCreatedAt(entryDate: Date): Date {
  return new Date(Date.UTC(
    entryDate.getUTCFullYear(),
    entryDate.getUTCMonth(),
    entryDate.getUTCDate(),
    7,
    15,
    0,
    0,
  ));
}

function determineFirstRewardDate(existingDate?: Date, newDate?: Date): Date | undefined {
  if (!existingDate) {
    return newDate;
  }
  if (!newDate) {
    return existingDate;
  }
  return existingDate <= newDate ? existingDate : newDate;
}

function cloneWeeklyRewards(
  weekly: DeviceReward['weekly_rewards'],
): WeeklyRewardPayload[] {
  return weekly.map((reward) => ({
    _id: resolveObjectId(reward),
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

function sumWeeklyByStatus(
  rewards: WeeklyRewardPayload[],
  statuses: Array<'pending' | 'claimable' | 'claimed'>,
): number {
  const statusSet = new Set(statuses);
  return rewards
    .filter((reward) => statusSet.has(reward.status))
    .reduce((total, reward) => total + reward.amount, 0);
}

function resolveObjectId(value: unknown): Types.ObjectId | undefined {
  const candidate = (value as { _id?: unknown })?._id;
  if (!candidate) return undefined;
  if (candidate instanceof Types.ObjectId) return candidate;
  try { return new Types.ObjectId(String(candidate)); } catch { return undefined; }
}

function logSummary(stats: SeedStats): void {
  console.log('\n===== Reward Seeding Summary =====');
  console.log(`Processed devices : ${stats.processed}`);
  console.log(`Eligible devices  : ${stats.eligible}`);
  console.log(`Seeded devices    : ${stats.seeded}`);
  console.log(`Daily rows seeded : ${stats.dailyRows}`);
  console.log(`Total pending     : ${stats.totalPending}`);
  console.log(`Total claimable   : ${stats.totalClaimable}`);

  console.log('\nSkipped devices:');
  console.log(`  No product config        : ${stats.skipped.noProduct}`);
  console.log(`  No reward token configured: ${stats.skipped.noRewardToken}`);
  console.log(`  Failed eligibility check : ${stats.skipped.notEligible}`);
  console.log(`  Missing reward wallet    : ${stats.skipped.noWallet}`);
  console.log(`  Registration mismatch    : ${stats.skipped.registrationMismatch}`);
  console.log(`  Node staking mismatch    : ${stats.skipped.nodeMismatch}`);
  console.log(`  Invalid reward amount    : ${stats.skipped.invalidAmount}`);
  console.log('=================================\n');
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
  _id?: Types.ObjectId;
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
  _id?: Types.ObjectId;
};

function printUsage(): void {
  console.log('Usage: npx ts-node src/scripts/grant-recent-rewards.ts [options]\n');
  console.log('Options:');
  console.log('  --amount <value>   Override daily reward amount for all devices');
  console.log('  --miner <key>      Process only the specified miner key');
  console.log('  --start-date <ISO> Seed 30 days ending 29 days after YYYY-MM-DD (earliest day equals start-date)');
  console.log('  --help             Show this message');
}

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
    } else if (arg.startsWith('--miner=')) {
      const raw = arg.split('=')[1];
      const value = raw?.trim();
      if (!value) {
        throw new Error('Missing value for --miner');
      }
      options.minerKey = value.toUpperCase();
    } else if (arg === '--miner') {
      const raw = argv[i + 1];
      const value = raw?.trim();
      if (!value) {
        throw new Error('Missing value for --miner');
      }
      options.minerKey = value.toUpperCase();
      i += 1;
    } else if (arg.startsWith('--start-date=')) {
      const raw = arg.split('=')[1];
      options.startDate = parseStartDate(raw);
    } else if (arg === '--start-date') {
      const raw = argv[i + 1];
      options.startDate = parseStartDate(raw);
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
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

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

function sumRewardsByStatus(
  rewards: DailyRewardPayload[],
  statuses: DailyStatus | DailyStatus[],
): number {
  const set = Array.isArray(statuses) ? new Set(statuses) : new Set<DailyStatus>([statuses]);
  return rewards
    .filter((reward) => set.has(reward.status))
    .reduce((total, reward) => total + reward.amount, 0);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseStartDate(raw?: string): Date {
  if (!raw) {
    throw new Error('Missing value for --start-date');
  }
  const trimmed = raw.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) {
    throw new Error(`Invalid start date format '${raw}'. Use YYYY-MM-DD.`);
  }
  const [ , yearStr, monthStr, dayStr ] = match;
  const date = new Date(Date.UTC(Number(yearStr), Number(monthStr) - 1, Number(dayStr)));
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Unable to parse start date '${raw}'.`);
  }
  return date;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

main().catch((error) => {
  console.error('❌ Failed to seed rewards:', error.message ?? error);
  if (process.env.DEBUG === 'true') {
    console.error(error);
  }
  process.exitCode = 1;
});
