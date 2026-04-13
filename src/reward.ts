/**
 * HARDWARE VALIDATION SYSTEM - GRADUAL ROLLOUT
 * 
 * This module implements a granular hardware credential validation system for reward processing.
 * Validation can be enabled/disabled per device category using environment variables.
 * 
 * VALIDATION GROUPS:
 * 
 * 1. AI Edge Miners (AEM)
 *    - Environment Variable: VALIDATE_HARDWARE_AEM
 *    - Device Types: AEM
 *    - Validation: MAC address + hardware credentials
 * 
 * 2. Decentralization Nodes
 *    - Environment Variable: VALIDATE_HARDWARE_NODES
 *    - Device Types: CN, SDN, RDN, SVN
 *    - Validation: MAC address + hardware credentials
 * 
 * 3. Hardware Miners
 *    - Environment Variable: VALIDATE_HARDWARE_MINERS
 *    - Device Types: BM, ISM, OSM, IDM, ODM
 *    - Validation: MAC address + hardware credentials
 * 
 * FUTURE SENSOR VALIDATION (API Keys/Tokens):
 *    - VALIDATE_CREDENTIALS_RADIATION (IRM)
 *    - VALIDATE_CREDENTIALS_ENERGY (EM)
 *    - VALIDATE_CREDENTIALS_AIR (IHAQM, ILAQM, OMAQM, IMAQM, OHAQM)
 *    - VALIDATE_CREDENTIALS_WEATHER (HWM, LWM)
 *    - VALIDATE_CREDENTIALS_WATER (OLWQM, OHWQM)
 * 
 * ROLLOUT STRATEGY:
 * 
 * Week 1 - Test AEM devices:
 *   VALIDATE_HARDWARE_AEM=true
 *   VALIDATE_HARDWARE_NODES=false
 *   VALIDATE_HARDWARE_MINERS=false
 * 
 * Week 2 - Add Node devices:
 *   VALIDATE_HARDWARE_AEM=true
 *   VALIDATE_HARDWARE_NODES=true
 *   VALIDATE_HARDWARE_MINERS=false
 * 
 * Week 3+ - Full rollout:
 *   VALIDATE_HARDWARE_AEM=true
 *   VALIDATE_HARDWARE_NODES=true
 *   VALIDATE_HARDWARE_MINERS=true
 * 
 * BEHAVIOR:
 * - When validation is ENABLED (true): Devices without valid credentials are BLOCKED from rewards
 * - When validation is DISABLED (false): Credential checks are SKIPPED, devices can be rewarded
 * - All variables default to 'true' for security-first approach
 * - Quick rollback available by setting any variable to 'false'
 */

import { Device } from "./db/devices-schema";
import "dotenv/config";
import { Product } from "./db/products-schema";
// NEW: Import device rewards schema for aggregated reward system
import { type DeviceReward, DeviceRewardModel, TestDeviceRewardModel } from "./db/device-rewards-schema";
import { getHardwareCredential, type HardwareCredential } from "./db/hardware-credentials";
import { getPocHardwareDocsForDate, type PocHardwareDoc } from "./db/poc-hardware";
import { PocRewardDailyModel, TestPocRewardDailyModel } from "./db/poc-reward-daily-schema";
import { sleep } from "./main";
import { logSection } from "./logger";
import { getSimNow } from "./time-control";
import { validateMacAddress } from "./security/mac-validator";
import { type RewardReport, type RewardReportEntry } from "./reporting/reward-report";
import { applyTfryDelta, isTfryAsset } from "./reward-totals";

const minerType = {
  weather: [ "HWM", "LWM" ],
  air: ["IHAQM", "ILAQM", "OMAQM", "IMAQM", "OHAQM"],
  water: ["OLWQM", "OHWQM"],
  radiation: ["IRM"],
  hardware: ["ISM", "OSM", "BM", "IDM", "ODM"],
  camera: [
    'AOWSCM',
    'AOWCM',
    'AIWCM',
    'AOSCM',
    'AISCM',
    'AOTCM',
    'AITCM',
    'AIWSCM'
  ],
  energy: ["EM"],
  node: ['SDN', 'SVN', 'RDN', 'CN', 'AEM'],
};

type MinerCategory = keyof typeof minerType;
type MinerType = (typeof minerType)[MinerCategory][number];

// Presale airdrop keys that were generated with CN- prefix but sold as RDN (Compute Node) product.
// These specific keys must use the RDN product for reward calculation. Does NOT affect other CN- keys.
const PRESALE_CN_TO_RDN_OVERRIDES = new Set([
  "CN-CWIP0RDUL3NS11QEYTXJ3Z7VO6CGQY23",
  "CN-IJN64DMM0V2GT7CBYTG4ODNV6UQ5MW2X",
  "CN-L9Q5FDW4409L386L6WF9S51VDQ57TH07",
  "CN-8FDLA1RK8OF56QJPSUS0KF0AETA4V3U4",
  "CN-8XG0KQMOYS0EN9IV8GHGUBJGN9UKUXFA",
  "CN-8IPVIXHGWXJ4DDT9AS9Y5L9AOUMKT4G3",
  "CN-ZPOLFAE24E0VKQ93B9J2KAJHD1WPDJ2Q",
  "CN-Z8NHBDN99RJKZIJC33581L8J73S439IK",
  "CN-L8QRUDTLJTZ571SO4H93QBABNFYIMX77",
]);

// Device type groupings for hardware validation
const MAC_REQUIRED_PREFIXES = new Set<string>([
  'SDN',
  'SVN',
  'RDN',
  'CN',
  'AEM',
  'BM',
  'ISM',
  'OSM',
  'IDM',
  'ODM',
]);

// Granular validation control groups
const AEM_DEVICES = new Set<string>(['AEM']);
const NODE_DEVICES = new Set<string>(['CN', 'SDN', 'RDN', 'SVN']);
const MINER_DEVICES = new Set<string>(['BM', 'ISM', 'OSM', 'IDM', 'ODM']);

// Future credential validation groups (API keys/tokens, etc.)
const RADIATION_DEVICES = new Set<string>(['IRM']);
const ENERGY_DEVICES = new Set<string>(['EM']);
const AIR_DEVICES = new Set<string>(['IHAQM', 'ILAQM', 'OMAQM', 'IMAQM', 'OHAQM']);
const WEATHER_DEVICES = new Set<string>(['HWM', 'LWM']);
const WATER_DEVICES = new Set<string>(['OLWQM', 'OHWQM']);

/**
 * Check if a string exists in any miner type category.
 * @param value - String to check.
 * @returns True if found in minerType values, false otherwise.
 */
function isValidMinerType(minerKey: string): minerKey is MinerType {
  const prefix = minerKey.split('-')[0];
  return Object.values(minerType).some((types) => types.includes(prefix));
}

function requiresHardwareMac(minerKey: string): boolean {
  const prefix = minerKey.split('-')[0];
  return MAC_REQUIRED_PREFIXES.has(prefix);
}

/**
 * Check if hardware validation is enabled for a specific device type.
 * Uses granular environment variables to control validation rollout.
 * Case-insensitive comparison to handle Docker Compose boolean capitalization.
 * @param minerKey - The miner key (e.g., "AEM-12345", "SDN-67890")
 * @returns true if validation is enabled for this device type, false otherwise
 */
