import 'dotenv/config';
import mongoose from 'mongoose';
import { connect } from '../db/connect';
import { finalizeWeeklyRewards, updateWeeklyPendingStatuses, getLastWeekWindowUTC } from '../main';
import { JobRunModel } from '../db/job-run-schema';
import { DeviceRewardModel } from '../db/device-rewards-schema';
import { logSection } from '../logger';
import { getSimNow, scaledIntervalMs } from '../time-control';

const MAX_CATCHUP_WEEKS = 4;

function formatUtcDate(date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

async function runStartupCatchUp(): Promise<void> {
  logSection('Checking for missed weekly rollups...');
  const now = getSimNow();
  let missedCount = 0;

  // Check the last MAX_CATCHUP_WEEKS weeks, oldest first (reverse after collecting)
  const missedWeeks: Array<{ refDate: Date; dateStrings: string[] }> = [];

  for (let weeksBack = 0; weeksBack < MAX_CATCHUP_WEEKS; weeksBack++) {
    const refDate = new Date(now.getTime() - weeksBack * 7 * 24 * 60 * 60 * 1000);
    const { unlockAt, dateStrings } = getLastWeekWindowUTC(refDate);

    // Skip if this window is still in the future
    if (now < unlockAt) continue;

    // Check if already rolled up via job_runs
    const jobKey = `weekly-rollup:${unlockAt.toISOString()}`;
    const existingJob = await JobRunModel.findOne({ job_key: jobKey, status: 'completed' }).lean();
    if (existingJob) continue;

    // Check if there are accruing entries for this week
    const hasAccruals = await DeviceRewardModel.findOne({
      daily_rewards: { $elemMatch: { status: 'accruing', date: { $in: dateStrings } } },
    })
      .select({ _id: 1 })
      .lean();
    if (!hasAccruals) continue;

    missedWeeks.push({ refDate, dateStrings });
  }

  // Process in chronological order (oldest first)
  missedWeeks.reverse();

  for (const { refDate, dateStrings } of missedWeeks) {
    logSection(
      `CATCH-UP: Found missed rollup for week ${dateStrings[0]} to ${dateStrings[6]}, processing...`,
    );
    try {
      await finalizeWeeklyRewards(refDate);
      logSection(
        `CATCH-UP: Successfully processed missed rollup for week ${dateStrings[0]} to ${dateStrings[6]}`,
      );
      missedCount++;
    } catch (err) {
      console.error(`CATCH-UP: Failed to process rollup for week ${dateStrings[0]}:`, err);
    }
  }

  if (missedCount === 0) {
    logSection('No missed rollups detected.');
  } else {
    logSection(`CATCH-UP: Processed ${missedCount} missed rollup(s).`);
  }
}

async function startWeeklyWorker(): Promise<void> {
  await connect();
  logSection('Weekly job worker online — awaiting schedule triggers.');

  try {
    await updateWeeklyPendingStatuses();
  } catch (err) {
    console.error('Startup weekly maturation catch-up failed:', err);
  }

  try {
    await runStartupCatchUp();
  } catch (err) {
    console.error('Startup rollup catch-up failed:', err);
  }

  let lastRollupKey: string | null = null;
  let lastMaturationKey: string | null = null;
  let lastSafetyCheckKey: string | null = null;
  let rollupInFlight = false;
  let maturationInFlight = false;

  const runRollupIfNeeded = async (now: Date): Promise<void> => {
    if (now.getUTCDay() !== 5 || now.getUTCHours() !== 0 || now.getUTCMinutes() > 29) {
      return;
    }
    const key = `rollup-${formatUtcDate(now)}`;
    if (lastRollupKey === key || rollupInFlight) {
      return;
    }

    rollupInFlight = true;
    try {
      await finalizeWeeklyRewards();
      lastRollupKey = key;
    } catch (err) {
      console.error('Scheduled weekly roll-up failed:', err);
    } finally {
      rollupInFlight = false;
    }
  };

  const runMaturationIfNeeded = async (now: Date): Promise<void> => {
    if (now.getUTCHours() !== 3 || now.getUTCMinutes() !== 0) {
      return;
    }
    const key = `maturation-${formatUtcDate(now)}`;
    if (lastMaturationKey === key || maturationInFlight) {
      return;
    }

    maturationInFlight = true;
    try {
      await updateWeeklyPendingStatuses();
      lastMaturationKey = key;
    } catch (err) {
      console.error('Scheduled weekly maturation failed:', err);
    } finally {
      maturationInFlight = false;
    }
  };

  const runPeriodicSafetyCheck = async (now: Date): Promise<void> => {
    // Run once per hour at minute 30
    if (now.getUTCMinutes() !== 30) return;
    const key = `safety-${formatUtcDate(now)}-${now.getUTCHours()}`;
    if (lastSafetyCheckKey === key) return;
    lastSafetyCheckKey = key;

    // Check for accruing entries older than 8 days (should have been rolled up)
    const eightDaysAgo = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
    const cutoffDate = formatUtcDate(eightDaysAgo);
    const staleAccruals = await DeviceRewardModel.findOne({
      daily_rewards: { $elemMatch: { status: 'accruing', date: { $lt: cutoffDate } } },
    })
      .select({ _id: 1 })
      .lean();

    if (staleAccruals) {
      logSection(
        'SAFETY CHECK: Found stale accruing entries older than 8 days — triggering catch-up...',
      );
      await runStartupCatchUp();
    }
  };

  const tick = async (): Promise<void> => {
    const now = getSimNow();
    await runRollupIfNeeded(now);
    await runMaturationIfNeeded(now);
    await runPeriodicSafetyCheck(now);
  };

  await tick();

  const intervalHandle = setInterval(() => {
    tick().catch((err) => {
      console.error('Weekly job worker tick failed:', err);
    });
  }, scaledIntervalMs(60 * 1000));

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logSection(`Weekly job worker shutting down (${signal})...`);
    clearInterval(intervalHandle);
    try {
      await mongoose.connection.close();
    } catch (err) {
      console.error('Failed to close MongoDB connection during shutdown:', err);
    } finally {
      process.exit(0);
    }
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (require.main === module) {
  startWeeklyWorker().catch(async (err) => {
    console.error('Weekly job worker encountered a fatal error:', err);
    try {
      await mongoose.connection.close();
    } catch (closeErr) {
      console.error('Failed to close MongoDB connection after fatal error:', closeErr);
    } finally {
      process.exit(1);
    }
  });
}

export { startWeeklyWorker as runWeeklyJobs };
