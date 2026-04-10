/**
 * Conversion Verification CLI
 *
 * Purpose:
 *   Cross-check legacy Fry → tFRY conversion results by diffing the same miner/device
 *   across two MongoDB environments (typically "before" and "after" databases).
 *
 * Workflow:
 *   1. Reads SOURCE_MONGO_URI (pre-conversion) and DEST_MONGO_URI (post-conversion) from
 *      environment variables or CLI flags; no typing required once .env is configured.
 *   2. Opens interactive prompt where you can:
 *        - enter comma-separated miner keys,
 *        - load keys from a file using the syntax `@path/to/file.txt` (one key per line),
 *        - scan every miner in the destination DB using `ALL`,
 *        - type `EXIT` to quit and write a JSON audit report.
 *   3. For each requested miner it compares:
 *        - legacy Fry snapshots vs. raw asset totals from the source DB,
 *        - tFRY balances vs. recomputed totals in the destination DB,
 *        - total_* aggregates vs. tFRY buckets,
 *        - reward counts to ensure no rows were dropped,
 *        - device metadata (verified/staking status) for unexpected changes.
 *   4. Prints a concise success line for clean miners, or a detailed issue block with
 *      suggestions for fixes when mismatches are detected.
 *   5. Writes a full audit log (including every miner’s findings) to
 *      `reports/conversion-audit/verify-conversion-<timestamp>.json`.
 *
 * CLI Flags:
 *   --source=<mongodb-uri>    Override/source Mongo connection string.
 *   --dest=<mongodb-uri>      Override/destination Mongo connection string.
 *   --tolerance=<number>      Allowed rounding delta (defaults to 0.01).
 *
 * Environment variables (optional fallbacks):
 *   SOURCE_MONGO_URI, DEST_MONGO_URI, VER_MONGODB_URI, VER_MONGO_URI.
 *
 * Usage Examples:
 *   npm run verify-conversion
 *   npm run verify-conversion -- --source="mongodb+srv://pre..." --dest="mongodb://post..."
 *   npm run verify-conversion -- --tolerance=0.05
 *
 *   Inside the prompt:
 *     Miner keys? BM-123,BM-456
 *     Miner keys? @./lists/pilot-miners.txt
 *     Miner keys? ALL
 *     Miner keys? EXIT
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { stdin as input, stdout as output } from 'node:process';
import readline from 'readline/promises';
import mongoose, { Connection } from 'mongoose';
import { deviceRewardsSchema, type DeviceReward } from '../db/device-rewards-schema';
import { devicesSchema, type Device } from '../db/devices-schema';
import { TFRY_ASSET_ID } from '../reward-totals';

const LEGACY_FRY_ASSET_ID = '924268058';

type CliOptions = {
  sourceUri?: string;
  destUri?: string;
  tolerance: number;
};

type StatusTotals = {
  pending: number;
  claimable: number;
  claimed: number;
  aggregated: number;
};

type AssetBreakdown = Record<string, StatusTotals>;

type RewardFieldSnapshot = {
  legacy: {
    pending: number;
    claimable: number;
    claimed: number;
    aggregated: number;
    total: number;
  };
  tfry: {
    pending: number;
    claimable: number;
    claimed: number;
    aggregated: number;
    total: number;
  };
  totals: {
    pending: number;
    claimable: number;
    claimed: number;
  };
};

type RewardDocSummary = {
  minerKey: string;
  exists: boolean;
  fields: RewardFieldSnapshot;
  computed: {
    daily: AssetBreakdown;
    weekly: AssetBreakdown;
    combined: AssetBreakdown;
  };
  metadata: {
    dailyCount: number;
    weeklyCount: number;
    rewardCount?: number;
    weeklyRewardCount?: number;
    lastUpdated?: Date;
  };
};

type DeviceSnapshot = {
  minerKey: string;
  exists: boolean;
  verified: boolean;
  stakedType?: string;
  stakedAmount?: number;
  stakedTime?: Date;
  rewardedTime?: Date;
};

type MinerAuditResult = {
  minerKey: string;
  ok: boolean;
  issues: string[];
  suggestions: string[];
  sourceSummary?: RewardDocSummary;
  destSummary?: RewardDocSummary;
  sourceDevice?: DeviceSnapshot;
  destDevice?: DeviceSnapshot;
};

type AuditLog = {
  startedAt: string;
  finishedAt?: string;
  tolerance: number;
  sourceUri: string;
  destUri: string;
  results: MinerAuditResult[];
};

const STATUS_FIELDS: Array<keyof StatusTotals> = ['pending', 'claimable', 'claimed', 'aggregated'];

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const rl = readline.createInterface({ input, output });

  try {
    const sourceUri = resolveUri(
      'Source Mongo URI',
      options.sourceUri ?? process.env.SOURCE_MONGO_URI ?? process.env.VER_MONGODB_URI,
    );
    const destUri = resolveUri(
      'Destination Mongo URI',
      options.destUri ?? process.env.DEST_MONGO_URI ?? process.env.VER_MONGO_URI,
    );

    const [sourceConn, destConn] = await Promise.all([
      connectMongo(sourceUri, 'source'),
      connectMongo(destUri, 'destination'),
    ]);

    const sourceModels = createModels(sourceConn);
    const destModels = createModels(destConn);

    console.log('\n✅ Connected to both MongoDB instances.\n');

    const log: AuditLog = {
      startedAt: new Date().toISOString(),
      tolerance: options.tolerance,
      sourceUri: sanitizeUri(sourceUri),
      destUri: sanitizeUri(destUri),
      results: [],
    };

    let totalChecked = 0;
    let totalOk = 0;

    while (true) {
      const rawInput = await rl.question(
        'Enter miner keys (comma-separated), @file path, ALL, or EXIT: ',
      );
      const trimmed = rawInput.trim();
      if (trimmed.length === 0) {
        continue;
      }
      if (/^exit$/i.test(trimmed)) {
        break;
      }

      let minerKeys: string[] = [];

      if (/^all$/i.test(trimmed)) {
        minerKeys = await fetchAllMinerKeys(destModels.deviceRewards);
        console.log(`Loaded ${minerKeys.length.toLocaleString()} miner keys from destination DB.`);
      } else if (trimmed.startsWith('@')) {
        const filePath = trimmed.slice(1).trim();
        try {
          const fromFile = await fs.promises.readFile(filePath, 'utf8');
          minerKeys = fromFile
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0 && !line.startsWith('#'));
          console.log(`Loaded ${minerKeys.length} miner keys from ${filePath}.`);
        } catch (error) {
          console.error(`Unable to load file ${filePath}:`, error);
          continue;
        }
      } else {
        minerKeys = trimmed
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean);
      }

      if (minerKeys.length === 0) {
        console.log('No miner keys detected. Try again.');
        continue;
      }

      for (const key of minerKeys) {
        const minerKey = normalizeMinerKey(key);
        totalChecked += 1;
        const result = await auditMiner(
          minerKey,
          sourceModels,
          destModels,
          options.tolerance,
        );
        log.results.push(result);
        if (result.ok) {
          totalOk += 1;
          console.log(renderSuccessLine(minerKey));
        } else {
          console.log(renderIssueBlock(result));
        }
      }

      const successRate = totalChecked === 0 ? 0 : (totalOk / totalChecked) * 100;
      console.log(
        `\nProgress: ${totalOk}/${totalChecked} miners clean (${successRate.toFixed(2)}%).\n`,
      );
    }

    log.finishedAt = new Date().toISOString();
    await persistLog(log);

    console.log('\n📄 Detailed audit log saved for future reference.');
    console.log('👋 Exiting conversion verifier.\n');

    await Promise.all([sourceConn.close(), destConn.close()]);
  } finally {
    rl.close();
  }
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { tolerance: 0.01 };
  argv.forEach((arg) => {
    if (arg.startsWith('--source=')) {
      options.sourceUri = arg.slice('--source='.length);
    } else if (arg.startsWith('--dest=')) {
      options.destUri = arg.slice('--dest='.length);
    } else if (arg.startsWith('--tolerance=')) {
      const value = Number(arg.slice('--tolerance='.length));
      if (Number.isFinite(value) && value >= 0) {
        options.tolerance = value;
      }
    }
  });
  return options;
}

function resolveUri(label: string, value?: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${label} is required. Provide it via CLI flag or .env setting.`);
  }
  if (!/^mongodb(\+srv)?:\/\//.test(trimmed)) {
    throw new Error(`${label} must be a valid MongoDB URI`);
  }
  return trimmed;
}

async function connectMongo(uri: string, label: string): Promise<Connection> {
  const conn = await mongoose.createConnection(uri, {
    maxPoolSize: 8,
    serverSelectionTimeoutMS: 8_000,
  }).asPromise();
  conn.on('error', (err) => {
    console.error(`Mongo connection error (${label}):`, err);
  });
  return conn;
}

function createModels(connection: Connection): {
  deviceRewards: mongoose.Model<DeviceReward>;
  devices: mongoose.Model<Device>;
} {
  return {
    deviceRewards: connection.model<DeviceReward>('device-rewards', deviceRewardsSchema),
    devices: connection.model<Device>('devices', devicesSchema),
  };
}

async function fetchAllMinerKeys(model: mongoose.Model<DeviceReward>): Promise<string[]> {
  const cursor = model.find({}, { miner_key: 1 }).lean().cursor();
  const keys: string[] = [];
  for await (const doc of cursor as AsyncIterable<{ miner_key: string }>) {
    if (doc?.miner_key) {
      keys.push(normalizeMinerKey(doc.miner_key));
    }
  }
  return keys;
}

async function auditMiner(
  minerKey: string,
  sourceModels: { deviceRewards: mongoose.Model<DeviceReward>; devices: mongoose.Model<Device> },
  destModels: { deviceRewards: mongoose.Model<DeviceReward>; devices: mongoose.Model<Device> },
  tolerance: number,
): Promise<MinerAuditResult> {
  const [sourceReward, destReward, sourceDeviceDoc, destDeviceDoc] = await Promise.all([
    sourceModels.deviceRewards.findOne({ miner_key: minerKey }).lean<DeviceReward>().exec(),
    destModels.deviceRewards.findOne({ miner_key: minerKey }).lean<DeviceReward>().exec(),
    sourceModels.devices.findOne({ miner_key: minerKey }).lean<Device>().exec(),
    destModels.devices.findOne({ miner_key: minerKey }).lean<Device>().exec(),
  ]);

  const sourceSummary = summarizeRewardDoc(sourceReward);
  const destSummary = summarizeRewardDoc(destReward);
  const sourceDevice = summarizeDevice(sourceDeviceDoc);
  const destDevice = summarizeDevice(destDeviceDoc);

  const issues: string[] = [];
  const suggestions: string[] = [];

  if (!sourceSummary.exists) {
    issues.push('Source reward document missing.');
  }

  if (!destSummary.exists) {
    issues.push('Destination reward document missing.');
  }

  if (sourceSummary.exists && destSummary.exists) {
    compareLegacyTotals(sourceSummary, destSummary, tolerance, issues, suggestions);
    compareTfryTotals(destSummary, tolerance, issues, suggestions);
    compareTotalFields(destSummary, tolerance, issues, suggestions);
    compareRewardCounts(sourceSummary, destSummary, issues);
  }

  compareDeviceSnapshots(sourceDevice, destDevice, issues, suggestions);

  return {
    minerKey,
    ok: issues.length === 0,
    issues,
    suggestions,
    sourceSummary,
    destSummary,
    sourceDevice,
    destDevice,
  };
}

function summarizeRewardDoc(doc: DeviceReward | null): RewardDocSummary {
  if (!doc) {
    return {
      minerKey: '',
      exists: false,
      fields: emptyFieldSnapshot(),
      computed: emptyComputed(),
      metadata: {
        dailyCount: 0,
        weeklyCount: 0,
      },
    };
  }

  const dailyBreakdown = computeDailyBreakdown(doc);
  const weeklyBreakdown = computeWeeklyBreakdown(doc);
  const combined = mergeBreakdowns(dailyBreakdown, weeklyBreakdown);

  return {
    minerKey: doc.miner_key,
    exists: true,
    fields: {
      legacy: {
        pending: round2(Number(doc.legacy_fry_pending ?? 0)),
        claimable: round2(Number(doc.legacy_fry_claimable ?? 0)),
        claimed: round2(Number(doc.legacy_fry_claimed ?? 0)),
        aggregated: round2(Number(doc.legacy_fry_aggregated ?? 0)),
        total: round2(Number(doc.legacy_fry_total ?? 0)),
      },
      tfry: {
        pending: round2(Number(doc.tfry_pending ?? 0)),
        claimable: round2(Number(doc.tfry_claimable ?? 0)),
        claimed: round2(Number(doc.tfry_claimed ?? 0)),
        aggregated: round2(Number(doc.tfry_aggregated ?? 0)),
        total: round2(Number(doc.tfry_total ?? 0)),
      },
      totals: {
        pending: round2(Number(doc.total_pending ?? 0)),
        claimable: round2(Number(doc.total_claimable ?? 0)),
        claimed: round2(Number(doc.total_claimed ?? 0)),
      },
    },
    computed: {
      daily: dailyBreakdown,
      weekly: weeklyBreakdown,
      combined,
    },
    metadata: {
      dailyCount: doc.daily_rewards?.length ?? 0,
      weeklyCount: doc.weekly_rewards?.length ?? 0,
      rewardCount: doc.reward_count,
      weeklyRewardCount: doc.weekly_reward_count,
      lastUpdated: doc.last_updated,
    },
  };
}

function emptyFieldSnapshot(): RewardFieldSnapshot {
  return {
    legacy: {
      pending: 0,
      claimable: 0,
      claimed: 0,
      aggregated: 0,
      total: 0,
    },
    tfry: {
      pending: 0,
      claimable: 0,
      claimed: 0,
      aggregated: 0,
      total: 0,
    },
    totals: {
      pending: 0,
      claimable: 0,
      claimed: 0,
    },
  };
}

function emptyComputed(): RewardDocSummary['computed'] {
  return {
    daily: {},
    weekly: {},
    combined: {},
  };
}

function computeDailyBreakdown(doc: DeviceReward): AssetBreakdown {
  const breakdown: AssetBreakdown = {};
  for (const reward of doc.daily_rewards ?? []) {
    const status = reward.status;
    const assetId = String(reward.asset_id ?? '');
    const amount = Number(reward.amount ?? 0);
    if (!assetId || !Number.isFinite(amount)) {
      continue;
    }
    ensureAsset(breakdown, assetId);
    switch (status) {
      case 'pending':
        breakdown[assetId].pending += amount;
        break;
      case 'claimable':
        breakdown[assetId].claimable += amount;
        break;
      case 'claimed':
        breakdown[assetId].claimed += amount;
        break;
      case 'aggregated':
        breakdown[assetId].aggregated += amount;
        break;
      case 'accruing':
        // ignore accrual rows for this audit
        break;
      default:
        break;
    }
  }
  return roundBreakdown(breakdown);
}

function computeWeeklyBreakdown(doc: DeviceReward): AssetBreakdown {
  const breakdown: AssetBreakdown = {};
  for (const reward of doc.weekly_rewards ?? []) {
    const status = reward.status;
    const assetId = String(reward.asset_id ?? '');
    const amount = Number(reward.amount ?? 0);
    if (!assetId || !Number.isFinite(amount)) {
      continue;
    }
    ensureAsset(breakdown, assetId);
    switch (status) {
      case 'pending':
        breakdown[assetId].pending += amount;
        break;
      case 'claimable':
        breakdown[assetId].claimable += amount;
        break;
      case 'claimed':
        breakdown[assetId].claimed += amount;
        break;
      default:
        break;
    }
  }
  return roundBreakdown(breakdown);
}

function ensureAsset(breakdown: AssetBreakdown, assetId: string): void {
  if (!breakdown[assetId]) {
    breakdown[assetId] = {
      pending: 0,
      claimable: 0,
      claimed: 0,
      aggregated: 0,
    };
  }
}

function roundBreakdown(breakdown: AssetBreakdown): AssetBreakdown {
  for (const assetId of Object.keys(breakdown)) {
    for (const field of STATUS_FIELDS) {
      breakdown[assetId][field] = round2(breakdown[assetId][field]);
    }
  }
  return breakdown;
}

function mergeBreakdowns(a: AssetBreakdown, b: AssetBreakdown): AssetBreakdown {
  const merged: AssetBreakdown = {};
  const assetIds = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const assetId of assetIds) {
    ensureAsset(merged, assetId);
    for (const field of STATUS_FIELDS) {
      merged[assetId][field] = round2((a[assetId]?.[field] ?? 0) + (b[assetId]?.[field] ?? 0));
    }
  }
  return merged;
}

function summarizeDevice(doc: Device | null): DeviceSnapshot {
  if (!doc) {
    return {
      minerKey: '',
      exists: false,
      verified: false,
    };
  }
  return {
    minerKey: doc.miner_key,
    exists: true,
    verified: Boolean(doc.verified),
    stakedType: doc.staked?.type,
    stakedAmount: toNumber(doc.staked?.amount),
    stakedTime: doc.staked?.time ? new Date(doc.staked.time) : undefined,
    rewardedTime: doc.staked?.rewarded_time ? new Date(doc.staked.rewarded_time) : undefined,
  };
}

function compareLegacyTotals(
  source: RewardDocSummary,
  dest: RewardDocSummary,
  tolerance: number,
  issues: string[],
  suggestions: string[],
): void {
  const sourceLegacy = getAssetTotals(source.computed.combined, LEGACY_FRY_ASSET_ID);
  const destLegacyFields = dest.fields.legacy;
  const destLegacyComputed = getAssetTotals(dest.computed.combined, LEGACY_FRY_ASSET_ID);

  const expectedTotal = round2(
    sourceLegacy.pending + sourceLegacy.claimable + sourceLegacy.claimed + sourceLegacy.aggregated,
  );

  checkClose(
    'Legacy claimed balance',
    destLegacyFields.claimed,
    sourceLegacy.claimed,
    tolerance,
    issues,
    'Legacy claimed snapshot does not match source totals.',
    'Confirm claimed history was preserved in legacy snapshot.',
    suggestions,
  );

  checkClose(
    'Legacy total balance',
    destLegacyFields.total,
    expectedTotal,
    tolerance,
    issues,
    'Legacy total snapshot does not match original legacy totals.',
    'Ensure snapshot phase captured full legacy balance before conversion.',
    suggestions,
  );

  checkClose(
    'Legacy claimed field vs computed',
    destLegacyFields.claimed,
    destLegacyComputed.claimed,
    tolerance,
    issues,
    'Legacy claimed field does not match computed totals.',
    'Inspect legacy claimed entries for inconsistencies.',
    suggestions,
  );

  enforceZero(
    'Legacy pending cleared',
    destLegacyFields.pending,
    tolerance,
    issues,
    'Legacy pending snapshot should be zero after conversion.',
    'Investigate leftover legacy pending rows in destination document.',
    suggestions,
  );

  enforceZero(
    'Legacy claimable cleared',
    destLegacyFields.claimable,
    tolerance,
    issues,
    'Legacy claimable snapshot should be zero after conversion.',
    'Investigate leftover legacy claimable rows in destination document.',
    suggestions,
  );

  enforceZero(
    'Legacy aggregated cleared',
    destLegacyFields.aggregated,
    tolerance,
    issues,
    'Legacy aggregated snapshot should be zero after conversion.',
    'Investigate leftover legacy aggregated rows in destination document.',
    suggestions,
  );

  enforceZero(
    'Legacy ledger cleared (computed)',
    destLegacyComputed.pending + destLegacyComputed.claimable + destLegacyComputed.aggregated,
    tolerance,
    issues,
    'Destination still has legacy pending/claimable/aggregated rows.',
    'Converted documents should not retain legacy balances outside claimed history.',
    suggestions,
  );
}

function compareTfryTotals(
  dest: RewardDocSummary,
  tolerance: number,
  issues: string[],
  suggestions: string[],
): void {
  const destTfryFields = dest.fields.tfry;
  const destTfryComputed = getAssetTotals(dest.computed.combined, TFRY_ASSET_ID);

  checkClose(
    'tFRY pending balance',
    destTfryFields.pending,
    destTfryComputed.pending,
    tolerance,
    issues,
    'tFRY pending field does not match computed totals.',
    'Re-run conversion for this miner to rebuild pending totals.',
    suggestions,
  );
  checkClose(
    'tFRY claimable balance',
    destTfryFields.claimable,
    destTfryComputed.claimable,
    tolerance,
    issues,
    'tFRY claimable field does not match computed totals.',
    'Verify weekly aggregation results and rerun conversion if needed.',
    suggestions,
  );
  checkClose(
    'tFRY claimed balance',
    destTfryFields.claimed,
    destTfryComputed.claimed,
    tolerance,
    issues,
    'tFRY claimed field does not match computed totals.',
    'Inspect historical claimed entries for mixed assets.',
    suggestions,
  );
  enforceZero(
    'tFRY aggregated cleared',
    destTfryFields.aggregated,
    tolerance,
    issues,
    'tFRY aggregated bucket should remain zero; weekly rewards hold the rolled-up balances.',
    'Investigate unexpected aggregated tFRY rows in the destination document.',
    suggestions,
  );
  const expectedTotal =
    destTfryComputed.pending +
    destTfryComputed.claimable +
    destTfryComputed.claimed;
  checkClose(
    'tFRY total balance',
    round2(destTfryFields.total),
    round2(expectedTotal),
    tolerance,
    issues,
    'tFRY total does not match the sum of components.',
    'Investigate rounding deltas or missing reward rows.',
    suggestions,
  );
}

function compareTotalFields(
  dest: RewardDocSummary,
  tolerance: number,
  issues: string[],
  suggestions: string[],
): void {
  const tfry = dest.fields.tfry;
  const totals = dest.fields.totals;

  checkClose(
    'total_pending vs tFRY pending',
    totals.pending,
    tfry.pending,
    tolerance,
    issues,
    'total_pending diverges from tFRY pending.',
    'Totals should mirror tFRY balances post-conversion.',
    suggestions,
  );
  checkClose(
    'total_claimable vs tFRY claimable',
    totals.claimable,
    tfry.claimable,
    tolerance,
    issues,
    'total_claimable diverges from tFRY claimable.',
    'Totals should mirror tFRY balances post-conversion.',
    suggestions,
  );
  checkClose(
    'total_claimed vs tFRY claimed',
    totals.claimed,
    tfry.claimed,
    tolerance,
    issues,
    'total_claimed diverges from tFRY claimed.',
    'Totals should mirror tFRY balances post-conversion.',
    suggestions,
  );
}

function compareRewardCounts(
  source: RewardDocSummary,
  dest: RewardDocSummary,
  issues: string[],
): void {
  if (source.metadata.dailyCount > dest.metadata.dailyCount) {
    issues.push(
      `Destination daily reward count (${dest.metadata.dailyCount}) is lower than source (${source.metadata.dailyCount}).`,
    );
  }
  if (dest.metadata.weeklyCount > source.metadata.weeklyCount) {
    issues.push(
      `Destination weekly reward count (${dest.metadata.weeklyCount}) exceeds source (${source.metadata.weeklyCount}).`,
    );
  }
}

function compareDeviceSnapshots(
  source: DeviceSnapshot,
  dest: DeviceSnapshot,
  issues: string[],
  suggestions: string[],
): void {
  if (!source.exists && !dest.exists) {
    return;
  }

  if (source.exists && !dest.exists) {
    issues.push('Device record missing in destination database.');
    suggestions.push('Copy device metadata before running conversion.');
    return;
  }

  if (!source.exists && dest.exists) {
    issues.push('Device record missing in source database.');
    return;
  }

  if (source.verified !== dest.verified) {
    issues.push(
      `Verified flag mismatch (source=${source.verified}, destination=${dest.verified}).`,
    );
    suggestions.push('Confirm device verification state was not altered during migration.');
  }

  const srcStakeType = source.stakedType ?? 'none';
  const destStakeType = dest.stakedType ?? 'none';
  if (srcStakeType !== destStakeType) {
    issues.push(`Stake type mismatch (source=${srcStakeType}, destination=${destStakeType}).`);
    suggestions.push('Review staking/withdrawal events that occurred during conversion window.');
  }

  const srcStakeAmount = source.stakedAmount ?? 0;
  const destStakeAmount = dest.stakedAmount ?? 0;
  if (Math.abs(srcStakeAmount - destStakeAmount) > 0.0001) {
    issues.push(
      `Stake amount mismatch (source=${srcStakeAmount}, destination=${destStakeAmount}).`,
    );
  }
}

function checkClose(
  label: string,
  actual: number,
  expected: number,
  tolerance: number,
  issues: string[],
  issueMessage: string,
  suggestion: string,
  suggestions: string[],
): void {
  if (Math.abs(actual - expected) > tolerance) {
    issues.push(`${label} mismatch. Expected ${expected}, found ${actual}. ${issueMessage}`);
    suggestions.push(suggestion);
  }
}

function enforceZero(
  label: string,
  actual: number,
  tolerance: number,
  issues: string[],
  issueMessage: string,
  suggestion: string,
  suggestions: string[],
): void {
  if (Math.abs(actual) > tolerance) {
    issues.push(`${label} mismatch. Expected 0, found ${round2(actual)}. ${issueMessage}`);
    suggestions.push(suggestion);
  }
}

function getAssetTotals(breakdown: AssetBreakdown, assetId: string): StatusTotals {
  return breakdown[assetId] ?? { pending: 0, claimable: 0, claimed: 0, aggregated: 0 };
}

function normalizeMinerKey(value: string): string {
  return value.trim().toUpperCase();
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function toNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function renderSuccessLine(minerKey: string): string {
  return `✅ ${minerKey}: OK`;
}

function renderIssueBlock(result: MinerAuditResult): string {
  const lines: string[] = [];
  lines.push(`❌ ${result.minerKey}: Issues detected`);
  result.issues.forEach((issue) => {
    lines.push(`   - ${issue}`);
  });
  if (result.suggestions.length > 0) {
    lines.push('   Suggestions:');
    result.suggestions.forEach((suggestion) => {
      lines.push(`     • ${suggestion}`);
    });
  }
  return lines.join('\n');
}

async function persistLog(log: AuditLog): Promise<void> {
  const dir = path.resolve(process.cwd(), 'reports', 'conversion-audit');
  await fs.promises.mkdir(dir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(dir, `verify-conversion-${timestamp}-${Date.now()}.json`);
  await fs.promises.writeFile(filePath, JSON.stringify(log, null, 2), 'utf8');
}

function sanitizeUri(uri: string): string {
  try {
    const withoutScheme = uri.replace(/^mongodb(\+srv)?:\/\//i, '');
    const hostAndPath = withoutScheme.split('/')[0] ?? '';
    const host = hostAndPath.includes('@')
      ? hostAndPath.split('@')[1] ?? 'unknown-host'
      : hostAndPath || 'unknown-host';
    return `mongodb://${host}/<redacted>`;
  } catch {
    return '<redacted>';
  }
}

main().catch((error) => {
  console.error('Conversion verification tool failed:', error);
  process.exitCode = 1;
});
