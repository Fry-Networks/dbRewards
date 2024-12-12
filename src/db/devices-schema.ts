import mongoose, { mongo } from "mongoose";
export const devicesSchema = new mongoose.Schema({
  user_id: mongoose.Schema.Types.ObjectId,
  miner_key: String,
  name: String,
  created_at: { type: Date, default: Date.now },
  is_registered: { type: Boolean, default: false },
  verified: { type: Boolean, default: false },
  reward_wallet: String,
  address: String,
  byod: { type: String, default: "" },
  staked: {
    type: {
      type: String, // The type field for staked
      required: true,
    },
    amount: {
      type: Number, // The amount of staked tokens
      required: true,
    },
    txId: {
      type: String, // The transaction ID of the staking operation
      required: true,
    },
    time: {
      type: Date, // The timestamp when the staking occurred
    },
    rewarded_time: {
      type: Date, // The timestamp when the staking occurred
    },
    asset_id: {
      type: String,
    },
  },
  registration: {
    amount: {
      type: Number, // The amount of staked tokens
      required: true,
    },
    txId: {
      type: String, // The transaction ID of the staking operation
      required: true,
    },
    time: {
      type: Date, // The timestamp when the staking occurred
    },
    asset_id: {
      type: String,
    },
  },
  node: {
    amount: {
      type: Number, // The amount of staked tokens
      required: true,
    },
    txId: {
      type: String, // The transaction ID of the staking operation
      required: true,
    },
    time: {
      type: Date, // The timestamp when the staking occurred
    },
    asset_id: {
      type: String,
    },
  },
});

export interface Device extends mongoose.Document {
  user_id: mongoose.Schema.Types.ObjectId | string;
  miner_key: string;
  name: string;
  address: string;
  created_at: Date;
  is_registered: boolean;
  verified: boolean;
  reward_wallet: string;
  byod?: string;
  staked?: {
    type: string;
    amount: number;
    txId: string;
    time: Date;
    rewarded_time: Date;
    asset_id: string;
  };
  registration?: {
    asset_id: string;
    amount: number;
    txId: string;
    time: Date;
  };
  node?: {
    asset_id: string;
    amount: number;
    txId: string;
    time: Date;
  };
}

export const DeviceModel = mongoose.model<Device>("devices", devicesSchema);
export const TestDeviceModel = mongoose.model<Device>(
  "test-devices",
  devicesSchema
);
