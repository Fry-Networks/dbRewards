import readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { connect, getConnection } from "../db/connect";
import { DeviceModel, TestDeviceModel } from "../db/devices-schema";
import { ProductModel } from "../db/products-schema";
import { DeviceRewardModel, TestDeviceRewardModel, DeviceReward } from "../db/device-rewards-schema";
import "dotenv/config";

import {
  isRegistrationStaked,
  isNodeStaked
} from "../reward";

// PHASE 1: Historical Eligibility Validation Functions

/**
 * Determine device type from miner key prefix
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
 * Check if device was eligible for rewards on a specific historical date
 * Implements device-type-specific eligibility rules for backpay operations
 */
function isDeviceEligibleForDate(
  device: Device, 
  targetDate: Date, 
  product: Product
): {
  eligible: boolean;
  hasVerificationMultiplier: boolean;
  reason?: string;
} {
  const deviceType = getDeviceType(device.miner_key);
  
  try {
    switch (deviceType) {
      case 'regular': {
        // Regular miners: Use created_at for base eligibility
        if (!device.created_at || targetDate < device.created_at) {
          return {
            eligible: false,
            hasVerificationMultiplier: false,
            reason: `Device created on ${device.created_at?.toISOString()} after target date ${targetDate.toISOString()}`
          };
        }
        
        // Check verification multiplier eligibility
        const hasVerificationMultiplier = device.staked?.time && targetDate >= device.staked.time;
        
        return {
          eligible: true,
          hasVerificationMultiplier: hasVerificationMultiplier || false,
          reason: hasVerificationMultiplier ? 'Eligible with verification multiplier' : 'Eligible with base reward'
        };
      }
      
      case 'node': {
        // Nodes (RDN/SDN/SVN): IGNORE created_at, require both registration and node staking
        
        // Check registration staking requirement
        if (!device.registration?.time || targetDate < device.registration.time) {
          return {
            eligible: false,
            hasVerificationMultiplier: false,
            reason: `Registration staking not completed by target date. Registration: ${device.registration?.time?.toISOString() || 'none'}, Target: ${targetDate.toISOString()}`
          };
        }
        
        // Check node staking requirement
        if (!device.node?.time || targetDate < device.node.time) {
          return {
            eligible: false,
            hasVerificationMultiplier: false,
            reason: `Node staking not completed by target date. Node: ${device.node?.time?.toISOString() || 'none'}, Target: ${targetDate.toISOString()}`
          };
        }
        
        // Check verification multiplier eligibility
        const hasVerificationMultiplier = device.staked?.time && targetDate >= device.staked.time;
        
        return {
          eligible: true,
          hasVerificationMultiplier: hasVerificationMultiplier || false,
          reason: hasVerificationMultiplier ? 'Node eligible with verification multiplier' : 'Node eligible with base reward'
        };
      }
      
      case 'aem': {
        // AI Edge Miners: IGNORE created_at, require only registration staking (NO node staking)
        
        // Check registration staking requirement
        if (!device.registration?.time || targetDate < device.registration.time) {
          return {
            eligible: false,
            hasVerificationMultiplier: false,
            reason: `AEM registration staking not completed by target date. Registration: ${device.registration?.time?.toISOString() || 'none'}, Target: ${targetDate.toISOString()}`
          };
        }
        
        // Check verification multiplier eligibility
        const hasVerificationMultiplier = device.staked?.time && targetDate >= device.staked.time;
        
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
 * Calculate historical reward amount based on device eligibility at target date
 * This accounts for whether verification staking was active at the time
 */
function calculateHistoricalRewardAmount(
  device: Device, 
  product: Product, 
  targetDate: Date,
  eligibilityResult: { eligible: boolean; hasVerificationMultiplier: boolean }
): number {
  if (!eligibilityResult.eligible) {
    return 0;
  }

  let rewardAmount = 0;

  // Apply verification multiplier only if staking was active on target date
  if (eligibilityResult.hasVerificationMultiplier && device.verified) {
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
    // Base reward (no multiplier or device not verified)
    rewardAmount = product.reward.verified;
  }

  // Apply BYOD reduction
  if (device.byod !== undefined && device.byod.length > 0) {
    rewardAmount = Math.round((rewardAmount / 2) * 100) / 100;
  }

  return rewardAmount;
}

import { Product } from "../db/products-schema";
import { Device } from "../db/devices-schema";
import { errorTracker } from "../error-tracker";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

interface BackpayConfig {
  startDate: Date;
  endDate: Date;
  minerKey?: string;
  allDevices: boolean;
  minerTypePrefix?: string;
  mode: 'daily' | 'weekly' | 'daily-accruing';
}

function parseDate(dateStr: string): Date | null {
  // Support MM/DD/YYYY format
  const match = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  
  const [, month, day, year] = match;
  const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
  
  // Validate date
  if (date.getDate() !== parseInt(day) || 
      date.getMonth() !== parseInt(month) - 1 || 
      date.getFullYear() !== parseInt(year)) {
    return null;
  }
  
  return date;
}

function question(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

function calculateRewardAmount(device: Device, product: Product): number {
  let rewardAmount = 0;

  // Use same logic as reward.ts for consistency
  if (
    device.staked === undefined ||
    product.reward.tokens?.stake === "none" ||
    device.staked.asset_id !== product.reward.tokens?.stake
  ) {
    rewardAmount = product.reward.verified;
  } else {
    if (device.verified) {
      switch (device.staked.type) {
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
      rewardAmount = product.reward.verified;
    }
  }

  // Apply BYOD reduction
  if (device.byod !== undefined && device.byod.length > 0) {
    rewardAmount = Math.round((rewardAmount / 2) * 100) / 100;
  }

  return rewardAmount;
}

async function getBackpayConfig(): Promise<BackpayConfig> {
  console.log('\n=== BACKPAY CONFIGURATION ===');
  
  // Choose backpay type: daily vs weekly
  let mode: 'daily' | 'weekly' | 'daily-accruing' = 'daily';
  while (true) {
    const typeStr = (await question('Backpay type (daily/weekly/daily-accruing) [daily]: ')).trim().toLowerCase();
    if (typeStr === '' || typeStr === 'daily') { mode = 'daily'; break; }
    if (typeStr === 'weekly') { mode = 'weekly'; break; }
    if (typeStr === 'accruing' || typeStr === 'daily-accruing') { mode = 'daily-accruing'; break; }
    console.log('Please enter "daily" or "weekly"');
  }
  
  // Get start date
  let startDate: Date | null = null;
  while (!startDate) {
    const startDateStr = await question('Enter start date (MM/DD/YYYY): ');
    startDate = parseDate(startDateStr);
    if (!startDate) {
      console.log('Invalid date format. Please use MM/DD/YYYY');
    }
  }
  
  // Get end date
  let endDate: Date | null = null;
  while (!endDate) {
    const endDateStr = await question('Enter end date (MM/DD/YYYY): ');
    endDate = parseDate(endDateStr);
    if (!endDate) {
      console.log('Invalid date format. Please use MM/DD/YYYY');
    } else if (endDate < startDate) {
      console.log('End date must be after start date');
      endDate = null;
    }
  }
  
  // Get miner type prefix filter
  const wantsMinerTypeFilter = await question('Do you want to filter by miner type prefix? (yes/no): ');
  let minerTypePrefix: string | undefined;
  
  if (wantsMinerTypeFilter.toLowerCase() === 'yes') {
    while (!minerTypePrefix) {
      const prefixInput = await question('Enter miner type prefix (e.g., AEM, RDN, BM): ');
      const trimmedPrefix = prefixInput.trim().toUpperCase();
      if (trimmedPrefix.length > 0) {
        minerTypePrefix = trimmedPrefix;
        console.log(`✅ Will filter for miner type prefix: ${minerTypePrefix}`);
      } else {
        console.log('Please enter a valid miner type prefix');
      }
    }
  }
  
  // Get device selection - different prompts based on miner type filter
  let minerKey: string | undefined;
  let allDevices: boolean;
  
  if (minerTypePrefix) {
    // If miner type prefix is specified, ask about processing all devices of that type
    const processAllOfType = await question(`Process for all ${minerTypePrefix} devices? (yes/no): `);
    
    if (processAllOfType.toLowerCase() === 'yes') {
      allDevices = true;
    } else {
      minerKey = await question(`Enter specific ${minerTypePrefix} miner key: `);
      allDevices = false;
    }
  } else {
    // Original flow if no miner type prefix specified
    const deviceChoice = await question('Process for specific device or all devices? (device/all): ');
    
    if (deviceChoice.toLowerCase() === 'device') {
      minerKey = await question('Enter miner key: ');
      allDevices = false;
    } else {
      allDevices = true;
    }
  }
  
  return { startDate, endDate, minerKey, allDevices, minerTypePrefix, mode };
}

interface BackpayProgress {
  totalOperations: number;
  completedOperations: number;
  currentDate: string;
  currentDevice: string;
  successCount: number;
  skipCount: number;
  errorCount: number;
  startTime: Date;
  validationBreakdown: ValidationCounts;
}

interface BackpayError {
  date: string;
  deviceKey: string;
  error: string;
  operation: string;
}

// Track validation-blocked reasons separately from hard errors
interface ValidationCounts {
  unknownProduct: number;
  notRewardable: number;
  stakingRequired: number;
  invalidRegistrationAsset: number;
  invalidNodeAsset: number;
  noWallet: number;
  invalidAmount: number;
}

type ValidationCategory =
  | 'unknown_product'
  | 'not_rewardable'
  | 'staking_required'
  | 'invalid_registration_asset'
  | 'invalid_node_asset'
  | 'no_wallet'
  | 'invalid_amount';

interface ValidationEntry {
  date: string;
  deviceKey: string;
  category: ValidationCategory;
}

type FailureType = 'duplicate' | 'validation' | 'error';
interface FailureEntry {
  type: FailureType;
  timestamp: number;
  date: string;
  deviceKey: string;
  details?: string;
}

function initValidationCounts(): ValidationCounts {
  return {
    unknownProduct: 0,
    notRewardable: 0,
    stakingRequired: 0,
    invalidRegistrationAsset: 0,
    invalidNodeAsset: 0,
    noWallet: 0,
    invalidAmount: 0,
  };
}

function sumValidationCounts(vc: ValidationCounts): number {
  return (
    vc.unknownProduct +
    vc.notRewardable +
    vc.stakingRequired +
    vc.invalidRegistrationAsset +
    vc.invalidNodeAsset +
    vc.noWallet +
    vc.invalidAmount
  );
}

function formatValidationBreakdown(vc: ValidationCounts): string {
  const parts: string[] = [];
  if (vc.unknownProduct) parts.push(`unknown_product: ${vc.unknownProduct}`);
  if (vc.notRewardable) parts.push(`not_rewardable: ${vc.notRewardable}`);
  if (vc.stakingRequired) parts.push(`staking_required: ${vc.stakingRequired}`);
  if (vc.invalidRegistrationAsset) parts.push(`invalid_registration_asset: ${vc.invalidRegistrationAsset}`);
  if (vc.invalidNodeAsset) parts.push(`invalid_node_asset: ${vc.invalidNodeAsset}`);
  if (vc.noWallet) parts.push(`no_wallet: ${vc.noWallet}`);
  if (vc.invalidAmount) parts.push(`invalid_amount: ${vc.invalidAmount}`);
  return parts.join(', ');
}

function displayMilestonePreview(recentFailures: FailureEntry[], limit = 10): void {
  const slice = recentFailures.slice(-limit);
  if (slice.length === 0) return;
  console.log(`🔎 Recent failed entries (last ${slice.length}):`);
  slice.forEach((item) => {
    const tail = item.details ? `: ${item.details}` : '';
    console.log(`   - [${item.type}] ${item.deviceKey} (${item.date})${tail}`);
  });
}

async function sendDiscordSummary(
  totals: { success: number; skipped: number; errors: number; validations: number },
  breakdown: ValidationCounts,
  dateRange: { start: Date; end: Date },
  meta?: { devices?: number; operations?: number; durationMs?: number }
): Promise<void> {
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) return; // no webhook configured

  const env = process.env.TEST_MODE === 'true' ? 'TEST' : 'PRODUCTION';
  const duration = meta?.durationMs ? `${Math.round(meta.durationMs / 60000)}m` : 'n/a';
  const ops = meta?.operations ?? 0;
  const devices = meta?.devices ?? 0;

  const breakdownText = formatValidationBreakdown(breakdown) || 'n/a';
  const lines = [
    `dbRewards Backpay Summary (${env})`,
    `Range: ${dateRange.start.toDateString()} → ${dateRange.end.toDateString()}`,
    `Devices: ${devices} | Ops: ${ops} | Duration: ${duration}`,
    `Success: ${totals.success} | Skipped: ${totals.skipped} | Errors: ${totals.errors}`,
    `Validation blocks: ${totals.validations}${breakdownText !== 'n/a' ? ` (${breakdownText})` : ''}`
  ];

  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: lines.join('\n') })
    });
    if (!res.ok) {
      throw new Error(`Discord webhook failed with status ${res.status}`);
    }
  } catch (err) {
    const errorId = errorTracker.trackError(err, 'backpay', 'send_discord_summary');
    console.error(`❌ Failed to send Discord summary: ${errorId}`);
  }
}

