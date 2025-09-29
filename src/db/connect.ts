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

    connection = await mongoose.connect(uri, {
        maxPoolSize: 10, // Maintain up to 10 socket connections
        serverSelectionTimeoutMS: 5000, // Keep trying to send operations for 5 seconds
        socketTimeoutMS: 45000, // Close sockets after 45 seconds of inactivity
        retryWrites: true, // Automatically retry certain write operations
        retryReads: true, // Automatically retry certain read operations
        heartbeatFrequencyMS: 10000, // How often to check connection health (10 seconds)
        maxIdleTimeMS: 30000, // Close connections after 30 seconds of inactivity
    });

    mongoose.connection.useDb('main');



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
