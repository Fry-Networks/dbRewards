import mongoose, { Types } from 'mongoose';

// Sub-schema for individual daily rewards within a device document
const dailyRewardSchema = new mongoose.Schema({
  date: { type: String, required: true },           // YYYY-MM-DD format for easy queries
  amount: { type: Number, required: true },         // Reward amount (post-PoC pro-rating if applicable)
  status: {
    type: String,
    // accruing: daily preview only, aggregated: rolled into weekly
    enum: ['accruing', 'aggregated', 'pending', 'claimable', 'claimed'],
    required: true
  },
  asset_id: { type: String, required: true },       // Token asset ID
  created_at: { type: Date, required: true },       // When reward was created
  claimed_at: { type: Date },                       // When reward was claimed (if status = claimed)
  tx_id: { type: String },                          // Transaction ID (if status = claimed)
  reward_number: { type: Number, required: true },  // Sequential number for this device (1, 2, 3...)
  // PoC slot-based pro-rating fields (optional — set when slot logic is active for the device)
  poc_reward_factor: { type: Number },              // 0.0-1.0, multiplied against base reward
  poc_slots_valid: { type: Number },                // Number of slots that passed gates
  poc_slots_total: { type: Number },                // Always 144 when set
  poc_category: { type: String }                    // AEM | BM | STANDARD
});

// Sub-schema for weekly aggregated rewards
const weeklyRewardSchema = new mongoose.Schema({
  week_start: { type: Date, required: true },        // Friday 00:00:00 UTC
  week_end: { type: Date, required: true },          // Thursday 23:59:59 UTC
  unlock_at: { type: Date, required: true },         // Friday 00:05:00 UTC (buffered unlock)
  status: {
    type: String,
    enum: ['pending', 'claimable', 'claimed'],
    required: true
  },
  asset_id: { type: String, required: true },        // Token asset ID
  amount: { type: Number, required: true },          // Aggregated weekly amount
  created_at: { type: Date, required: true },        // Usually equal to unlock_at
  claimed_at: { type: Date },                        // When the weekly reward was claimed
  tx_id: { type: String },                           // Blockchain transaction id
  reward_number: { type: Number, required: true }    // Sequential number for weekly entries
});

// Main schema for device rewards - one document per device containing all rewards
export const deviceRewardsSchema = new mongoose.Schema({
  miner_key: { type: String, required: true, unique: true },  // Device identifier - unique index
  legacy_fry_claimed: { type: Number, default: 0 },           // Snapshot of claimed Legacy Fry rewards
  legacy_fry_pending: { type: Number, default: 0 },           // Snapshot of pending Legacy Fry rewards
  legacy_fry_claimable: { type: Number, default: 0 },         // Snapshot of claimable Legacy Fry rewards
  legacy_fry_aggregated: { type: Number, default: 0 },        // Snapshot of aggregated Legacy Fry rewards
  legacy_fry_total: { type: Number, default: 0 },             // Total Legacy Fry ever accrued
  legacy_fry_claimed_snapshot: { type: Number, default: 0 },  // Original claimed Legacy Fry prior to conversions
  tfry_claimed: { type: Number, default: 0 },                 // Claimed tFry rewards
  tfry_pending: { type: Number, default: 0 },                 // Pending tFry rewards
  tfry_claimable: { type: Number, default: 0 },               // Claimable tFry rewards
  tfry_aggregated: { type: Number, default: 0 },              // Aggregated tFry rewards
  tfry_total: { type: Number, default: 0 },                   // Total tFry ever accrued
  legacy_fry_claimed_converted: { type: Boolean, default: false }, // Future flag for claimed conversion
  total_pending: { type: Number, default: 0 },                // Sum of all pending rewards
  total_claimable: { type: Number, default: 0 },              // Sum of all claimable rewards
  total_claimed: { type: Number, default: 0 },                // Sum of all claimed rewards
  token_totals: {
    type: Map,
    of: {
      pending: { type: Number, default: 0 },
      claimable: { type: Number, default: 0 },
      claimed: { type: Number, default: 0 },
      aggregated: { type: Number, default: 0 }
    },
    default: {}
  },
  daily_rewards: [dailyRewardSchema],                         // Array of all rewards for this device (daily accrual)
  weekly_rewards: [weeklyRewardSchema],                       // Array of aggregated weekly rewards
  last_updated: { type: Date, default: Date.now },           // Last modification timestamp
  reward_count: { type: Number, default: 0 },                // Total number of rewards ever received
  weekly_reward_count: { type: Number, default: 0 },         // Total number of weekly rewards
  first_reward_date: { type: Date },                         // Date of first reward (for analytics)
  last_reward_date: { type: Date }                           // Date of most recent reward
});

// Indexes for optimal query performance
deviceRewardsSchema.index({ miner_key: 1 });                // Primary lookup index
deviceRewardsSchema.index({ last_updated: -1 });            // For recent updates queries
deviceRewardsSchema.index({ 'daily_rewards.status': 1 });   // For status-based queries
deviceRewardsSchema.index({ 'daily_rewards.date': -1 });    // For date-based queries
deviceRewardsSchema.index({ 'weekly_rewards.status': 1 });  // Weekly status queries
deviceRewardsSchema.index({ 'weekly_rewards.unlock_at': -1 }); // Recent unlocks
deviceRewardsSchema.index({ 'weekly_rewards.week_start': -1 }); // Weekly windows
// Guard against duplicate weekly entries for the same device, asset, and unlock window
deviceRewardsSchema.index(
  { miner_key: 1, 'weekly_rewards.unlock_at': 1, 'weekly_rewards.asset_id': 1 },
  { unique: true, sparse: true, name: 'unique_weekly_window_per_asset' },
); // Prevent duplicate weekly entries for same window/asset

// TypeScript interface for type safety
export interface DeviceReward extends mongoose.Document {
  miner_key: string;
  legacy_fry_claimed: number;
  legacy_fry_pending: number;
  legacy_fry_claimable: number;
  legacy_fry_aggregated: number;
  legacy_fry_total: number;
  legacy_fry_claimed_snapshot: number;
  tfry_claimed: number;
  tfry_pending: number;
  tfry_claimable: number;
  tfry_aggregated: number;
  tfry_total: number;
  legacy_fry_claimed_converted?: boolean;
  total_pending: number;
  total_claimable: number;
  total_claimed: number;
  token_totals?: Map<string, {
    pending: number;
    claimable: number;
    claimed: number;
    aggregated: number;
  }>;
  daily_rewards: Array<{
    date: string;                                           // YYYY-MM-DD format
    amount: number;
    status: 'accruing' | 'aggregated' | 'pending' | 'claimable' | 'claimed';
    asset_id: string;
    created_at: Date;
    claimed_at?: Date;
    tx_id?: string;
    reward_number: number;
    poc_reward_factor?: number;
    poc_slots_valid?: number;
    poc_slots_total?: number;
    poc_category?: string;
    _id?: Types.ObjectId;
  }>;
  weekly_rewards: Array<{
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
  }>;
  last_updated: Date;
  reward_count: number;
  weekly_reward_count: number;
  first_reward_date: Date;
  last_reward_date: Date;
}

// Mongoose models for production and test environments
export const DeviceRewardModel = mongoose.model<DeviceReward>('device-rewards', deviceRewardsSchema);
export const TestDeviceRewardModel = mongoose.model<DeviceReward>('test-device-rewards', deviceRewardsSchema);
