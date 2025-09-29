import mongoose, { Connection } from "mongoose";

export interface HardwareCredential {
  miner_key: string;
  device_id?: string;
}

const HARDWARE_DB_NAME = process.env.CREDS_DB_NAME || "creds";
const HARDWARE_COLLECTION = process.env.CREDS_HARDWARE_COLLECTION || "hardware";

let hardwareConnectionPromise: Promise<Connection> | null = null;

async function ensureHardwareConnection(): Promise<Connection> {
  if (hardwareConnectionPromise) {
    return hardwareConnectionPromise;
  }

  const uri = process.env.CREDS_MONGO_URI?.trim();
  if (uri) {
    hardwareConnectionPromise = mongoose
      .createConnection(uri, {
        maxPoolSize: 5,
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
        retryWrites: true,
        retryReads: true,
        heartbeatFrequencyMS: 10000,
        maxIdleTimeMS: 30000,
      })
      .asPromise();

    return hardwareConnectionPromise;
  }

  if (mongoose.connection.readyState === 0) {
    throw new Error("Mongo connection must be established before querying hardware credentials");
  }

  const connection = mongoose.connection.useDb(HARDWARE_DB_NAME, { useCache: true });
  hardwareConnectionPromise = Promise.resolve(connection);
  return hardwareConnectionPromise;
}

export async function getHardwareCredential(minerKey: string): Promise<HardwareCredential | null> {
  const connection = await ensureHardwareConnection();
  const document = await connection
    .collection(HARDWARE_COLLECTION)
    .findOne({ miner_key: minerKey }, { projection: { miner_key: 1, device_id: 1, deviceId: 1 } });

  if (!document) {
    return null;
  }

  const deviceId = (document as any).device_id ?? (document as any).deviceId;

  return {
    miner_key: document.miner_key as string,
    device_id: typeof deviceId === "string" ? deviceId : undefined,
  };
}

export async function clearHardwareConnection(): Promise<void> {
  if (!hardwareConnectionPromise) {
    return;
  }

  const connection = await hardwareConnectionPromise;
  await connection.close().catch(() => undefined);
  hardwareConnectionPromise = null;
}
