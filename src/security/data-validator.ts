import { getSimNow } from '../time-control';
import { DeviceRewardModel, TestDeviceRewardModel } from '../db/device-rewards-schema';
import { DeviceModel, TestDeviceModel } from '../db/devices-schema';
import { auditLogger } from './audit-logger';
import { withJobLock } from '../scheduler/job-lock';

const EPSILON = 0.01; // minor rounding noise
const WARNING_GAP = 0.5; // small drift -> warning
const LEGACY_FRY_ASSET_ID = '924268058'; // claimed Fry 1.0 rows are allowed to remain

interface ValidationError {
  type: 'CRITICAL' | 'WARNING' | 'INFO';
  entity: string;
  entityId: string;
  field: string;
  message: string;
  currentValue: any;
  expectedValue?: any;
  timestamp: Date;
}

interface ValidationSummary {
  totalChecked: number;
  errors: ValidationError[];
  criticalCount: number;
  warningCount: number;
  infoCount: number;
  executionTime: number;
}

export class DataValidator {
  private readonly testMode = process.env.TEST_MODE === 'true';
  
  public async validateDeviceRewards(): Promise<ValidationSummary> {
    const startTime = Date.now();
    const errors: ValidationError[] = [];
    
    console.log('🔍 Starting device rewards data validation...');
    
    try {
      const Model = this.testMode ? TestDeviceRewardModel : DeviceRewardModel;
      const devices = await Model.find({}).lean();
      
      for (const device of devices) {
        // Validate total calculations
        await this.validateDeviceTotals(device, errors);
        
        // Validate reward sequences
        await this.validateRewardSequences(device, errors);
        
        // Validate date consistency
        await this.validateDateConsistency(device, errors);
        
        // Validate status transitions
        await this.validateStatusTransitions(device, errors);
      }
      
      const executionTime = Date.now() - startTime;
      const summary = this.createValidationSummary(devices.length, errors, executionTime);
      
      if (summary.criticalCount > 0) {
        await auditLogger.logSecurityViolation(
          'system',
          'Critical data validation errors detected',
          { criticalCount: summary.criticalCount, errors: errors.filter(e => e.type === 'CRITICAL') }
        );
      }
      
      console.log(`✅ Device rewards validation completed: ${summary.criticalCount} critical, ${summary.warningCount} warnings`);
      return summary;
      
    } catch (error) {
      const executionTime = Date.now() - startTime;
      console.error('❌ Device rewards validation failed:', error);
      
      errors.push({
        type: 'CRITICAL',
        entity: 'validation_system',
        entityId: 'system',
        field: 'execution',
        message: `Validation system error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        currentValue: null,
        timestamp: getSimNow()
      });
      
      return this.createValidationSummary(0, errors, executionTime);
    }
  }

  private async validateDeviceTotals(device: any, errors: ValidationError[]): Promise<void> {
    // Calculate expected totals from arrays
    let expectedPending = 0;
    let expectedClaimable = 0;
    let expectedClaimed = 0;
    
    // Always include daily rewards in totals to support hybrid data states
    device.daily_rewards?.forEach((reward: any) => {
      // Ignore legacy Fry 1.0 claimed rows; they were snapshotted and do not participate in totals anymore
      if (String(reward.asset_id) === LEGACY_FRY_ASSET_ID) return;
      if (reward.status === 'pending') expectedPending += reward.amount;
      else if (reward.status === 'claimable') expectedClaimable += reward.amount;
      else if (reward.status === 'claimed') expectedClaimed += reward.amount;
    });
    
    // Weekly rewards (always count toward totals when they exist)
    device.weekly_rewards?.forEach((reward: any) => {
      if (String(reward.asset_id) === LEGACY_FRY_ASSET_ID) return;
      if (reward.status === 'pending') expectedPending += reward.amount;
      else if (reward.status === 'claimable') expectedClaimable += reward.amount;
      else if (reward.status === 'claimed') expectedClaimed += reward.amount;
    });
    
    // Round to avoid floating point precision issues
    expectedPending = Math.round(expectedPending * 100) / 100;
    expectedClaimable = Math.round(expectedClaimable * 100) / 100;
    expectedClaimed = Math.round(expectedClaimed * 100) / 100;
    
    const actualPending = Math.round((device.total_pending || 0) * 100) / 100;
    const actualClaimable = Math.round((device.total_claimable || 0) * 100) / 100;
    const actualClaimed = Math.round((device.total_claimed || 0) * 100) / 100;

    const addError = (field: string, expected: number, actual: number): void => {
      const diff = Math.abs(actual - expected);
      if (diff <= EPSILON) return;
      const level: ValidationError['type'] = diff <= WARNING_GAP ? 'WARNING' : 'CRITICAL';
      errors.push({
        type: level,
        entity: 'device_reward',
        entityId: device.miner_key,
        field,
        message: `${field} does not match sum of rewards (diff=${diff.toFixed(2)})`,
        currentValue: actual,
        expectedValue: expected,
        timestamp: getSimNow()
      });
    };
    
    addError('total_pending', expectedPending, actualPending);
    addError('total_claimable', expectedClaimable, actualClaimable);
    addError('total_claimed', expectedClaimed, actualClaimed);
  }

  private async validateRewardSequences(device: any, errors: ValidationError[]): Promise<void> {
    // Validate daily reward sequence
    const dailyNumbers = device.daily_rewards?.map((r: any) => r.reward_number).sort((a: number, b: number) => a - b) || [];
    for (let i = 0; i < dailyNumbers.length; i++) {
      if (i > 0 && dailyNumbers[i] !== dailyNumbers[i - 1] + 1) {
        // Allow for gaps but detect duplicates
        if (dailyNumbers[i] === dailyNumbers[i - 1]) {
          errors.push({
            type: 'CRITICAL',
            entity: 'device_reward',
            entityId: device.miner_key,
            field: 'daily_reward_sequence',
            message: `Duplicate daily reward number: ${dailyNumbers[i]}`,
            currentValue: dailyNumbers[i],
            timestamp: getSimNow()
          });
        }
      }
    }
    
    // Validate weekly reward sequence
    const weeklyNumbers = device.weekly_rewards?.map((r: any) => r.reward_number).sort((a: number, b: number) => a - b) || [];
    for (let i = 0; i < weeklyNumbers.length; i++) {
      if (i > 0 && weeklyNumbers[i] === weeklyNumbers[i - 1]) {
        errors.push({
          type: 'CRITICAL',
          entity: 'device_reward',
          entityId: device.miner_key,
          field: 'weekly_reward_sequence',
          message: `Duplicate weekly reward number: ${weeklyNumbers[i]}`,
          currentValue: weeklyNumbers[i],
          timestamp: getSimNow()
        });
      }
    }
    
    // Validate reward count consistency
    const expectedRewardCount = Math.max(...dailyNumbers, 0);
    if (device.reward_count && device.reward_count !== expectedRewardCount) {
      errors.push({
        type: 'WARNING',
        entity: 'device_reward',
        entityId: device.miner_key,
        field: 'reward_count',
        message: 'Reward count does not match highest daily reward number',
        currentValue: device.reward_count,
        expectedValue: expectedRewardCount,
        timestamp: getSimNow()
      });
    }
    
    const expectedWeeklyCount = Math.max(...weeklyNumbers, 0);
    if (device.weekly_reward_count && device.weekly_reward_count !== expectedWeeklyCount) {
      errors.push({
        type: 'WARNING',
        entity: 'device_reward',
        entityId: device.miner_key,
        field: 'weekly_reward_count',
        message: 'Weekly reward count does not match highest weekly reward number',
        currentValue: device.weekly_reward_count,
        expectedValue: expectedWeeklyCount,
        timestamp: getSimNow()
      });
    }
  }

  private async validateDateConsistency(device: any, errors: ValidationError[]): Promise<void> {
    const now = getSimNow();
    
    // Check if first_reward_date matches earliest reward
    if (device.daily_rewards && device.daily_rewards.length > 0) {
      const earliestDaily = device.daily_rewards.reduce((earliest: any, reward: any) => 
        !earliest || reward.created_at < earliest.created_at ? reward : earliest
      );
      
      if (device.first_reward_date && Math.abs(new Date(device.first_reward_date).getTime() - earliestDaily.created_at.getTime()) > 1000) {
        errors.push({
          type: 'WARNING',
          entity: 'device_reward',
          entityId: device.miner_key,
          field: 'first_reward_date',
          message: 'First reward date does not match earliest daily reward',
          currentValue: device.first_reward_date,
          expectedValue: earliestDaily.created_at,
          timestamp: now
        });
      }
    }
    
    // Check if last_reward_date matches latest reward
    if (device.daily_rewards && device.daily_rewards.length > 0) {
      const latestDaily = device.daily_rewards.reduce((latest: any, reward: any) => 
        !latest || reward.created_at > latest.created_at ? reward : latest
      );
      
      if (device.last_reward_date && Math.abs(new Date(device.last_reward_date).getTime() - latestDaily.created_at.getTime()) > 1000) {
        errors.push({
          type: 'WARNING',
          entity: 'device_reward',
          entityId: device.miner_key,
          field: 'last_reward_date',
          message: 'Last reward date does not match latest daily reward',
          currentValue: device.last_reward_date,
          expectedValue: latestDaily.created_at,
          timestamp: now
        });
      }
    }
    
    // Check for future dates
    device.daily_rewards?.forEach((reward: any, index: number) => {
      if (reward.created_at > now) {
        errors.push({
          type: 'CRITICAL',
          entity: 'device_reward',
          entityId: device.miner_key,
          field: `daily_reward_${index}_created_at`,
          message: 'Reward has future creation date',
          currentValue: reward.created_at,
          timestamp: now
        });
      }
    });
    
    device.weekly_rewards?.forEach((reward: any, index: number) => {
      if (reward.created_at > now) {
        errors.push({
          type: 'CRITICAL',
          entity: 'device_reward',
          entityId: device.miner_key,
          field: `weekly_reward_${index}_created_at`,
          message: 'Weekly reward has future creation date',
          currentValue: reward.created_at,
          timestamp: now
        });
      }
    });
  }

  private async validateStatusTransitions(device: any, errors: ValidationError[]): Promise<void> {
    const now = getSimNow();
    
    // Check claimed rewards have transaction IDs
    device.daily_rewards?.forEach((reward: any, index: number) => {
      if (reward.status === 'claimed' && !reward.tx_id) {
        errors.push({
          type: 'CRITICAL',
          entity: 'device_reward',
          entityId: device.miner_key,
          field: `daily_reward_${index}_tx_id`,
          message: 'Claimed reward missing transaction ID',
          currentValue: null,
          timestamp: now
        });
      }
      
      if (reward.status === 'claimed' && !reward.claimed_at) {
        errors.push({
          type: 'CRITICAL',
          entity: 'device_reward',
          entityId: device.miner_key,
          field: `daily_reward_${index}_claimed_at`,
          message: 'Claimed reward missing claimed timestamp',
          currentValue: null,
          timestamp: now
        });
      }
    });
    
    device.weekly_rewards?.forEach((reward: any, index: number) => {
      if (reward.status === 'claimed' && !reward.tx_id) {
        errors.push({
          type: 'CRITICAL',
          entity: 'device_reward',
          entityId: device.miner_key,
          field: `weekly_reward_${index}_tx_id`,
          message: 'Claimed weekly reward missing transaction ID',
          currentValue: null,
          timestamp: now
        });
      }
      
      if (reward.status === 'claimed' && !reward.claimed_at) {
        errors.push({
          type: 'CRITICAL',
          entity: 'device_reward',
          entityId: device.miner_key,
          field: `weekly_reward_${index}_claimed_at`,
          message: 'Claimed weekly reward missing claimed timestamp',
          currentValue: null,
          timestamp: now
        });
      }
      
      // Check unlock_at logic for weekly rewards
      if (reward.status === 'claimable' && reward.unlock_at > now) {
        errors.push({
          type: 'WARNING',
          entity: 'device_reward',
          entityId: device.miner_key,
          field: `weekly_reward_${index}_status`,
          message: 'Weekly reward marked claimable before unlock date',
          currentValue: reward.status,
          expectedValue: 'pending',
          timestamp: now
        });
      }
    });
  }

  public async validateDeviceConsistency(): Promise<ValidationSummary> {
    const startTime = Date.now();
    const errors: ValidationError[] = [];
    
    console.log('🔍 Starting device consistency validation...');
    
    try {
      const RewardModel = this.testMode ? TestDeviceRewardModel : DeviceRewardModel;
      const DevModel = this.testMode ? TestDeviceModel : DeviceModel;
      
      // Get all device rewards
      const deviceRewards = await RewardModel.find({}).lean();
      const devices = await DevModel.find({ is_registered: true }).lean();
      
      // Check for orphaned device rewards
      const deviceKeys = new Set(devices.map((d: any) => d.miner_key));
      const rewardKeys = new Set(deviceRewards.map((dr: any) => dr.miner_key));
      
      for (const rewardKey of rewardKeys) {
        if (!deviceKeys.has(rewardKey)) {
          errors.push({
            type: 'WARNING',
            entity: 'device_reward',
            entityId: rewardKey as string,
            field: 'miner_key',
            message: 'Device reward exists for unregistered or non-existent device',
            currentValue: rewardKey,
            timestamp: getSimNow()
          });
        }
      }
      
      // Check for devices with rewards but missing reward documents
      for (const device of devices) {
        const hasRewardDoc = rewardKeys.has(device.miner_key);
        if (!hasRewardDoc) {
          // This might be normal for new devices, so only warning
          errors.push({
            type: 'INFO',
            entity: 'device',
            entityId: device.miner_key,
            field: 'rewards',
            message: 'Registered device has no reward document',
            currentValue: null,
            timestamp: getSimNow()
          });
        }
      }
      
      const executionTime = Date.now() - startTime;
      const summary = this.createValidationSummary(devices.length, errors, executionTime);
      
      console.log(`✅ Device consistency validation completed: ${summary.criticalCount} critical, ${summary.warningCount} warnings`);
      return summary;
      
    } catch (error) {
      const executionTime = Date.now() - startTime;
      console.error('❌ Device consistency validation failed:', error);
      
      errors.push({
        type: 'CRITICAL',
        entity: 'validation_system',
        entityId: 'system',
        field: 'execution',
        message: `Consistency validation error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        currentValue: null,
        timestamp: getSimNow()
      });
      
      return this.createValidationSummary(0, errors, executionTime);
    }
  }

