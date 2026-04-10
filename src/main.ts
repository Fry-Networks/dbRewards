import path from "path";
import fs from "fs";
import { connect, getConnection } from "./db/connect";
import { Device, DeviceModel, TestDeviceModel } from "./db/devices-schema";
import "dotenv/config";
import { ProductModel, Product } from "./db/products-schema";
import { RewardModel, TestRewardModel } from "./db/rewards-schema";
// NEW: Import device rewards schema for aggregated reward system
import { DeviceRewardModel, TestDeviceRewardModel, DeviceReward } from "./db/device-rewards-schema";
import { JobRunModel, TestJobRunModel, type JobRun } from "./db/job-run-schema";
import { doRewards } from "./reward";
import { RewardReportAggregator, type RewardReport } from "./reporting/reward-report";
import { writeRewardCsvReports } from "./reporting/csv-writer";
import mongoose, { Types } from "mongoose";
import { dbPerformanceMonitor, withPerformanceMonitoring } from "./performance-monitor";
import { startPeriodicHealthChecks, alertingSystem } from "./alerting";
import { errorTracker } from "./error-tracker";
import { printEnvironmentStatus, validateEnvironment } from "./env-validation";
import { getSimNow, scaledIntervalMs, getTimeConfigSummary } from "./time-control";
import { tokenManager } from "./security/token-manager";
import { auditLogger } from "./security/audit-logger";
import { backupManager } from "./security/backup-manager";
import { dataValidator } from "./security/data-validator";
import { logSection } from "./logger";
import { withJobLock } from "./scheduler/job-lock";
import { applyTfryDelta, getRewardAssetLabel, isTfryAsset, TFRY_ASSET_ID } from "./reward-totals";

const testMode = process.env.TEST_MODE
  ? process.env.TEST_MODE === "true"
  : false;
const WEEKLY_REWARDS_ENABLED = process.env.WEEKLY_REWARDS_ENABLED === 'true';
const INLINE_WEEKLY_JOBS =
  process.env.INLINE_WEEKLY_JOBS === undefined
    ? true
    : process.env.INLINE_WEEKLY_JOBS === 'true';
// Weekly roll-up guard rails: persistent job tracking + lock TTL so runs are idempotent across processes
const WEEKLY_ROLLUP_JOB_NAME = 'weekly-rollup';
const WEEKLY_ROLLUP_LOCK_TTL_MS = 15 * 60 * 1000; // 15 minutes
// Maturation job controls
// Global default: MATURATION_ENABLED (true unless explicitly 'false')
const MATURATION_ENABLED = process.env.MATURATION_ENABLED !== 'false';
// Specific overrides: if unset, fall back to global
const DAILY_MATURATION_ENABLED =
  process.env.DAILY_MATURATION_ENABLED !== undefined
    ? process.env.DAILY_MATURATION_ENABLED === 'true'
    : MATURATION_ENABLED;
const WEEKLY_MATURATION_ENABLED =
  process.env.WEEKLY_MATURATION_ENABLED !== undefined
    ? process.env.WEEKLY_MATURATION_ENABLED === 'true'
    : MATURATION_ENABLED;

const REWARD_REPORT_DIR = process.env.REWARD_REPORT_DIR
  ? path.resolve(process.env.REWARD_REPORT_DIR)
  : path.resolve(process.cwd(), "reward-reports");

// One-time daily maturation at startup to clear backlog when coming back online
const RUN_DAILY_MATURATION_ONCE = process.env.RUN_DAILY_MATURATION_ONCE === 'true';
const DAILY_MATURATION_ONCE_TIMEBASE = (process.env.DAILY_MATURATION_ONCE_TIMEBASE || 'real').toLowerCase(); // 'real' | 'sim'

interface PendingFlipDoc {
  _id: Types.ObjectId;
  miner_key?: string;
  amountToFlip: number;
  tfryAmountToFlip: number;
}

async function runDailyMaturationOnce(): Promise<void> {
  const now = DAILY_MATURATION_ONCE_TIMEBASE === 'sim' ? getSimNow() : new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  logSection(`One-time daily maturation starting (timebase: ${DAILY_MATURATION_ONCE_TIMEBASE})...`);
  try {
    const Model = testMode ? TestDeviceRewardModel : DeviceRewardModel;
    const pipeline = [
      { $match: { daily_rewards: { $elemMatch: { status: 'pending', created_at: { $lte: thirtyDaysAgo } } } } },
      {
        $project: {
          _id: 1,
          miner_key: 1,
          amountToFlip: {
            $sum: {
              $map: {
                input: {
                  $filter: {
                    input: '$daily_rewards',
                    as: 'r',
                    cond: { $and: [ { $eq: ['$$r.status', 'pending'] }, { $lte: ['$$r.created_at', thirtyDaysAgo] } ] }
                  }
                },
                as: 'r',
                in: '$$r.amount'
              }
            }
          }
        }
      }
    ];
    const cursor = Model.aggregate<PendingFlipDoc>(pipeline).cursor({ batchSize: 200 });

    let devicesUpdated = 0;
    let elemFlipsApprox = 0;
    for await (const doc of cursor as AsyncIterable<PendingFlipDoc>) {
      const amount = Number(doc.amountToFlip || 0);
      if (amount <= 0) continue;
      const upd = await Model.updateOne(
        { _id: doc._id },
        {
          $set: { 'daily_rewards.$[elem].status': 'claimable', last_updated: now },
          $inc: { total_pending: -amount, total_claimable: amount }
        },
        { arrayFilters: [ { 'elem.status': 'pending', 'elem.created_at': { $lte: thirtyDaysAgo } } ] }
      );
      if (upd.modifiedCount && upd.modifiedCount > 0) {
        devicesUpdated++;
        elemFlipsApprox += upd.modifiedCount;
      }
    }
    logSection(`One-time daily maturation completed: devices=${devicesUpdated}, elements≈${elemFlipsApprox}`);
  } catch (err) {
    console.error('One-time daily maturation failed:', err);
  }
}

logSection(`Test mode: ${testMode}`);

const isStakeValid = (product: Product): boolean => {
  if (!product.reward.stake) {
    // stake is undefined or null, return false if it must be present
    return false;
  }

  const { stake_one, stake_two } = product.reward.stake;

  // Check if both stake_one and stake_two are defined and are numbers
  if (typeof stake_one !== "number" || typeof stake_two !== "number") {
    return false;
  }

  // Optionally: Check for more specific validation rules (e.g., stake values must be positive)
  if (stake_one < 0 || stake_two < 0) {
    return false; // Example rule: stakes cannot be negative
  }

  // All checks passed, return true
  return true;
};

const unverifyRewardDate = new Date(Date.now());

const ensureCollectionsExist = async (
  db: mongoose.Connection,
  collections: string[]
) => {
  const existingCollections = await db.db.listCollections().toArray();
  const existingNames = existingCollections.map((col) => col.name);

  for (const collectionName of collections) {
    if (!existingNames.includes(collectionName)) {
      await db.createCollection(collectionName);
      logSection(`Collection '${collectionName}' created.`);
    } else {
      // Collection exists; no need to log every cycle
    }
  }
};

// Explicitly create poc_reward_daily indexes so production doesn't rely on Mongoose autoIndex.
const ensurePocRewardDailyIndexes = async (db: mongoose.Connection): Promise<void> => {
  try {
    await db.collection("poc_reward_daily").createIndex(
      { miner_key: 1, date: 1 },
      { unique: true, name: 'unique_poc_reward_daily' }
    );
    await db.collection("poc_reward_daily").createIndex(
      { date: -1 },
      { name: 'poc_reward_daily_date' }
    );
  } catch (err: any) {
    if (err?.code === 85 || err?.codeName === 'IndexOptionsConflict') {
      return;
    }
    if (err?.code === 11000) {
      console.error('Failed to enforce poc_reward_daily unique index due to existing duplicates:', err);
      return;
    }
    console.error('Failed to ensure poc_reward_daily indexes:', err);
  }
};

// Device hash function for consistent hour assignment
function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

// Get devices assigned to a specific hour (0-23)
function getDevicesForHour(devices: Device[], hour: number): Device[] {
  return devices.filter(device => {
    const deviceHash = hashString(device._id.toString());
    return deviceHash % 24 === hour;
  });
}

// Cache for products to avoid repeated queries
let cachedProducts: Product[] = [];

type HourlySummary = {
  eligibleDevices: number;
  insertedDevices: number;
  insertedRows: number;
  skippedDuplicates: number;
  notEligible: number;
  noWallet: number;
  otherValidation: number;
  dbErrors: number;
};

type HourlyRunResult = {
  summary: HourlySummary;
  report: RewardReport;
};

const DEVICE_FIELDS_FOR_REWARDS =
  '_id miner_key is_registered reward_wallet verified staked registration node byod rewards_exception hardware created_at reward_multiplier timezone mac_addresses addresses exception_flags last_reward_date last_updated type device_type';

type AssetSummary = {
  amount: number;
  devices: number;
  rewards: number;
};

type DeviceTypeSummary = {
  totalAmount: number;
  totalRewards: number;
  devices: number;
  assets: Record<string, AssetSummary>;
};

const roundToTwo = (value: number): number => {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
};

type AssetAggregationState = {
  amount: number;
  rewards: number;
  devices: Set<string>;
};