function displayProgress(progress: BackpayProgress): void {
  const percentage = Math.round((progress.completedOperations / progress.totalOperations) * 100);
  const elapsed = Date.now() - progress.startTime.getTime();
  const estimatedTotal = progress.completedOperations > 0 ? (elapsed / progress.completedOperations) * progress.totalOperations : 0;
  const remainingTime = estimatedTotal - elapsed;
  
  console.log(`\n📊 Progress: ${percentage}% (${progress.completedOperations}/${progress.totalOperations})`);
  console.log(`📅 Current: ${progress.currentDate} | Device: ${progress.currentDevice}`);
  console.log(`✅ Success: ${progress.successCount} | ⏭️  Skipped: ${progress.skipCount} | ❌ Errors: ${progress.errorCount}`);
  const totalValidation = sumValidationCounts(progress.validationBreakdown);
  if (totalValidation > 0) {
    const breakdown = formatValidationBreakdown(progress.validationBreakdown);
    console.log(`🚫 Validation blocks: ${totalValidation}${breakdown ? ` (${breakdown})` : ''}`);
  }
  
  if (remainingTime > 0) {
    const remainingMinutes = Math.round(remainingTime / 60000);
    console.log(`⏱️  Estimated time remaining: ${remainingMinutes} minutes`);
  }
}

