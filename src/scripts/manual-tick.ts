import 'dotenv/config';
import path from 'path';
import mongoose from 'mongoose';
import { connect } from '../db/connect';
import { DeviceModel, Device } from '../db/devices-schema';
import { ProductModel, Product } from '../db/products-schema';
import { doRewards } from '../reward';
import { withJobLock } from '../scheduler/job-lock';
import { logSection } from '../logger';
import { writeRewardCsvReports } from '../reporting/csv-writer';
import { RewardReportAggregator } from '../reporting/reward-report';
import { getSimNow } from '../time-control';

// Replicated from main.ts:190-198 (not exported)
function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
}

// Replicated from main.ts:201-205 (not exported)
function getDevicesForHour(devices: Device[], hour: number): Device[] {
  return devices.filter(device => {
    const deviceHash = hashString(device._id.toString());
    return deviceHash % 24 === hour;
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const hourIdx = process.argv.indexOf('--hour');
  if (hourIdx === -1 || hourIdx + 1 >= process.argv.length) {
    console.error('Usage: manual-tick.js --hour <0-23>');
    process.exit(1);
  }
  const hour = parseInt(process.argv[hourIdx + 1], 10);
  if (isNaN(hour) || hour < 0 || hour > 23) {
    console.error('Invalid hour: must be 0-23');
    process.exit(1);
  }

  logSection(`[manual-tick] Starting manual tick for hour ${hour}`);

  await connect();

  const allDevices = (await DeviceModel.find({ is_registered: true })) as Device[];
  const hourlyDevices = getDevicesForHour(allDevices, hour);

  logSection(
    `[manual-tick] Hour ${hour} device breakdown:`,
    `  Total registered: ${allDevices.length}`,
    `  Devices in hour ${hour}: ${hourlyDevices.length}`
  );

  if (hourlyDevices.length === 0) {
    logSection(`[manual-tick] No devices in hour ${hour}. Exiting.`);
    await mongoose.disconnect();
    process.exit(0);
  }

  const products = await ProductModel.find({});
  logSection(`[manual-tick] Loaded ${products.length} products`);

  const REWARD_REPORT_DIR = process.env.REWARD_REPORT_DIR
    ? path.resolve(process.env.REWARD_REPORT_DIR)
    : path.resolve(process.cwd(), 'reward-reports');

  await withJobLock('hourly-processing', ['weekly-rollup', 'daily-backup', 'data-validation'], async () => {
    let filtered = hourlyDevices;
    let retryCount = 0;
    const reportAggregator = new RewardReportAggregator();
    const startTime = getSimNow();

    while (retryCount < 5) {
      const { errors: errDevices, summary, report } = await doRewards(filtered, products);
      reportAggregator.addReport(report);

      logSection(
        `[manual-tick] Run ${retryCount + 1} summary:`,
        `  Eligible: ${summary.eligibleDevices}`,
        `  Inserted devices: ${summary.insertedDevices}`,
        `  Inserted rows: ${summary.insertedRows}`,
        `  Skipped duplicates: ${summary.skippedDuplicates}`,
        `  Not eligible: ${summary.notEligible}`,
        `  No wallet: ${summary.noWallet}`,
        `  Other validation: ${summary.otherValidation}`,
        `  DB errors: ${summary.dbErrors}`
      );

      const retryDevices = errDevices
        .filter(value => value.err === 'Failed')
        .map(value => value.device);

      if (retryDevices.length === 0) break;

      logSection(`[manual-tick] ${retryDevices.length} devices failed, retrying in 10 minutes...`);
      filtered = retryDevices;
      retryCount++;
      await sleep(10 * 60 * 1000);
    }

    if (retryCount >= 5) {
      logSection(`[manual-tick] FAILED after 5 retries for hour ${hour}`);
    } else {
      logSection(`[manual-tick] SUCCESS for hour ${hour}`);
    }

    const mergedReport = reportAggregator.toReport();
    try {
      await writeRewardCsvReports(startTime, mergedReport, REWARD_REPORT_DIR);
    } catch (reportError) {
      console.error('[manual-tick] Failed to write CSV reports:', reportError);
    }
  });

  logSection(`[manual-tick] Done. Disconnecting.`);
  await mongoose.disconnect();
  process.exit(0);
}

main().catch(err => {
  console.error('[manual-tick] Fatal error:', err);
  process.exit(1);
});