type DeviceTypeAggregationState = {
  totalAmount: number;
  totalRewards: number;
  devices: Set<string>;
  assets: Map<string, AssetAggregationState>;
};

function ensureAssetAggregationState(
  map: Map<string, AssetAggregationState>,
  key: string,
): AssetAggregationState {
  let state = map.get(key);
  if (!state) {
    state = { amount: 0, rewards: 0, devices: new Set<string>() };
    map.set(key, state);
  }
  return state;
}

function ensureDeviceTypeAggregationState(
  map: Map<string, DeviceTypeAggregationState>,
  key: string,
): DeviceTypeAggregationState {
  let state = map.get(key);
  if (!state) {
    state = {
      totalAmount: 0,
      totalRewards: 0,
      devices: new Set<string>(),
      assets: new Map<string, AssetAggregationState>(),
    };
    map.set(key, state);
  }
  return state;
}

function buildAssetSummary(
  aggregates: Map<string, AssetAggregationState>,
): Record<string, AssetSummary> {
  const summary: Record<string, AssetSummary> = {};
  for (const [asset, state] of aggregates.entries()) {
    summary[asset] = {
      amount: roundToTwo(state.amount),
      devices: state.devices.size,
      rewards: state.rewards,
    };
  }
  return summary;
}

function buildDeviceTypeSummary(
  aggregates: Map<string, DeviceTypeAggregationState>,
): Record<string, DeviceTypeSummary> {
  const summary: Record<string, DeviceTypeSummary> = {};
  for (const [deviceType, state] of aggregates.entries()) {
    const assetSummary: Record<string, AssetSummary> = {};
    for (const [assetKey, assetState] of state.assets.entries()) {
      assetSummary[assetKey] = {
        amount: roundToTwo(assetState.amount),
        devices: assetState.devices.size,
        rewards: assetState.rewards,
      };
    }
    summary[deviceType] = {
      totalAmount: roundToTwo(state.totalAmount),
      totalRewards: state.totalRewards,
      devices: state.devices.size,
      assets: assetSummary,
    };
  }
  return summary;
}

function formatAssetLabel(label: string): string {
  return label.startsWith('asset:') ? `asset ${label.slice(6)}` : label;
}

function withAssetBaseline(
  assets: Record<string, AssetSummary> | undefined,
): Record<string, AssetSummary> {
  const result: Record<string, AssetSummary> = { ...(assets ?? {}) };
  const ensure = (key: string): void => {
    if (!result[key]) {
      result[key] = { amount: 0, devices: 0, rewards: 0 };
    }
  };
  ensure('fNode');
  ensure('tFry');
  return result;
}

async function writeReportFile(subdir: string, fileName: string, payload: unknown): Promise<string | null> {
  try {
    const dir = path.resolve(process.cwd(), 'logs', subdir);
    await fs.promises.mkdir(dir, { recursive: true });
    const safeName = fileName.replace(/[^a-zA-Z0-9_.-]/g, '-');
    const fullPath = path.join(dir, safeName);
    await fs.promises.writeFile(fullPath, JSON.stringify(payload, null, 2), 'utf8');
    return fullPath;
  } catch (err) {
    console.error('Failed to write report file', err);
    return null;
  }
}

function toDiscordMessage(lines: string[], overflowNote: string): string {
  const limit = 1900; // keep a buffer under 2k
  let joined = lines.join('\n');
  if (joined.length <= limit) return joined;

  const trimmed: string[] = [];
  let used = 0;
  for (const line of lines) {
    const nextLen = used + line.length + 1;
    if (nextLen > limit - overflowNote.length - 5) break;
    trimmed.push(line);
    used = nextLen;
  }
  trimmed.push(overflowNote);
  return trimmed.join('\n');
}

function getDeviceTypeFromMinerKey(minerKey?: string): string {
  if (!minerKey) return 'UNKNOWN';
  const prefix = minerKey.split('-')[0]?.trim().toUpperCase();
  return prefix && prefix.length > 0 ? prefix : 'UNKNOWN';
}

function shortMinerKey(minerKey?: string): string {
  if (!minerKey) return 'UNKNOWN';
  const parts = minerKey.split('-');
  const prefix = parts[0]?.toUpperCase() ?? 'UNKNOWN';
  const tail = (parts[1] ?? '').slice(0, 4).toUpperCase();
  return tail ? `${prefix}-${tail}` : prefix;
}

async function loadRegisteredDevices(): Promise<Device[]> {
  if (testMode) {
    return await TestDeviceModel.find({ is_registered: true })
      .select(DEVICE_FIELDS_FOR_REWARDS)
      .lean<Device[]>();
  }
  return await DeviceModel.find({ is_registered: true })
    .select(DEVICE_FIELDS_FOR_REWARDS)
    .lean<Device[]>();
}

const main = async (devicesToProcess?: Device[]): Promise<HourlyRunResult> => {
  await connect();
  const connection = getConnection();
  const db = connection.connection;

  // OLD_LOGIC_BACKUP: Only ensured old reward collections
  // await ensureCollectionsExist(db, ["rewards", "test-rewards"]);

  // Ensure aggregated reward collections
  await ensureCollectionsExist(db, [
    "device-rewards",
    "poc_reward_daily"
  ]);

  // Ensure poc_reward_daily indexes (unique on miner_key+date for idempotency)
  await ensurePocRewardDailyIndexes(db);

  const rewardsConfig = await connection.connection
    .collection("configs")
    .findOne({ name: "rewards" });
  if (!testMode && !rewardsConfig?.enabled) {
    logSection("Rewards are disabled");
    return {
      summary: { eligibleDevices: 0, insertedDevices: 0, insertedRows: 0, skippedDuplicates: 0, notEligible: 0, noWallet: 0, otherValidation: 0, dbErrors: 0 },
      report: { successes: [], failures: [] }
    };
  }

  const globalMulitplier = rewardsConfig ? rewardsConfig.multiplier : 1;

  // Use provided devices or load all devices with performance monitoring
  let allDevices: Device[];
  if (devicesToProcess) {
    allDevices = devicesToProcess;
  } else {
    allDevices = await withPerformanceMonitoring(
      'find',
      testMode ? 'test-devices' : 'devices',
      async () => await loadRegisteredDevices()
    );
  }

  let filtered = allDevices;
  
  // Cache products if not already cached with performance monitoring
  if (cachedProducts.length === 0) {
    cachedProducts = await withPerformanceMonitoring(
      'find',
      'products',
      async () => await ProductModel.find({})
    );
    logSection(`Cached ${cachedProducts.length} products`);
  }

  let retryCount = 0;
  // aggregate across retries
  let summaryAgg: HourlySummary = { eligibleDevices: 0, insertedDevices: 0, insertedRows: 0, skippedDuplicates: 0, notEligible: 0, noWallet: 0, otherValidation: 0, dbErrors: 0 };
  const reportAggregator = new RewardReportAggregator();

  while (retryCount < 5) {
    const { errors: errDevices, summary, report } = await doRewards(filtered, cachedProducts);
    // accumulate
    summaryAgg.eligibleDevices += summary.eligibleDevices;
    summaryAgg.insertedDevices += summary.insertedDevices;
    summaryAgg.insertedRows += summary.insertedRows;
    summaryAgg.skippedDuplicates += summary.skippedDuplicates;
    summaryAgg.notEligible += summary.notEligible;
    summaryAgg.noWallet += summary.noWallet;
    summaryAgg.otherValidation += summary.otherValidation;
    summaryAgg.dbErrors += summary.dbErrors;

    reportAggregator.addReport(report);

    const retryRewardDevices = errDevices
      .filter((value) => {
        if (value.err === "Failed") {
          return true;
        }

        return false;
      })
      .map((value) => value.device);

    if (retryRewardDevices.length === 0) {
      break;
    } else {
      logSection(`Failed to reward for ${retryRewardDevices.length} devices`);
    }

    filtered = retryRewardDevices;
    retryCount++;

    await sleep(10 * 60 * 1000);
  }

  if (retryCount >= 5) {
    logSection(`Failed in hourly reward for ${allDevices.length} miners`);
  } else {
    logSection(`Success in hourly reward for ${allDevices.length} miners`);
  }
  const mergedReport = reportAggregator.toReport();

  return {
    summary: summaryAgg,
    report: mergedReport
  };
};


export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Enhanced logging and metrics interface
interface ProcessingMetrics {
  startTime: Date;
  endTime: Date;
  devicesProcessed: number;
  devicesSucceeded: number;
  devicesFailed: number;
  rewardsGenerated: number;
  processingTimeMs: number;
  hour: number;
  eligibleDevices?: number;
  insertedDevices?: number;
  insertedRows?: number;
  skippedDuplicates?: number;
  notEligible?: number;
  noWallet?: number;
  otherValidation?: number;
  dbErrors?: number;
}

