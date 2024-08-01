import mongoose from 'mongoose';
import 'dotenv/config';
import { EventEmitter } from 'node:events';
let connection: typeof mongoose | null = null;
export async function connect() {
    //check if connected
    if (mongoose.connection.readyState >= 1) {
        return;
    }
    const uri = process.env.MONGO_URI;
    if (!uri) {
        throw new Error('MONGO_URI not set!');
    }
    console.log('Connecting to MongoDB...');
    mongoose.connection.on('connected', () => {
        console.log('Connected to MongoDB!');
    });

    connection = await mongoose.connect(uri);

    mongoose.connection.useDb('weather');



    mongoose.connection.on('error', (err) => {
        console.error(`Mongoose connection error:\n${err.stack}`);
    });

    mongoose.connection.on('disconnected', () => {
        console.log('Disconnected from MongoDB!');
    });
}

export const newApiKeyEvent = new EventEmitter();

export function getConnection() {
    if (connection === null) {
        throw new Error('Not connected to MongoDB!');
    }
    return connection;
}