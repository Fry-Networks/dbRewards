
import mongoose, { mongo } from 'mongoose';
export const rewardsSchema = new mongoose.Schema({
    no: Number,
    miner_key: String,
    status: String,
    asset_id: String,
    amount: Number,
    createdAt: Date,
    txId: String,
    claimedAt: Date 
});
export interface Reward extends mongoose.Document {
   no: number,
   miner_key: string,
   status: string,
   asset_id: string,
   amount: number,
   createdAt: Date,
   txId: String,
   claimedAt: Date
}

export const RewardModel = mongoose.model<Reward>('rewards', rewardsSchema);
export const TestRewardModel = mongoose.model<Reward>('test-rewards', rewardsSchema);
