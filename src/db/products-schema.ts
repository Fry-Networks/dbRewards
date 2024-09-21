
import mongoose, { mongo } from 'mongoose';
export const productsSchema = new mongoose.Schema({
    wix_id: String,
    name: String,
    key: String,
    reward: {
        unverified: { type: Number, default: 0},
        verified: { type: Number, default: 0},
        stake: {
            stake_one: { type: Number, default: 0},
            stake_two: { type: Number, default: 0},
        }
    },
    created_at: { type: Date, default: Date.now },
    type: { type: String, required: false },
    need_transactions: { type: Boolean, default: false, required: false },
 
});
export interface Product extends mongoose.Document {
    wix_id: string,
    name: string,
    key: string,
    reward: {
        unverified: number,
        verified: number,
        stake?: {
            stake_one: number,
            stake_two: number
        }
    },
    type: string,
    created_at: Date,
    need_transactions?: boolean,

}

export const ProductModel = mongoose.model<Product>('products', productsSchema);
