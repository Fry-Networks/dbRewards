/**
 * Legacy Fry (Fry 1.0) → tFry conversion utility.
 *
 * What this script does:
 * 1. Creates a full JSON backup of every `device-rewards` document.
 * 2. Phase 1 (Snapshot): populates the new asset-specific totals (`legacy_fry_*`, `tfry_*`)
 *    for all devices so historical Fry 1.0 balances are preserved.
 * 3. Phase 2 (Conversion): rewrites any pending/claimable/aggregated Legacy Fry rewards
 *    to tFry, recalculating amounts based on original reward dates while keeping snapshots.
 *
 * Usage:
 *   npm run convert-legacy-fry -- [options]
 *
 * Options:
 *   --dry-run        Perform both phases without writing changes (logs preview actions).
 *   --snapshot-only  Run only Phase 1 (takes snapshots, skips conversion).
 *   --skip-snapshot  Bypass Phase 1 and run conversion only (use with caution).
 *   --restore-backup <path>
 *                    Restore the device-rewards collection from a JSON backup produced
 *                    by this script. Prompts for confirmation before overwriting data.
 *
 * Examples:
 *   npm run convert-legacy-fry -- --dry-run
 *   npm run convert-legacy-fry -- --snapshot-only
 *   npm run convert-legacy-fry -- --skip-snapshot
 *   npm run convert-legacy-fry -- --restore-backup backups/legacy-fry/device-rewards-backup-2025-01-01T00-00-00-000Z.json
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { DeviceModel } from '../db/devices-schema';
import { DeviceRewardModel, type DeviceReward } from '../db/device-rewards-schema';
import { ProductModel, type Product } from '../db/products-schema';
import { getSimNow } from '../time-control';

const LEGACY_FRY_ASSET_ID = '924268058';
const TFRY_ASSET_ID = '2681521901';
const DAY_MS = 24 * 60 * 60 * 1000;

const DAILY_STATUSES_TO_CONVERT = new Set<DeviceReward['daily_rewards'][number]['status']>([
  'pending',
  'claimable',
  'aggregated',
]);
const WEEKLY_STATUSES_TO_CONVERT = new Set<DeviceReward['weekly_rewards'][number]['status']>([
  'pending',
  'claimable',
]);

function hasLegacyRewards(rewardDoc: DeviceReward): boolean {
  const daily = rewardDoc.daily_rewards ?? [];
  const weekly = rewardDoc.weekly_rewards ?? [];
  const statusSet = new Set([
    ...Array.from(DAILY_STATUSES_TO_CONVERT),
    ...Array.from(WEEKLY_STATUSES_TO_CONVERT),
  ]);
  return (
    daily.some(
      (entry) =>
        entry.asset_id === LEGACY_FRY_ASSET_ID && statusSet.has(entry.status as typeof entry.status),
    ) ||
    weekly.some(
      (entry) =>
        entry.asset_id === LEGACY_FRY_ASSET_ID && statusSet.has(entry.status as typeof entry.status),
    )
  );
}

type ScriptOptions = {
  dryRun: boolean;
  skipSnapshot: boolean;
  snapshotOnly: boolean;
  restoreBackupPath?: string | null;
};

type SnapshotCounters = {
  processed: number;
  updated: number;
  devicesWithLegacy: number;
  legacyTotal: number;
  tfryTotal: number;
  skippedMissingDevice: number;
  skippedNodes: number;
  skippedAems: number;
  dryRunPreviews: number;
};

type ConversionCounters = {
  examined: number;
  updated: number;
  skippedNoDevice: number;
  skippedNoProduct: number;
  skippedNodes: number;
  skippedAems: number;
  skippedInvalidAmount: number;
  skippedNoLegacy: number;
  skippedNoChanges: number;
  dailyEntriesUpdated: number;
  weeklyEntriesUpdated: number;
  dryRunPreviews: number;
};

type SnapshotValues = {
  legacy: {
    claimed: number;
    pending: number;
    claimable: number;
    aggregated: number;
    total: number;
  };
  tfry: {
    claimed: number;
    pending: number;
    claimable: number;
    aggregated: number;
    total: number;
  };
};

type WithdrawalRecord = {
  amount?: number;
  txId?: string;
  time?: Date | string;
  asset_id?: string;
};

type ConversionStakeInfo = {
  type?: string;
  amount?: number;
  time?: Date | string;
  rewarded_time?: Date | string;
  asset_id?: string;
  lastWithdrawal?: WithdrawalRecord;
  withdrawals?: WithdrawalRecord[];
};

type ConversionDevice = {
  miner_key: string;
  verified?: boolean;
  staked?: ConversionStakeInfo;
  byod?: unknown;
};

type DailyRewardEntry = DeviceReward['daily_rewards'][number];
type WeeklyRewardEntry = DeviceReward['weekly_rewards'][number];

type DailyConversionResult = {
  rewards: DailyRewardEntry[];
  changes: number;
  valid: boolean;
  legacyConverted: {
    pending: number;
    claimable: number;
    aggregated: number;
  };
};

type WeeklyRewardWithMeta = WeeklyRewardEntry & {
  __convertedFromLegacy?: boolean;
};

type WeeklyConversionResult = {
  rewards: WeeklyRewardWithMeta[];
  changes: number;
  valid: boolean;
  legacyConverted: {
    pending: number;
    claimable: number;
  };
};

async function main(): Promise<void> {
  normalizeMongoEnv();
  const options = parseOptions(process.argv.slice(2));

  const uri = process.env.VER_MONGO_URI;
  if (!uri) {
    throw new Error('VER_MONGO_URI must be set to run this script');
  }

  await mongoose.connect(uri, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 8_000,
    socketTimeoutMS: 60_000,
    retryReads: true,
    retryWrites: true,
  });

  try {
    if (options.restoreBackupPath) {
      await restoreFromBackup(options.restoreBackupPath);
      return;
    }

    const productMap = await loadProductMap();
    const backupPath = await backupDeviceRewards();
    console.log(`📦 Device rewards backup created at ${backupPath}`);

    const deviceMap = await loadDeviceMap();
    const totalDocs = await DeviceRewardModel.estimatedDocumentCount();
    console.log(`📚 Total device-rewards documents : ${totalDocs.toLocaleString()}`);

    if (!options.skipSnapshot) {
      const snapshotStats = await runSnapshotPhase(options, deviceMap);
      logSnapshotSummary(snapshotStats, options.dryRun);
      if (options.snapshotOnly) {
        return;
      }
    } else {
      console.log('⚠️ Skipping snapshot phase (per CLI flag).');
      if (options.snapshotOnly) {
        console.log('ℹ️ Snapshot-only requested but snapshot phase skipped; exiting.');
        return;
      }
    }

    const conversionStats = await runConversionPhase(options, productMap, deviceMap);
    logConversionSummary(conversionStats, options.dryRun);
  } finally {
    await mongoose.disconnect().catch(() => undefined);
  }
}

function parseOptions(argv: string[]): ScriptOptions {
  const options: ScriptOptions = {
    dryRun: false,
    skipSnapshot: false,
    snapshotOnly: false,
    restoreBackupPath: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--skip-snapshot') {
      options.skipSnapshot = true;
    } else if (arg === '--snapshot-only') {
      options.snapshotOnly = true;
      options.skipSnapshot = false;
    } else if (arg === '--restore-backup') {
      const next = argv[i + 1];
      if (!next) {
        throw new Error('--restore-backup requires a file path argument');
      }
      options.restoreBackupPath = next;
      i += 1;
    } else if (arg.startsWith('--restore-backup=')) {
      const value = arg.split('=', 2)[1];
      if (!value) {
        throw new Error('--restore-backup requires a file path argument');
      }
      options.restoreBackupPath = value;
    }
  }

  if (options.restoreBackupPath) {
    // Restore mode ignores transformation options
    options.dryRun = false;
    options.skipSnapshot = false;
    options.snapshotOnly = false;
  }

  return options;
}

async function loadProductMap(): Promise<Map<string, Product>> {
  const products = await ProductModel.find({});
  const map = new Map<string, Product>();
  products.forEach((doc) => {
    map.set(doc.key, doc.toObject<Product>());
  });
  if (map.size === 0) {
    throw new Error('No product configurations found');
  }
  return map;
}

async function loadDeviceMap(): Promise<Map<string, ConversionDevice>> {
  const devices = (await DeviceModel.find({}).lean().exec()) as ConversionDevice[];
  const map = new Map<string, ConversionDevice>();

  devices.forEach((device) => {
    const key = device.miner_key?.toUpperCase();
    if (key) {
      map.set(key, { ...device, miner_key: key } as ConversionDevice);
    }
  });

  if (map.size === 0) {
    throw new Error('No devices found to support conversion');
  }

  return map;
}

async function runSnapshotPhase(
  options: ScriptOptions,
  deviceMap: Map<string, ConversionDevice>,
): Promise<SnapshotCounters> {
  console.log(options.dryRun ? '🔍 Phase 1: Snapshot (dry run)' : '📊 Phase 1: Snapshot');

  const cursor = DeviceRewardModel.find({})
    .lean<DeviceReward>()
    .cursor();

  const stats: SnapshotCounters = {
    processed: 0,
    updated: 0,
    devicesWithLegacy: 0,
    legacyTotal: 0,
    tfryTotal: 0,
    skippedMissingDevice: 0,
    skippedNodes: 0,
    skippedAems: 0,
    dryRunPreviews: 0,
  };

  for await (const rewardDoc of cursor as AsyncIterable<DeviceReward>) {
    const minerKey = rewardDoc.miner_key.toUpperCase();
    const device = deviceMap.get(minerKey);

    if (!device) {
      if (stats.skippedMissingDevice > 5) {
        console.warn(
          `⚠️  Snapshot skip: device record not found for ${minerKey} (reward doc ${rewardDoc._id})`,
        );
      }
      stats.skippedMissingDevice += 1;
      continue;
    }

    const deviceType = getDeviceType(minerKey);
    if (deviceType === 'node') {
      stats.skippedNodes += 1;
      continue;
    }
    if (deviceType === 'aem') {
      stats.skippedAems += 1;
      continue;
    }

    if (!hasLegacyRewards(rewardDoc)) {
      continue;
    }

    stats.processed += 1;

    const snapshot = computeSnapshots(rewardDoc);
    stats.legacyTotal += snapshot.legacy.total;
    stats.tfryTotal += snapshot.tfry.total;
    if (snapshot.legacy.total > 0) {
      stats.devicesWithLegacy += 1;
    }

    const payload = {
      legacy_fry_claimed: snapshot.legacy.claimed,
      legacy_fry_pending: snapshot.legacy.pending,
      legacy_fry_claimable: snapshot.legacy.claimable,
      legacy_fry_aggregated: snapshot.legacy.aggregated,
      legacy_fry_total: snapshot.legacy.total,
      legacy_fry_claimed_snapshot:
        typeof rewardDoc.legacy_fry_claimed_snapshot === 'number' && rewardDoc.legacy_fry_claimed_snapshot > 0
          ? round2(Number(rewardDoc.legacy_fry_claimed_snapshot))
          : snapshot.legacy.claimed,
      legacy_fry_claimed_converted:
        typeof rewardDoc.legacy_fry_claimed_converted === 'boolean'
          ? rewardDoc.legacy_fry_claimed_converted
          : false,
      tfry_claimed: snapshot.tfry.claimed,
      tfry_pending: snapshot.tfry.pending,
      tfry_claimable: snapshot.tfry.claimable,
      tfry_aggregated: snapshot.tfry.aggregated,
      tfry_total: snapshot.tfry.total,
    };

    const rewardDocRecord = rewardDoc as unknown as Record<string, unknown>;
    const needsUpdate = Object.entries(payload).some(([key, value]) => {
      const current = round2(Number(rewardDocRecord[key] ?? 0));
      return current !== value;
    });

    if (!needsUpdate) {
      continue;
    }

    stats.updated += 1;
    if (options.dryRun) {
      if (stats.dryRunPreviews < 5) {
        console.log(
          `  [dry-run] Would snapshot ${rewardDoc.miner_key}: legacy_total=${snapshot.legacy.total} tfry_total=${snapshot.tfry.total}`,
        );
        stats.dryRunPreviews += 1;
      }
      continue;
    }

    await DeviceRewardModel.updateOne({ _id: rewardDoc._id }, { $set: payload }).exec();
  }

  return stats;
}

function computeSnapshots(rewardDoc: DeviceReward): SnapshotValues {
  const dailyRewards = rewardDoc.daily_rewards ?? [];
  const weeklyRewards = rewardDoc.weekly_rewards ?? [];

  const legacyClaimed =
    sumDailyByAssetAndStatuses(dailyRewards, LEGACY_FRY_ASSET_ID, ['claimed']) +
    sumWeeklyByAssetAndStatuses(weeklyRewards, LEGACY_FRY_ASSET_ID, ['claimed']);
  const legacyPending =
    sumDailyByAssetAndStatuses(dailyRewards, LEGACY_FRY_ASSET_ID, ['pending']) +
    sumWeeklyByAssetAndStatuses(weeklyRewards, LEGACY_FRY_ASSET_ID, ['pending']);
  const legacyClaimable =
    sumDailyByAssetAndStatuses(dailyRewards, LEGACY_FRY_ASSET_ID, ['claimable']) +
    sumWeeklyByAssetAndStatuses(weeklyRewards, LEGACY_FRY_ASSET_ID, ['claimable']);
  const legacyAggregated = sumDailyByAssetAndStatuses(dailyRewards, LEGACY_FRY_ASSET_ID, ['aggregated']);

  const tfryClaimed =
    sumDailyByAssetAndStatuses(dailyRewards, TFRY_ASSET_ID, ['claimed']) +
    sumWeeklyByAssetAndStatuses(weeklyRewards, TFRY_ASSET_ID, ['claimed']);
  const tfryPending =
    sumDailyByAssetAndStatuses(dailyRewards, TFRY_ASSET_ID, ['pending']) +
    sumWeeklyByAssetAndStatuses(weeklyRewards, TFRY_ASSET_ID, ['pending']);
  const tfryClaimable =
    sumDailyByAssetAndStatuses(dailyRewards, TFRY_ASSET_ID, ['claimable']) +
    sumWeeklyByAssetAndStatuses(weeklyRewards, TFRY_ASSET_ID, ['claimable']);
  const tfryAggregated = 0;

  const legacyTotal = round2(legacyClaimed + legacyPending + legacyClaimable + legacyAggregated);
  const tfryTotal = round2(tfryClaimed + tfryPending + tfryClaimable + tfryAggregated);

  return {
    legacy: {
      claimed: round2(legacyClaimed),
      pending: round2(legacyPending),
      claimable: round2(legacyClaimable),
      aggregated: round2(legacyAggregated),
      total: legacyTotal,
    },
    tfry: {
      claimed: round2(tfryClaimed),
      pending: round2(tfryPending),
      claimable: round2(tfryClaimable),
      aggregated: round2(tfryAggregated),
      total: tfryTotal,
    },
  };
}

async function runConversionPhase(
  options: ScriptOptions,
  productMap: Map<string, Product>,
  deviceMap: Map<string, ConversionDevice>,
): Promise<ConversionCounters> {
  console.log(options.dryRun ? '🧪 Phase 2: Conversion (dry run)' : '⚙️ Phase 2: Conversion');

  const cursor = DeviceRewardModel.find({})
    .lean<DeviceReward>()
    .cursor();

  const stats: ConversionCounters = {
    examined: 0,
    updated: 0,
    skippedNoDevice: 0,
    skippedNoProduct: 0,
    skippedNodes: 0,
    skippedAems: 0,
    skippedInvalidAmount: 0,
    skippedNoLegacy: 0,
    skippedNoChanges: 0,
    dailyEntriesUpdated: 0,
    weeklyEntriesUpdated: 0,
    dryRunPreviews: 0,
  };

  const runTimestamp = getSimNow();

  for await (const rewardDoc of cursor as AsyncIterable<DeviceReward>) {
    const minerKey = rewardDoc.miner_key.toUpperCase();
    const device = deviceMap.get(minerKey);
    if (!device) {
      stats.skippedNoDevice += 1;
      continue;
    }

    const deviceType = getDeviceType(minerKey);
    if (deviceType === 'node') {
      stats.skippedNodes += 1;
      continue;
    }
    if (deviceType === 'aem') {
      stats.skippedAems += 1;
      continue;
    }

    const product = resolveProductForDevice(minerKey, productMap);
    if (!product) {
      stats.skippedNoProduct += 1;
      continue;
    }

    if (!hasLegacyRewards(rewardDoc)) {
      stats.skippedNoLegacy += 1;
      continue;
    }

    stats.examined += 1;

    const dailyResult = convertDailyRewards(rewardDoc.daily_rewards ?? [], device, product);
    if (!dailyResult.valid) {
      stats.skippedInvalidAmount += 1;
      continue;
    }

    const weeklyResult = convertWeeklyRewards(rewardDoc.weekly_rewards ?? [], device, product);
    if (!weeklyResult.valid) {
      stats.skippedInvalidAmount += 1;
      continue;
    }

    const mergedWeekly = mergeWeeklyRewards(weeklyResult.rewards);
    const mergeDifference = weeklyResult.rewards.length - mergedWeekly.length;

    if (dailyResult.changes === 0 && weeklyResult.changes === 0 && mergeDifference === 0) {
      stats.skippedNoChanges += 1;
      continue;
    }

    const updatedDaily = sortAndRenumberDaily(dailyResult.rewards);
    const finalWeekly = renumberWeekly(mergedWeekly);

    const legacyPendingConverted = round2(
      dailyResult.legacyConverted.pending + weeklyResult.legacyConverted.pending,
    );
    const legacyClaimableConverted = round2(
      dailyResult.legacyConverted.claimable + weeklyResult.legacyConverted.claimable,
    );
    const legacyAggregatedConverted = round2(dailyResult.legacyConverted.aggregated);

    const startingLegacyPending = Number(rewardDoc.legacy_fry_pending ?? 0);
    const startingLegacyClaimable = Number(rewardDoc.legacy_fry_claimable ?? 0);
    const legacyAggregatedSnapshot = Number(rewardDoc.legacy_fry_aggregated ?? 0);
    const legacyClaimedSnapshot = Number(rewardDoc.legacy_fry_claimed ?? 0);
    const legacyTotalSnapshot = Number(rewardDoc.legacy_fry_total ?? 0);

    const newLegacyPending = Math.max(0, round2(startingLegacyPending - legacyPendingConverted));
    const newLegacyClaimable = Math.max(0, round2(startingLegacyClaimable - legacyClaimableConverted));
    // Legacy aggregated balance should reflect whatever legacy reward rows still exist after conversion,
    // so we subtract the amount we just transformed into tFRY instead of wholesale zeroing the field.
    const newLegacyAggregated = Math.max(
      0,
      round2(legacyAggregatedSnapshot - legacyAggregatedConverted),
    );
    // Preserve the original legacy total snapshot if it was captured pre-conversion; otherwise fall back
    // to recomputing from the remaining legacy breakdown.
    const legacyTotal = round2(
      legacyTotalSnapshot > 0
        ? legacyTotalSnapshot
        : legacyClaimedSnapshot + newLegacyPending + newLegacyClaimable + newLegacyAggregated,
    );

    const tfryPending = round2(
      sumDailyByAssetAndStatuses(updatedDaily, TFRY_ASSET_ID, ['pending']) +
        sumWeeklyByAssetAndStatuses(finalWeekly, TFRY_ASSET_ID, ['pending']),
    );
    const tfryClaimable = round2(
      sumDailyByAssetAndStatuses(updatedDaily, TFRY_ASSET_ID, ['claimable']) +
        sumWeeklyByAssetAndStatuses(finalWeekly, TFRY_ASSET_ID, ['claimable']),
    );
    // Aggregated daily rows are placeholders for historical audit; suppress them in the live totals
    // so we rely solely on the weekly reward entries for tFRY balances.
    const tfryAggregated = 0;
    const tfryClaimed = round2(
      sumDailyByAssetAndStatuses(updatedDaily, TFRY_ASSET_ID, ['claimed']) +
        sumWeeklyByAssetAndStatuses(finalWeekly, TFRY_ASSET_ID, ['claimed']),
    );
    const tfryTotal = round2(tfryClaimed + tfryPending + tfryClaimable + tfryAggregated);

    const updatePayload = {
      miner_key: minerKey,
      daily_rewards: updatedDaily,
      weekly_rewards: finalWeekly,
      legacy_fry_claimed_snapshot:
        typeof rewardDoc.legacy_fry_claimed_snapshot === 'number'
          ? round2(Number(rewardDoc.legacy_fry_claimed_snapshot))
          : legacyClaimedSnapshot,
      legacy_fry_claimed_converted:
        typeof rewardDoc.legacy_fry_claimed_converted === 'boolean'
          ? rewardDoc.legacy_fry_claimed_converted
          : false,
      legacy_fry_pending: newLegacyPending,
      legacy_fry_claimable: newLegacyClaimable,
      legacy_fry_aggregated: newLegacyAggregated,
      legacy_fry_total: legacyTotal,
      tfry_pending: tfryPending,
      tfry_claimable: tfryClaimable,
      tfry_aggregated: tfryAggregated,
      tfry_claimed: tfryClaimed,
      tfry_total: tfryTotal,
      total_pending: tfryPending,
      total_claimable: tfryClaimable,
      total_claimed: tfryClaimed,
      last_updated: runTimestamp,
    };

    stats.updated += 1;
    stats.dailyEntriesUpdated += dailyResult.changes;
    stats.weeklyEntriesUpdated += weeklyResult.changes + (mergeDifference > 0 ? mergeDifference : 0);

    if (options.dryRun) {
      if (stats.dryRunPreviews < 5) {
        console.log(
          `  [dry-run] Would convert ${minerKey}: daily=${dailyResult.changes}, weekly=${weeklyResult.changes}, tfry_total=${tfryTotal}`,
        );
        stats.dryRunPreviews += 1;
      }
      continue;
    }

    await DeviceRewardModel.updateOne({ _id: rewardDoc._id }, { $set: updatePayload }).exec();
  }

  return stats;
}

function convertDailyRewards(
  rewards: DailyRewardEntry[],
  device: ConversionDevice,
  product: Product,
): DailyConversionResult {
  const normalized = (rewards ?? []).map(normalizeDaily);
  const converted: DailyRewardEntry[] = [];
  let changes = 0;
  const legacyTotals = {
    pending: 0,
    claimable: 0,
    aggregated: 0,
  };

  for (const entry of normalized) {
    if (!DAILY_STATUSES_TO_CONVERT.has(entry.status) || !isLegacyAsset(entry.asset_id)) {
      converted.push(entry);
      continue;
    }

    const referenceDate = getDailyReferenceDate(entry);
    if (!referenceDate) {
      return { rewards: normalized, changes: 0, valid: false, legacyConverted: legacyTotals };
    }

    const newAmount = calculateRewardAmount(device, product, referenceDate);
    if (!isValidAmount(newAmount)) {
      return { rewards: normalized, changes: 0, valid: false, legacyConverted: legacyTotals };
    }

    const legacyAmount = Number(entry.amount ?? 0);
    if (entry.status === 'pending') {
      legacyTotals.pending += legacyAmount;
    } else if (entry.status === 'claimable') {
      legacyTotals.claimable += legacyAmount;
    } else if (entry.status === 'aggregated') {
      legacyTotals.aggregated += legacyAmount;
    }

    converted.push({
      ...entry,
      asset_id: TFRY_ASSET_ID,
      amount: newAmount,
    });
    changes += 1;
  }

  return {
    rewards: converted,
    changes,
    valid: true,
    legacyConverted: {
      pending: round2(legacyTotals.pending),
      claimable: round2(legacyTotals.claimable),
      aggregated: round2(legacyTotals.aggregated),
    },
  };
}

function convertWeeklyRewards(
  rewards: WeeklyRewardEntry[],
  device: ConversionDevice,
  product: Product,
): WeeklyConversionResult {
  const normalized = (rewards ?? []).map((entry) => ({
    ...normalizeWeekly(entry),
  })) as WeeklyRewardWithMeta[];

  const converted: WeeklyRewardWithMeta[] = [];
  let changes = 0;
  const legacyTotals = {
    pending: 0,
    claimable: 0,
  };

  for (const entry of normalized) {
    if (!WEEKLY_STATUSES_TO_CONVERT.has(entry.status) || !isLegacyAsset(entry.asset_id)) {
      converted.push(entry);
      continue;
    }

    const referenceDate = getWeeklyReferenceDate(entry);
    if (!referenceDate) {
      return { rewards: normalized, changes: 0, valid: false, legacyConverted: legacyTotals };
    }

    const dailyAmount = calculateRewardAmount(device, product, referenceDate);
    if (!isValidAmount(dailyAmount)) {
      return { rewards: normalized, changes: 0, valid: false, legacyConverted: legacyTotals };
    }

    const weeklyAmount = computeWeeklyAmount(entry.week_start, entry.week_end, dailyAmount);
    if (!isValidAmount(weeklyAmount)) {
      return { rewards: normalized, changes: 0, valid: false, legacyConverted: legacyTotals };
    }

    const legacyAmount = Number(entry.amount ?? 0);
    if (entry.status === 'pending') {
      legacyTotals.pending += legacyAmount;
    } else if (entry.status === 'claimable') {
      legacyTotals.claimable += legacyAmount;
    }

    const convertedEntry: WeeklyRewardWithMeta = {
      ...entry,
      asset_id: TFRY_ASSET_ID,
      amount: weeklyAmount,
      __convertedFromLegacy: true,
    };

    converted.push(convertedEntry);
    changes += 1;
  }

  return {
    rewards: converted,
    changes,
    valid: true,
    legacyConverted: {
      pending: round2(legacyTotals.pending),
      claimable: round2(legacyTotals.claimable),
    },
  };
}

function getDailyReferenceDate(entry: DailyRewardEntry): Date | undefined {
  if (isValidDate(entry.created_at)) {
    return new Date(entry.created_at);
  }

  if (entry.date) {
    const parsed = new Date(`${entry.date}T00:00:00Z`);
    if (isValidDate(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function getWeeklyReferenceDate(entry: WeeklyRewardEntry): Date | undefined {
  if (!isValidDate(entry.week_start)) {
    return undefined;
  }
  return new Date(entry.week_start);
}

function sortAndRenumberDaily(rewards: DailyRewardEntry[]): DailyRewardEntry[] {
  const sorted = rewards
    .map((reward) => ({
      ...reward,
      created_at: new Date(reward.created_at),
      claimed_at: reward.claimed_at ? new Date(reward.claimed_at) : undefined,
    }))
    .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());

  sorted.forEach((reward, index) => {
    reward.reward_number = index + 1;
  });

  return sorted;
}

function renumberWeekly(rewards: WeeklyRewardWithMeta[]): WeeklyRewardEntry[] {
  const result = rewards.map((reward) => {
    const { __convertedFromLegacy, ...rest } = reward;
    return {
      ...rest,
      week_start: new Date(rest.week_start),
      week_end: new Date(rest.week_end),
      unlock_at: new Date(rest.unlock_at),
      created_at: new Date(rest.created_at),
      claimed_at: rest.claimed_at ? new Date(rest.claimed_at) : undefined,
    };
  });

  result.sort((a, b) => a.week_start.getTime() - b.week_start.getTime());
  result.forEach((reward, index) => {
    reward.reward_number = index + 1;
  });

  return result;
}

function computeWeeklyAmount(weekStart: Date, weekEnd: Date, dailyAmount: number): number {
  if (!isValidDate(weekStart) || !isValidDate(weekEnd)) {
    return Number.NaN;
  }

  const spanMs = weekEnd.getTime() - weekStart.getTime();
  const daysCovered = Math.max(1, Math.floor(spanMs / DAY_MS) + 1);
  const weeklyAmount = dailyAmount * daysCovered;

  return round2(weeklyAmount);
}

function calculateRewardAmount(device: ConversionDevice, product: Product, referenceDate: Date): number {
  const baseAmount = Number.isFinite(product.reward?.verified)
    ? Number(product.reward?.verified)
    : Number(product.reward?.unverified ?? 0);

  if (!Number.isFinite(baseAmount) || baseAmount <= 0) {
    return Number.NaN;
  }

  let rewardAmount = round2(baseAmount);
  const multiplier = resolveVerificationMultiplier(device, product, referenceDate);
  rewardAmount = round2(rewardAmount * multiplier);

  if (hasByod(device)) {
    rewardAmount = round2(rewardAmount / 2);
  }

  return rewardAmount;
}

function resolveVerificationMultiplier(device: ConversionDevice, product: Product, referenceDate: Date): number {
  const stakeInfo = device.staked;
  const withdrawalTime = resolveLastWithdrawalTime(stakeInfo);

  const fallbackMultiplier = (() => {
    if (withdrawalTime && referenceDate < withdrawalTime) {
      if (stakeInfo?.type === 'one') return 1.5;
      if (stakeInfo?.type === 'two') return 3.0;
      return 3.0;
    }
    return 1;
  })();

  if (!device?.verified) {
    return fallbackMultiplier;
  }

  if (!stakeInfo?.type) {
    return fallbackMultiplier;
  }

  const activationTime = resolveStakeActivationTime(stakeInfo);
  if (!activationTime || referenceDate < activationTime) {
    return fallbackMultiplier;
  }

  const amount = Number(stakeInfo.amount ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    return fallbackMultiplier;
  }

  switch (stakeInfo.type) {
    case 'one':
      return 1.5;
    case 'two':
      return 3.0;
    default:
      return fallbackMultiplier;
  }
}

function resolveStakeActivationTime(stakeInfo: ConversionDevice['staked']): Date | undefined {
  if (!stakeInfo) {
    return undefined;
  }

  if (isValidDate(stakeInfo.rewarded_time)) {
    return new Date(stakeInfo.rewarded_time);
  }

  if (isValidDate(stakeInfo.time)) {
    return new Date(stakeInfo.time);
  }

  return undefined;
}

function getDeviceType(minerKey: string): 'regular' | 'node' | 'aem' {
  const prefix = minerKey.split('-')[0];
  if (prefix === 'AEM') {
    return 'aem';
  }
  if (['RDN', 'SDN', 'SVN', 'CN'].includes(prefix)) {
    return 'node';
  }
  return 'regular';
}

function resolveProductForDevice(minerKey: string, productMap: Map<string, Product>): Product | undefined {
  const prefix = minerKey.split('-')[0];
  return productMap.get(prefix);
}

function toDateOrUndefined(value?: Date | string): Date | undefined {
  if (!value) {
    return undefined;
  }
  if (value instanceof Date) {
    return isValidDate(value) ? value : undefined;
  }
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
  return undefined;
}

function resolveLastWithdrawalTime(stakeInfo?: ConversionStakeInfo): Date | undefined {
  if (!stakeInfo) {
    return undefined;
  }

  let latest = toDateOrUndefined(stakeInfo.lastWithdrawal?.time);

  if (Array.isArray(stakeInfo.withdrawals)) {
    for (const record of stakeInfo.withdrawals) {
      const recordTime = toDateOrUndefined(record?.time);
      if (recordTime && (!latest || recordTime > latest)) {
        latest = recordTime;
      }
    }
  }

  return latest;
}

function mergeWeeklyRewards(rewards: WeeklyRewardWithMeta[]): WeeklyRewardWithMeta[] {
  const groups = new Map<string, WeeklyRewardWithMeta[]>();
  rewards.forEach((entry) => {
    const key = `${entry.week_start.getTime()}_${entry.week_end.getTime()}`;
    const list = groups.get(key);
    if (list) {
      list.push(entry);
    } else {
      groups.set(key, [entry]);
    }
  });

  const statusPriority: Record<WeeklyRewardEntry['status'], number> = {
    pending: 0,
    claimable: 1,
    claimed: 2,
  };

  const merged: WeeklyRewardWithMeta[] = [];

  groups.forEach((entries) => {
    // Prefer the converted legacy rows for amount math; if none exist we fall back to every entry
    // recorded for this window.
    const convertedEntries = entries.filter((entry) => entry.__convertedFromLegacy);
    const baselineEntries = convertedEntries.length > 0 ? convertedEntries : entries;

    const finalAmount = round2(
      baselineEntries.reduce((sum, entry) => sum + Number(entry.amount ?? 0), 0),
    );

    // Preserve the highest-priority lifecycle status (claimed > claimable > pending) so the merged
    // entry reflects the furthest progress the window had reached.
    const statusSource = entries.reduce((best, current) => {
      const bestPriority = statusPriority[best.status] ?? 0;
      const currentPriority = statusPriority[current.status] ?? 0;
      if (currentPriority > bestPriority) {
        return current;
      }
      if (currentPriority === bestPriority) {
        return new Date(current.created_at).getTime() > new Date(best.created_at).getTime()
          ? current
          : best;
      }
      return best;
    }, entries[0]);

    const earliestCreated = entries.reduce((earliest, entry) =>
      new Date(entry.created_at).getTime() < new Date(earliest.created_at).getTime()
        ? entry
        : earliest,
    );

    const claimedSource =
      entries.find((entry) => entry.claimed_at && entry.status === statusSource.status) ??
      statusSource;

    const txSource =
      entries.find((entry) => entry.tx_id && entry.status === statusSource.status) ?? statusSource;

    const reference = convertedEntries[0] ?? statusSource ?? entries[0];

    const combined: WeeklyRewardWithMeta = {
      ...reference,
      status: statusSource.status,
      amount: finalAmount,
      asset_id: TFRY_ASSET_ID,
      created_at: earliestCreated.created_at,
      claimed_at: claimedSource.claimed_at,
      tx_id: txSource.tx_id,
      // Mark as converted if any contributor came from Legacy Fry so subsequent passes know
      // this window was part of the migration.
      __convertedFromLegacy:
        convertedEntries.length > 0 || Boolean(reference.__convertedFromLegacy),
    };

    merged.push(combined);
  });

  return merged;
}

function hasByod(device: ConversionDevice): boolean {
  const byodValue = device.byod as unknown;

  if (byodValue === undefined || byodValue === null) {
    return false;
  }

  if (typeof byodValue === 'string') {
    return byodValue.trim().length > 0;
  }

  if (Array.isArray(byodValue)) {
    return byodValue.length > 0;
  }

  return Boolean(byodValue);
}

function isLegacyAsset(assetId: unknown): boolean {
  return String(assetId) === LEGACY_FRY_ASSET_ID;
}

function sumDailyByAssetAndStatuses(
  rewards: DailyRewardEntry[],
  assetId: string,
  statuses: Array<'pending' | 'claimable' | 'aggregated' | 'accruing' | 'claimed'>,
): number {
  const statusSet = new Set(statuses);
  return rewards
    .filter((reward) => statusSet.has(reward.status) && String(reward.asset_id) === assetId)
    .reduce((total, reward) => total + Number(reward.amount ?? 0), 0);
}

function sumWeeklyByAssetAndStatuses(
  rewards: WeeklyRewardEntry[],
  assetId: string,
  statuses: Array<'pending' | 'claimable' | 'claimed'>,
): number {
  const statusSet = new Set(statuses);
  return rewards
    .filter((reward) => statusSet.has(reward.status) && String(reward.asset_id) === assetId)
    .reduce((total, reward) => total + Number(reward.amount ?? 0), 0);
}

function normalizeDaily(entry: DailyRewardEntry): DailyRewardEntry {
  return {
    ...entry,
    created_at: new Date(entry.created_at),
    claimed_at: entry.claimed_at ? new Date(entry.claimed_at) : undefined,
  };
}

function normalizeWeekly(entry: WeeklyRewardEntry): WeeklyRewardEntry {
  return {
    ...entry,
    week_start: new Date(entry.week_start),
    week_end: new Date(entry.week_end),
    unlock_at: new Date(entry.unlock_at),
    created_at: new Date(entry.created_at),
    claimed_at: entry.claimed_at ? new Date(entry.claimed_at) : undefined,
  };
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function isValidAmount(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function promptYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${question} (y/N): `, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === 'y' || normalized === 'yes');
    });
  });
}

function hydrateBackupDocument(raw: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...raw };

  const toObjectId = (value: unknown): mongoose.Types.ObjectId | undefined => {
    if (!value) return undefined;
    if (value instanceof mongoose.Types.ObjectId) return value;
    try {
      return new mongoose.Types.ObjectId(String(value));
    } catch {
      return undefined;
    }
  };

  const toDate = (value: unknown): Date | undefined => {
    if (!value) return undefined;
    if (value instanceof Date) return value;
    const parsed = new Date(value as string);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  };

  const topLevelDates = ['last_updated', 'first_reward_date', 'last_reward_date'] as const;
  topLevelDates.forEach((field) => {
    const dateValue = toDate(clone[field]);
    if (dateValue) {
      clone[field] = dateValue;
    }
  });

  if (clone._id) {
    clone._id = toObjectId(clone._id) ?? clone._id;
  }

  if (Array.isArray(clone.daily_rewards)) {
    const dailyEntries = clone.daily_rewards as unknown[];
    clone.daily_rewards = dailyEntries.map((entry) => {
      const hydratedEntry: Record<string, unknown> = { ...(entry as Record<string, unknown>) };
      if (hydratedEntry._id) {
        hydratedEntry._id = toObjectId(hydratedEntry._id) ?? hydratedEntry._id;
      }
      const dateFields = ['created_at', 'claimed_at'] as const;
      dateFields.forEach((field) => {
        const dateValue = toDate(hydratedEntry[field]);
        if (dateValue) {
          hydratedEntry[field] = dateValue;
        }
      });
      return hydratedEntry;
    });
  }

  if (Array.isArray(clone.weekly_rewards)) {
    const weeklyEntries = clone.weekly_rewards as unknown[];
    clone.weekly_rewards = weeklyEntries.map((entry) => {
      const hydratedEntry: Record<string, unknown> = { ...(entry as Record<string, unknown>) };
      if (hydratedEntry._id) {
        hydratedEntry._id = toObjectId(hydratedEntry._id) ?? hydratedEntry._id;
      }
      const dateFields = ['week_start', 'week_end', 'unlock_at', 'created_at', 'claimed_at'] as const;
      dateFields.forEach((field) => {
        const dateValue = toDate(hydratedEntry[field]);
        if (dateValue) {
          hydratedEntry[field] = dateValue;
        }
      });
      return hydratedEntry;
    });
  }

  return clone;
}

async function restoreFromBackup(filePath: string): Promise<void> {
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Backup file not found at ${resolvedPath}`);
  }

  console.log(`🛠️  Restore mode enabled. Backup source: ${resolvedPath}`);

  const confirm = await promptYesNo(
    'This will overwrite all documents in the device-rewards collection with the backup data. Continue?',
  );
  if (!confirm) {
    console.log('⛔ Restore cancelled by user.');
    return;
  }

  console.log('📦 Creating safety backup of current device-rewards collection before restore...');
  const safetyBackupPath = await backupDeviceRewards();
  console.log(`   Current state saved to ${safetyBackupPath}`);

  const fileContents = await fs.promises.readFile(resolvedPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(fileContents);
  } catch (err) {
    throw new Error(`Failed to parse backup JSON: ${(err as Error).message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Invalid backup format: expected a JSON array of documents.');
  }

  console.log(`🧹 Clearing existing device-rewards documents (${parsed.length.toLocaleString()} records to restore)...`);
  await DeviceRewardModel.deleteMany({});

  if (parsed.length === 0) {
    console.log('⚠️ Backup file contained no documents. Collection cleared, nothing to restore.');
    return;
  }

  const hydratedDocs = parsed.map((doc) => hydrateBackupDocument(doc as Record<string, unknown>));
  await DeviceRewardModel.insertMany(hydratedDocs, { ordered: false });

  console.log(`✅ Restore complete. Inserted ${hydratedDocs.length.toLocaleString()} documents from backup.`);
}

async function backupDeviceRewards(): Promise<string> {
  const backupDir = path.resolve(process.cwd(), 'backups', 'legacy-fry');
  await fs.promises.mkdir(backupDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(backupDir, `device-rewards-backup-${timestamp}.json`);

  const stream = fs.createWriteStream(filePath, { encoding: 'utf8' });
  stream.write('[\n');
  let first = true;

  const cursor = DeviceRewardModel.find({}).lean().cursor();
  for await (const doc of cursor as AsyncIterable<Record<string, unknown>>) {
    if (!first) {
      stream.write(',\n');
    } else {
      first = false;
    }
    stream.write(JSON.stringify(doc));
  }
  stream.write('\n]\n');

  await new Promise<void>((resolve, reject) => {
    stream.end((err: NodeJS.ErrnoException | null | undefined) => {
      if (err) reject(err);
      else resolve();
    });
  });

  return filePath;
}

function normalizeMongoEnv(): void {
  if (!process.env.VER_MONGO_URI && process.env.VER_MONGODB_URI) {
    process.env.VER_MONGO_URI = process.env.VER_MONGODB_URI;
  }
}

function logSnapshotSummary(stats: SnapshotCounters, dryRun: boolean): void {
  console.log('\n===== Snapshot Summary =====');
  console.log(`Documents processed        : ${stats.processed}`);
  console.log(`Documents needing update   : ${stats.updated}`);
  console.log(`Devices with Legacy Fry    : ${stats.devicesWithLegacy}`);
  console.log(`Legacy Fry total (all docs): ${round2(stats.legacyTotal)}`);
  console.log(`tFry total (all docs)      : ${round2(stats.tfryTotal)}`);
  console.log('Skipped:');
  console.log(`  Missing devices          : ${stats.skippedMissingDevice}`);
  console.log(`  Node devices             : ${stats.skippedNodes}`);
  console.log(`  AEM devices              : ${stats.skippedAems}`);
  if (dryRun) {
    console.log('Mode                       : dry run (no writes performed)');
  }
  console.log('============================\n');
}

function logConversionSummary(stats: ConversionCounters, dryRun: boolean): void {
  console.log('\n===== Conversion Summary =====');
  console.log(`Documents examined         : ${stats.examined}`);
  console.log(`Documents updated          : ${stats.updated}`);
  console.log(`Daily entries adjusted     : ${stats.dailyEntriesUpdated}`);
  console.log(`Weekly entries adjusted    : ${stats.weeklyEntriesUpdated}`);
  console.log('\nSkipped:');
  console.log(`  Missing devices          : ${stats.skippedNoDevice}`);
  console.log(`  Missing product config   : ${stats.skippedNoProduct}`);
  console.log(`  Node devices             : ${stats.skippedNodes}`);
  console.log(`  AEM devices              : ${stats.skippedAems}`);
  console.log(`  No legacy rewards        : ${stats.skippedNoLegacy}`);
  console.log(`  Invalid reward data      : ${stats.skippedInvalidAmount}`);
  console.log(`  No qualifying rewards    : ${stats.skippedNoChanges}`);
  if (dryRun) {
    console.log('Mode                       : dry run (no writes performed)');
  }
  console.log('==============================\n');
}

main().catch((error) => {
  console.error('Legacy Fry conversion failed:', error);
  process.exitCode = 1;
});