function isHardwareValidationEnabled(minerKey: string): boolean {
  const prefix = minerKey.split('-')[0];
  
  // Helper function for case-insensitive boolean check
  const isFalse = (value: string | undefined): boolean => {
    return value?.toLowerCase() === 'false';
  };
  
  // Check AEM devices
  if (AEM_DEVICES.has(prefix)) {
    return !isFalse(process.env.VALIDATE_HARDWARE_AEM);
  }
  
  // Check Node devices (CN, SDN, RDN, SVN)
  if (NODE_DEVICES.has(prefix)) {
    return !isFalse(process.env.VALIDATE_HARDWARE_NODES);
  }
  
  // Check Miner devices (BM, ISM, OSM, IDM, ODM)
  if (MINER_DEVICES.has(prefix)) {
    return !isFalse(process.env.VALIDATE_HARDWARE_MINERS);
  }
  
  // Future: Check sensor credential validation groups
  // These will use different validation logic (API keys/tokens instead of MAC addresses)
  // For now, return false as these are not yet implemented
  if (RADIATION_DEVICES.has(prefix)) {
    return !isFalse(process.env.VALIDATE_CREDENTIALS_RADIATION);
  }
  
  if (ENERGY_DEVICES.has(prefix)) {
    return !isFalse(process.env.VALIDATE_CREDENTIALS_ENERGY);
  }
  
  if (AIR_DEVICES.has(prefix)) {
    return !isFalse(process.env.VALIDATE_CREDENTIALS_AIR);
  }
  
  if (WEATHER_DEVICES.has(prefix)) {
    return !isFalse(process.env.VALIDATE_CREDENTIALS_WEATHER);
  }
  
  if (WATER_DEVICES.has(prefix)) {
    return !isFalse(process.env.VALIDATE_CREDENTIALS_WATER);
  }
  
  // Default to true (enabled) for unknown device types - fail secure
  return true;
}

interface ReturnDevice {
  device: Device;
  err: string;
}

const testMode = process.env.TEST_MODE && process.env.TEST_MODE === "true";
const DEBUG = process.env.DEBUG && process.env.DEBUG === "true";
const WEEKLY_REWARDS_ENABLED = process.env.WEEKLY_REWARDS_ENABLED === "true";
// Maturation controls (mirror main.ts logic to keep behavior consistent)
const MATURATION_ENABLED = process.env.MATURATION_ENABLED !== 'false';
const DAILY_MATURATION_ENABLED =
  process.env.DAILY_MATURATION_ENABLED !== undefined
    ? process.env.DAILY_MATURATION_ENABLED === 'true'
    : MATURATION_ENABLED;

// Slot-based PoC reward gating (case-insensitive env reads).
// INSTALLER (AEM, BM, IDM, ODM, ISM, OSM, IRM, EM, HWM, LWM, RDN, SDN, SVN, CN):
//   6 gates — data + online + mac_match + pol + poi + poa
// NON_INSTALLER (cameras, weather, AQ monitors — no MAC):
//   4 gates — data + online + pol + poi
// Both categories default ENABLED; set env to "false" for emergency disable.
const POC_REWARD_INSTALLER = process.env.POC_REWARD_INSTALLER?.toLowerCase() !== "false";
const POC_REWARD_NON_INSTALLER = process.env.POC_REWARD_NON_INSTALLER?.toLowerCase() !== "false";

function getDaysConsideringTime(startDate: Date, endDate: Date): number {
  // Set both dates to midnight to ignore hour differences
  const start = new Date(
    startDate.getFullYear(),
    startDate.getMonth(),
    startDate.getDate()
  );
  const end = new Date(
    endDate.getFullYear(),
    endDate.getMonth(),
    endDate.getDate()
  );

  // Get the difference in time in milliseconds
  const differenceInTime = end.getTime() - start.getTime();

  // Convert the difference to days (ignoring time)
  const differenceInDays = differenceInTime / (1000 * 60 * 60 * 24);

  return differenceInDays;
}


/* OLD_LOGIC_BACKUP - Original recordReward function preserved for rollback
export const recordReward = async (
  device: Device,
  product: Product,
  amount: number
): Promise<boolean> => {
  // Algorand validation completely removed for performance optimization
  // All devices now get full reward amount without API calls
  const availableAmount = amount;
  
  DEBUG &&
    console.log(
      `Queue reward ${availableAmount} to miner ${device.miner_key}'s pending list`
    );
  const currentDate = new Date(Date.now());

  try {
    const bookedRecords = (await (testMode
      ? TestRewardModel
      : RewardModel
    ).find({ miner_key: device.miner_key })) as Reward[];
    const rewardNumber = bookedRecords.length + 1;
    const assetId: string = (product.reward.tokens?.reward) || "";
    
    const result = testMode
      ? await TestRewardModel.create({
          no: rewardNumber,
          miner_key: device.miner_key,
          status: "pending",
          amount: availableAmount,
          asset_id: assetId,
          createdAt: new Date(Date.now()),
        })
      : await RewardModel.create({
          no: rewardNumber,
          miner_key: device.miner_key,
          status: "pending",
          amount: availableAmount,
          asset_id: assetId,
          createdAt: new Date(Date.now()),
        });

    if (!result) {
      DEBUG &&
        console.log(`Failed to record reward for miner ${device.miner_key}`);
      return false;
    }

    return true;
  } catch (error) {
    DEBUG && console.error(error);
    return false;
  }
};
*/

// NEW: Device-centric reward recording - aggregates rewards per device instead of individual documents
export const recordReward = async (
  device: Device,
  product: Product,
  amount: number,
  rewardDateStringOverride?: string
): Promise<boolean> => {
  const availableAmount = amount;
  const currentDate = getSimNow();
  // PoC-gated rewards target yesterday UTC; legacy rewards use today's date.
  const dateString = rewardDateStringOverride ?? currentDate.toISOString().split('T')[0]; // YYYY-MM-DD format
  const assetId: string = (product.reward.tokens?.reward) || "";
  const isTfryReward = isTfryAsset(assetId);
  const entryStatus: 'accruing' | 'pending' = WEEKLY_REWARDS_ENABLED ? 'accruing' : 'pending';

  DEBUG &&
    console.log(
      `Recording device reward ${availableAmount} for miner ${device.miner_key} (${entryStatus}) [sim=${currentDate.toISOString()}]`
    );

  try {
    // First, get current reward count for this device to calculate reward_number
    const existingDevice: DeviceReward | null = await (testMode ? TestDeviceRewardModel : DeviceRewardModel)
      .findOne({ miner_key: device.miner_key });

    const nextRewardNumber = (existingDevice?.reward_count || 0) + 1;

    // Prevent duplicate daily rows for the same date/asset (all modes).
    if (existingDevice) {
      const duplicateEntry = existingDevice.daily_rewards?.find(r => r.date === dateString && r.asset_id === assetId);
      if (duplicateEntry) {
        DEBUG && console.log(`Skip duplicate daily entry for ${device.miner_key} on ${dateString} (asset ${assetId}, status ${duplicateEntry.status})`);
        return true;
      }
    }
    
    // Use findOneAndUpdate with upsert to create or update device reward document
    // Build dynamic update object based on weekly flag
    const incFields: Record<string, number> = { reward_count: 1 };
    if (!WEEKLY_REWARDS_ENABLED) {
      if (isTfryReward) {
        applyTfryDelta(incFields, { pending: availableAmount });
      } else {
        incFields.total_pending = availableAmount;
      }
    }

    const result = await (testMode ? TestDeviceRewardModel : DeviceRewardModel)
      .findOneAndUpdate(
        { miner_key: device.miner_key },
        {
          $inc: incFields,
          $push: {
            daily_rewards: {
              date: dateString,
              amount: availableAmount,
              status: entryStatus,
              asset_id: assetId,
              created_at: currentDate,
              reward_number: nextRewardNumber
            }
          },
          $set: {
            last_updated: currentDate,
            last_reward_date: currentDate
          },
          $setOnInsert: {
            first_reward_date: currentDate,
            total_claimable: 0,
            total_claimed: 0
          }
        },
        { 
          upsert: true, 
          new: true,
          setDefaultsOnInsert: true
        }
      ) as DeviceReward | null;

    if (!result) {
      DEBUG && console.log(`Failed to record device reward for miner ${device.miner_key}`);
      return false;
    }

    DEBUG && console.log(`Successfully recorded device reward #${nextRewardNumber} for ${device.miner_key}`);
    return true;
    
  } catch (error) {
    DEBUG && console.error(`Failed to record device reward for ${device.miner_key}:`, error);
    return false;
  }
};

function getDaysBetweenDates(start: Date, end: Date): number {
  // Parse the date strings into Date objects

  // Calculate the difference in milliseconds
  const diffInMs = end.getTime() - start.getTime();

  // Convert milliseconds to days
  const diffInDays = diffInMs / (1000 * 60 * 60 * 24);

  return Math.round(diffInDays); // Round to nearest day
}

