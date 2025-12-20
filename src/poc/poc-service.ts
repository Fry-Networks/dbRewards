/**
 * PROOF OF CONNECTIVITY (PoC) SERVICE
 *
 * This service implements the off-chain Proof of Connectivity system for reward calculation.
 * Miners must receive/send data at least once per hour to be eligible for rewards for that hour.
 *
 * KEY CONCEPTS:
 * - Connectivity is tracked hourly (24 slots per day)
 * - Reward multiplier = hours_with_data / 24
 * - A miner with 18 hours of data gets 75% of the daily reward
 * - A miner with 0 hours of data gets 0% of the daily reward
 *
 * USAGE:
 * - recordMinerActivity(): Call when miner sends/receives data
 * - getConnectivityForDate(): Get connectivity stats for a specific date
 * - calculatePocMultiplier(): Get the reward multiplier based on connectivity
 */

import {
  MinerActivity,
  MinerActivityModel,
  TestMinerActivityModel,
  createEmptyHourlySlots,
  type HourlySlot,
} from '../db/miner-activity-schema';
import { getSimNow } from '../time-control';
import { logSection } from '../logger';

const testMode = process.env.TEST_MODE === 'true';
const DEBUG = process.env.DEBUG === 'true';
const POC_ENABLED = process.env.POC_ENABLED !== 'false'; // Enabled by default

// Get the appropriate model based on test mode
function getModel() {
  return testMode ? TestMinerActivityModel : MinerActivityModel;
}

