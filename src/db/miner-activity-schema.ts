import mongoose from 'mongoose';

/**
 * PROOF OF CONNECTIVITY (PoC) - Miner Activity Tracking Schema
 *
 * This schema tracks hourly data received from miners to implement
 * the PoC system. Miners must send data at least once per hour to
 * receive full rewards for that hour.
 *
 * REWARD CALCULATION IMPACT:
 * - Daily rewards are calculated based on hours with confirmed connectivity
 * - If a miner has data for all 24 hours: 100% of daily reward
 * - If a miner has data for 18 hours: 75% of daily reward (18/24)
 * - Missing hours result in proportional reward reduction
 *
 * DATA STRUCTURE:
 * - One document per miner per day for efficient querying
 * - Hourly slots (0-23) track if data was received in that hour
 * - Timestamps record when data was last received for each hour
 */

// Sub-schema for hourly activity slot
const hourlySlotSchema = new mongoose.Schema({
  hour: { type: Number, required: true, min: 0, max: 23 },  // Hour of day (0-23)
  has_data: { type: Boolean, default: false },               // Whether data was received this hour
  first_received_at: { type: Date },                         // First data received timestamp
  last_received_at: { type: Date },                          // Most recent data timestamp
  data_count: { type: Number, default: 0 },                  // Number of data points received
}, { _id: false });

// Main activity tracking schema - one document per miner per day
export const minerActivitySchema = new mongoose.Schema({
  miner_key: { type: String, required: true, index: true },  // Device identifier
  date: { type: String, required: true, index: true },       // YYYY-MM-DD format

  // Hourly activity slots (24 entries for each hour)
  hourly_slots: [hourlySlotSchema],

  // Summary metrics for quick queries
  hours_with_data: { type: Number, default: 0, min: 0, max: 24 },    // Count of hours with data
  total_data_points: { type: Number, default: 0 },                    // Total data points received
  connectivity_percentage: { type: Number, default: 0, min: 0, max: 100 }, // hours_with_data / 24 * 100

  // Timestamps
  created_at: { type: Date, default: Date.now },
  last_updated: { type: Date, default: Date.now },

  // For reward calculation
  poc_verified: { type: Boolean, default: false },           // Set true after day is complete and verified
  poc_verified_at: { type: Date },                           // When PoC was verified for this day
});

// Compound unique index to ensure one document per miner per day
minerActivitySchema.index({ miner_key: 1, date: 1 }, { unique: true });

// Index for querying by date range
minerActivitySchema.index({ date: -1 });

// Index for finding incomplete days (for cleanup/verification jobs)
minerActivitySchema.index({ poc_verified: 1, date: -1 });

// Index for connectivity queries
minerActivitySchema.index({ connectivity_percentage: 1 });

// TypeScript interface for type safety
export interface HourlySlot {
  hour: number;
  has_data: boolean;
  first_received_at?: Date;
  last_received_at?: Date;
  data_count: number;
}

export interface MinerActivity extends mongoose.Document {
  miner_key: string;
  date: string;
  hourly_slots: HourlySlot[];
  hours_with_data: number;
  total_data_points: number;
  connectivity_percentage: number;
  created_at: Date;
  last_updated: Date;
  poc_verified: boolean;
  poc_verified_at?: Date;
}

// Helper function to create empty hourly slots for a new day
export function createEmptyHourlySlots(): HourlySlot[] {
  return Array.from({ length: 24 }, (_, hour) => ({
    hour,
    has_data: false,
    data_count: 0,
  }));
}

// Mongoose models for production and test environments
export const MinerActivityModel = mongoose.model<MinerActivity>('miner-activity', minerActivitySchema);
export const TestMinerActivityModel = mongoose.model<MinerActivity>('test-miner-activity', minerActivitySchema);
