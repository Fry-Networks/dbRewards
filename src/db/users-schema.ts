import mongoose, { mongo } from 'mongoose';
export const usersSchema = new mongoose.Schema({
    email: { type: String, default: ""},
    address: {type: String, default: ""},
    byod: {
        licenses: { type: [String], default: [] },
        payments: { type: [Date], default: [] }
    }
    
 
});
export interface User extends mongoose.Document {
    email: string,
    address: string,
    byod: {
        licenses: string[],
        payments: Date[]
    }
}

const UserModel = mongoose.models.user || mongoose.model<User>('user', usersSchema);


export default UserModel;

export async function getUserByAddress(address: string): Promise<User> {
   let user = await UserModel.findOne({ address: address });
   if(!user) user = await UserModel.create({ address: address });
    return user;
}

export async function getUser(email?: string, address?: string, noCreate?: boolean): Promise<User | null> {
    let user: User | null = email ? await UserModel.findOne({ email: email }) : await UserModel.findOne({ address: address });
    if(!user && !noCreate) user = await UserModel.create({ email: email, address: address });
    return user;
}