async function logProcessingMetrics(metrics: ProcessingMetrics): Promise<void> {
  const durationMs = metrics.processingTimeMs;
  const durationSeconds = (durationMs / 1000).toFixed(1);
  const successRate = metrics.devicesProcessed > 0
    ? `${((metrics.devicesSucceeded / metrics.devicesProcessed) * 100).toFixed(2)}%`
    : '0.00%';
  const performanceStatus = durationMs < 30 * 60 * 1000
    ? 'OPTIMAL'
    : durationMs < 60 * 60 * 1000
      ? 'ACCEPTABLE'
      : 'SLOW';

  const eligibleDevices = metrics.eligibleDevices ?? 0;
  const insertedDevices = metrics.insertedDevices ?? 0;
  const insertedRows = metrics.insertedRows ?? 0;
  const skippedDuplicates = metrics.skippedDuplicates ?? 0;
  const notEligible = metrics.notEligible ?? 0;
  const noWallet = metrics.noWallet ?? 0;
  const otherValidation = metrics.otherValidation ?? 0;
  const dbErrors = metrics.dbErrors ?? 0;

  logSection(
    `📊 Hourly Processing — hour ${metrics.hour}`,
    `  Window: ${metrics.startTime.toISOString()} → ${metrics.endTime.toISOString()}`,
    `  Duration: ${durationSeconds}s (${durationMs} ms) | Performance: ${performanceStatus}`,
    `  Devices processed: ${metrics.devicesProcessed} (✅ ${metrics.devicesSucceeded} | ❌ ${metrics.devicesFailed})`,
    `  Rewards generated: ${metrics.rewardsGenerated} | Success rate: ${successRate}`,
    `  Eligible: ${eligibleDevices} | Inserted devices: ${insertedDevices} | Inserted rows: ${insertedRows}`,
    `  Skipped duplicates: ${skippedDuplicates} | Not eligible: ${notEligible} | No wallet: ${noWallet}`,
    `  Other validation errors: ${otherValidation} | DB errors: ${dbErrors}`
  );

  // Log performance warnings
  if (durationMs > 30 * 60 * 1000) {
    console.warn(`⚠️  Processing took ${Math.round(durationMs / 60000)} minutes - consider optimization`);
  }

  // Warn only on real DB errors (skip duplicate-guard scenarios)
  if (dbErrors > 0) {
    console.warn(`⚠️  Detected ${dbErrors} database errors during accrual run`);
  }
}

// Track execution times to prevent duplicate processing
let lastExecutionHours: string[] = [];
let inFlightHours: Set<string> = new Set();
let loggedSkipHourKeys: Set<string> = new Set();
// Simple in-process lock to avoid overlapping hourly accruals and weekly roll-up
let weeklyRollupInProgress = false;

// Helper function to check if we should execute at a specific time
function shouldExecuteAtTime(currentDate: Date, targetMinute: number): boolean {
  const currentMinute = currentDate.getMinutes();
  // Execute if current time is within 5 minutes after target time
  return currentMinute >= targetMinute && currentMinute <= targetMinute + 5;
}

// Helper function to check if we already executed this hour today
function alreadyExecutedThisHour(currentDate: Date): boolean {
  const hourKey = `${currentDate.toDateString()}-${currentDate.getHours()}`;
  return lastExecutionHours.includes(hourKey);
}

// Main hourly reward system
async function rewardSystem() {
  const currentDate = getSimNow();
  const currentHour = currentDate.getHours();
  
  try {
    // If weekly roll-up is running, skip hourly accruals to reduce contention/memory
    if (weeklyRollupInProgress) {
      const hourKey = `${currentDate.toDateString()}-${currentHour}`;
      if (!loggedSkipHourKeys.has(`${hourKey}-weekly-lock`)) {
        logSection(`Skipping hourly reward for hour ${currentHour} — weekly roll-up in progress.`);
        loggedSkipHourKeys.add(`${hourKey}-weekly-lock`);
      }
      return;
    }
  // Execute every hour at minute 15 (xx:15)
  if (shouldExecuteAtTime(currentDate, 15)) {
      const hourKey = `${currentDate.toDateString()}-${currentHour}`;

      if (alreadyExecutedThisHour(currentDate)) {
        if (!loggedSkipHourKeys.has(`${hourKey}-done`)) {
          logSection(`Skipping hourly reward for hour ${currentHour} — already completed this hour.`);
          loggedSkipHourKeys.add(`${hourKey}-done`);
        }
        return;
      }

      if (inFlightHours.has(hourKey)) {
        if (!loggedSkipHourKeys.has(`${hourKey}-inflight`)) {
          logSection(`Skipping hourly reward for hour ${currentHour} — previous run still in progress.`);
          loggedSkipHourKeys.add(`${hourKey}-inflight`);
        }
        return; // prevent re-entrancy within the same hour window
      }

      inFlightHours.add(hourKey);

      try {
        await withJobLock('hourly-processing', ['weekly-rollup', 'daily-backup', 'data-validation'], async () => {
          // Load all registered devices
          const allDevices = testMode
            ? ((await TestDeviceModel.find({ is_registered: true })) as Device[])
            : ((await DeviceModel.find({ is_registered: true })) as Device[]);
          
          // Get devices assigned to this hour
          const hourlyDevices = getDevicesForHour(allDevices, currentHour);
          
          logSection(
            `Starting hourly reward processing for hour ${currentHour}`,
            `  Cycle devices: ${hourlyDevices.length}`,
            `  Total registered devices: ${allDevices.length}`
          );
          
          if (hourlyDevices.length > 0) {
            // Track processing metrics with accurate reward counting
            const startTime = getSimNow();
            // Use the main function which handles caching, retries, error recovery, and returns a detailed summary
            const { summary: hourlySummary, report } = await main(hourlyDevices);

            const endTime = getSimNow();

            // Treat inserted rows count as rewards generated to avoid large unwinds under acceleration
            const actualRewardsGenerated = Math.max(hourlySummary.insertedRows, 0);
            // Prefer insertedDevices over time-window counts for success
            const devicesSucceeded = Math.max(0, Math.min(hourlySummary.insertedDevices, hourlyDevices.length));
            const devicesFailed = Math.max(0, hourlyDevices.length - devicesSucceeded);
            
            const metrics: ProcessingMetrics = {
              startTime,
              endTime,
              devicesProcessed: hourlyDevices.length,
              devicesSucceeded: devicesSucceeded,
              devicesFailed: devicesFailed,
              rewardsGenerated: actualRewardsGenerated,
              processingTimeMs: endTime.getTime() - startTime.getTime(),
              hour: currentHour,
              eligibleDevices: hourlySummary.eligibleDevices,
              insertedDevices: hourlySummary.insertedDevices,
              insertedRows: hourlySummary.insertedRows,
              skippedDuplicates: hourlySummary.skippedDuplicates,
              notEligible: hourlySummary.notEligible,
              noWallet: hourlySummary.noWallet,
              otherValidation: hourlySummary.otherValidation,
              dbErrors: hourlySummary.dbErrors
            };
            
            // Log comprehensive metrics
            await logProcessingMetrics(metrics);

            try {
              await writeRewardCsvReports(startTime, report, REWARD_REPORT_DIR);
            } catch (reportError) {
              console.error('Failed to write hourly reward CSV reports:', reportError);
            }
          }

          // Record this execution
          lastExecutionHours.push(hourKey);
          
          // Keep only last 48 hours to prevent memory bloat
          if (lastExecutionHours.length > 48) {
            lastExecutionHours = lastExecutionHours.slice(-48);
          }
          
          logSection(`Completed hourly processing for hour ${currentHour}`);
        });
      } finally {
        inFlightHours.delete(hourKey);
      }
    }
  } catch (error) {
    console.error(`Error in hourly reward system (hour ${currentHour}):`, error);
    
    // Retry mechanism for failed hourly batch
    logSection(`Retrying hour ${currentHour} processing in 5 minutes...`);
    setTimeout(async () => {
      try {
        // Remove the failed hour key so it can retry
        const hourKey = `${currentDate.toDateString()}-${currentHour}`;
        const index = lastExecutionHours.indexOf(hourKey);
        if (index > -1) {
          lastExecutionHours.splice(index, 1);
        }
        await rewardSystem();
      } catch (retryError) {
        console.error(`Retry failed for hour ${currentHour}:`, retryError);
      }
    }, scaledIntervalMs(5 * 60 * 1000)); // 5 minute retry (scaled)
  }
}

// Run a specific hour's batch now, bypassing the minute window gating.
// Used for post-roll-up catch-up to ensure hour 0 (midnight) is processed even if the window was missed.
async function runHourBatch(hour: number, preloadedDevices?: Device[]): Promise<void> {
  if (weeklyRollupInProgress) return; // safety guard
  const now = getSimNow();
  const hourKey = `${now.toDateString()}-${hour}`;
  if (lastExecutionHours.includes(hourKey)) return; // already processed

  logSection(`Catch-up: processing hour ${hour} batch after weekly roll-up`);
  const startTime = getSimNow();

  try {
    await connect();
    await withJobLock('hourly-processing', ['weekly-rollup', 'daily-backup', 'data-validation'], async () => {
      const allDevices: Device[] = preloadedDevices ?? await withPerformanceMonitoring(
        'find',
        testMode ? 'test-devices' : 'devices',
        async () => await loadRegisteredDevices()
      );
      const hourlyDevices = getDevicesForHour(allDevices, hour);

      const { summary: hourlySummary, report } = await main(hourlyDevices);

      const endTime = getSimNow();
      const actualRewardsGenerated = Math.max(hourlySummary.insertedRows, 0);

      const devicesSucceeded = Math.max(0, Math.min(hourlySummary.insertedDevices, hourlyDevices.length));
      const devicesFailed = Math.max(0, hourlyDevices.length - devicesSucceeded);

      const metrics: ProcessingMetrics = {
        startTime,
        endTime,
        devicesProcessed: hourlyDevices.length,
        devicesSucceeded,
        devicesFailed,
        rewardsGenerated: actualRewardsGenerated,
        processingTimeMs: endTime.getTime() - startTime.getTime(),
        hour,
        eligibleDevices: hourlySummary.eligibleDevices,
        insertedDevices: hourlySummary.insertedDevices,
        insertedRows: hourlySummary.insertedRows,
        skippedDuplicates: hourlySummary.skippedDuplicates,
        notEligible: hourlySummary.notEligible,
        noWallet: hourlySummary.noWallet,
        otherValidation: hourlySummary.otherValidation,
        dbErrors: hourlySummary.dbErrors
      };
      await logProcessingMetrics(metrics);

      try {
        await writeRewardCsvReports(startTime, report, REWARD_REPORT_DIR);
      } catch (reportError) {
        console.error('Failed to write hourly reward CSV reports:', reportError);
      }

      lastExecutionHours.push(hourKey);
      if (lastExecutionHours.length > 48) {
        lastExecutionHours = lastExecutionHours.slice(-48);
      }
      logSection(`Catch-up: completed hour ${hour} batch`);
    });
  } catch (err) {
    console.error(`Catch-up hour ${hour} failed:`, err);
  }
}

