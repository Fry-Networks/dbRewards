import 'dotenv/config';
import mongoose from 'mongoose';
import { connect } from '../db/connect';
import { finalizeWeeklyRewards, updateWeeklyPendingStatuses } from '../main';
import { logSection } from '../logger';
import { getSimNow, scaledIntervalMs } from '../time-control';

function formatUtcDate(date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

async function startWeeklyWorker(): Promise<void> {
  await connect();
  logSection('Weekly job worker online — awaiting schedule triggers.');

  try {
    await updateWeeklyPendingStatuses();
  } catch (err) {
    console.error('Startup weekly maturation catch-up failed:', err);
  }

  let lastRollupKey: string | null = null;
  let lastMaturationKey: string | null = null;
  let rollupInFlight = false;
  let maturationInFlight = false;

  const runRollupIfNeeded = async (now: Date): Promise<void> => {
    if (now.getUTCDay() !== 5 || now.getUTCHours() !== 0 || now.getUTCMinutes() !== 0) {
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

  const tick = async (): Promise<void> => {
    const now = getSimNow();
    await runRollupIfNeeded(now);
    await runMaturationIfNeeded(now);
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