/* OLD_LOGIC_BACKUP - Original pendingManage function preserved for rollback
const pendingManage = async (
  device: Device,
  product: Product
): Promise<boolean> => {
  const currentDate = new Date(Date.now());

  try {
    // First, get the records that need status change (preserving original logic)
    const rewardRecords = testMode
      ? ((await TestRewardModel.find({
          miner_key: device.miner_key,
          status: "pending",
        })) as Reward[])
      : ((await RewardModel.find({
          miner_key: device.miner_key,
          status: "pending",
        })) as Reward[]);

    const needStatusChangeRecords = rewardRecords.filter((reward) => {
      const rewardBookDate = new Date(reward.createdAt);
      if (getDaysBetweenDates(rewardBookDate, currentDate) >= 30) {
        return true;
      }
      return false;
    });

    if (needStatusChangeRecords.length === 0) {
      return true; // No records to update
    }

    // Use bulk update with precise matching (optimized version of original logic)
    const bulkOps = needStatusChangeRecords.map(record => ({
      updateOne: {
        filter: {
          miner_key: record.miner_key,
          status: record.status,
          asset_id: record.asset_id,
          amount: record.amount,
          createdAt: record.createdAt,
        },
        update: {
          $set: { status: "claimable" }
        }
      }
    }));

    const result = testMode
      ? await TestRewardModel.bulkWrite(bulkOps)
      : await RewardModel.bulkWrite(bulkOps);

    if (result.modifiedCount > 0) {
      DEBUG && console.log(`Updated ${result.modifiedCount} rewards to claimable for ${device.miner_key}`);
    }

    // Check if all expected records were updated
    if (result.modifiedCount !== needStatusChangeRecords.length) {
      DEBUG && console.log(`Warning: Expected to update ${needStatusChangeRecords.length} records but only updated ${result.modifiedCount}`);
    }

    return true;
  } catch (error) {
    DEBUG && console.error('Status update failed:', error);
    return false;
  }
};
*/

// NEW: Device-centric status management - updates statuses within device reward documents
const pendingManage = async (
  device: Device,
  product: Product
): Promise<boolean> => {
  // Respect daily maturation flag; skip if disabled
  if (!DAILY_MATURATION_ENABLED) return true;
  const currentDate = getSimNow();
  const thirtyDaysAgo = new Date(currentDate.getTime() - 30 * 24 * 60 * 60 * 1000);
  
  DEBUG && console.log(`Managing device reward statuses for ${device.miner_key}`);

  try {
    // Find the device reward document
    const deviceReward: DeviceReward | null = await (testMode ? TestDeviceRewardModel : DeviceRewardModel)
      .findOne({ miner_key: device.miner_key });
    
    if (!deviceReward) {
      DEBUG && console.log(`No device rewards found for ${device.miner_key}`);
      return true; // No device rewards yet, nothing to update
    }
    
    let pendingToClaimable = 0;
    let hasUpdates = false;
    
    // Update statuses in daily_rewards array for rewards older than 30 days
    deviceReward.daily_rewards.forEach(reward => {
      if (reward.status === 'pending' && reward.created_at <= thirtyDaysAgo) {
        reward.status = 'claimable';
        pendingToClaimable += reward.amount;
        hasUpdates = true;
        DEBUG && console.log(`Updating reward #${reward.reward_number} from pending to claimable for ${device.miner_key}`);
      }
    });
    
    if (hasUpdates) {
      // Update the totals to reflect status changes
      deviceReward.total_pending -= pendingToClaimable;
      deviceReward.total_claimable += pendingToClaimable;
      deviceReward.last_updated = currentDate;
      (deviceReward as any).markModified?.('daily_rewards');
      // Save the updated document
      await deviceReward.save();
      DEBUG && console.log(`Updated ${pendingToClaimable} worth of rewards to claimable for ${device.miner_key} (device-centric)`);
    } else {
      DEBUG && console.log(`No pending rewards older than 30 days found for ${device.miner_key}`);
    }
    
    return true;
    
  } catch (error) {
    DEBUG && console.error(`Device status update failed for ${device.miner_key}:`, error);
    return false;
  }
};

export const isNodeProduct = (product: Product) => {
  return product.name.includes("Node");
};

export const isRegistrationNeeded = (product: Product) => {
  const isTokenTypeValid =
    product.reward.tokens?.register &&
    product.reward.tokens.register !== "none";
  const isTokenAmountValid =
    product.reward.stake?.register && product.reward.stake.register > 0;

  return isTokenAmountValid && isTokenTypeValid;
};

export const isNodeStakingNeeded = (product: Product) => {
  const isTokenTypeValid =
    product.reward.tokens?.node && product.reward.tokens.node !== "none";
  const isTokenAmountValid =
    product.reward.stake?.node && product.reward.stake.node > 0;

  return isTokenAmountValid && isTokenTypeValid;
};

export const isRegistrationStaked = (device: Device) => {
  if (device.registration && device.registration.amount > 0) {
    return true;
  }

  return false;
};

export const isNodeStaked = (device: Device) => {
  if (device.node && device.node.amount > 0) {
    return true;
  }

  return false;
};

// ────────────────────────────────────────────────────────────────────────────
// SLOT-BASED PoC REWARD LOGIC
// ────────────────────────────────────────────────────────────────────────────
// Pro-rates each device's daily reward based on 144 slot validations per day
// (6 slots/hour × 24 hours). Each slot has gates that vary by category:
//   - INSTALLER:     data + online + mac_match + pol + poi + poa (6 gates)
//   - NON_INSTALLER: data + online + pol + poi (4 gates) — no MAC on device
// Fail-closed: no PoC hardware doc → rewardFactor = 0 → zero reward.

type PocRewardCategory = 'INSTALLER' | 'NON_INSTALLER';

type PocSlotSummary = {
  slotsTotal: number;
  slotsValid: number;
  multiplierSum: number;
  rewardFactor: number;
  toolsAvg: number | null;
  poiRequired: boolean;
};

type PocRewardDailyEntry = {
  miner_key: string;
  date: string;
  device_type: string;
  category: PocRewardCategory;
  slots_total: number;
  slots_valid: number;
  multiplier_sum: number;
  reward_factor: number;
  tools_avg: number | null;
  poi_required: boolean;
  computed_at: Date;
};

const POC_SLOTS_PER_DAY = 144; // 24h × 6 slots/hour

const clampNumber = (value: number, min: number, max: number): number => {
  return Math.min(max, Math.max(min, value));
};

const roundToTwo = (value: number): number => {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
};

const getDevicePrefix = (minerKey: string): string => {
  return minerKey.split('-')[0]?.toUpperCase() || '';
};

// Non-installer device prefixes: no MAC address, no installer binary.
// Gated on data + online + pol + poi (4 gates, no mac_match).
const NON_INSTALLER_PREFIXES = new Set<string>([
  'IHAQM', 'ILAQM', 'OMAQM', 'IMAQM', 'OHAQM',
  'OLWQM', 'OHWQM',
  'AOWSCM', 'AOWCM', 'AIWCM',
  'AOSCM', 'AISCM',
  'AOTCM', 'AITCM',
  'AIWSCM'
]);

// Returns category for ALL device types — never null. INSTALLER is the default
// for any prefix not explicitly mapped as NON_INSTALLER. Fail-closed still
// applies because the device needs a PoC.hardware doc with slot data to get
// a non-zero rewardFactor.
const getPocRewardCategory = (minerKey: string): PocRewardCategory => {
  const prefix = getDevicePrefix(minerKey);
  if (NON_INSTALLER_PREFIXES.has(prefix)) return 'NON_INSTALLER';
  return 'INSTALLER'; // AEM, BM, ISM, OSM, IDM, ODM, EM, IRM, HWM, LWM, SDN, SVN, RDN, CN, and any new types
};

const isPocRewardEnabledForCategory = (category: PocRewardCategory): boolean => {
  if (category === 'INSTALLER') return POC_REWARD_INSTALLER;
  if (category === 'NON_INSTALLER') return POC_REWARD_NON_INSTALLER;
  return false;
};

const getYesterdayUtcDate = (baseDate: Date): Date => {
  const utc = new Date(Date.UTC(
    baseDate.getUTCFullYear(),
    baseDate.getUTCMonth(),
    baseDate.getUTCDate()
  ));
  utc.setUTCDate(utc.getUTCDate() - 1);
  return utc;
};