// OLD_LOGIC_BACKUP: Global status update for individual reward documents
/* 
async function updateAllPendingStatuses(): Promise<void> {
  if (!DAILY_MATURATION_ENABLED) {
    logSection('⏸️  Daily maturation disabled');
    return;
  }
  const currentDate = getSimNow();
  const thirtyDaysAgo = new Date(currentDate.getTime() - 30 * 24 * 60 * 60 * 1000);
  
  logSection('Starting global status update job...');
  
  try {
    const result = testMode
      ? await TestRewardModel.updateMany(
          {
            status: "pending",
            createdAt: { $lte: thirtyDaysAgo }
          },
          {
            $set: { status: "claimable" }
          }
        )
      : await RewardModel.updateMany(
          {
            status: "pending",
            createdAt: { $lte: thirtyDaysAgo }
          },
          {
            $set: { status: "claimable" }
          }
        );
    
    logSection(`Global status update completed: ${result.modifiedCount} rewards updated to claimable`);
  } catch (error) {
    console.error('Global status update failed:', error);
  }
}
*/

// NEW: Global status update job for device-centric rewards - runs daily at 2:50 AM
async function updateAllPendingStatuses(): Promise<void> {
  if (!DAILY_MATURATION_ENABLED) {
    logSection('⏸️  Daily maturation disabled');
    return;
  }
  const currentDate = getSimNow();
  const thirtyDaysAgo = new Date(currentDate.getTime() - 30 * 24 * 60 * 60 * 1000);
  
  logSection('Starting global device-centric status update job...');
  
  try {
    const Model = testMode ? TestDeviceRewardModel : DeviceRewardModel;
    const pipeline2 = [
      { $match: { daily_rewards: { $elemMatch: { status: 'pending', created_at: { $lte: thirtyDaysAgo } } } } },
      {
        $project: {
          _id: 1,
          miner_key: 1,
          amountToFlip: {
            $sum: {
              $map: {
                input: {
                  $filter: {
                    input: '$daily_rewards',
                    as: 'r',
                    cond: { $and: [ { $eq: ['$$r.status', 'pending'] }, { $lte: ['$$r.created_at', thirtyDaysAgo] } ] }
                  }
                },
                as: 'r',
                in: '$$r.amount'
              }
            }
          },
          tfryAmountToFlip: {
            $sum: {
              $map: {
                input: {
                  $filter: {
                    input: '$daily_rewards',
                    as: 'r',
                    cond: {
                      $and: [
                        { $eq: ['$$r.status', 'pending'] },
                        { $lte: ['$$r.created_at', thirtyDaysAgo] },
                        { $eq: ['$$r.asset_id', TFRY_ASSET_ID] }
                      ]
                    }
                  }
                },
                as: 'r',
                in: '$$r.amount'
              }
            }
          }
        }
      }
    ];
    const cursor2 = Model.aggregate<PendingFlipDoc>(pipeline2).cursor({ batchSize: 200 });

    let devicesUpdated = 0;
    let elemsFlipped = 0;
    for await (const doc of cursor2 as AsyncIterable<PendingFlipDoc>) {
      const amount = Number(doc.amountToFlip || 0);
      if (amount <= 0) continue;
      const tfryAmount = Number(doc.tfryAmountToFlip || 0);
      const otherAmount = Math.round((amount - tfryAmount) * 100) / 100;
      const inc: Record<string, number> = {};
      if (otherAmount !== 0) {
        inc.total_pending = -otherAmount;
        inc.total_claimable = otherAmount;
      }
      if (tfryAmount !== 0) {
        applyTfryDelta(inc, { pending: -tfryAmount, claimable: tfryAmount });
      }
      const upd = await Model.updateOne(
        { _id: doc._id },
        {
          $set: { 'daily_rewards.$[elem].status': 'claimable', last_updated: currentDate },
          $inc: inc
        },
        { arrayFilters: [ { 'elem.status': 'pending', 'elem.created_at': { $lte: thirtyDaysAgo } } ] }
      );
      if (upd.modifiedCount && upd.modifiedCount > 0) {
        devicesUpdated++;
        elemsFlipped += upd.modifiedCount;
      }
    }
    logSection(`Global device-centric status update completed: devices=${devicesUpdated}, elements≈${elemsFlipped}`);
  } catch (error) {
    console.error('Global device-centric status update failed:', error);
  }
}

// Helper: format date as YYYY-MM-DD in UTC
function formatDateUTC(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Helper: get the UTC Friday 00:00 of the current week relative to a reference date
function getThisFridayStartUTC(ref: Date): Date {
  const d = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate(), 0, 0, 0, 0));
  const day = d.getUTCDay(); // 0=Sun .. 5=Fri
  const diffToFriday = (day + 7 - 5) % 7; // days since last Friday
  d.setUTCDate(d.getUTCDate() - diffToFriday);
  return d; // Friday 00:00 UTC of this week
}

// Compute last full week window (Fri->Thu) and unlockAt (Friday 00:05 UTC)
export function getLastWeekWindowUTC(now: Date): {
  weekStart: Date;
  weekEnd: Date;
  unlockAt: Date;
  dateStrings: string[];
  thisFridayStart: Date;
} {
  const thisFridayStart = getThisFridayStartUTC(now);
  const weekStart = new Date(thisFridayStart.getTime() - 7 * 24 * 60 * 60 * 1000);
  const weekEnd = new Date(thisFridayStart.getTime() - 1000); // Thursday 23:59:59
  const unlockAt = new Date(thisFridayStart.getTime() + 5 * 60 * 1000); // Friday 00:05 UTC

  // Build YYYY-MM-DD list for Fri..Thu
  const dateStrings: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart.getTime() + i * 24 * 60 * 60 * 1000);
    dateStrings.push(formatDateUTC(d));
  }
  return { weekStart, weekEnd, unlockAt, dateStrings, thisFridayStart };
}