// Format date as YYYY-MM-DD
function formatDateString(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Record that a miner has sent/received data.
 * This should be called whenever data is received from a miner.
 *
 * @param minerKey - The miner identifier (e.g., "AEM-12345")
 * @param timestamp - Optional timestamp of data receipt (defaults to now)
 * @returns The updated miner activity document
 */
export async function recordMinerActivity(
  minerKey: string,
  timestamp?: Date
): Promise<MinerActivity | null> {
  if (!POC_ENABLED) {
    DEBUG && console.log(`PoC disabled - skipping activity recording for ${minerKey}`);
    return null;
  }

  const now = timestamp || getSimNow();
  const dateString = formatDateString(now);
  const hour = now.getHours();

  try {
    const Model = getModel();

    // Try to update existing document, or create new one
    const result = await Model.findOneAndUpdate(
      { miner_key: minerKey, date: dateString },
      {
        $set: {
          [`hourly_slots.${hour}.hour`]: hour,
          [`hourly_slots.${hour}.has_data`]: true,
          [`hourly_slots.${hour}.last_received_at`]: now,
          last_updated: now,
        },
        $inc: {
          [`hourly_slots.${hour}.data_count`]: 1,
          total_data_points: 1,
        },
        $setOnInsert: {
          miner_key: minerKey,
          date: dateString,
          created_at: now,
          [`hourly_slots.${hour}.first_received_at`]: now,
        },
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      }
    );

    if (result) {
      // Recalculate hours_with_data and connectivity_percentage
      await recalculateConnectivityStats(minerKey, dateString);
    }

    DEBUG && console.log(`Recorded activity for ${minerKey} at hour ${hour} on ${dateString}`);
    return result;
  } catch (error) {
    console.error(`Failed to record miner activity for ${minerKey}:`, error);
    return null;
  }
}

/**
 * Record activity for multiple miners in bulk.
 * More efficient than calling recordMinerActivity individually.
 *
 * @param activities - Array of { minerKey, timestamp? } objects
 * @returns Number of successful records
 */
export async function recordMinerActivityBulk(
  activities: Array<{ minerKey: string; timestamp?: Date }>
): Promise<number> {
  if (!POC_ENABLED) {
    return 0;
  }

  const Model = getModel();
  let successCount = 0;

  // Group activities by date for batch processing
  const byDate = new Map<string, Array<{ minerKey: string; hour: number; timestamp: Date }>>();

  for (const { minerKey, timestamp } of activities) {
    const ts = timestamp || getSimNow();
    const dateString = formatDateString(ts);
    const hour = ts.getHours();

    if (!byDate.has(dateString)) {
      byDate.set(dateString, []);
    }
    byDate.get(dateString)!.push({ minerKey, hour, timestamp: ts });
  }

  // Process each date's activities
  for (const [dateString, dateActivities] of byDate) {
    const bulkOps = dateActivities.map(({ minerKey, hour, timestamp }) => ({
      updateOne: {
        filter: { miner_key: minerKey, date: dateString },
        update: {
          $set: {
            [`hourly_slots.${hour}.hour`]: hour,
            [`hourly_slots.${hour}.has_data`]: true,
            [`hourly_slots.${hour}.last_received_at`]: timestamp,
            last_updated: timestamp,
          },
          $inc: {
            [`hourly_slots.${hour}.data_count`]: 1,
            total_data_points: 1,
          },
          $setOnInsert: {
            miner_key: minerKey,
            date: dateString,
            hourly_slots: createEmptyHourlySlots(),
            created_at: timestamp,
          },
        },
        upsert: true,
      },
    }));

    try {
      const result = await Model.bulkWrite(bulkOps, { ordered: false });
      successCount += result.upsertedCount + result.modifiedCount;

      // Recalculate stats for affected miners
      const minerKeys = [...new Set(dateActivities.map((a) => a.minerKey))];
      await Promise.all(
        minerKeys.map((minerKey) => recalculateConnectivityStats(minerKey, dateString))
      );
    } catch (error) {
      console.error(`Bulk activity recording failed for date ${dateString}:`, error);
    }
  }

  return successCount;
}

/**
 * Recalculate connectivity stats for a miner on a specific date.
 * Updates hours_with_data and connectivity_percentage.
 */
async function recalculateConnectivityStats(
  minerKey: string,
  dateString: string
): Promise<void> {
  const Model = getModel();

  try {
    const doc = await Model.findOne({ miner_key: minerKey, date: dateString });
    if (!doc) return;

    // Count hours with data
    let hoursWithData = 0;
    if (doc.hourly_slots && Array.isArray(doc.hourly_slots)) {
      for (const slot of doc.hourly_slots) {
        if (slot && slot.has_data) {
          hoursWithData++;
        }
      }
    }

    // Calculate percentage
    const connectivityPercentage = Math.round((hoursWithData / 24) * 100);

    // Update the document
    await Model.updateOne(
      { _id: doc._id },
      {
        $set: {
          hours_with_data: hoursWithData,
          connectivity_percentage: connectivityPercentage,
          last_updated: getSimNow(),
        },
      }
    );

    DEBUG &&
      console.log(
        `Updated connectivity for ${minerKey} on ${dateString}: ${hoursWithData}/24 hours (${connectivityPercentage}%)`
      );
  } catch (error) {
    console.error(`Failed to recalculate connectivity for ${minerKey}:`, error);
  }
}

/**
 * Get connectivity data for a miner on a specific date.
 *
 * @param minerKey - The miner identifier
 * @param dateString - Date in YYYY-MM-DD format
 * @returns MinerActivity document or null if not found
 */
export async function getConnectivityForDate(
  minerKey: string,
  dateString: string
): Promise<MinerActivity | null> {
  const Model = getModel();
  return Model.findOne({ miner_key: minerKey, date: dateString });
}

/**
 * Get connectivity data for a miner for the previous day (for reward calculation).
 * Rewards are calculated for the previous complete day.
 *
 * @param minerKey - The miner identifier
 * @param referenceDate - Optional reference date (defaults to now)
 * @returns MinerActivity document for the previous day
 */
export async function getYesterdayConnectivity(
  minerKey: string,
  referenceDate?: Date
): Promise<MinerActivity | null> {
  const ref = referenceDate || getSimNow();
  const yesterday = new Date(ref);
  yesterday.setDate(yesterday.getDate() - 1);
  const dateString = formatDateString(yesterday);

  return getConnectivityForDate(minerKey, dateString);
}

/**
 * Calculate the PoC multiplier for reward calculation.
 * This is the main function used during reward processing.
 *
 * @param minerKey - The miner identifier
 * @param dateString - Date in YYYY-MM-DD format
 * @returns Multiplier between 0.0 and 1.0
 */
export async function calculatePocMultiplier(
  minerKey: string,
  dateString: string
): Promise<number> {
  // If PoC is disabled, return full multiplier
  if (!POC_ENABLED) {
    return 1.0;
  }

  try {
    const activity = await getConnectivityForDate(minerKey, dateString);

    if (!activity) {
      // No activity recorded for this day - miner gets 0% reward
      DEBUG && console.log(`No PoC data for ${minerKey} on ${dateString} - multiplier: 0.0`);
      return 0.0;
    }

    // Calculate multiplier based on hours with data
    const multiplier = activity.hours_with_data / 24;

    DEBUG &&
      console.log(
        `PoC multiplier for ${minerKey} on ${dateString}: ${activity.hours_with_data}/24 = ${multiplier.toFixed(4)}`
      );

    return multiplier;
  } catch (error) {
    console.error(`Failed to calculate PoC multiplier for ${minerKey}:`, error);
    // On error, default to full multiplier to avoid penalizing miners
    return 1.0;
  }
}

/**
 * Get detailed connectivity report for a miner.
 * Useful for debugging and miner dashboards.
 *
 * @param minerKey - The miner identifier
 * @param dateString - Date in YYYY-MM-DD format
 */
export interface ConnectivityReport {
  minerKey: string;
  date: string;
  hoursWithData: number;
  totalHours: 24;
  connectivityPercentage: number;
  rewardMultiplier: number;
  missingHours: number[];
  hourlyBreakdown: Array<{
    hour: number;
    hasData: boolean;
    dataCount: number;
    lastReceived?: Date;
  }>;
}

export async function getConnectivityReport(
  minerKey: string,
  dateString: string
): Promise<ConnectivityReport | null> {
  const activity = await getConnectivityForDate(minerKey, dateString);

  if (!activity) {
    return null;
  }

  const missingHours: number[] = [];
  const hourlyBreakdown: ConnectivityReport['hourlyBreakdown'] = [];

  // Build hourly breakdown and find missing hours
  for (let hour = 0; hour < 24; hour++) {
    const slot = activity.hourly_slots?.find((s) => s.hour === hour);

    if (!slot || !slot.has_data) {
      missingHours.push(hour);
      hourlyBreakdown.push({
        hour,
        hasData: false,
        dataCount: 0,
      });
    } else {
      hourlyBreakdown.push({
        hour,
        hasData: true,
        dataCount: slot.data_count,
        lastReceived: slot.last_received_at,
      });
    }
  }

  return {
    minerKey,
    date: dateString,
    hoursWithData: activity.hours_with_data,
    totalHours: 24,
    connectivityPercentage: activity.connectivity_percentage,
    rewardMultiplier: activity.hours_with_data / 24,
    missingHours,
    hourlyBreakdown,
  };
}

/**
 * Mark a day as PoC verified (used after daily reward processing).
 *
 * @param minerKey - The miner identifier
 * @param dateString - Date in YYYY-MM-DD format
 */
export async function markDayVerified(minerKey: string, dateString: string): Promise<void> {
  const Model = getModel();

  try {
    await Model.updateOne(
      { miner_key: minerKey, date: dateString },
      {
        $set: {
          poc_verified: true,
          poc_verified_at: getSimNow(),
          last_updated: getSimNow(),
        },
      }
    );
  } catch (error) {
    console.error(`Failed to mark day verified for ${minerKey}:`, error);
  }
}

/**
 * Get summary stats for all miners on a specific date.
 * Useful for monitoring and reporting.
 */
export interface DailyPocSummary {
  date: string;
  totalMiners: number;
  minersWithFullConnectivity: number;
  minersWithPartialConnectivity: number;
  minersWithNoConnectivity: number;
  averageConnectivityPercentage: number;
  averageHoursWithData: number;
}

export async function getDailyPocSummary(dateString: string): Promise<DailyPocSummary> {
  const Model = getModel();

  try {
    const pipeline = [
      { $match: { date: dateString } },
      {
        $group: {
          _id: null,
          totalMiners: { $sum: 1 },
          fullConnectivity: {
            $sum: { $cond: [{ $eq: ['$hours_with_data', 24] }, 1, 0] },
          },
          partialConnectivity: {
            $sum: {
              $cond: [
                { $and: [{ $gt: ['$hours_with_data', 0] }, { $lt: ['$hours_with_data', 24] }] },
                1,
                0,
              ],
            },
          },
          noConnectivity: {
            $sum: { $cond: [{ $eq: ['$hours_with_data', 0] }, 1, 0] },
          },
          totalPercentage: { $sum: '$connectivity_percentage' },
          totalHours: { $sum: '$hours_with_data' },
        },
      },
    ];

    const result = await Model.aggregate(pipeline);

    if (!result.length) {
      return {
        date: dateString,
        totalMiners: 0,
        minersWithFullConnectivity: 0,
        minersWithPartialConnectivity: 0,
        minersWithNoConnectivity: 0,
        averageConnectivityPercentage: 0,
        averageHoursWithData: 0,
      };
    }

    const stats = result[0];
    return {
      date: dateString,
      totalMiners: stats.totalMiners,
      minersWithFullConnectivity: stats.fullConnectivity,
      minersWithPartialConnectivity: stats.partialConnectivity,
      minersWithNoConnectivity: stats.noConnectivity,
      averageConnectivityPercentage:
        stats.totalMiners > 0 ? Math.round(stats.totalPercentage / stats.totalMiners) : 0,
      averageHoursWithData:
        stats.totalMiners > 0 ? Math.round((stats.totalHours / stats.totalMiners) * 10) / 10 : 0,
    };
  } catch (error) {
    console.error(`Failed to get daily PoC summary for ${dateString}:`, error);
    return {
      date: dateString,
      totalMiners: 0,
      minersWithFullConnectivity: 0,
      minersWithPartialConnectivity: 0,
      minersWithNoConnectivity: 0,
      averageConnectivityPercentage: 0,
      averageHoursWithData: 0,
    };
  }
}

/**
 * Cleanup old activity records (retention policy).
 * Keeps data for the specified number of days.
 *
 * @param retentionDays - Number of days to retain (default: 90)
 * @returns Number of documents deleted
 */
export async function cleanupOldActivityRecords(retentionDays: number = 90): Promise<number> {
  const Model = getModel();
  const cutoffDate = new Date(getSimNow());
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
  const cutoffDateString = formatDateString(cutoffDate);

  try {
    const result = await Model.deleteMany({
      date: { $lt: cutoffDateString },
      poc_verified: true, // Only delete verified records
    });

    logSection(`PoC cleanup: Removed ${result.deletedCount} activity records older than ${retentionDays} days`);
    return result.deletedCount;
  } catch (error) {
    console.error('Failed to cleanup old activity records:', error);
    return 0;
  }
}

// Export the enabled status for use in other modules
export function isPocEnabled(): boolean {
  return POC_ENABLED;
}
