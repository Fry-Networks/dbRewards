import mongoose, { mongo } from 'mongoose';
export const devicesSchema = new mongoose.Schema({
	user_id: mongoose.Schema.Types.ObjectId,
    miner_key: String, 
    name: String,
    created_at: { type: Date, default: Date.now },
    is_registered: { type: Boolean, default: false },
    registered_at: Date,
    verified: { type: Boolean, default: false },
    verified_at: { type: Date, default: null },
    need_transactions: { type: Boolean, default: false },
 
});
export interface Device extends mongoose.Document {
	user_id: mongoose.Schema.Types.ObjectId | string,
    miner_key: string,
    name: string,
    created_at: Date,
    is_registered: boolean,
    registered_at: Date,
    verified: boolean,
    verified_at: Date | null,
    need_transactions: boolean
}

export const DeviceModel = mongoose.model<Device>('devices', devicesSchema);