const formatUtcDateString = (date: Date): string => {
  return date.toISOString().split('T')[0];
};

const extractPocDayRewards = (
  doc: PocHardwareDoc | null | undefined,
  dateString: string
): Record<string, any> | null => {
  if (!doc || !doc.rewards || typeof doc.rewards !== 'object') {
    return null;
  }
  const dayRewards = doc.rewards[dateString];
  return dayRewards && typeof dayRewards === 'object' ? dayRewards : null;
};

const computePocSlotSummary = (
  doc: PocHardwareDoc | null | undefined,
  dateString: string,
  category: PocRewardCategory
): PocSlotSummary => {
  const dayRewards = extractPocDayRewards(doc, dateString);
  const poiRequired = true; // Both categories require poi

  if (!dayRewards) {
    // Fail-closed: no data → zero reward factor
    return {
      slotsTotal: POC_SLOTS_PER_DAY,
      slotsValid: 0,
      multiplierSum: 0,
      rewardFactor: 0,
      toolsAvg: null,
      poiRequired
    };
  }

  let slotsValid = 0;
  let multiplierSum = 0;
  let toolsSum = 0;
  let toolsSlots = 0;

  const hourKeys = Object.keys(dayRewards).sort((a, b) => Number(a) - Number(b));
  for (const hourKey of hourKeys) {
    const hourEntry = dayRewards[hourKey];
    const slots = Array.isArray(hourEntry?.slots) ? hourEntry.slots : [];
    for (const slot of slots) {
      if (!slot || typeof slot !== 'object') {
        continue;
      }

      const gates = slot.gates || {};

      // Per-category gate validation
      let gateOk: boolean;
      if (category === 'INSTALLER') {
        // 6 gates: data + online + mac_match + pol + poi + poa (poa required for all INSTALLER types)
        gateOk =
          gates.data === true &&
          gates.online === true &&
          gates.mac_match === true &&
          gates.pol === true &&
          gates.poi === true &&
          gates.poa === true;
      } else {
        // NON_INSTALLER: 4 gates (no mac_match — no MAC address on device)
        gateOk =
          gates.data === true &&
          gates.online === true &&
          gates.pol === true &&
          gates.poi === true;
      }

      if (!gateOk) {
        continue;
      }

      slotsValid += 1;
      const rawMultiplier = typeof slot.multiplier === 'number' ? slot.multiplier : 0;
      multiplierSum += clampNumber(rawMultiplier, 0, 1);

      // Tools tracking (any device type that reports tools per slot)
      const rawTools =
        typeof slot.tools_count === 'number'
          ? slot.tools_count
          : Array.isArray(slot.tools_active)
            ? slot.tools_active.length
            : null;
      if (typeof rawTools === 'number' && Number.isFinite(rawTools)) {
        toolsSum += clampNumber(rawTools, 0, 3);
        toolsSlots += 1;
      }
    }
  }

  const rewardFactor = clampNumber(multiplierSum / POC_SLOTS_PER_DAY, 0, 1);

  return {
    slotsTotal: POC_SLOTS_PER_DAY,
    slotsValid,
    multiplierSum,
    rewardFactor,
    toolsAvg: toolsSlots > 0 ? roundToTwo(toolsSum / toolsSlots) : null,
    poiRequired
  };
};

const buildPocRewardDailyEntry = (
  minerKey: string,
  category: PocRewardCategory,
  dateString: string,
  summary: PocSlotSummary,
  computedAt: Date
): PocRewardDailyEntry => ({
  miner_key: minerKey,
  date: dateString,
  device_type: getDevicePrefix(minerKey),
  category,
  slots_total: summary.slotsTotal,
  slots_valid: summary.slotsValid,
  multiplier_sum: summary.multiplierSum,
  reward_factor: summary.rewardFactor,
  tools_avg: summary.toolsAvg,
  poi_required: summary.poiRequired,
  computed_at: computedAt
});

const upsertPocRewardSummaries = async (
  entries: PocRewardDailyEntry[]
): Promise<number> => {
  if (entries.length === 0) {
    return 0;
  }

  const Model = testMode ? TestPocRewardDailyModel : PocRewardDailyModel;
  const ops = entries.map((entry) => ({
    updateOne: {
      filter: { miner_key: entry.miner_key, date: entry.date },
      // Idempotent insert so hourly runs don't balloon storage.
      update: { $setOnInsert: entry },
      upsert: true
    }
  }));

  try {
    const result = await Model.bulkWrite(ops, { ordered: false });
    return result.upsertedCount ?? 0;
  } catch (error) {
    DEBUG && console.error('PoC daily summary upsert failed:', error);
    return 0;
  }
};

// ────────────────────────────────────────────────────────────────────────────
// END SLOT-BASED PoC REWARD LOGIC
// ────────────────────────────────────────────────────────────────────────────

// CONSISTENCY FIX: Add same historical eligibility functions as backpay.ts

/**
 * Determine device type from miner key prefix - CONSISTENT WITH BACKPAY
 */
function getDeviceType(minerKey: string): 'regular' | 'node' | 'aem' {
  const prefix = minerKey.split('-')[0];
  
  if (prefix === 'AEM') {
    return 'aem';
  } else if (['RDN', 'SDN', 'SVN', 'CN'].includes(prefix)) {
    return 'node';
  } else {
    return 'regular';
  }
}

/**
 * Check if device is eligible for rewards on current date - CONSISTENT WITH BACKPAY
 * Uses same logic as backpay but for current date validation
 */
