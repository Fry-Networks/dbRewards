import mongoose, { mongo } from 'mongoose';
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
 
});
export interface Device extends mongoose.Document {
	user_id: mongoose.Schema.Types.ObjectId | string,
    miner_key: string,
    name: string,
    address: string,
    created_at: Date,
    is_registered: boolean,
    verified: boolean,
    reward_wallet: string,
    byod?: string
}

export const DeviceModel = mongoose.model<Device>('devices', devicesSchema);
