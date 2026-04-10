import mongoose, { Types } from 'mongoose';

// Per-day PoC reward summary stored alongside device_rewards in the main database.
// Provides an audit trail of slot calculations without ballooning device_rewards.
const pocRewardDailySchema = new mongoose.Schema({
  miner_key: { type: String, required: true },
  date: { type: String, required: true },        // YYYY-MM-DD UTC (the day measured)
  device_type: { type: String, required: true }, // Miner prefix (e.g., AEM, BM, ISM)
  category: { type: String, required: true },    // PoC category: AEM | BM | STANDARD
  slots_total: { type: Number, required: true }, // Always 144 (6/hr × 24h)
  slots_valid: { type: Number, required: true },
  multiplier_sum: { type: Number, required: true },
  reward_factor: { type: Number, required: true }, // 0.0 - 1.0
  tools_avg: { type: Number, default: null },      // BM only
  poi_required: { type: Boolean, default: false },
  computed_at: { type: Date, required: true }
});

// Idempotency: one summary per device per day
pocRewardDailySchema.index(
  { miner_key: 1, date: 1 },
  { unique: true, name: 'unique_poc_reward_daily' }
);
pocRewardDailySchema.index({ date: -1 });

export interface PocRewardDaily extends mongoose.Document {
  miner_key: string;
  date: string;
  device_type: string;
  category: string;
  slots_total: number;
  slots_valid: number;
  multiplier_sum: number;
  reward_factor: number;
  tools_avg: number | null;
  poi_required: boolean;
  computed_at: Date;
  _id?: Types.ObjectId;
}

export const PocRewardDailyModel = mongoose.model<PocRewardDaily>(
  'poc_reward_daily',
  pocRewardDailySchema
);
export const TestPocRewardDailyModel = mongoose.model<PocRewardDaily>(
  'test_poc_reward_daily',
  pocRewardDailySchema
);
