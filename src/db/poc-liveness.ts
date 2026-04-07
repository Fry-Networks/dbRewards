/**
 * PoC LIVENESS GATE — Soft gate with grace period
 *
 * Checks PoC.installations for device last_seen_at to determine
 * whether a device is actively running the PoC client.
 *
 * BEHAVIOR:
 * - If POC_LIVENESS_CUTOFF_DATE is empty or in the future: all devices pass (grace period)
 * - If POC_LIVENESS_CUTOFF_DATE is in the past:
 *   - Devices with last_seen_at within POC_LIVENESS_THRESHOLD_DAYS: pass
 *   - Devices with no installation record or stale last_seen_at: fail
 *
 * Per-device-type control uses existing POC_REWARD_* env vars:
 *   POC_REWARD_AEM=true   → liveness check enabled for AEM devices
 *   POC_REWARD_BM=true    → liveness check enabled for BM devices
 *   (Extend as needed)
 *
 * TODO: Add indexes to PoC.installations before enabling in production:
 *   db.installations.createIndex({ miner_key: 1 }, { unique: true })
 *   db.installations.createIndex({ last_seen_at: -1 })
 */

import mongoose, { Connection } from "mongoose";

export interface PocInstallation {
  miner_key: string;
  last_seen_at?: Date | string;
  is_installed?: boolean;
  minerCode?: string;
}

export interface LivenessResult {
  isAlive: boolean;
  lastSeen: Date | null;
  reason: string;
}

const POC_DB_NAME = process.env.POC_DB_NAME || "PoC";
const POC_COLLECTION = process.env.POC_LIVENESS_COLLECTION || "installations";
const POC_THRESHOLD_DAYS = parseInt(process.env.POC_LIVENESS_THRESHOLD_DAYS || "7", 10);
const POC_CUTOFF_DATE_STR = (process.env.POC_LIVENESS_CUTOFF_DATE || "").trim();

let pocConnectionPromise: Promise<Connection> | null = null;

async function ensurePocConnection(): Promise<Connection> {
  if (pocConnectionPromise) {
    return pocConnectionPromise;
  }

  if (mongoose.connection.readyState === 0) {
    throw new Error("Mongo connection must be established before querying PoC liveness");
  }

  const connection = mongoose.connection.useDb(POC_DB_NAME, { useCache: true });
  pocConnectionPromise = Promise.resolve(connection);
  return pocConnectionPromise;
}

/**
 * Check whether the PoC liveness cutoff date has passed.
 * If no cutoff is set or it's in the future, we're in grace period.
 */
export function isLivenessEnforced(now: Date): boolean {
  if (!POC_CUTOFF_DATE_STR) {
    return false; // No cutoff date → grace period
  }
  const cutoff = new Date(POC_CUTOFF_DATE_STR);
  if (isNaN(cutoff.getTime())) {
    return false; // Invalid date → treat as grace period
  }
  return now >= cutoff;
}

/**
 * Check whether liveness validation is enabled for a given device prefix.
 * Reuses existing POC_REWARD_* env vars as per-type toggles.
 */
export function shouldValidateLiveness(minerKey: string): boolean {
  const prefix = minerKey.split("-")[0]?.toUpperCase();
  switch (prefix) {
    case "AEM":
      return process.env.POC_REWARD_AEM === "true";
    case "BM":
      return process.env.POC_REWARD_BM === "true";
    // Extend for other device types as needed:
    // case "RDN": case "SDN": case "SVN": case "CN":
    //   return process.env.POC_REWARD_NODES === "true";
    default:
      return false;
  }
}

/**
 * Query PoC.installations for a device's liveness status.
 * Returns isAlive=true if the device has been seen within threshold days.
 */
export async function getPocLiveness(minerKey: string, now: Date): Promise<LivenessResult> {
  // Grace period check
  if (!isLivenessEnforced(now)) {
    return { isAlive: true, lastSeen: null, reason: "Grace period active" };
  }

  try {
    const connection = await ensurePocConnection();
    const doc = await connection
      .collection(POC_COLLECTION)
      .findOne(
        { miner_key: minerKey },
        { projection: { miner_key: 1, last_seen_at: 1, is_installed: 1 } }
      );

    if (!doc) {
      return { isAlive: false, lastSeen: null, reason: "No PoC installation" };
    }

    const lastSeenRaw = (doc as any).last_seen_at;
    if (!lastSeenRaw) {
      return { isAlive: false, lastSeen: null, reason: "No last_seen_at recorded" };
    }

    const lastSeen = new Date(lastSeenRaw);
    if (isNaN(lastSeen.getTime())) {
      return { isAlive: false, lastSeen: null, reason: "Invalid last_seen_at" };
    }

    const thresholdMs = POC_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
    const age = now.getTime() - lastSeen.getTime();

    if (age <= thresholdMs) {
      return { isAlive: true, lastSeen, reason: "Active" };
    }

    const daysSince = Math.floor(age / (24 * 60 * 60 * 1000));
    return {
      isAlive: false,
      lastSeen,
      reason: `Inactive ${daysSince}d (threshold: ${POC_THRESHOLD_DAYS}d)`,
    };
  } catch (error) {
    // On DB error, fail open (don't block rewards due to PoC query failure)
    console.error(`PoC liveness check failed for ${minerKey}:`, error);
    return { isAlive: true, lastSeen: null, reason: "Liveness check error (fail-open)" };
  }
}

export async function clearPocConnection(): Promise<void> {
  if (!pocConnectionPromise) {
    return;
  }
  const connection = await pocConnectionPromise;
  await connection.close().catch(() => undefined);
  pocConnectionPromise = null;
}