  private createValidationSummary(totalChecked: number, errors: ValidationError[], executionTime: number): ValidationSummary {
    return {
      totalChecked,
      errors,
      criticalCount: errors.filter(e => e.type === 'CRITICAL').length,
      warningCount: errors.filter(e => e.type === 'WARNING').length,
      infoCount: errors.filter(e => e.type === 'INFO').length,
      executionTime
    };
  }

  public async runFullValidation(): Promise<{
    deviceRewards: ValidationSummary;
    deviceConsistency: ValidationSummary;
    overallHealth: 'HEALTHY' | 'WARNING' | 'CRITICAL';
  }> {
    return await withJobLock('data-validation', ['weekly-rollup', 'hourly-processing'], async () => {
      console.log('🔍 Starting full data validation suite...');
      
      const [deviceRewards, deviceConsistency] = await Promise.all([
        this.validateDeviceRewards(),
        this.validateDeviceConsistency()
      ]);
      
      const totalCritical = deviceRewards.criticalCount + deviceConsistency.criticalCount;
      const totalWarnings = deviceRewards.warningCount + deviceConsistency.warningCount;
      
      let overallHealth: 'HEALTHY' | 'WARNING' | 'CRITICAL';
      if (totalCritical > 0) {
        overallHealth = 'CRITICAL';
      } else if (totalWarnings > 5) {
        overallHealth = 'WARNING';
      } else {
        overallHealth = 'HEALTHY';
      }
      
      console.log(`🏁 Full validation completed: ${overallHealth} (${totalCritical} critical, ${totalWarnings} warnings)`);
      
      return {
        deviceRewards,
        deviceConsistency,
        overallHealth
      };
    });
  }

  // Schedule periodic validation
  public startPeriodicValidation(): void {
    // Run validation every 6 hours
    setInterval(async () => {
      try {
        const results = await this.runFullValidation();
        
        if (results.overallHealth === 'CRITICAL') {
          console.log('🚨 Critical data validation issues detected!');
        }
      } catch (error) {
        console.error('Periodic validation failed:', error);
      }
    }, 6 * 60 * 60 * 1000);
    
    console.log('🔍 Periodic data validation started (every 6 hours)');
  }
}

// Singleton instance
export const dataValidator = new DataValidator();
