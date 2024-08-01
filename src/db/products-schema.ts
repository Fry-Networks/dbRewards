
import mongoose, { mongo } from 'mongoose';
export const productsSchema = new mongoose.Schema({
    wix_id: String,
    name: String,
    key: String,
    reward: {
        unverified: { type: Number, default: 0},
        verified: { type: Number, default: 0}
    },
    created_at: { type: Date, default: Date.now }
 
});
export interface Product extends mongoose.Document {
    wix_id: string,
    name: string,
    key: string,
    reward: {
        unverified: number,
        verified: number,
    },
    created_at: Date,

}

export const ProductModel = mongoose.model<Product>('products', productsSchema);
