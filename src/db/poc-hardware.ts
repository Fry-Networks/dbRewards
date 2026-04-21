import mongoose, { Connection } from "mongoose";

export interface PocHardwareDoc {
  miner_key?: string;
  rewards?: Record<string, any>;
  reward_eligible?: boolean;
}

const POC_DB_NAME = process.env.POC_DB_NAME || "PoC";
const POC_COLLECTION = process.env.POC_HARDWARE_COLLECTION || "hardware";

let pocConnectionPromise: Promise<Connection> | null = null;

async function ensurePocConnection(): Promise<Connection> {
  if (pocConnectionPromise) {
    return pocConnectionPromise;
  }

  if (mongoose.connection.readyState === 0) {
    throw new Error("Mongo connection must be established before querying PoC hardware");
  }

  const connection = mongoose.connection.useDb(POC_DB_NAME, { useCache: true });
  pocConnectionPromise = Promise.resolve(connection);
  return pocConnectionPromise;
}

/**
 * Fetch PoC.hardware documents for a batch of miner_keys, projecting only the
 * target day's rewards subtree to minimize payload size.
 */
export async function getPocHardwareDocsForDate(
  minerKeys: string[],
  dateString: string
): Promise<Map<string, PocHardwareDoc>> {
  if (minerKeys.length === 0) {
    return new Map();
  }

  const connection = await ensurePocConnection();
  const rewardField = `rewards.${dateString}`;

  const docs = await connection
    .collection<PocHardwareDoc>(POC_COLLECTION)
    .find({ miner_key: { $in: minerKeys } })
    .project({ miner_key: 1, [rewardField]: 1, reward_eligible: 1 })
    .toArray();

  const byKey = new Map<string, PocHardwareDoc>();
  for (const doc of docs) {
    const key = doc.miner_key ? String(doc.miner_key) : "";
    if (key) {
      byKey.set(key, doc);
    }
  }

  return byKey;
}

export async function clearPocHardwareConnection(): Promise<void> {
  pocConnectionPromise = null;
}
