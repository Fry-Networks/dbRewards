import mongoose from 'mongoose';

// Sub-schema for individual daily rewards within a device document
const dailyRewardSchema = new mongoose.Schema({
  date: { type: String, required: true },           // YYYY-MM-DD format for easy queries
  amount: { type: Number, required: true },         // Reward amount
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
  reward_number: { type: Number, required: true }   // Sequential number for this device (1, 2, 3...)
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
  total_pending: { type: Number, default: 0 },                // Sum of all pending rewards
  total_claimable: { type: Number, default: 0 },              // Sum of all claimable rewards
  total_claimed: { type: Number, default: 0 },                // Sum of all claimed rewards
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

// TypeScript interface for type safety
export interface DeviceReward extends mongoose.Document {
  miner_key: string;
  total_pending: number;
  total_claimable: number;
  total_claimed: number;
  daily_rewards: Array<{
    date: string;                                           // YYYY-MM-DD format
    amount: number;
    status: 'accruing' | 'aggregated' | 'pending' | 'claimable' | 'claimed';
    asset_id: string;
    created_at: Date;
    claimed_at?: Date;
    tx_id?: string;
    reward_number: number;
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