// NEW: Weekly maturation (pending -> claimable) based on unlock_at + 30 days
export async function updateWeeklyPendingStatuses(): Promise<void> {
  if (!WEEKLY_MATURATION_ENABLED) {
    logSection('⏸️  Weekly maturation disabled');
    return;
  }
  const currentDate = getSimNow();
  const thirtyDaysAgo = new Date(currentDate.getTime() - 30 * 24 * 60 * 60 * 1000);
  const startTime = Date.now();

  logSection('Starting weekly rewards maturation job...');
  let documentsExamined = 0;
  let documentsUpdated = 0;
  let totalEntriesUpdated = 0;
  let totalAmountShifted = 0;
  let totalTfryShifted = 0;
  const assetAggregates = new Map<string, AssetAggregationState>();
  const deviceTypeAggregates = new Map<string, DeviceTypeAggregationState>();

  try {
    const Model = testMode ? TestDeviceRewardModel : DeviceRewardModel;

    type PendingWeeklyDoc = {
      _id: Types.ObjectId;
      miner_key?: string;
      pendingWeekly: Array<{
        amount: number;
        asset_id: string;
        unlock_at: Date;
      }>;
    };

    const pipeline = [
      {
        $match: {
          weekly_rewards: {
            $elemMatch: {
              status: 'pending',
              unlock_at: { $lte: thirtyDaysAgo },
            },
          },
        },
      },
      {
        $project: {
          miner_key: 1,
          pendingWeekly: {
            $filter: {
              input: '$weekly_rewards',
              as: 'wr',
              cond: {
                $and: [
                  { $eq: ['$$wr.status', 'pending'] },
                  { $lte: ['$$wr.unlock_at', thirtyDaysAgo] },
                ],
              },
            },
          },
        },
      },
    ] as mongoose.PipelineStage[];

    const cursor = Model.aggregate<PendingWeeklyDoc>(pipeline).cursor({ batchSize: 200 });

    const toFixed2 = (value: number): number => roundToTwo(value);

    for await (const doc of cursor as AsyncIterable<PendingWeeklyDoc>) {
      documentsExamined += 1;
      const pendingEntries = doc.pendingWeekly ?? [];
      if (!pendingEntries.length) {
        continue;
      }

      let delta = 0;
      let tfryDelta = 0;
      const maturedEntries: Array<{ assetLabel: string; amount: number }> = [];
      pendingEntries.forEach((entry) => {
        const amountRaw = Number(entry?.amount ?? 0);
        if (!Number.isFinite(amountRaw)) {
          return;
        }
        const roundedAmount = toFixed2(amountRaw);
        delta = toFixed2(delta + roundedAmount);
        const assetLabel = getRewardAssetLabel(entry?.asset_id);
        if (assetLabel === 'tFry') {
          tfryDelta = toFixed2(tfryDelta + roundedAmount);
        }
        maturedEntries.push({ assetLabel, amount: roundedAmount });
      });

      const inc: Record<string, number> = {};
      if (delta !== 0) {
        inc.total_pending = toFixed2(-delta);
        inc.total_claimable = toFixed2(delta);
      }
      if (tfryDelta !== 0) {
        inc.tfry_pending = toFixed2(-tfryDelta);
        inc.tfry_claimable = toFixed2(tfryDelta);
      }

      const updateDoc: Record<string, unknown> = {
        $set: {
          'weekly_rewards.$[wr].status': 'claimable',
          last_updated: currentDate,
        },
      };
      if (Object.keys(inc).length > 0) {
        updateDoc.$inc = inc;
      }

      const result = await Model.updateOne(
        {
          _id: doc._id,
          weekly_rewards: {
            $elemMatch: {
              status: 'pending',
              unlock_at: { $lte: thirtyDaysAgo },
            },
          },
        },
        updateDoc,
        {
          arrayFilters: [
            {
              'wr.status': 'pending',
              'wr.unlock_at': { $lte: thirtyDaysAgo },
            },
          ],
        },
      );

      if (result.modifiedCount && result.modifiedCount > 0) {
        documentsUpdated += 1;
        totalEntriesUpdated += pendingEntries.length;
        totalAmountShifted = toFixed2(totalAmountShifted + delta);
        totalTfryShifted = toFixed2(totalTfryShifted + tfryDelta);
        const deviceId =
          doc._id instanceof Types.ObjectId ? doc._id.toHexString() : String(doc._id);
        const deviceType = getDeviceTypeFromMinerKey(doc.miner_key);
        const deviceTypeState = ensureDeviceTypeAggregationState(deviceTypeAggregates, deviceType);
        deviceTypeState.devices.add(deviceId);
        maturedEntries.forEach(({ assetLabel, amount }) => {
          const globalAssetState = ensureAssetAggregationState(assetAggregates, assetLabel);
          globalAssetState.amount = toFixed2(globalAssetState.amount + amount);
          globalAssetState.rewards += 1;
          globalAssetState.devices.add(deviceId);

          deviceTypeState.totalAmount = toFixed2(deviceTypeState.totalAmount + amount);
          deviceTypeState.totalRewards += 1;

          const deviceTypeAssetState = ensureAssetAggregationState(deviceTypeState.assets, assetLabel);
          deviceTypeAssetState.amount = toFixed2(deviceTypeAssetState.amount + amount);
          deviceTypeAssetState.rewards += 1;
          deviceTypeAssetState.devices.add(deviceId);
        });
      }
    }

    logSection(
      `Weekly rewards maturation completed: docs=${documentsUpdated}/${documentsExamined}, entries=${totalEntriesUpdated}`,
    );
    const amountByAsset = buildAssetSummary(assetAggregates);
    const deviceTypeSummary = buildDeviceTypeSummary(deviceTypeAggregates);
    await sendWeeklyMaturationReport('completed', {
      documentsExamined,
      documentsUpdated,
      entriesUpdated: totalEntriesUpdated,
      totalAmountShifted,
      totalTfryShifted,
      durationMs: Date.now() - startTime,
      amountByAsset,
      deviceTypeSummary,
    });
  } catch (err) {
    console.error('Weekly maturation job failed:', err);
    const amountByAsset = buildAssetSummary(assetAggregates);
    const deviceTypeSummary = buildDeviceTypeSummary(deviceTypeAggregates);
    await sendWeeklyMaturationReport('failed', {
      documentsExamined,
      documentsUpdated,
      entriesUpdated: totalEntriesUpdated,
      totalAmountShifted,
      totalTfryShifted,
      durationMs: Date.now() - startTime,
      amountByAsset,
      deviceTypeSummary,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// Weekly roll-up execution bookkeeping; ensures we capture the same metrics we persist and report
type WeeklyRollupMetrics = {
  eligibleDevices: number;
  rewardedDevices: number;
  weeklyEntriesCreated: number;
  duplicateEntriesSkipped: number;
  errors: number;
  amountByAsset: Record<string, AssetSummary>;
  deviceTypeSummary: Record<string, DeviceTypeSummary>;
};

let weeklyIndexEnsured = false; // Cache flag so we only request index creation once per process

// Ensure the multikey unique index exists before we attempt writes; relies on Mongo's idempotent createIndex
async function ensureWeeklyRewardIndex(): Promise<void> {
  if (weeklyIndexEnsured) {
    return;
  }
  try {
    const model = testMode ? TestDeviceRewardModel : DeviceRewardModel;
    await model.collection.createIndex(
      { miner_key: 1, 'weekly_rewards.unlock_at': 1, 'weekly_rewards.asset_id': 1 },
      { unique: true, sparse: true, name: 'unique_weekly_window_per_asset' },
    );
    weeklyIndexEnsured = true;
  } catch (err: any) {
    if (err?.code === 85 || err?.codeName === 'IndexOptionsConflict') {
      weeklyIndexEnsured = true;
      return;
    }
    if (err?.code === 11000) {
      console.error('Failed to enforce weekly reward unique index due to existing duplicates:', err);
    } else {
      console.error('Failed to ensure weekly reward unique index:', err);
    }
  }
}

const isDuplicateKeyError = (err: unknown): boolean =>
  !!err && typeof err === 'object' && 'code' in err && (err as { code?: number }).code === 11000;

// Post-run Discord summary so on-call gets immediate insight into roll-up health/volume
async function sendWeeklyRollupReport(
  status: 'completed' | 'failed',
  summary: {
    jobKey: string;
    windowStart: Date;
    windowEnd: Date;
    unlockAt: Date;
    metrics: WeeklyRollupMetrics;
    durationMs: number;
    errorMessages: string[];
  },
): Promise<void> {
  const logPath = await writeReportFile(
    'weekly-rollup',
    `${summary.jobKey}.json`,
    summary,
  );
  const metrics = {
    ...summary.metrics,
    amountByAsset: withAssetBaseline(summary.metrics.amountByAsset),
  };
  const totalProcessed = metrics.rewardedDevices + metrics.duplicateEntriesSkipped + metrics.errors;
  const messageLines = [
    `Window: ${summary.windowStart.toISOString()} → ${summary.windowEnd.toISOString()} (unlock ${summary.unlockAt.toISOString()})`,
    `Eligible devices: ${metrics.eligibleDevices}`,
    `Rewarded devices: ${metrics.rewardedDevices}`,
    `Weekly entries created: ${metrics.weeklyEntriesCreated}`,
    `Duplicate entries skipped: ${metrics.duplicateEntriesSkipped}`,
    `Errors: ${metrics.errors}`,
    `Duration: ${(summary.durationMs / 1000).toFixed(1)}s`,
  ];

  const amountEntries = Object.entries(metrics.amountByAsset ?? {});
  if (amountEntries.length > 0) {
    messageLines.push('Payout totals:');
    amountEntries
      .sort(([a], [b]) => a.localeCompare(b))
      .forEach(([label, summaryValue]) => {
        const amountLine = `${summaryValue.amount.toFixed(2)} (${summaryValue.devices} devices / ${summaryValue.rewards} rewards)`;
        messageLines.push(`  • ${formatAssetLabel(label)}: ${amountLine}`);
      });
  }

  const deviceBreakdownEntries = Object.entries(metrics.deviceTypeSummary ?? {});
  if (deviceBreakdownEntries.length > 0) {
    messageLines.push('Totals per device type:');
    deviceBreakdownEntries
      .sort(([a], [b]) => a.localeCompare(b))
      .forEach(([deviceType, summaryValue]) => {
        messageLines.push(
          `  • ${deviceType}: total ${summaryValue.totalAmount.toFixed(2)} across ${summaryValue.devices} devices (${summaryValue.totalRewards} rewards)`,
        );
        const assetBreakdown = Object.entries(summaryValue.assets ?? {});
        assetBreakdown
          .sort(([a], [b]) => a.localeCompare(b))
          .forEach(([assetLabel, assetSummary]) => {
            messageLines.push(
              `      - ${formatAssetLabel(assetLabel)}: ${assetSummary.amount.toFixed(2)} (${assetSummary.devices} devices / ${assetSummary.rewards} rewards)`,
            );
          });
      });
  }

  if (logPath) {
    messageLines.push(`Full payload: ${path.relative(process.cwd(), logPath)}`);
  }

  const message = toDiscordMessage(
    messageLines,
    logPath
      ? `…truncated; full payload: ${path.relative(process.cwd(), logPath)}`
      : '…truncated; full payload written to logs.',
  );

  const alertLevel = status === 'completed' ? 'INFO' : 'CRITICAL';

  await alertingSystem.emit(alertLevel, `Weekly roll-up ${status}`, message, {
    jobKey: summary.jobKey,
    status,
    metrics: {
      ...metrics,
      totalProcessed,
    },
    durationMs: summary.durationMs,
    errors: summary.errorMessages.slice(0, 5),
  }, { force: true });
}

type WeeklyMaturationSummary = {
  documentsExamined: number;
  documentsUpdated: number;
  entriesUpdated: number;
  totalAmountShifted: number;
  totalTfryShifted: number;
  durationMs: number;
  amountByAsset: Record<string, AssetSummary>;
  deviceTypeSummary: Record<string, DeviceTypeSummary>;
  error?: string;
};

async function sendWeeklyMaturationReport(
  status: 'completed' | 'failed',
  summary: WeeklyMaturationSummary,
): Promise<void> {
  const logPath = await writeReportFile(
    'weekly-maturation',
    `weekly-maturation-${new Date().toISOString()}.json`,
    summary,
  );
  const amountByAsset = withAssetBaseline(summary.amountByAsset);
  const noMaturation = status === 'completed' && summary.entriesUpdated === 0;
  if (noMaturation) {
    const messageLines = [
      'Weekly maturation completed with no pending rewards to mature.',
      'Status: online (job ran successfully).',
    ];
    if (logPath) {
      messageLines.push(`Full payload: ${path.relative(process.cwd(), logPath)}`);
    }
    const message = toDiscordMessage(
      messageLines,
      logPath
        ? `...truncated; full payload: ${path.relative(process.cwd(), logPath)}`
        : '...truncated; full payload written to logs.',
    );
    await alertingSystem.emit(
      'INFO',
      'Weekly maturation completed (no changes)',
      message,
      undefined,
      { force: true },
    );
    return;
  }

  const messageLines = [
    `Documents examined: ${summary.documentsExamined}`,
    `Documents updated: ${summary.documentsUpdated}`,
    `Weekly entries flipped: ${summary.entriesUpdated}`,
    `Total amount shifted: ${summary.totalAmountShifted.toFixed(2)}`,
    `Duration: ${(summary.durationMs / 1000).toFixed(1)}s`,
  ];
  const amountEntries = Object.entries(amountByAsset ?? {});
  if (amountEntries.length > 0) {
    messageLines.push('Amount shifted by asset:');
    amountEntries
      .sort(([a], [b]) => a.localeCompare(b))
      .forEach(([label, assetSummary]) => {
        messageLines.push(
          `  • ${formatAssetLabel(label)}: ${assetSummary.amount.toFixed(2)} (${assetSummary.devices} devices / ${assetSummary.rewards} rewards)`,
        );
      });
  }

  const deviceBreakdownEntries = Object.entries(summary.deviceTypeSummary ?? {});
  if (deviceBreakdownEntries.length > 0) {
    messageLines.push('Totals per device type:');
    deviceBreakdownEntries
      .sort(([a], [b]) => a.localeCompare(b))
      .forEach(([deviceType, deviceSummary]) => {
        messageLines.push(
          `  • ${deviceType}: total ${deviceSummary.totalAmount.toFixed(2)} across ${deviceSummary.devices} devices (${deviceSummary.totalRewards} rewards)`,
        );
        const assetBreakdown = Object.entries(deviceSummary.assets ?? {});
        assetBreakdown
          .sort(([a], [b]) => a.localeCompare(b))
          .forEach(([assetLabel, assetSummary]) => {
            messageLines.push(
              `      - ${formatAssetLabel(assetLabel)}: ${assetSummary.amount.toFixed(2)} (${assetSummary.devices} devices / ${assetSummary.rewards} rewards)`,
            );
          });
      });
  }

  if (summary.error) {
    messageLines.push(`Error: ${summary.error}`);
  }

  if (logPath) {
    messageLines.push(`Full payload: ${path.relative(process.cwd(), logPath)}`);
  }

  const message = toDiscordMessage(
    messageLines,
    logPath
      ? `…truncated; full payload: ${path.relative(process.cwd(), logPath)}`
      : '…truncated; full payload written to logs.',
  );

  const level = status === 'completed' ? 'INFO' : 'CRITICAL';
  await alertingSystem.emit(
    level,
    `Weekly maturation ${status}`,
    message,
    {
      ...summary,
      amountByAsset,
    },
    { force: true },
  );
}

// NEW: Weekly roll-up (Friday 00:05 UTC)
export async function finalizeWeeklyRewards(referenceDate?: Date): Promise<void> {
  if (!WEEKLY_REWARDS_ENABLED) {
    return;
  }

  // Distributed guard so only one instance handles a window; metrics + status live in rewards_job_runs
  await withJobLock('weekly-rollup', ['hourly-processing', 'daily-backup', 'data-validation'], async () => {
    const now = getSimNow();
    const { weekStart, weekEnd, unlockAt, dateStrings } = getLastWeekWindowUTC(referenceDate ?? now);
    const jobKey = `${WEEKLY_ROLLUP_JOB_NAME}:${unlockAt.toISOString()}`;

    const JobRunModelToUse = testMode ? TestJobRunModel : JobRunModel;

    // Check existing run metadata before acquiring a new lock to handle stale/crashed executions gracefully
    const existingJob = await JobRunModelToUse.findOne({ job_key: jobKey }).exec();
    if (existingJob) {
      if (existingJob.status === 'completed') {
        logSection(`Weekly roll-up skipped: window ${unlockAt.toISOString()} already processed (completed).`);
        return;
      }
      if (existingJob.status === 'running') {
        const lastBeat = existingJob.last_heartbeat ?? existingJob.started_at ?? existingJob.window_start;
        const age = lastBeat ? now.getTime() - lastBeat.getTime() : 0;
        if (age <= WEEKLY_ROLLUP_LOCK_TTL_MS) {
          logSection(`Weekly roll-up skipped: window ${unlockAt.toISOString()} already running (heartbeat ${Math.round(age / 1000)}s ago).`);
          return;
        }
        await JobRunModelToUse.updateOne(
          { _id: existingJob._id, status: 'running' },
          {
            $set: { status: 'failed', last_heartbeat: now },
            $push: { error_messages: `Detected stale weekly roll-up; lock expired after ${Math.round(age / 1000)}s.` },
          },
        );
      }
    }

    await ensureWeeklyRewardIndex();

    let jobRun: JobRun | null = null;
    try {
      // Acquire/refresh job record; unique key enforces single active run per window even across processes
      jobRun = await JobRunModelToUse.findOneAndUpdate(
        { job_key: jobKey, status: { $in: ['pending', 'failed'] } },
        {
          $setOnInsert: {
            job_key: jobKey,
            job_name: WEEKLY_ROLLUP_JOB_NAME,
            window_start: weekStart,
            window_end: weekEnd,
            unlock_at: unlockAt,
          },
          $set: {
            status: 'running',
            started_at: now,
            last_heartbeat: now,
            'metrics.eligible_devices': 0,
            'metrics.rewarded_devices': 0,
            'metrics.weekly_entries_created': 0,
            'metrics.duplicate_entries_skipped': 0,
            'metrics.errors': 0,
            'metrics.amount_by_asset': {},
            'metrics.device_type_summary': {},
            error_messages: [],
          },
        },
        { upsert: true, new: true },
      );
    } catch (lockError) {
      if (isDuplicateKeyError(lockError)) {
        const existing = await JobRunModelToUse.findOne({ job_key: jobKey }).lean();
        if (existing && (existing.status === 'running' || existing.status === 'completed')) {
          logSection(`Weekly roll-up skipped: window ${unlockAt.toISOString()} already processed (${existing.status}).`);
          return;
        }
      }
      throw lockError;
    }

    if (!jobRun) {
      const existing = await JobRunModelToUse.findOne({ job_key: jobKey }).lean();
      if (existing && (existing.status === 'running' || existing.status === 'completed')) {
        logSection(`Weekly roll-up skipped: window ${unlockAt.toISOString()} already processed (${existing.status}).`);
        return;
      }
      logSection(`Weekly roll-up skipped: window ${unlockAt.toISOString()} status unknown (no lock acquired).`);
      return;
    }

    logSection(
      `Starting weekly roll-up for window ${weekStart.toISOString()} → ${weekEnd.toISOString()} (unlock ${unlockAt.toISOString()})`,
    );

    const Model = testMode ? TestDeviceRewardModel : DeviceRewardModel;

    type WeeklyRewardEntry = {
      week_start: Date;
      week_end: Date;
      unlock_at: Date;
      status: 'pending' | 'claimable' | 'claimed';
      asset_id: string;
      amount: number;
      created_at: Date;
      reward_number: number;
    };

    type RollupAggDoc = {
      _id: Types.ObjectId;
      miner_key: string;
      weekly_reward_count?: number;
      existingWeeklyKeys?: string[];
      accruals: Array<{ asset_id: string; amount: number; date: string }>;
    };

    const pipeline = [
      { $match: { daily_rewards: { $elemMatch: { status: 'accruing', date: { $in: dateStrings } } } } },
      {
        $project: {
          _id: 1,
          miner_key: 1,
          weekly_reward_count: 1,
          existingWeeklyKeys: {
            $map: {
              input: {
                $filter: { input: '$weekly_rewards', as: 'w', cond: { $eq: ['$$w.unlock_at', unlockAt] } },
              },
              as: 'w',
              in: {
                $concat: ['$$w.asset_id', '|', { $toString: '$$w.unlock_at' }],
              },
            },
          },
          accruals: {
            $filter: {
              input: '$daily_rewards',
              as: 'r',
              cond: { $and: [{ $eq: ['$$r.status', 'accruing'] }, { $in: ['$$r.date', dateStrings] }] },
            },
          },
        },
      },
    ];

    const cursor = Model.aggregate<RollupAggDoc>(pipeline).cursor({ batchSize: 200 });

    const metrics: WeeklyRollupMetrics = {
      eligibleDevices: 0,
      rewardedDevices: 0,
      weeklyEntriesCreated: 0,
      duplicateEntriesSkipped: 0,
      errors: 0,
      amountByAsset: {},
      deviceTypeSummary: {},
    };
    const assetAggregates = new Map<string, AssetAggregationState>();
    const deviceTypeAggregates = new Map<string, DeviceTypeAggregationState>();
    const errorMessages: string[] = [];
    const startTime = Date.now();

    const updateJobRunMetrics = async (): Promise<void> => {
      if (!jobRun?._id) {
        return;
      }
      await JobRunModelToUse.updateOne(
        { _id: jobRun._id },
        {
          $set: {
            last_heartbeat: getSimNow(),
            'metrics.eligible_devices': metrics.eligibleDevices,
            'metrics.rewarded_devices': metrics.rewardedDevices,
            'metrics.weekly_entries_created': metrics.weeklyEntriesCreated,
            'metrics.duplicate_entries_skipped': metrics.duplicateEntriesSkipped,
            'metrics.errors': metrics.errors,
          },
        },
      );
    };

    try {
      let processed = 0;
      for await (const doc of cursor as AsyncIterable<RollupAggDoc>) {
        const accruals = doc.accruals || [];
        if (!accruals.length) {
          continue;
        }

        metrics.eligibleDevices += 1;

        const byAsset = new Map<string, number>();
        for (const r of accruals) {
          const current = byAsset.get(r.asset_id) || 0;
          byAsset.set(r.asset_id, Math.round((current + (r.amount || 0)) * 100) / 100);
        }

        const weeklyEntries: WeeklyRewardEntry[] = [];
        const startNo = (doc.weekly_reward_count || 0) + 1;
        let idx = 0;
        let tfryPendingDelta = 0;
        let tfryAggregatedDelta = 0;
        let otherAssetPending = 0;
        const existingKeys = new Set<string>((doc.existingWeeklyKeys || []).map((key: string) => String(key)));

        for (const [asset_id, amount] of byAsset.entries()) {
          const weeklyKey = `${String(asset_id)}|${unlockAt.toISOString()}`;
          if (existingKeys.has(weeklyKey)) {
            metrics.duplicateEntriesSkipped += 1;
            continue;
          }
          if (!(amount > 0)) {
            continue;
          }

          weeklyEntries.push({
            week_start: weekStart,
            week_end: weekEnd,
            unlock_at: unlockAt,
            status: 'pending',
            asset_id,
            amount,
            created_at: unlockAt,
            reward_number: startNo + idx,
          });
          idx += 1;
          if (isTfryAsset(asset_id)) {
            tfryPendingDelta = Math.round((tfryPendingDelta + amount) * 100) / 100;
            tfryAggregatedDelta = Math.round((tfryAggregatedDelta + amount) * 100) / 100;
          } else {
            otherAssetPending = Math.round((otherAssetPending + amount) * 100) / 100;
          }
          existingKeys.add(weeklyKey);
        }

        if (!weeklyEntries.length) {
          continue;
        }

        const inc: Record<string, number> = { weekly_reward_count: weeklyEntries.length };
        if (otherAssetPending !== 0) {
          inc.total_pending = otherAssetPending;
        }
        if (tfryPendingDelta !== 0 || tfryAggregatedDelta !== 0) {
          applyTfryDelta(inc, {
            pending: tfryPendingDelta || undefined,
            aggregated: tfryAggregatedDelta || undefined,
          });
        }

        const update: Record<string, unknown> = {
          $set: { 'daily_rewards.$[elem].status': 'aggregated', last_updated: now },
          $push: { weekly_rewards: { $each: weeklyEntries } },
          $inc: inc,
        };
        const arrayFilters = [{ 'elem.status': 'accruing', 'elem.date': { $in: dateStrings } }];

        try {
          const res = await Model.updateOne({ _id: doc._id }, update, { arrayFilters });
          if (res.modifiedCount && res.modifiedCount > 0) {
            metrics.rewardedDevices += 1;
            metrics.weeklyEntriesCreated += weeklyEntries.length;
            const deviceType = getDeviceTypeFromMinerKey(doc.miner_key);
            const deviceId =
              doc._id instanceof Types.ObjectId ? doc._id.toHexString() : String(doc._id);
            const deviceTypeState = ensureDeviceTypeAggregationState(deviceTypeAggregates, deviceType);
            deviceTypeState.devices.add(deviceId);
            weeklyEntries.forEach((entry) => {
              const label = getRewardAssetLabel(entry.asset_id);
              const roundedAmount = roundToTwo(entry.amount ?? 0);

              const globalAssetState = ensureAssetAggregationState(assetAggregates, label);
              globalAssetState.amount = roundToTwo(globalAssetState.amount + roundedAmount);
              globalAssetState.rewards += 1;
              globalAssetState.devices.add(deviceId);

              deviceTypeState.totalAmount = roundToTwo(deviceTypeState.totalAmount + roundedAmount);
              deviceTypeState.totalRewards += 1;

              const deviceTypeAssetState = ensureAssetAggregationState(deviceTypeState.assets, label);
              deviceTypeAssetState.amount = roundToTwo(deviceTypeAssetState.amount + roundedAmount);
              deviceTypeAssetState.rewards += 1;
              deviceTypeAssetState.devices.add(deviceId);
            });
          } else {
            metrics.duplicateEntriesSkipped += weeklyEntries.length;
          }
        } catch (error) {
          if (isDuplicateKeyError(error)) {
            metrics.duplicateEntriesSkipped += weeklyEntries.length;
          } else {
            metrics.errors += 1;
            const identifier = doc.miner_key ?? doc._id.toHexString();
            errorMessages.push(`${identifier}: ${(error as Error).message || error}`);
          }
        }

        processed += 1;
        if (processed % 250 === 0) {
          await updateJobRunMetrics();
        }
      }

      const finishTime = getSimNow();
      metrics.amountByAsset = buildAssetSummary(assetAggregates);
      metrics.deviceTypeSummary = buildDeviceTypeSummary(deviceTypeAggregates);
      const status: 'completed' | 'failed' = metrics.errors > 0 ? 'failed' : 'completed';

      if (!jobRun?._id) {
        console.error('Weekly roll-up could not record completion: missing jobRun reference.');
        return;
      }
      await JobRunModelToUse.updateOne(
        { _id: jobRun._id },
        {
          $set: {
            status,
            finished_at: finishTime,
            last_heartbeat: finishTime,
            'metrics.eligible_devices': metrics.eligibleDevices,
            'metrics.rewarded_devices': metrics.rewardedDevices,
            'metrics.weekly_entries_created': metrics.weeklyEntriesCreated,
            'metrics.duplicate_entries_skipped': metrics.duplicateEntriesSkipped,
            'metrics.errors': metrics.errors,
            'metrics.amount_by_asset': metrics.amountByAsset,
            'metrics.device_type_summary': metrics.deviceTypeSummary,
            error_messages: errorMessages.slice(0, 20),
          },
        },
      );

      await sendWeeklyRollupReport(status, {
        jobKey,
        windowStart: weekStart,
        windowEnd: weekEnd,
        unlockAt,
        metrics,
        durationMs: Date.now() - startTime,
        errorMessages,
      });

      if (status === 'completed') {
        logSection(
          `Weekly roll-up completed: eligible=${metrics.eligibleDevices}, rewarded=${metrics.rewardedDevices}, duplicates=${metrics.duplicateEntriesSkipped}`,
        );
      } else {
        console.error(
          `Weekly roll-up finished with errors: eligible=${metrics.eligibleDevices}, rewarded=${metrics.rewardedDevices}, duplicates=${metrics.duplicateEntriesSkipped}, errors=${metrics.errors}`,
        );
      }
    } catch (err) {
      metrics.errors += 1;
      const errorMessage = err instanceof Error ? err.message : String(err);
      errorMessages.push(errorMessage);
      const finishTime = getSimNow();
      metrics.amountByAsset = buildAssetSummary(assetAggregates);
      metrics.deviceTypeSummary = buildDeviceTypeSummary(deviceTypeAggregates);
      if (!jobRun?._id) {
        console.error('Weekly roll-up failed but job record missing. Error:', err);
        return;
      }
      await JobRunModelToUse.updateOne(
        { _id: jobRun._id },
        {
          $set: {
            status: 'failed',
            finished_at: finishTime,
            last_heartbeat: finishTime,
            'metrics.eligible_devices': metrics.eligibleDevices,
            'metrics.rewarded_devices': metrics.rewardedDevices,
            'metrics.weekly_entries_created': metrics.weeklyEntriesCreated,
            'metrics.duplicate_entries_skipped': metrics.duplicateEntriesSkipped,
            'metrics.errors': metrics.errors,
            'metrics.amount_by_asset': metrics.amountByAsset,
            'metrics.device_type_summary': metrics.deviceTypeSummary,
          },
          $push: { error_messages: errorMessage },
        },
      );
      await sendWeeklyRollupReport('failed', {
        jobKey,
        windowStart: weekStart,
        windowEnd: weekEnd,
        unlockAt,
        metrics,
        durationMs: Date.now() - startTime,
        errorMessages,
      });
      console.error('Weekly roll-up failed:', err);
    }
  });
}

// Schedule weekly roll-up at Friday 00:05–00:10 UTC window
function scheduleWeeklyRollup() {
  setInterval(async () => {
    if (!WEEKLY_REWARDS_ENABLED) return;
    const now = getSimNow();
    // Use UTC day/hour/minute
    const isFriday = now.getUTCDay() === 5;
    const hourUTC = now.getUTCHours();
    const minuteUTC = now.getUTCMinutes();
    if (isFriday && hourUTC === 0 && minuteUTC >= 5 && minuteUTC <= 10) {
      const keyDate = formatDateUTC(getThisFridayStartUTC(now));
      const thisFridayKey = `weekly-rollup-${keyDate}`;
      if (!lastExecutionHours.includes(thisFridayKey)) {
        weeklyRollupInProgress = true;
        try {
          await finalizeWeeklyRewards();
        } finally {
          weeklyRollupInProgress = false;
        }
        // Post-roll-up catch-up: ensure hour 0 accrual runs even if the :15 window was skipped
        const after = getSimNow();
        const midnightKey = `${after.toDateString()}-0`;
        if (after.getHours() === 0 && !lastExecutionHours.includes(midnightKey)) {
          const cachedDevices = await loadRegisteredDevices();
          await runHourBatch(0, cachedDevices);
        }
        lastExecutionHours.push(thisFridayKey);
        // Keep only last 8 roll keys
        const rollKeys = lastExecutionHours.filter(k => k.startsWith('weekly-rollup-'));
        if (rollKeys.length > 8) {
          const toRemove = rollKeys.slice(0, rollKeys.length - 8);
          lastExecutionHours = lastExecutionHours.filter(k => !toRemove.includes(k));
        }
      }
    }
  }, scaledIntervalMs(5 * 60 * 1000)); // every 5 minutes (scaled)
}

// On startup, if it's already past last Friday's unlock time and the roll-up
// was not recorded, run it once immediately.
async function maybeRunMissedWeeklyRollup(): Promise<void> {
  if (!WEEKLY_REWARDS_ENABLED) return;
  try {
    const now = getSimNow();
    const { unlockAt, dateStrings } = getLastWeekWindowUTC(now);
    if (now < unlockAt) return; // not yet time for the last window

    const Model = testMode ? TestDeviceRewardModel : DeviceRewardModel;
    // If any weekly reward exists for unlockAt, consider it done
    const alreadyRolled = await Model.findOne({ 'weekly_rewards.unlock_at': unlockAt }).select({ _id: 1 }).lean();
    if (alreadyRolled) return;

    // Ensure there is something to roll up (accruing rows in that week)
    const hasAccruals = await Model.findOne({
      daily_rewards: { $elemMatch: { status: 'accruing', date: { $in: dateStrings } } }
    }).select({ _id: 1 }).lean();
    if (!hasAccruals) return;

    logSection('Missed weekly roll-up detected — running now.');
    weeklyRollupInProgress = true;
    try {
      await finalizeWeeklyRewards();
    } finally {
      weeklyRollupInProgress = false;
    }
  } catch (err) {
    console.error('maybeRunMissedWeeklyRollup failed:', err);
  }
}

// Schedule global status updates daily at 2:50 AM
function scheduleStatusUpdates() {
  setInterval(async () => {
    const now = getSimNow();
    if (now.getHours() === 2 && now.getMinutes() >= 50 && now.getMinutes() <= 55) {
      // Check if we already ran today
      const todayKey = `status-update-${now.toDateString()}`;
      if (!lastExecutionHours.includes(todayKey)) {
        await updateAllPendingStatuses();
        // Also update weekly pending -> claimable maturation
        if (INLINE_WEEKLY_JOBS) {
          await updateWeeklyPendingStatuses();
        }
        lastExecutionHours.push(todayKey);

        // Keep only last 7 days of status update records
        const statusUpdateKeys = lastExecutionHours.filter(key => key.startsWith('status-update-'));
        if (statusUpdateKeys.length > 7) {
          const keysToRemove = statusUpdateKeys.slice(0, statusUpdateKeys.length - 7);
          lastExecutionHours = lastExecutionHours.filter(key => !keysToRemove.includes(key));
        }

        // Catch up the current hour if the maintenance window overlapped the execution slot
        const afterUpdates = getSimNow();
        const catchupHour = afterUpdates.getHours();
        const catchupKey = `${afterUpdates.toDateString()}-${catchupHour}`;
        if (!lastExecutionHours.includes(catchupKey)) {
          const cachedDevices = await loadRegisteredDevices();
          await runHourBatch(catchupHour, cachedDevices);
        }
      }
    }
  }, scaledIntervalMs(5 * 60 * 1000)); // Check every 5 minutes (scaled)
}

// Function to start the reward system
export async function startRewardSystem(): Promise<void> {
  // Validate environment before starting
  printEnvironmentStatus();
  
  // Log hardware validation configuration
  const getValidationStatus = (envVar: string | undefined): string => {
    if (!envVar) return 'ENABLED (default)';
    return envVar.toLowerCase() === 'false' ? 'DISABLED' : 'ENABLED';
  };
  
  logSection(
    '🔐 Hardware Validation Status:',
    `  - AEM Devices: ${getValidationStatus(process.env.VALIDATE_HARDWARE_AEM)}`,
    `  - Node Devices (CN/SDN/RDN/SVN): ${getValidationStatus(process.env.VALIDATE_HARDWARE_NODES)}`,
    `  - Hardware Miners (BM/ISM/OSM/IDM/ODM): ${getValidationStatus(process.env.VALIDATE_HARDWARE_MINERS)}`,
    `  - Radiation Sensors (IRM): ${getValidationStatus(process.env.VALIDATE_CREDENTIALS_RADIATION)} [future]`,
    `  - Energy Monitors (EM): ${getValidationStatus(process.env.VALIDATE_CREDENTIALS_ENERGY)} [future]`,
    `  - Air Quality (IHAQM, etc.): ${getValidationStatus(process.env.VALIDATE_CREDENTIALS_AIR)} [future]`,
    `  - Weather Monitors (HWM/LWM): ${getValidationStatus(process.env.VALIDATE_CREDENTIALS_WEATHER)} [future]`,
    `  - Water Quality (OLWQM/OHWQM): ${getValidationStatus(process.env.VALIDATE_CREDENTIALS_WATER)} [future]`
  );
  
  logSection(
    `Reward system starting with hourly processing...`,
    `System will process devices every hour at minute 15`,
    `Each device assigned to specific hour based on device ID hash`,
    `Global status updates will run daily at 2:50 AM`,
    `Weekly roll-up ${WEEKLY_REWARDS_ENABLED ? 'ENABLED' : 'DISABLED'} (Friday 00:05 UTC)`,
    getTimeConfigSummary()
  );

  // Initialize error tracker
  errorTracker.initialize();

  // Initialize security services
  logSection('🔐 Initializing security services...');
  tokenManager.checkAndRotateToken().catch(err => 
    console.error('Token manager initialization failed:', err)
  );
  // backupManager.startDailyBackups();
  // dataValidator.startPeriodicValidation();

  // Heavy background jobs can be disabled (default off in simulation)
  const SIM_ON = process.env.SIMULATION_ENABLED === 'true';
  const BACKUPS_ENABLED = (process.env.BACKUPS_ENABLED ?? (SIM_ON ? 'false' : 'true')) !== 'false';
  const DATA_VALIDATOR_ENABLED = (process.env.DATA_VALIDATOR_ENABLED ?? (SIM_ON ? 'false' : 'true')) !== 'false';
  if (BACKUPS_ENABLED) {
    backupManager.startDailyBackups();
  } else {
    logSection('📦 Backups disabled by configuration');
  }
  if (DATA_VALIDATOR_ENABLED) {
    dataValidator.startPeriodicValidation();
  } else {
    logSection('🧪 Data validation disabled by configuration');
  }
  logSection('✅ Security services initialized');

  // Ensure database connection before any jobs run
  try {
    await connect();
  } catch (err) {
    console.error('Failed to connect to MongoDB before startup jobs:', err);
    throw err;
  }

  // Start the systems
  // Optional one-time daily maturation (e.g., after downtime). Ensure it completes before scheduling.
  if (RUN_DAILY_MATURATION_ONCE) {
    await runDailyMaturationOnce();
  }
  // If the process starts after a Friday window, ensure last week's roll-up happened
  if (INLINE_WEEKLY_JOBS) {
    await maybeRunMissedWeeklyRollup();
  }
  await rewardSystem();
  scheduleStatusUpdates();
  if (INLINE_WEEKLY_JOBS) {
    scheduleWeeklyRollup();
  }
  startPeriodicHealthChecks(); // Start Discord alerting system

  // Check every minute for execution time
  setInterval(rewardSystem, scaledIntervalMs(60 * 1000));

  // Log database performance summary every hour
  setInterval(() => {
    logSection(`📊 ${dbPerformanceMonitor.getPerformanceSummary()}`);
  }, scaledIntervalMs(60 * 60 * 1000));
}

// Only start if this file is run directly
if (require.main === module) {
  startRewardSystem().catch(err => {
    console.error('Fatal start error:', err);
    process.exit(1);
  });
}