async function checkForRunningOperations(): Promise<boolean> {
  // Check if it's during the critical hourly processing window (XX:00 to XX:10)
  const now = new Date();
  const minutes = now.getMinutes();
  
  if (minutes >= 0 && minutes <= 10) {
    console.log(`⚠️  Warning: Current time is ${now.toTimeString()}`);
    console.log(`⚠️  This overlaps with hourly reward processing window (XX:00-XX:10)`);
    const proceed = await question('Continue anyway? (yes/no): ');
    return proceed.toLowerCase() === 'yes';
  }
  
  return true;
}

async function generateMissingRewards(config: BackpayConfig): Promise<void> {
  const testMode = process.env.TEST_MODE === 'true';
  const BATCH_SIZE = 50; // Process devices in batches
  const errors: BackpayError[] = [];
  const validationPreview: ValidationEntry[] = [];
  const allValidations: ValidationEntry[] = [];
  const recentFailures: FailureEntry[] = [];
  
  console.log(`\n🔍 Initializing backpay operation...`);
  
  // Check for potential conflicts
  const canProceed = await checkForRunningOperations();
  if (!canProceed) {
    console.log('Backpay cancelled due to timing conflict');
    return;
  }
  
  try {
    // Get devices with error tracking
    let devices;
    try {
      if (config.allDevices) {
        // Load all registered devices
        devices = testMode
          ? await TestDeviceModel.find({ is_registered: true })
          : await DeviceModel.find({ is_registered: true });
        
        // Apply miner type prefix filter if specified
        if (config.minerTypePrefix) {
          const originalCount = devices.length;
          devices = devices.filter(device => {
            const prefix = device.miner_key.split('-')[0];
            return prefix === config.minerTypePrefix;
          });
          console.log(`🔍 Filtered devices by prefix "${config.minerTypePrefix}": ${devices.length}/${originalCount} devices match`);
        }
      } else {
        devices = testMode
          ? await TestDeviceModel.find({ miner_key: config.minerKey, is_registered: true })
          : await DeviceModel.find({ miner_key: config.minerKey, is_registered: true });
      }
    } catch (error) {
      const errorId = errorTracker.trackError(error, 'backpay', 'load_devices');
      console.error(`❌ Failed to load devices: ${errorId}`);
      return;
    }
    
    if (devices.length === 0) {
      console.log('No devices found for backpay');
      return;
    }
    
    // Get products with error tracking
    let products;
    try {
      products = await ProductModel.find({});
    } catch (error) {
      const errorId = errorTracker.trackError(error, 'backpay', 'load_products');
      console.error(`❌ Failed to load products: ${errorId}`);
      return;
    }
    
    console.log(`\n📋 Backpay Configuration:`);
    console.log(`   Type: ${config.mode.toUpperCase()}`);
    console.log(`   Devices: ${devices.length}`);
    console.log(`   Date range: ${config.startDate.toDateString()} to ${config.endDate.toDateString()}`);

    // Prepare date units for chosen mode
    let totalOperations = 0;
    let dates: Date[] = [];
    let weeklyWindows: Array<{ weekStart: Date; weekEnd: Date; unlockAt: Date }>= [];

    if (config.mode === 'daily' || config.mode === 'daily-accruing') {
      const currentDate = new Date(config.startDate);
      while (currentDate <= config.endDate) {
        dates.push(new Date(currentDate));
        currentDate.setDate(currentDate.getDate() + 1);
      }
      totalOperations = dates.length * devices.length;
      console.log(`   Total operations: ${totalOperations} (${dates.length} days × ${devices.length} devices)`);
    } else {
      // Compute weekly windows fully inside the range (Fri 00:00 UTC → Thu 23:59:59 UTC)
      function getFridayStartUTC(ref: Date): Date {
        const d = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate(), 0, 0, 0, 0));
        const day = d.getUTCDay(); // 0=Sun .. 5=Fri
        const diffToFriday = (day + 7 - 5) % 7; // days since last Friday
        d.setUTCDate(d.getUTCDate() - diffToFriday);
        return d; // Friday 00:00 UTC
      }
      const rangeStartUTC = new Date(Date.UTC(config.startDate.getUTCFullYear(), config.startDate.getUTCMonth(), config.startDate.getUTCDate(), 0, 0, 0, 0));
      const rangeEndUTC = new Date(Date.UTC(config.endDate.getUTCFullYear(), config.endDate.getUTCMonth(), config.endDate.getUTCDate(), 23, 59, 59, 999));
      let ws = getFridayStartUTC(rangeStartUTC);
      const lastWs = getFridayStartUTC(rangeEndUTC);
      while (ws.getTime() <= lastWs.getTime()) {
        const we = new Date(ws.getTime() + 7 * 24 * 60 * 60 * 1000 - 1000); // Thu 23:59:59
        const unlockAt = new Date(ws.getTime() + 7 * 24 * 60 * 60 * 1000 + 5 * 60 * 1000); // Fri 00:05
        // Only include windows fully inside range
        if (ws.getTime() >= rangeStartUTC.getTime() && we.getTime() <= rangeEndUTC.getTime()) {
          weeklyWindows.push({ weekStart: ws, weekEnd: we, unlockAt });
        }
        ws = new Date(ws.getTime() + 7 * 24 * 60 * 60 * 1000);
      }
      totalOperations = weeklyWindows.length * devices.length;
      console.log(`   Weekly windows: ${weeklyWindows.length}`);
      console.log(`   Total operations: ${totalOperations} (${weeklyWindows.length} weeks × ${devices.length} devices)`);
    }
    
    // Estimate potential rewards and warn if large
    if (totalOperations > 10000) {
      console.log(`⚠️  Large operation detected: ${totalOperations} potential rewards`);
      console.log(`⚠️  This may take significant time and database resources`);
    }
    
    // Final confirmation
    const confirm = await question('\n🚀 Proceed with backpay generation? (yes/no): ');
    if (confirm.toLowerCase() !== 'yes') {
      console.log('Backpay cancelled');
      return;
    }
    
    // Initialize progress tracking
    const progress: BackpayProgress = {
      totalOperations,
      completedOperations: 0,
      currentDate: '',
      currentDevice: '',
      successCount: 0,
      skipCount: 0,
      errorCount: 0,
      startTime: new Date(),
      validationBreakdown: initValidationCounts()
    };

    console.log(`\n🎯 Starting device-centric backpay generation...`);
    console.log(`📦 Target collection: device-rewards (new aggregated system)`);

    if (config.mode === 'daily' || config.mode === 'daily-accruing') {
      // Process dates in order (Daily mode)
      for (let dateIndex = 0; dateIndex < dates.length; dateIndex++) {
        const date = dates[dateIndex];
        progress.currentDate = date.toDateString();
        console.log(`\n📅 Processing ${date.toDateString()} (${dateIndex + 1}/${dates.length})`);
      
      // Process devices in batches for this date
      for (let batchStart = 0; batchStart < devices.length; batchStart += BATCH_SIZE) {
        const batch = devices.slice(batchStart, batchStart + BATCH_SIZE);
        const rewardsToCreate: any[] = [];
        
        // Prepare batch rewards
        for (const device of batch) {
          progress.currentDevice = device.miner_key;
          progress.completedOperations++;
          
          try {
            // NEW: Check if reward already exists for this date in device-rewards collection
            const dateString = date.toISOString().split('T')[0]; // YYYY-MM-DD format
            const deviceReward = await (testMode ? TestDeviceRewardModel : DeviceRewardModel)
              .findOne({ 
                miner_key: device.miner_key,
                "daily_rewards.date": dateString
              });
            
            if (deviceReward) {
              const existingDailyReward = deviceReward.daily_rewards.find(
                reward => reward.date === dateString
              );
              if (existingDailyReward) {
                progress.skipCount++;
                // Track duplicate/skip for milestone preview
                recentFailures.push({
                  type: 'duplicate',
                  timestamp: Date.now(),
                  date: date.toDateString(),
                  deviceKey: device.miner_key,
                  details: 'already exists in device-rewards'
                });
                continue;
              }
            }
            
            // Find product
            const minerType = device.miner_key.split("-")[0];
            const product = products.find(p => p.key === minerType);
            if (!product) {
              // Unknown product/miner type - treat as validation block
              progress.validationBreakdown.unknownProduct++;
              const v: ValidationEntry = { date: date.toDateString(), deviceKey: device.miner_key, category: 'unknown_product' };
              allValidations.push(v);
              recentFailures.push({ type: 'validation', timestamp: Date.now(), date: v.date, deviceKey: v.deviceKey, details: v.category });
              if (validationPreview.length < 100) validationPreview.push(v);
              continue;
            }
            
            // PHASE 2: NEW HISTORICAL ELIGIBILITY VALIDATION
            
            // Basic product validation first
            if (
              !product.reward.tokens ||
              !product.reward.tokens.reward ||
              product.reward.tokens.reward === "none"
            ) {
              // Not rewardable product - validation block
              progress.validationBreakdown.notRewardable++;
              const v: ValidationEntry = { date: date.toDateString(), deviceKey: device.miner_key, category: 'not_rewardable' };
              allValidations.push(v);
              recentFailures.push({ type: 'validation', timestamp: Date.now(), date: v.date, deviceKey: v.deviceKey, details: v.category });
              if (validationPreview.length < 100) validationPreview.push(v);
              continue;
            }
            
            // Check if device was eligible for rewards on this specific historical date
            const eligibilityResult = isDeviceEligibleForDate(device, date, product);
            
            if (!eligibilityResult.eligible) {
              // Device not eligible on this historical date - validation block
              progress.validationBreakdown.stakingRequired++;
              const v: ValidationEntry = { 
                date: date.toDateString(), 
                deviceKey: device.miner_key, 
                category: 'staking_required' 
              };
              allValidations.push(v);
              recentFailures.push({ 
                type: 'validation', 
                timestamp: Date.now(), 
                date: v.date, 
                deviceKey: v.deviceKey, 
                details: `historical_eligibility: ${eligibilityResult.reason}` 
              });
              if (validationPreview.length < 100) validationPreview.push(v);
              continue;
            }
            
            // Wallet validation (still required)
            if (!device.reward_wallet) {
              // No wallet configured - validation block
              progress.validationBreakdown.noWallet++;
              const v: ValidationEntry = { date: date.toDateString(), deviceKey: device.miner_key, category: 'no_wallet' };
              allValidations.push(v);
              recentFailures.push({ type: 'validation', timestamp: Date.now(), date: v.date, deviceKey: v.deviceKey, details: v.category });
              if (validationPreview.length < 100) validationPreview.push(v);
              continue;
            }
            
            // Asset validation for staking mismatches
            if (
              isRegistrationStaked(device) &&
              device.registration?.asset_id !== product.reward.tokens?.register
            ) {
              // Registration staking asset mismatch - validation block
              progress.validationBreakdown.invalidRegistrationAsset++;
              const v: ValidationEntry = { date: date.toDateString(), deviceKey: device.miner_key, category: 'invalid_registration_asset' };
              allValidations.push(v);
              recentFailures.push({ type: 'validation', timestamp: Date.now(), date: v.date, deviceKey: v.deviceKey, details: v.category });
              if (validationPreview.length < 100) validationPreview.push(v);
              continue;
            }

            if (
              isNodeStaked(device) &&
              device.node?.asset_id !== product.reward.tokens?.node
            ) {
              // Node staking asset mismatch - validation block
              progress.validationBreakdown.invalidNodeAsset++;
              const v: ValidationEntry = { date: date.toDateString(), deviceKey: device.miner_key, category: 'invalid_node_asset' };
              allValidations.push(v);
              recentFailures.push({ type: 'validation', timestamp: Date.now(), date: v.date, deviceKey: v.deviceKey, details: v.category });
              if (validationPreview.length < 100) validationPreview.push(v);
              continue;
            }
            
            // Calculate historical reward amount using new function
            const rewardAmount = calculateHistoricalRewardAmount(device, product, date, eligibilityResult);
            if (rewardAmount <= 0) {
              // Invalid calculated amount - validation block
              progress.validationBreakdown.invalidAmount++;
              const v: ValidationEntry = { date: date.toDateString(), deviceKey: device.miner_key, category: 'invalid_amount' };
              allValidations.push(v);
              if (validationPreview.length < 100) validationPreview.push(v);
              continue;
            }
            
            // Log detailed eligibility info for debugging
            if (dateIndex === 0 && batchStart === 0) { // Log details for first date and first batch only
              const deviceType = getDeviceType(device.miner_key);
              console.log(`📋 Device ${device.miner_key} (${deviceType}): ${eligibilityResult.reason} -> ${rewardAmount} reward`);
            }
            
            // Determine status based on mode/date
            let status: 'accruing' | 'pending' | 'claimable';
            if (config.mode === 'daily-accruing') {
              // Backfill as accruing entries for weekly system
              status = 'accruing';
            } else {
              const daysDifference = Math.floor((new Date().getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
              status = daysDifference >= 30 ? "claimable" : "pending";
            }
            
            // NEW: Get or create device reward document
            const assetId = product.reward.tokens?.reward || "";
            const currentTime = new Date();
            
            // Get current reward count for this device to calculate reward_number
            const existingDevice = await (testMode ? TestDeviceRewardModel : DeviceRewardModel)
              .findOne({ miner_key: device.miner_key });
            
            const nextRewardNumber = (existingDevice?.reward_count || 0) + 1;
            
            // Prepare device-centric reward for batch creation
            rewardsToCreate.push({
              miner_key: device.miner_key,
              dateString: dateString,
              amount: rewardAmount,
              status: status,
              asset_id: assetId,
              created_at: date,
              reward_number: nextRewardNumber
            });
            
          } catch (error) {
            const errorId = errorTracker.trackError(error, 'backpay', 'process_device', device.miner_key);
            errors.push({
              date: date.toDateString(),
              deviceKey: device.miner_key,
              error: `Processing failed: ${errorId}`,
              operation: 'process_device'
            });
            progress.errorCount++;
            recentFailures.push({ type: 'error', timestamp: Date.now(), date: date.toDateString(), deviceKey: device.miner_key, details: 'process_device' });
          }
        }
        
        // NEW: Bulk create device-centric rewards for this batch
        if (rewardsToCreate.length > 0) {
          try {
            // Group rewards by device for efficient batch processing
            const deviceRewardMap = new Map<string, Array<any>>();
            
            for (const reward of rewardsToCreate) {
              if (!deviceRewardMap.has(reward.miner_key)) {
                deviceRewardMap.set(reward.miner_key, []);
              }
              deviceRewardMap.get(reward.miner_key)!.push(reward);
            }
            
            // Process each device's rewards
            for (const [minerKey, deviceRewards] of deviceRewardMap.entries()) {
              try {
                let totalPendingIncrease = 0;
                let totalClaimableIncrease = 0;
                const dailyRewardsToAdd: any[] = [];

                // Prepare all rewards for this device
                for (const reward of deviceRewards) {
                  if (reward.status === 'pending') {
                    totalPendingIncrease += reward.amount;
                  } else {
                    totalClaimableIncrease += reward.amount;
                  }

                  dailyRewardsToAdd.push({
                    date: reward.dateString,
                    amount: reward.amount,
                    status: reward.status,
                    asset_id: reward.asset_id,
                    created_at: reward.created_at,
                    reward_number: reward.reward_number
                  });
                }

                // Update device reward document with all rewards at once
                const incFields: any = {
                  reward_count: deviceRewards.length,
                  total_pending: totalPendingIncrease,
                  total_claimable: totalClaimableIncrease
                };

                await (testMode ? TestDeviceRewardModel : DeviceRewardModel)
                  .findOneAndUpdate(
                    { miner_key: minerKey },
                    {
                      $inc: incFields,
                      $push: {
                        daily_rewards: { $each: dailyRewardsToAdd }
                      },
                      $set: {
                        last_updated: new Date(),
                        last_reward_date: deviceRewards[0].created_at
                      },
                      $setOnInsert: {
                        first_reward_date: deviceRewards[0].created_at,
                        total_claimed: 0
                      }
                    },
                    { 
                      upsert: true, 
                      new: true,
                      setDefaultsOnInsert: true
                    }
                  );
                
                progress.successCount += deviceRewards.length;
                
              } catch (deviceError) {
                const errorId = errorTracker.trackError(deviceError, 'backpay', 'device_update', minerKey);
                console.error(`❌ Device update failed for ${minerKey}: ${errorId}`);
                
                // Add all rewards for this device to error list
                for (const reward of deviceRewards) {
                  errors.push({
                    date: date.toDateString(),
                    deviceKey: minerKey,
                    error: `Device update failed: ${errorId}`,
                    operation: 'create_device_reward'
                  });
                  progress.errorCount++;
                  recentFailures.push({ 
                    type: 'error', 
                    timestamp: Date.now(), 
                    date: date.toDateString(), 
                    deviceKey: minerKey, 
                    details: 'device_update' 
                  });
                }
              }
            }
            
          } catch (error) {
            const errorId = errorTracker.trackError(error, 'backpay', 'bulk_device_insert');
            console.error(`❌ Bulk device insert failed for batch: ${errorId}`);
            
            // Fall back to individual device processing
            for (const reward of rewardsToCreate) {
              try {
                const incFields: any = {
                  reward_count: 1
                };

                if (reward.status === 'pending') {
                  incFields.total_pending = reward.amount;
                } else {
                  incFields.total_claimable = reward.amount;
                }

                await (testMode ? TestDeviceRewardModel : DeviceRewardModel)
                  .findOneAndUpdate(
                    { miner_key: reward.miner_key },
                    {
                      $inc: incFields,
                      $push: {
                        daily_rewards: {
                          date: reward.dateString,
                          amount: reward.amount,
                          status: reward.status,
                          asset_id: reward.asset_id,
                          created_at: reward.created_at,
                          reward_number: reward.reward_number
                        }
                      },
                      $set: {
                        last_updated: new Date(),
                        last_reward_date: reward.created_at
                      },
                      $setOnInsert: {
                        first_reward_date: reward.created_at,
                        total_claimed: 0
                      }
                    },
                    { upsert: true, new: true }
                  );

                progress.successCount++;
              } catch (individualError) {
                const individualErrorId = errorTracker.trackError(individualError, 'backpay', 'individual_device_insert', reward.miner_key);
                errors.push({
                  date: date.toDateString(),
                  deviceKey: reward.miner_key,
                  error: `Individual device insert failed: ${individualErrorId}`,
                  operation: 'create_device_reward'
                });
                progress.errorCount++;
                recentFailures.push({ 
                  type: 'error', 
                  timestamp: Date.now(), 
                  date: date.toDateString(), 
                  deviceKey: reward.miner_key, 
                  details: 'individual_device_insert' 
                });
              }
            }
          }
        }
        
        // Display progress every 10% or every 1000 operations
        if (progress.completedOperations % 1000 === 0 || 
            progress.completedOperations % Math.ceil(totalOperations / 10) === 0) {
          displayProgress(progress);
          displayMilestonePreview(recentFailures, 10);
        }
      }
        // Small delay between dates to prevent overwhelming the database
        if (dateIndex < dates.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    } else {
      // WEEKLY mode: process weekly windows fully in range
      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      for (let w = 0; w < weeklyWindows.length; w++) {
        const { weekStart, weekEnd, unlockAt } = weeklyWindows[w];
        progress.currentDate = `${weekStart.toISOString()} → ${weekEnd.toISOString()}`;
        console.log(`\n📅 Processing week ${w + 1}/${weeklyWindows.length}: ${weekStart.toISOString()} → ${weekEnd.toISOString()} (unlock ${unlockAt.toISOString()})`);

        // Do not create weekly entries before unlock — skip windows with future unlocks
        if (unlockAt > now) {
          console.log(`⏭️  Skipping future unlock window (unlock ${unlockAt.toISOString()})`);
          continue;
        }

        for (let batchStart = 0; batchStart < devices.length; batchStart += BATCH_SIZE) {
          const batch = devices.slice(batchStart, batchStart + BATCH_SIZE);
          // Map miner_key -> entries to add
          const deviceWeeklyMap = new Map<string, Array<{
            asset_id: string;
            amount: number;
            status: 'pending' | 'claimable';
            unlock_at: Date;
            week_start: Date;
            week_end: Date;
            created_at: Date;
          }>>();

          for (const device of batch) {
            progress.currentDevice = device.miner_key;
            progress.completedOperations++;

            try {
              // Resolve product per device
              const minerType = device.miner_key.split('-')[0];
              const product = products.find(p => p.key === minerType);
              if (!product) {
                progress.validationBreakdown.unknownProduct++;
                const v: ValidationEntry = { date: `${weekStart.toDateString()}..${weekEnd.toDateString()}`, deviceKey: device.miner_key, category: 'unknown_product' };
                allValidations.push(v);
                recentFailures.push({ type: 'validation', timestamp: Date.now(), date: v.date, deviceKey: v.deviceKey, details: v.category });
                if (validationPreview.length < 100) validationPreview.push(v);
                continue;
              }

              // Basic rewardable validation
              if (!product.reward.tokens || !product.reward.tokens.reward || product.reward.tokens.reward === 'none') {
                progress.validationBreakdown.notRewardable++;
                const v: ValidationEntry = { date: `${weekStart.toDateString()}..${weekEnd.toDateString()}`, deviceKey: device.miner_key, category: 'not_rewardable' };
                allValidations.push(v);
                recentFailures.push({ type: 'validation', timestamp: Date.now(), date: v.date, deviceKey: v.deviceKey, details: v.category });
                if (validationPreview.length < 100) validationPreview.push(v);
                continue;
              }

              // Wallet validation
              if (!device.reward_wallet) {
                progress.validationBreakdown.noWallet++;
                const v: ValidationEntry = { date: `${weekStart.toDateString()}..${weekEnd.toDateString()}`, deviceKey: device.miner_key, category: 'no_wallet' };
                allValidations.push(v);
                recentFailures.push({ type: 'validation', timestamp: Date.now(), date: v.date, deviceKey: v.deviceKey, details: v.category });
                if (validationPreview.length < 100) validationPreview.push(v);
                continue;
              }

              // Asset validation for staking mismatches
              if (isRegistrationStaked(device) && device.registration?.asset_id !== product.reward.tokens?.register) {
                progress.validationBreakdown.invalidRegistrationAsset++;
                const v: ValidationEntry = { date: `${weekStart.toDateString()}..${weekEnd.toDateString()}`, deviceKey: device.miner_key, category: 'invalid_registration_asset' };
                allValidations.push(v);
                recentFailures.push({ type: 'validation', timestamp: Date.now(), date: v.date, deviceKey: v.deviceKey, details: v.category });
                if (validationPreview.length < 100) validationPreview.push(v);
                continue;
              }
              if (isNodeStaked(device) && device.node?.asset_id !== product.reward.tokens?.node) {
                progress.validationBreakdown.invalidNodeAsset++;
                const v: ValidationEntry = { date: `${weekStart.toDateString()}..${weekEnd.toDateString()}`, deviceKey: device.miner_key, category: 'invalid_node_asset' };
                allValidations.push(v);
                recentFailures.push({ type: 'validation', timestamp: Date.now(), date: v.date, deviceKey: v.deviceKey, details: v.category });
                if (validationPreview.length < 100) validationPreview.push(v);
                continue;
              }

              // Sum daily amounts across the week (Fri..Thu) within range
              const assetId = product.reward.tokens?.reward || '';
              let weeklyAmount = 0;
              for (let i = 0; i < 7; i++) {
                const d = new Date(weekStart.getTime() + i * 24 * 60 * 60 * 1000);
                // Eligibility for that historical day
                const eligibilityResult = isDeviceEligibleForDate(device, d, product);
                if (!eligibilityResult.eligible) continue;
                const amt = calculateHistoricalRewardAmount(device, product, d, eligibilityResult);
                weeklyAmount += amt;
              }

              if (weeklyAmount <= 0) {
                // Nothing to add for this week/device
                continue;
              }

              // Weekly status per unlock
              const status: 'pending' | 'claimable' = unlockAt <= thirtyDaysAgo ? 'claimable' : 'pending';

              // Dedup: skip if weekly entry already exists for this unlock + asset
              const existing = await (testMode ? TestDeviceRewardModel : DeviceRewardModel)
                .findOne({
                  miner_key: device.miner_key,
                  weekly_rewards: { $elemMatch: { unlock_at: unlockAt, asset_id: assetId } }
                }) as DeviceReward | null;
              if (existing) {
                progress.skipCount++;
                recentFailures.push({
                  type: 'duplicate', timestamp: Date.now(),
                  date: `${weekStart.toDateString()}..${weekEnd.toDateString()}`,
                  deviceKey: device.miner_key, details: 'weekly already exists'
                });
                continue;
              }

              if (!deviceWeeklyMap.has(device.miner_key)) deviceWeeklyMap.set(device.miner_key, []);
              deviceWeeklyMap.get(device.miner_key)!.push({
                asset_id: assetId,
                amount: Math.round(weeklyAmount * 100) / 100,
                status,
                unlock_at: unlockAt,
                week_start: weekStart,
                week_end: weekEnd,
                created_at: unlockAt
              });

            } catch (error) {
              const errorId = errorTracker.trackError(error, 'backpay', 'process_device_weekly', device.miner_key);
              errors.push({
                date: `${weekStart.toDateString()}..${weekEnd.toDateString()}`,
                deviceKey: device.miner_key,
                error: `Processing failed: ${errorId}`,
                operation: 'process_device_weekly'
              });
              progress.errorCount++;
              recentFailures.push({ type: 'error', timestamp: Date.now(), date: `${weekStart.toDateString()}..${weekEnd.toDateString()}`, deviceKey: device.miner_key, details: 'process_device_weekly' });
            }
          }

          // Apply batch updates per device for weekly entries
          for (const [minerKey, entries] of deviceWeeklyMap.entries()) {
            try {
              // Determine totals and reward_numbers
              let pendingInc = 0;
              let claimableInc = 0;
              for (const e of entries) {
                if (e.status === 'pending') pendingInc += e.amount; else claimableInc += e.amount;
              }

              // Fetch existing weekly count to assign sequential numbers
              const existingDevice = await (testMode ? TestDeviceRewardModel : DeviceRewardModel)
                .findOne({ miner_key: minerKey });
              let nextWeeklyNo = (existingDevice?.weekly_reward_count || 0) + 1;

              const weeklyToAdd = entries.map(e => ({
                week_start: e.week_start,
                week_end: e.week_end,
                unlock_at: e.unlock_at,
                status: e.status,
                asset_id: e.asset_id,
                amount: e.amount,
                created_at: e.created_at,
                reward_number: nextWeeklyNo++
              }));

              const incFields: any = {
                weekly_reward_count: entries.length
              };
              if (pendingInc > 0) incFields.total_pending = pendingInc;
              if (claimableInc > 0) incFields.total_claimable = claimableInc;

              await (testMode ? TestDeviceRewardModel : DeviceRewardModel)
                .findOneAndUpdate(
                  { miner_key: minerKey },
                  {
                    $inc: incFields,
                    $push: { weekly_rewards: { $each: weeklyToAdd } },
                    $set: { last_updated: new Date() },
                    $setOnInsert: { first_reward_date: weeklyToAdd[0].created_at, total_claimed: 0 }
                  },
                  { upsert: true, new: true, setDefaultsOnInsert: true }
                );

              progress.successCount += entries.length;

            } catch (deviceError) {
              const errorId = errorTracker.trackError(deviceError, 'backpay', 'device_weekly_update', minerKey);
              console.error(`❌ Device weekly update failed for ${minerKey}: ${errorId}`);
              for (const _ of entries) {
                errors.push({
                  date: `${weekStart.toDateString()}..${weekEnd.toDateString()}`,
                  deviceKey: minerKey,
                  error: `Device weekly update failed: ${errorId}`,
                  operation: 'create_weekly_reward'
                });
                progress.errorCount++;
                recentFailures.push({ type: 'error', timestamp: Date.now(), date: `${weekStart.toDateString()}..${weekEnd.toDateString()}`, deviceKey: minerKey, details: 'device_weekly_update' });
              }
            }
          }

          // Display periodic progress
          if (progress.completedOperations % 1000 === 0 || progress.completedOperations % Math.ceil((totalOperations || 1) / 10) === 0) {
            displayProgress(progress);
            displayMilestonePreview(recentFailures, 10);
          }
        }
      }
    }
    
    // Final progress display
    displayProgress(progress);
    
    console.log(`\n🎉 Device-centric backpay completed!`);
    console.log(`📊 Final Results:`);
    console.log(`   ✅ Generated: ${progress.successCount} new reward entries in device-rewards collection`);
    console.log(`   ⏭️  Skipped: ${progress.skipCount} existing rewards`);
    console.log(`   ❌ Errors: ${progress.errorCount} failed operations`);
    const finalValidationTotal = sumValidationCounts(progress.validationBreakdown);
    if (finalValidationTotal > 0) {
      console.log(`   🚫 Validation blocks: ${finalValidationTotal}`);
      const breakdown = formatValidationBreakdown(progress.validationBreakdown);
      if (breakdown) {
        console.log(`      - ${breakdown}`);
      }
    }
    
    const totalTime = Date.now() - progress.startTime.getTime();
    console.log(`   ⏱️  Total time: ${Math.round(totalTime / 60000)} minutes`);

    // Send concise summary to Discord if webhook configured
    await sendDiscordSummary(
      {
        success: progress.successCount,
        skipped: progress.skipCount,
        errors: progress.errorCount,
        validations: finalValidationTotal
      },
      progress.validationBreakdown,
      { start: config.startDate, end: config.endDate },
      { devices: devices.length, operations: totalOperations, durationMs: totalTime }
    );
    
    // Display error summary if any
    if (errors.length > 0) {
      console.log(`\n⚠️  Error Summary (first 100):`);
      errors.slice(0, 100).forEach((error, index) => {
        console.log(`   ${index + 1}. ${error.deviceKey} (${error.date}): ${error.error}`);
      });
      if (errors.length > 100) {
        console.log(`   ... and ${errors.length - 100} more errors`);
      }
    }

    // Validation preview
    if (validationPreview.length > 0) {
      console.log(`\n📄 Validation Preview (first ${validationPreview.length}):`);
      validationPreview.forEach((v, index) => {
        console.log(`   ${index + 1}. ${v.deviceKey} (${v.date}): ${v.category}`);
      });
    }

    // Write full validation list to JSON file
    if (allValidations.length > 0) {
      try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const fileName = `backpay-validations-${timestamp}.json`;
        const filePath = path.join(process.cwd(), fileName);
        const payload = {
          generatedAt: new Date().toISOString(),
          dateRange: {
            start: config.startDate.toISOString(),
            end: config.endDate.toISOString()
          },
          totals: {
            validationBlocks: sumValidationCounts(progress.validationBreakdown),
            breakdown: progress.validationBreakdown,
            errors: progress.errorCount,
            skipped: progress.skipCount,
            success: progress.successCount
          },
          validations: allValidations
        };
        fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
        console.log(`\n💾 Full validation list written to: ${filePath}`);
      } catch (fileError) {
        const errorId = errorTracker.trackError(fileError, 'backpay', 'write_validation_json');
        console.error(`❌ Failed to write validation JSON file: ${errorId}`);
      }
    }
    
  } catch (error) {
    const errorId = errorTracker.trackError(error, 'backpay', 'generate_missing_rewards');
    console.error(`❌ Backpay operation failed: ${errorId}`);
    throw error;
  }
}

async function listMissingRewards(config: BackpayConfig): Promise<void> {
  const testMode = process.env.TEST_MODE === 'true';
  
  // Get devices
  let devices;
  if (config.allDevices) {
    // Load all registered devices
    devices = testMode
      ? await TestDeviceModel.find({ is_registered: true })
      : await DeviceModel.find({ is_registered: true });
    
    // Apply miner type prefix filter if specified
    if (config.minerTypePrefix) {
      const originalCount = devices.length;
      devices = devices.filter(device => {
        const prefix = device.miner_key.split('-')[0];
        return prefix === config.minerTypePrefix;
      });
      console.log(`🔍 Filtered devices by prefix "${config.minerTypePrefix}": ${devices.length}/${originalCount} devices match`);
    }
  } else {
    devices = testMode
      ? await TestDeviceModel.find({ miner_key: config.minerKey, is_registered: true })
      : await DeviceModel.find({ miner_key: config.minerKey, is_registered: true });
  }
  
  if (devices.length === 0) {
    console.log('No devices found');
    return;
  }
  
  console.log(`\nAnalyzing missing rewards for ${devices.length} devices`);
  console.log(`Date range: ${config.startDate.toDateString()} to ${config.endDate.toDateString()}`);
  
  // Generate date range
  const dates: Date[] = [];
  const currentDate = new Date(config.startDate);
  while (currentDate <= config.endDate) {
    dates.push(new Date(currentDate));
    currentDate.setDate(currentDate.getDate() + 1);
  }
  
  let totalMissing = 0;
  const missingByDevice: { [key: string]: number } = {};
  
  for (const device of devices) {
    let deviceMissing = 0;
    
    // NEW: Get device reward document once per device
    const deviceReward = await (testMode ? TestDeviceRewardModel : DeviceRewardModel)
      .findOne({ miner_key: device.miner_key });
    
    const existingDates = new Set<string>();
    if (deviceReward) {
      deviceReward.daily_rewards.forEach(reward => {
        existingDates.add(reward.date);
      });
    }
    
    for (const date of dates) {
      const dateString = date.toISOString().split('T')[0]; // YYYY-MM-DD format
      
      if (!existingDates.has(dateString)) {
        deviceMissing++;
        totalMissing++;
      }
    }
    
    if (deviceMissing > 0) {
      missingByDevice[device.miner_key] = deviceMissing;
    }
  }
  
  console.log(`\n=== MISSING REWARDS SUMMARY ===`);
  console.log(`Total missing rewards: ${totalMissing}`);
  console.log(`Devices with missing rewards: ${Object.keys(missingByDevice).length}/${devices.length}`);
  
  if (Object.keys(missingByDevice).length > 0) {
    console.log(`\n=== TOP 10 DEVICES WITH MISSING REWARDS ===`);
    const sortedDevices = Object.entries(missingByDevice)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 10);
    
    sortedDevices.forEach(([minerKey, missing]) => {
      console.log(`${minerKey}: ${missing} missing rewards`);
    });
  }
}