function isDeviceCurrentlyEligible(
  device: Device, 
  product: Product
): {
  eligible: boolean;
  hasVerificationMultiplier: boolean;
  reason?: string;
} {
  const currentDate = getSimNow();
  const deviceType = getDeviceType(device.miner_key);
  
  try {
    switch (deviceType) {
      case 'regular': {
        // Regular miners: Use created_at for base eligibility
        if (!device.created_at || currentDate < device.created_at) {
          return {
            eligible: false,
            hasVerificationMultiplier: false,
            reason: `Device created on ${device.created_at?.toISOString()} after current date`
          };
        }
        
        // Check verification multiplier eligibility
        const hasVerificationMultiplier = device.staked?.time && currentDate >= device.staked.time;
        
        return {
          eligible: true,
          hasVerificationMultiplier: hasVerificationMultiplier || false,
          reason: hasVerificationMultiplier ? 'Eligible with verification multiplier' : 'Eligible with base reward'
        };
      }
      
      case 'node': {
        // Nodes (RDN/SDN/SVN): IGNORE created_at, require both registration and node staking
        // Check registration staking requirement
        if (
          !device.registration?.time ||
          currentDate < device.registration.time ||
          !device.registration?.amount ||
          device.registration.amount <= 0
        ) {
          return {
            eligible: false,
            hasVerificationMultiplier: false,
            reason: `Registration staking not completed. Registration: ${device.registration?.time?.toISOString() || 'none'}`
          };
        }
        
        // Check node staking requirement
        if (
          !device.node?.time ||
          currentDate < device.node.time ||
          !device.node?.amount ||
          device.node.amount <= 0
        ) {
          return {
            eligible: false,
            hasVerificationMultiplier: false,
            reason: `Node staking not completed. Node: ${device.node?.time?.toISOString() || 'none'}`
          };
        }
        
        // Check verification multiplier eligibility
        const hasVerificationMultiplier = device.staked?.time && currentDate >= device.staked.time;
        
        return {
          eligible: true,
          hasVerificationMultiplier: hasVerificationMultiplier || false,
          reason: hasVerificationMultiplier ? 'Node eligible with verification multiplier' : 'Node eligible with base reward'
        };
      }
      
      case 'aem': {
        // AI Edge Miners: IGNORE created_at, require only registration staking (NO node staking)
        
        // Check registration staking requirement
        if (
          !device.registration?.time ||
          currentDate < device.registration.time ||
          !device.registration?.amount ||
          device.registration.amount <= 0
        ) {
          return {
            eligible: false,
            hasVerificationMultiplier: false,
            reason: `AEM registration staking not completed. Registration: ${device.registration?.time?.toISOString() || 'none'}`
          };
        }
        
        // Check verification multiplier eligibility
        const hasVerificationMultiplier = device.staked?.time && currentDate >= device.staked.time;
        
        return {
          eligible: true,
          hasVerificationMultiplier: hasVerificationMultiplier || false,
          reason: hasVerificationMultiplier ? 'AEM eligible with verification multiplier' : 'AEM eligible with base reward'
        };
      }
      
      default: {
        return {
          eligible: false,
          hasVerificationMultiplier: false,
          reason: `Unknown device type: ${deviceType}`
        };
      }
    }
  } catch (error) {
    return {
      eligible: false,
      hasVerificationMultiplier: false,
      reason: `Eligibility check failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    };
  }
}

/**
 * Calculate current reward amount based on device eligibility - CONSISTENT WITH BACKPAY  
 * This accounts for whether verification staking is currently active
 */
function calculateCurrentRewardAmount(
  device: Device, 
  product: Product,
  eligibilityResult: { eligible: boolean; hasVerificationMultiplier: boolean }
): number {
  if (!eligibilityResult.eligible) {
    return 0;
  }

  let rewardAmount = 0;

  // Apply verification multiplier only if staking is currently active
  if (eligibilityResult.hasVerificationMultiplier) {
    switch (device.staked?.type) {
      case "one":
        rewardAmount = Math.round(product.reward.verified * 100 * 1.5) / 100;
        break;
      case "two":
        rewardAmount = Math.round(product.reward.verified * 100 * 3.0) / 100;
        break;
      default:
        // Invalid staking type - use base reward
        rewardAmount = product.reward.verified;
        break;
    }
  } else {
    // Base reward (no active staking multiplier)
    rewardAmount = product.reward.verified;
  }

  // Apply BYOD reduction
  if (device.byod !== undefined && device.byod.length > 0) {
    rewardAmount = Math.round((rewardAmount / 2) * 100) / 100;
  }

  return rewardAmount;
}

/* OLD_LOGIC_BACKUP - Original recordRewardsBulk function preserved for rollback
export const recordRewardsBulk = async (
  rewardBatch: Array<{
    device: Device;
    product: Product;
    amount: number;
  }>
): Promise<{ success: boolean; errors: ReturnDevice[]; partialSuccess?: boolean }> => {
  const errors: ReturnDevice[] = [];
  const rewardsToInsert: any[] = [];
  
  try {
    // Pre-calculate all reward numbers in bulk to avoid individual countDocuments calls
    const minerKeys = rewardBatch.map(({ device }) => device.miner_key);
    const uniqueMinerKeys = [...new Set(minerKeys)];
    
    // Get existing reward counts for all miners in one aggregation query with retry
    let rewardCounts: Array<{ _id: string; count: number }> = [];
    let retryCount = 0;
    const maxRetries = 3;
    
    while (retryCount < maxRetries) {
      try {
        rewardCounts = await (testMode ? TestRewardModel : RewardModel)
          .aggregate([
            { $match: { miner_key: { $in: uniqueMinerKeys } } },
            { $group: { _id: "$miner_key", count: { $sum: 1 } } }
          ]);
        break;
      } catch (aggregationError) {
        retryCount++;
        DEBUG && console.error(`Aggregation attempt ${retryCount} failed:`, aggregationError);
        
        if (retryCount >= maxRetries) {
          // Fall back to individual count queries if aggregation fails
          DEBUG && console.log('Falling back to individual count queries');
          rewardCounts = [];
          for (const minerKey of uniqueMinerKeys) {
            try {
              const count = await (testMode ? TestRewardModel : RewardModel)
                .countDocuments({ miner_key: minerKey });
              rewardCounts.push({ _id: minerKey, count });
            } catch (countError) {
              DEBUG && console.error(`Count failed for ${minerKey}:`, countError);
              const failedDevice = rewardBatch.find(({ device }) => device.miner_key === minerKey)?.device;
              if (failedDevice) {
                errors.push({ 
                  device: failedDevice, 
                  err: "Count query failed" 
                });
              }
            }
          }
          break;
        }
        
        // Wait before retry with exponential backoff
        await new Promise(resolve => setTimeout(resolve, 100 * Math.pow(2, retryCount - 1)));
      }
    }
    
    // Create lookup map for reward counts
    const countMap = new Map<string, number>();
    rewardCounts.forEach(({ _id, count }) => {
      countMap.set(_id, count);
    });
    
    // Track incremental counts for devices appearing multiple times in batch
    const incrementalCounts = new Map<string, number>();
    
    // Process each reward in the batch
    for (const { device, product, amount } of rewardBatch) {
      try {
        // Validate inputs
        if (!device || !device.miner_key) {
          errors.push({ device, err: "Invalid device data" });
          continue;
        }
        
        if (!product || !product.reward) {
          errors.push({ device, err: "Invalid product data" });
          continue;
        }
        
        if (typeof amount !== 'number' || amount <= 0) {
          errors.push({ device, err: "Invalid reward amount" });
          continue;
        }
        
        // Algorand validation completely removed for performance optimization
        const availableAmount = amount;
        
        // Get reward number efficiently
        const existingCount = countMap.get(device.miner_key) || 0;
        const incrementalCount = incrementalCounts.get(device.miner_key) || 0;
        const rewardNumber = existingCount + incrementalCount + 1;
        
        // Update incremental count for this device
        incrementalCounts.set(device.miner_key, incrementalCount + 1);
        
        // Ensure asset_id is properly typed - use empty string as default
        const assetId: string = (product.reward.tokens?.reward) || "";
        
        rewardsToInsert.push({
          no: rewardNumber,
          miner_key: device.miner_key,
          status: "pending",
          amount: availableAmount,
          asset_id: assetId,
          createdAt: new Date(),
        });
        
      } catch (itemError) {
        DEBUG && console.error(`Processing failed for device ${device?.miner_key}:`, itemError);
        errors.push({ device, err: "Item processing failed" });
      }
    }
    
    // Attempt bulk insert with enhanced error handling
    if (rewardsToInsert.length > 0) {
      let insertRetryCount = 0;
      const maxInsertRetries = 2;
      
      while (insertRetryCount < maxInsertRetries) {
        try {
          const result = await (testMode ? TestRewardModel : RewardModel)
            .insertMany(rewardsToInsert, { 
              ordered: false
            });
          
          const successCount = Array.isArray(result) ? result.length : 0;
          DEBUG && console.log(`Bulk inserted ${successCount}/${rewardsToInsert.length} rewards`);
          
          // Check for partial success
          if (successCount < rewardsToInsert.length) {
            DEBUG && console.warn(`Partial bulk insert: ${successCount}/${rewardsToInsert.length} succeeded`);
            return { 
              success: successCount > 0, 
              errors, 
              partialSuccess: successCount > 0 && successCount < rewardsToInsert.length 
            };
          }
          
          return { success: true, errors };
          
        } catch (insertError: any) {
          insertRetryCount++;
          DEBUG && console.error(`Bulk insert attempt ${insertRetryCount} failed:`, insertError);
          
          // Handle specific MongoDB errors
          if (insertError.code === 11000) {
            // Duplicate key error - this might be expected in some cases
            DEBUG && console.log('Duplicate key error detected, some records may already exist');
            return { success: true, errors, partialSuccess: true };
          }
          
          if (insertRetryCount >= maxInsertRetries) {
            DEBUG && console.error('All bulk insert attempts failed, falling back to individual inserts');
            
            // Fall back to individual inserts
            let individualSuccessCount = 0;
            const individualErrors: ReturnDevice[] = [];
            
            for (let i = 0; i < rewardsToInsert.length; i++) {
              const reward = rewardsToInsert[i];
              const originalDevice = rewardBatch[i]?.device;
              
              try {
                await (testMode ? TestRewardModel : RewardModel).create(reward);
                individualSuccessCount++;
              } catch (individualError) {
                DEBUG && console.error(`Individual insert failed for ${reward.miner_key}:`, individualError);
                if (originalDevice) {
                  individualErrors.push({ device: originalDevice, err: "Individual insert failed" });
                }
              }
            }
            
            DEBUG && console.log(`Individual fallback: ${individualSuccessCount}/${rewardsToInsert.length} succeeded`);
            errors.push(...individualErrors);
            
            return { 
              success: individualSuccessCount > 0, 
              errors, 
              partialSuccess: individualSuccessCount > 0 && individualSuccessCount < rewardsToInsert.length 
            };
          }
          
          // Wait before retry
          await new Promise(resolve => setTimeout(resolve, 500 * insertRetryCount));
        }
      }
    }
    
    return { success: true, errors };
    
  } catch (error) {
    DEBUG && console.error('Bulk reward processing completely failed:', error);
    
    // Return all items as errors
    const allErrors = rewardBatch.map(({ device }) => ({ 
      device, 
      err: `Bulk operation failed: ${error instanceof Error ? error.message : 'Unknown error'}` 
    }));
    
    return { success: false, errors: allErrors };
  }
};
*/

// NEW: Device-centric bulk reward recording - processes multiple devices efficiently using aggregated documents
export const recordRewardsBulk = async (
  rewardBatch: Array<{
    device: Device;
    product: Product;
    amount: number;
    rewardDateString?: string;
  }>
): Promise<{ success: boolean; errors: ReturnDevice[]; partialSuccess?: boolean; stats: { insertedDevices: number; insertedRows: number; skippedDevices: number } }> => {
  const errors: ReturnDevice[] = [];
  const currentDate = getSimNow();
  const dateString = currentDate.toISOString().split('T')[0]; // YYYY-MM-DD format (default if no override)
  const entryStatus: 'accruing' | 'pending' = WEEKLY_REWARDS_ENABLED ? 'accruing' : 'pending';

  DEBUG && console.log(`Processing bulk device rewards for ${rewardBatch.length} devices (device-centric)`);

  try {
    // Group rewards by device to handle multiple rewards per device efficiently
    const deviceRewardMap = new Map<string, {
      device: Device;
      rewards: Array<{ product: Product; amount: number; rewardDateString?: string }>;
    }>();

    // Group rewards by device
    for (const { device, product, amount, rewardDateString } of rewardBatch) {
      try {
        // Validate inputs
        if (!device || !device.miner_key) {
          errors.push({ device, err: "Invalid device data" });
          continue;
        }

        if (!product || !product.reward) {
          errors.push({ device, err: "Invalid product data" });
          continue;
        }

        // Allow zero amounts (slot system pro-rates to 0 for devices with no PoC data).
        // Only reject NaN/Infinity/negative.
        if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
          errors.push({ device, err: "Invalid reward amount" });
          continue;
        }

        const minerKey = device.miner_key;
        if (!deviceRewardMap.has(minerKey)) {
          deviceRewardMap.set(minerKey, {
            device,
            rewards: []
          });
        }

        deviceRewardMap.get(minerKey)!.rewards.push({ product, amount, rewardDateString });

      } catch (itemError) {
        DEBUG && console.error(`Validation failed for device ${device?.miner_key}:`, itemError);
        errors.push({ device, err: "Validation failed" });
      }
    }
    
    // Process each device's rewards
    let successCount = 0; // rows added
    let insertedDeviceSet = new Set<string>();
    let skippedDevices = 0; // devices with 0 rows added due to duplicate guard
    const promises = Array.from(deviceRewardMap.entries()).map(async ([minerKey, { device, rewards }]) => {
      try {
        // Get current device reward document to calculate next reward numbers
        const existingDevice = await (testMode ? TestDeviceRewardModel : DeviceRewardModel)
          .findOne({ miner_key: minerKey });

        let rewardCount = existingDevice?.reward_count || 0;
        let totalPendingIncrease = 0;
        const dailyRewardsToAdd: any[] = [];
        let deviceAddedAny = false;
        const seenDailyKeys = new Set<string>();
        // Track existing date/asset pairs to prevent duplicate daily rows (all modes).
        if (existingDevice?.daily_rewards) {
          existingDevice.daily_rewards.forEach(r => {
            if (r?.asset_id && r?.date) {
              seenDailyKeys.add(`${r.asset_id}::${r.date}`);
            }
          });
        }

        // Process all rewards for this device
        for (const { product, amount, rewardDateString } of rewards) {
          if (!WEEKLY_REWARDS_ENABLED) {
            totalPendingIncrease += amount;
          }
          const assetId: string = (product.reward.tokens?.reward) || "";
          // PoC entries use yesterday UTC; legacy entries use today.
          const effectiveDate = rewardDateString ?? dateString;
          const key = `${assetId}::${effectiveDate}`;
          if (seenDailyKeys.has(key)) {
            DEBUG && console.log(`Skip duplicate daily entry (bulk) for ${minerKey} on ${effectiveDate} (asset ${assetId})`);
            continue;
          }
          seenDailyKeys.add(key);

          rewardCount++;
          dailyRewardsToAdd.push({
            date: effectiveDate,
            amount: amount,
            status: entryStatus,
            asset_id: assetId,
            created_at: currentDate,
            reward_number: rewardCount
          });
          deviceAddedAny = true;
        }
        
        // Update device reward document with all rewards at once
        const incFields: any = { reward_count: dailyRewardsToAdd.length };
        if (!WEEKLY_REWARDS_ENABLED) {
          incFields.total_pending = totalPendingIncrease;
        }

        const result = await (testMode ? TestDeviceRewardModel : DeviceRewardModel)
          .findOneAndUpdate(
            { miner_key: minerKey },
            {
              $inc: incFields,
              $push: {
                daily_rewards: { $each: dailyRewardsToAdd }
              },
              $set: {
                last_updated: currentDate,
                last_reward_date: currentDate
              },
              $setOnInsert: {
                first_reward_date: currentDate,
                total_claimable: 0,
                total_claimed: 0
              }
            },
            { 
              upsert: true, 
              new: true,
              setDefaultsOnInsert: true
            }
          ) as DeviceReward | null;
          
        if (result) {
          successCount += dailyRewardsToAdd.length;
          if (deviceAddedAny) {
            insertedDeviceSet.add(minerKey);
            DEBUG && console.log(`Successfully processed ${dailyRewardsToAdd.length} rewards for device ${minerKey} (device-centric bulk)`);
          } else {
            skippedDevices += 1;
          }
        } else {
          throw new Error(`Failed to update device reward document for ${minerKey}`);
        }
        
      } catch (deviceError) {
        DEBUG && console.error(`Bulk processing failed for device ${minerKey}:`, deviceError);
        errors.push({ 
          device, 
          err: `Device processing failed: ${deviceError instanceof Error ? deviceError.message : 'Unknown error'}` 
        });
      }
    });
    
    // Wait for all device updates to complete
    await Promise.allSettled(promises);
    
    const totalExpected = rewardBatch.length;
    const totalFailed = errors.length;
    const actualSuccess = totalExpected - totalFailed;
    
    DEBUG && console.log(`Bulk device rewards completed: ${actualSuccess}/${totalExpected} successful`);
    
    const stats = { insertedDevices: insertedDeviceSet.size, insertedRows: successCount, skippedDevices };
    if (actualSuccess === 0) {
      return { success: false, errors, stats };
    } else if (actualSuccess < totalExpected) {
      return { success: true, errors, partialSuccess: true, stats };
    } else {
      return { success: true, errors, stats };
    }
    
  } catch (error) {
    DEBUG && console.error('Device-centric bulk reward processing completely failed:', error);
    
    // Return all items as errors
    const allErrors = rewardBatch.map(({ device }) => ({ 
      device, 
      err: `Bulk device operation failed: ${error instanceof Error ? error.message : 'Unknown error'}` 
    }));
    // Provide zeroed stats on failure path to satisfy return type
    const stats = { insertedDevices: 0, insertedRows: 0, skippedDevices: 0 };
    return { success: false, errors: allErrors, stats };
  }
};

export type AccrualSummary = {
  eligibleDevices: number;
  insertedDevices: number;
  insertedRows: number;
  skippedDuplicates: number;
  notEligible: number;
  noWallet: number;
  otherValidation: number;
  dbErrors: number;
};

export const doRewards = async (
  devices: Device[],
  products: Product[]
): Promise<{ errors: ReturnDevice[]; summary: AccrualSummary; report: RewardReport }> => {
  const errDevices: ReturnDevice[] = [];
  const currentDate = getSimNow();
  // PoC slot-based rewards target yesterday UTC to avoid partial-day penalties.
  const pocRewardDateString = formatUtcDateString(getYesterdayUtcDate(currentDate));
  const pocRewardsEnabled = POC_REWARD_INSTALLER || POC_REWARD_NON_INSTALLER;
  if (pocRewardsEnabled) {
    logSection(`PoC reward date (UTC): ${pocRewardDateString}`);
  }
  const BATCH_SIZE = 200; // Process devices in batches for better performance
  const BULK_INSERT_SIZE = 50; // Size for bulk database operations

  logSection(`Starting reward processing for ${devices.length} devices in batches of ${BATCH_SIZE} [sim=${currentDate.toISOString()}]`);
  // Aggregated summary across all batches
  let eligibleDevices = 0;
  let insertedDevices = 0;
  let insertedRows = 0;
  let skippedDuplicates = 0;
  let notEligible = 0;
  let noWallet = 0;
  let otherValidation = 0;
  let dbErrors = 0;

  const hardwareCache = new Map<string, HardwareCredential | null>();
  const attemptMap = new Map<string, number>();

  // Process devices in batches for better performance
  for (let i = 0; i < devices.length; i += BATCH_SIZE) {
    const batch = devices.slice(i, i + BATCH_SIZE);
    logSection(`Processing batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(devices.length/BATCH_SIZE)} (${batch.length} devices)`);

    // Collect valid devices and their rewards for bulk processing
    const validRewards: Array<{
      device: Device;
      product: Product;
      amount: number;
      rewardDateString?: string;
      pocSummary?: PocRewardDailyEntry;
    }> = [];
    const invalidDevices: ReturnDevice[] = [];

    // Pre-fetch PoC.hardware docs for all PoC-gated devices in this batch.
    // Pulling only the target day's rewards subtree keeps reads lean.
    const pocCategoryByKey = new Map<string, PocRewardCategory>();
    let pocDocsByKey = new Map<string, PocHardwareDoc>();
    if (pocRewardsEnabled) {
      const pocKeys: string[] = [];
      for (const device of batch) {
        const category = getPocRewardCategory(device.miner_key);
        if (isPocRewardEnabledForCategory(category)) {
          pocCategoryByKey.set(device.miner_key, category);
          pocKeys.push(device.miner_key);
        }
      }
      if (pocKeys.length > 0) {
        pocDocsByKey = await getPocHardwareDocsForDate(pocKeys, pocRewardDateString);
      }
    }

    // Process batch with concurrent validation
    const batchPromises = batch.map(async (device) => {
      try {
        // Get product of miner
        let minerType = device.miner_key.split("-")[0];
        if (minerType === "CN" && PRESALE_CN_TO_RDN_OVERRIDES.has(device.miner_key)) {
          minerType = "RDN";
        }
        const product = products.find((product) => product.key === minerType);
        if (!product) {
          DEBUG && console.log(`Product not found for miner ${device.miner_key}`);
          return { device, err: "Product not found" };
        }

        // Hardware validation with granular control.
        // When PoC slot gating is active for this device, the slot system's
        // mac_match gate covers MAC validation — skip the legacy check.
        const pocCategoryForValidation = getPocRewardCategory(device.miner_key);
        const skipLegacyMacValidation = isPocRewardEnabledForCategory(pocCategoryForValidation);
        if (skipLegacyMacValidation) {
          DEBUG && console.log(`Skipping legacy MAC validation for ${device.miner_key} (PoC slot gating active)`);
        }
        if (requiresHardwareMac(device.miner_key) && !skipLegacyMacValidation) {
          // Check if device has an active exception
          if (device.rewards_exception?.enabled) {
            const now = new Date();
            const isExpired = device.rewards_exception.expires_at && device.rewards_exception.expires_at < now;
            
            if (!isExpired) {
              // Active exception - bypass validation
              DEBUG && console.log(
                `Hardware validation BYPASSED for ${device.miner_key} ` +
                `(Exception: ${device.rewards_exception.reason || 'N/A'}, Added by: ${device.rewards_exception.added_by || 'N/A'})`
              );
            } else {
              // Exception expired - perform normal validation
              DEBUG && console.log(`Exception EXPIRED for ${device.miner_key} - performing validation`);
              
              // Check if validation is enabled for this device type
              if (isHardwareValidationEnabled(device.miner_key)) {
                try {
                  let hardwareCredential = hardwareCache.get(device.miner_key);
                  if (hardwareCredential === undefined) {
                    hardwareCredential = await getHardwareCredential(device.miner_key);
                    hardwareCache.set(device.miner_key, hardwareCredential);
                  }

                  if (!hardwareCredential || !hardwareCredential.device_id) {
                    DEBUG && console.log(`Missing hardware MAC for miner ${device.miner_key}`);
                    return { device, err: "Hardware MAC missing" };
                  }

                  const macAssessment = validateMacAddress(hardwareCredential.device_id);
                  if (!macAssessment.valid) {
                    DEBUG && console.log(`Invalid hardware MAC for miner ${device.miner_key}: ${hardwareCredential.device_id} (${macAssessment.reason})`);
                    return { device, err: "Hardware MAC invalid" };
                  }
                } catch (error) {
                  console.error(`Hardware credential lookup failed for ${device.miner_key}:`, error);
                  return { device, err: "Hardware lookup failed" };
                }
              } else {
                // Validation disabled for this device type - skip credential check
                DEBUG && console.log(`Hardware validation disabled for ${device.miner_key} - skipping credential check`);
              }
            }
          } else {
            // No exception - check if validation is enabled for this device type
            if (isHardwareValidationEnabled(device.miner_key)) {
              try {
                let hardwareCredential = hardwareCache.get(device.miner_key);
                if (hardwareCredential === undefined) {
                  hardwareCredential = await getHardwareCredential(device.miner_key);
                  hardwareCache.set(device.miner_key, hardwareCredential);
                }

                if (!hardwareCredential || !hardwareCredential.device_id) {
                  DEBUG && console.log(`Missing hardware MAC for miner ${device.miner_key}`);
                  return { device, err: "Hardware MAC missing" };
                }

                const macAssessment = validateMacAddress(hardwareCredential.device_id);
                if (!macAssessment.valid) {
                  DEBUG && console.log(`Invalid hardware MAC for miner ${device.miner_key}: ${hardwareCredential.device_id} (${macAssessment.reason})`);
                  return { device, err: "Hardware MAC invalid" };
                }
              } catch (error) {
                console.error(`Hardware credential lookup failed for ${device.miner_key}:`, error);
                return { device, err: "Hardware lookup failed" };
              }
            } else {
              // Validation disabled for this device type - skip credential check
              DEBUG && console.log(`Hardware validation disabled for ${device.miner_key} - skipping credential check`);
            }
          }
        }

        // Check if product is rewardable
        if (
          !product.reward.tokens ||
          !product.reward.tokens.reward ||
          product.reward.tokens.reward === "none"
        ) {
          DEBUG && console.log(`Product ${product.name} is not allowed to get reward`);
          return { device, err: "Product not rewardable" };
        }

        // CONSISTENCY FIX: Use new eligibility validation - SAME AS BACKPAY
        const eligibilityResult = isDeviceCurrentlyEligible(device, product);

        if (!eligibilityResult.eligible) {
          DEBUG && console.log(`Device ${device.miner_key} not eligible: ${eligibilityResult.reason}`);
          return { device, err: "Device not eligible" };
        }

        // Reward wallet validation
        const minerRewardAddr = device.reward_wallet;
        if (!minerRewardAddr) {
          DEBUG && console.log(`No reward wallet is set for miner ${device.miner_key}`);
          return { device, err: "No reward wallet" };
        }

        // Asset validation for staking mismatches
        if (
          isRegistrationStaked(device) &&
          device.registration?.asset_id !== product.reward.tokens?.register
        ) {
          DEBUG && console.log(`Device ${device.miner_key} is not valid for registration staking`);
          return { device, err: "Invalid registration staking" };
        }

        if (
          isNodeStaked(device) &&
          device.node?.asset_id !== product.reward.tokens?.node
        ) {
          DEBUG && console.log(`Device ${device.miner_key} is not valid for node staking`);
          return { device, err: "Invalid node staking" };
        }

        // CONSISTENCY FIX: Use new reward calculation - SAME AS BACKPAY
        let rewardAmount = calculateCurrentRewardAmount(device, product, eligibilityResult);
        let rewardDateStringOverride: string | undefined;
        let pocSummary: PocRewardDailyEntry | undefined;

        // Apply slot-based PoC reward factor for all gated devices.
        // Fail-closed: no PoC hardware doc → rewardFactor = 0 → zero reward.
        const pocCategory = pocCategoryByKey.get(device.miner_key);
        if (pocCategory) {
          const pocDoc = pocDocsByKey.get(device.miner_key);
          const slotSummary = computePocSlotSummary(pocDoc, pocRewardDateString, pocCategory);
          rewardAmount = roundToTwo(rewardAmount * slotSummary.rewardFactor);
          rewardDateStringOverride = pocRewardDateString;
          pocSummary = buildPocRewardDailyEntry(
            device.miner_key,
            pocCategory,
            pocRewardDateString,
            slotSummary,
            currentDate
          );
        }

        if (!Number.isFinite(rewardAmount) || rewardAmount < 0) {
          DEBUG && console.log(`Invalid reward amount for device ${device.miner_key}`);
          return { device, err: "Invalid reward amount" };
        }
        const normalizedRewardAmount = Math.max(0, rewardAmount);

        // Log device type and eligibility for debugging (first batch only)
        if (i === 0 && batch.indexOf(device) < 10) {
          const deviceType = getDeviceType(device.miner_key);
          DEBUG && console.log(`Daily: Device ${device.miner_key} (${deviceType}): ${eligibilityResult.reason} -> ${normalizedRewardAmount} reward`);
        }

        // Return valid reward data for bulk processing
        return {
          device,
          product,
          amount: normalizedRewardAmount,
          rewardDateString: rewardDateStringOverride,
          pocSummary,
          valid: true
        };
        
      } catch (error) {
        console.error(`Error validating device ${device.miner_key}: ${error}`);
        return { device, err: "Validation failed" };
      }
    });
    
    // Wait for all validation promises to complete
    const validationResults = await Promise.allSettled(batchPromises);
    
    // Separate valid and invalid devices
    validationResults.forEach((result) => {
      if (result.status === 'fulfilled') {
        if (result.value.valid) {
          validRewards.push({
            device: result.value.device,
            product: result.value.product,
            amount: result.value.amount,
            rewardDateString: result.value.rewardDateString,
            pocSummary: result.value.pocSummary
          });
          const key = result.value.device.miner_key;
          const amount = typeof result.value.amount === 'number' ? result.value.amount : 0;
          attemptMap.set(key, (attemptMap.get(key) ?? 0) + amount);
        } else {
          invalidDevices.push({ device: result.value.device, err: result.value.err || "Unknown validation error" });
        }
      } else {
        console.error('Validation promise rejected:', result.reason);
      }
    });
    
    // Add invalid devices to error list and counters
    errDevices.push(...invalidDevices);
    eligibleDevices += validRewards.length;
    for (const e of invalidDevices) {
      if (e.err === 'Device not eligible') notEligible++;
      else if (e.err === 'No reward wallet') noWallet++;
      else otherValidation++;
    }
    
    // Process valid rewards in bulk chunks
    if (validRewards.length > 0) {
      for (let j = 0; j < validRewards.length; j += BULK_INSERT_SIZE) {
        const bulkChunk = validRewards.slice(j, j + BULK_INSERT_SIZE);

        try {
          // Use bulk insert for reward records
          const bulkResult = await recordRewardsBulk(bulkChunk);

          if (!bulkResult.success) {
            errDevices.push(...bulkResult.errors);
            continue;
          }

          // Add any errors from bulk processing
          errDevices.push(...bulkResult.errors);
          // Aggregate bulk stats
          insertedDevices += bulkResult.stats.insertedDevices;
          insertedRows += bulkResult.stats.insertedRows;
          skippedDuplicates += bulkResult.stats.skippedDevices;
          dbErrors += bulkResult.errors.length;

          DEBUG && console.log(`Bulk processed ${bulkResult.stats.insertedRows} accrual rows across ${bulkResult.stats.insertedDevices} devices (skipped duplicates: ${bulkResult.stats.skippedDevices})`);

          // Write PoC daily summaries for successful rewards.
          // Idempotent inserts via $setOnInsert + unique (miner_key, date) index.
          const failedKeys = new Set(
            bulkResult.errors
              .map((entry) => entry.device?.miner_key)
              .filter((key): key is string => Boolean(key))
          );
          const summariesToWrite = bulkChunk
            .filter((entry) => entry.pocSummary && !failedKeys.has(entry.device.miner_key))
            .map((entry) => entry.pocSummary as PocRewardDailyEntry);
          if (summariesToWrite.length > 0) {
            const inserted = await upsertPocRewardSummaries(summariesToWrite);
            DEBUG && console.log(`PoC daily summaries inserted: ${inserted}/${summariesToWrite.length}`);
          }

        } catch (error) {
          console.error(`Bulk processing failed for chunk: ${error}`);
          // Fall back to individual processing for this chunk
          for (const { device, product, amount, rewardDateString, pocSummary } of bulkChunk) {
            try {
              const result = await recordReward(device, product, amount, rewardDateString);
              if (!result) {
                errDevices.push({ device, err: "Recording reward failed" });
              } else if (pocSummary) {
                // Write the PoC summary even when bulk insert had to fall back.
                await upsertPocRewardSummaries([pocSummary]);
              }
            } catch (individualError) {
              errDevices.push({ device, err: "Individual recording failed" });
            }
          }
        }
      }
      
      // Process pending status updates for all successful devices
      const statusUpdatePromises = validRewards
        .filter(({ device }) => !errDevices.some(err => err.device.miner_key === device.miner_key))
        .map(async ({ device, product }) => {
          let retryManage = 0;
          while (!(await pendingManage(device, product)) && retryManage < 3) {
            await sleep(500);
            retryManage++;
          }
        });
      
      await Promise.allSettled(statusUpdatePromises);
    }
    
    // Small delay between batches
    await sleep(100);
  }

  const failureMap = new Map<string, RewardReportEntry>();
  for (const errorEntry of errDevices) {
    const key = errorEntry.device?.miner_key;
    if (!key) {
      continue;
    }
    const reason = errorEntry.err || 'Unknown error';
    const existing = failureMap.get(key);
    if (existing) {
      if (existing.reason && existing.reason.includes(reason)) {
        continue;
      }
      const combinedReason = existing.reason
        ? `${existing.reason} | ${reason}`
        : reason;
      failureMap.set(key, { miner_key: key, reason: combinedReason });
    } else {
      failureMap.set(key, { miner_key: key, reason });
    }
  }

  const successes: RewardReportEntry[] = [];
  attemptMap.forEach((amount, key) => {
    if (failureMap.has(key)) {
      return;
    }
    successes.push({ miner_key: key, amount, reason: 'rewarded' });
  });

  const report: RewardReport = {
    successes,
    failures: Array.from(failureMap.values())
  };

  // Emit a clear, multi-line summary for this run
  const denom = Math.max(1, eligibleDevices);
  const successRate = ((insertedDevices / denom) * 100).toFixed(2);

  logSection(
    '--- Accrual Summary ---',
    `Eligible devices: ${eligibleDevices}`,
    `Inserted devices: ${insertedDevices}`,
    `Inserted rows: ${insertedRows}`,
    `Skipped (duplicate guard): ${skippedDuplicates}`,
    `Devices not eligible: ${notEligible}`,
    `No reward wallet: ${noWallet}`,
    `Other validation errors: ${otherValidation}`,
    `DB/errors during bulk: ${dbErrors}`,
    `Success rate (inserted / eligible): ${successRate}%`,
    '-----------------------------------'    
  );

  const summary: AccrualSummary = {
    eligibleDevices,
    insertedDevices,
    insertedRows,
    skippedDuplicates,
    notEligible,
    noWallet,
    otherValidation,
    dbErrors
  };

  return { errors: errDevices, summary, report };
};
