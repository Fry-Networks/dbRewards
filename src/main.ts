import path from "path";
import { connect, getConnection } from "./db/connect";
import { Device, DeviceModel, TestDeviceModel } from "./db/devices-schema";
import "dotenv/config";
import { ProductModel, Product } from "./db/products-schema";
import { RewardModel, TestRewardModel } from "./db/rewards-schema";
// NEW: Import device rewards schema for aggregated reward system
import { DeviceRewardModel, TestDeviceRewardModel, DeviceReward } from "./db/device-rewards-schema";
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

const testMode = process.env.TEST_MODE
  ? process.env.TEST_MODE === "true"
  : false;
const WEEKLY_REWARDS_ENABLED = process.env.WEEKLY_REWARDS_ENABLED === 'true';
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

interface PendingFlipDoc { _id: Types.ObjectId; miner_key?: string; amountToFlip: number }

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

const main = async (devicesToProcess?: Device[]): Promise<HourlyRunResult> => {
  await connect();
  const connection = getConnection();
  const db = connection.connection;

  // OLD_LOGIC_BACKUP: Only ensured old reward collections
  // await ensureCollectionsExist(db, ["rewards", "test-rewards"]);
  
  // Ensure aggregated collection exists
  await ensureCollectionsExist(db, [
    "device-rewards"
  ]);

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
      async () => testMode
        ? ((await TestDeviceModel.find({ is_registered: true })) as Device[])
        : ((await DeviceModel.find({ is_registered: true })) as Device[])
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

      // Record this execution and clear in-flight marker
      lastExecutionHours.push(hourKey);
      inFlightHours.delete(hourKey);
      
      // Keep only last 48 hours to prevent memory bloat
      if (lastExecutionHours.length > 48) {
        lastExecutionHours = lastExecutionHours.slice(-48);
      }
      
      logSection(`Completed hourly processing for hour ${currentHour}`);
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
async function runHourBatch(hour: number): Promise<void> {
  if (weeklyRollupInProgress) return; // safety guard
  const now = getSimNow();
  const hourKey = `${now.toDateString()}-${hour}`;
  if (lastExecutionHours.includes(hourKey)) return; // already processed

  logSection(`Catch-up: processing hour ${hour} batch after weekly roll-up`);
  const startTime = getSimNow();

  try {
    await connect();
    const allDevices: Device[] = await withPerformanceMonitoring(
      'find',
      testMode ? 'test-devices' : 'devices',
      async () => testMode
        ? ((await TestDeviceModel.find({ is_registered: true })) as Device[])
        : ((await DeviceModel.find({ is_registered: true })) as Device[])
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
      const upd = await Model.updateOne(
        { _id: doc._id },
        {
          $set: { 'daily_rewards.$[elem].status': 'claimable', last_updated: currentDate },
          $inc: { total_pending: -amount, total_claimable: amount }
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
function getLastWeekWindowUTC(now: Date): {
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
async function updateWeeklyPendingStatuses(): Promise<void> {
  if (!WEEKLY_MATURATION_ENABLED) {
    logSection('⏸️  Weekly maturation disabled');
    return;
  }
  const currentDate = getSimNow();
  const thirtyDaysAgo = new Date(currentDate.getTime() - 30 * 24 * 60 * 60 * 1000);

  logSection('Starting weekly rewards maturation job...');
  try {
    const devices = await (testMode ? TestDeviceRewardModel : DeviceRewardModel)
      .find({ 'weekly_rewards': { $elemMatch: { status: 'pending', unlock_at: { $lte: thirtyDaysAgo } } } });

    let totalUpdated = 0;
    for (const deviceReward of devices) {
      let delta = 0;
      let updatedCount = 0;
      deviceReward.weekly_rewards.forEach(wr => {
        if (wr.status === 'pending' && wr.unlock_at <= thirtyDaysAgo) {
          wr.status = 'claimable';
          delta += wr.amount;
          updatedCount++;
        }
      });
      if (updatedCount > 0) {
        deviceReward.total_pending -= delta;
        deviceReward.total_claimable += delta;
        deviceReward.last_updated = currentDate;
        deviceReward.markModified?.('weekly_rewards');
        await deviceReward.save();
        totalUpdated += updatedCount;
        logSection(`Weekly maturation: ${updatedCount} entries claimable for ${deviceReward.miner_key} (amount: ${delta})`);
      }
    }
    logSection(`Weekly rewards maturation completed: ${totalUpdated} entries updated`);
  } catch (err) {
    console.error('Weekly maturation job failed:', err);
  }
}

// NEW: Weekly roll-up (Friday 00:05 UTC)
async function finalizeWeeklyRewards(): Promise<void> {
  if (!WEEKLY_REWARDS_ENABLED) {
    return;
  }
  const now = getSimNow();
  const { weekStart, weekEnd, unlockAt, dateStrings } = getLastWeekWindowUTC(now);

  logSection(`Starting weekly roll-up for window ${weekStart.toISOString()} → ${weekEnd.toISOString()} (unlock ${unlockAt.toISOString()})`);

  try {
    // Use an aggregation cursor to avoid loading all docs into memory.
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
      existingWeeklyAssets?: string[];
      accruals: Array<{ asset_id: string; amount: number; date: string }>;
    };
    const pipeline = [
      { $match: { daily_rewards: { $elemMatch: { status: 'accruing', date: { $in: dateStrings } } } } },
      { $project: {
          _id: 1,
          miner_key: 1,
          weekly_reward_count: 1,
          existingWeeklyAssets: {
            $map: {
              input: {
                $filter: { input: '$weekly_rewards', as: 'w', cond: { $eq: ['$$w.unlock_at', unlockAt] } }
              },
              as: 'w', in: '$$w.asset_id'
            }
          },
          accruals: {
            $filter: {
              input: '$daily_rewards', as: 'r',
              cond: { $and: [ { $eq: ['$$r.status','accruing'] }, { $in: ['$$r.date', dateStrings] } ] }
            }
          }
        }
      }
    ];

    const cursor = Model.aggregate<RollupAggDoc>(pipeline).cursor({ batchSize: 200 });

    let devicesProcessed = 0;
    for await (const doc of cursor as AsyncIterable<RollupAggDoc>) {
      const accruals = doc.accruals || [];
      if (!accruals.length) continue;

      const byAsset = new Map<string, number>();
      for (const r of accruals) {
        byAsset.set(r.asset_id, Math.round(((byAsset.get(r.asset_id) || 0) + (r.amount || 0)) * 100) / 100);
      }

      const existing = new Set<string>((doc.existingWeeklyAssets || []).map((x: string) => String(x)));

      const weeklyEntries: WeeklyRewardEntry[] = [];
      const startNo = (doc.weekly_reward_count || 0) + 1;
      let idx = 0;
      let incPending = 0;
      for (const [asset_id, amount] of byAsset.entries()) {
        if (existing.has(String(asset_id))) continue; // already aggregated for this asset in this window
        weeklyEntries.push({
          week_start: weekStart,
          week_end: weekEnd,
          unlock_at: unlockAt,
          status: 'pending',
          asset_id,
          amount,
          created_at: unlockAt,
          reward_number: startNo + idx
        });
        idx++;
        incPending += amount;
      }

      // Always mark window accruals as aggregated (idempotent). Only bump totals/counts if we added entries.
      const update: Record<string, unknown> = {
        $set: { 'daily_rewards.$[elem].status': 'aggregated', last_updated: now },
      };
      const arrayFilters = [ { 'elem.status': 'accruing', 'elem.date': { $in: dateStrings } } ];

      if (weeklyEntries.length > 0) {
        update.$push = { weekly_rewards: { $each: weeklyEntries } };
        update.$inc = { weekly_reward_count: weeklyEntries.length, total_pending: incPending };
      }

      const res = await Model.updateOne({ _id: doc._id }, update, { arrayFilters });
      if (res.modifiedCount && res.modifiedCount > 0) {
        devicesProcessed++;
      }
    }
    logSection(`Weekly roll-up completed: ${devicesProcessed} devices processed (streamed)`);
    if (devicesProcessed === 0) {
      console.warn('⚠️ Weekly roll-up processed 0 devices. Check scheduler and accrual writes.');
      try { await alertingSystem.sendTestAlert(); } catch {}
    }
  } catch (err) {
    console.error('Weekly roll-up failed:', err);
  }
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
          await runHourBatch(0);
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
        await updateWeeklyPendingStatuses();
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
          await runHourBatch(catchupHour);
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
  await maybeRunMissedWeeklyRollup();
  await rewardSystem();
  scheduleStatusUpdates();
  scheduleWeeklyRollup();
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