async function showMenu(): Promise<void> {
  console.log('\n=== BACKPAY TOOL ===');
  console.log('This tool helps generate missing daily rewards for devices');
  
  while (true) {
    try {
      console.log('\nOptions:');
      console.log('1. Generate missing rewards (backpay)');
      console.log('2. Only analyze missing rewards (no changes)');
      console.log('3. Exit');
      
      const choice = await question('Choose option (1-3): ');
      
      switch (choice) {
        case '1':
          const config1 = await getBackpayConfig();
          await generateMissingRewards(config1);
          console.log('\n Press Enter to return to menu...');
          await question('');
          break;
        case '2':
          const config2 = await getBackpayConfig();
          await listMissingRewards(config2);
          console.log('\n Press Enter to return to menu...');
          await question('');
          break;
        case '3':
          console.log('Exiting backpay tool');
          return;
        default:
          console.log('Invalid choice. Please select 1, 2, or 3.');
      }
    } catch (error) {
      console.error('Operation failed:', error);
      console.log('\n Press Enter to return to menu...');
      await question('');
    }
  }
}

async function runBackpay(): Promise<void> {
  try {
    await connect();
    await showMenu();
  } catch (error) {
    console.error('Backpay tool failed to initialize:', error);
  } finally {
    rl.close();
    process.exit(0);
  }
}

// Run if called directly
if (require.main === module) {
  runBackpay();
}

export { runBackpay };
