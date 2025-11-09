import { connect } from "./db/connect";
import { DeviceModel, TestDeviceModel } from "./db/devices-schema";
// NEW: Import device rewards schema for health monitoring of new system
import { DeviceRewardModel, TestDeviceRewardModel } from "./db/device-rewards-schema";
import { dbPerformanceMonitor } from "./performance-monitor";
import "dotenv/config";

interface HealthStatus {
  timestamp: Date;
  mode: string;
  total_devices: number;
  todays_rewards: number;
  pending_rewards: number;
  claimable_rewards: number;
  expected_hourly_devices: number;
  current_hour: number;
  hours_expected_so_far: number;
  hours_processed_today: number;
  effective_hours_for_expectations: number;
  expected_rewards_by_now: number;
  system_status: string;
  issues: string[];
}

async function healthCheck(): Promise<HealthStatus> {
  try {
    await connect();
    
    const testMode = process.env.TEST_MODE === 'true';
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    
    // Count devices
    const totalDevices = await (testMode ? TestDeviceModel : DeviceModel)
      .countDocuments({ is_registered: true });
    
    // NEW: Count today's rewards from device-rewards collection
    const todayRewardsResult = await (testMode ? TestDeviceRewardModel : DeviceRewardModel)
      .aggregate([
        {
          $unwind: "$daily_rewards"
        },
        {
          $match: {
            "daily_rewards.created_at": { $gte: todayStart }
          }
        },
        {
          $count: "total"
        }
      ]);
    const todayRewards = todayRewardsResult[0]?.total || 0;
    
    // NEW: Check pending vs claimable from device-rewards aggregated totals
    const statusTotals = await (testMode ? TestDeviceRewardModel : DeviceRewardModel)
      .aggregate([
        {
          $group: {
            _id: null,
            totalPending: { $sum: "$total_pending" },
            totalClaimable: { $sum: "$total_claimable" }
          }
        }
      ]);
    
    const pendingRewards = statusTotals[0]?.totalPending || 0;
    const claimableRewards = statusTotals[0]?.totalClaimable || 0;
    
    // Calculate expected hourly devices
    const expectedHourlyDevices = Math.ceil(totalDevices / 24);
    const hoursExpectedSoFar = Math.min(
      24,
      Math.max(0, currentHour + (currentMinute >= 15 ? 1 : 0))
    );
    
    // Count how many hours have been processed today
    const hoursProcessedToday = await countProcessedHours(todayStart, testMode);
    
    // Detect issues
    const issues: string[] = [];
    
    // Check if we're behind on hourly processing
    const effectiveHours = Math.max(hoursProcessedToday, Math.min(hoursExpectedSoFar, hoursProcessedToday + 1));
    const expectedRewardsToday = expectedHourlyDevices * Math.max(effectiveHours, 1);
    const laggingHours = Math.max(0, hoursExpectedSoFar - hoursProcessedToday);
    const behindOnRewards = effectiveHours > 0 && todayRewards < expectedRewardsToday * 0.8;
    if (behindOnRewards && laggingHours >= 2) {
      issues.push(`Behind on daily processing: ${todayRewards}/${expectedRewardsToday} expected rewards (${laggingHours} hour lag)`);
    }
    
    // Check if any hour is completely missing
    if (hoursProcessedToday < currentHour && currentHour > 1) {
      issues.push(`Missing hourly processing: only ${hoursProcessedToday}/${currentHour} hours processed`);
    }
    
    // NEW: Check for excessive pending rewards (over 35 days old) in device-rewards
    const thirtyFiveDaysAgo = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000);
    const oldPendingResult = await (testMode ? TestDeviceRewardModel : DeviceRewardModel)
      .aggregate([
        {
          $unwind: "$daily_rewards"
        },
        {
          $match: {
            "daily_rewards.status": "pending",
            "daily_rewards.created_at": { $lt: thirtyFiveDaysAgo }
          }
        },
        {
          $count: "total"
        }
      ]);
    
    const oldPendingCount = oldPendingResult[0]?.total || 0;
    if (oldPendingCount > 0) {
      issues.push(`${oldPendingCount} rewards pending for over 35 days`);
    }
    
    // NEW: Check for zero amount rewards in device-rewards
    const zeroAmountResult = await (testMode ? TestDeviceRewardModel : DeviceRewardModel)
      .aggregate([
        {
          $unwind: "$daily_rewards"
        },
        {
          $match: {
            "daily_rewards.amount": 0
          }
        },
        {
          $count: "total"
        }
      ]);
    
    const zeroAmountCount = zeroAmountResult[0]?.total || 0;
    if (zeroAmountCount > 0) {
      issues.push(`${zeroAmountCount} rewards with zero amount`);
    }
    
    const systemStatus = issues.length === 0 ? 'HEALTHY' : 
                        issues.length <= 2 ? 'WARNING' : 'CRITICAL';
    
    return {
      timestamp: now,
      mode: testMode ? 'TEST' : 'PRODUCTION',
      total_devices: totalDevices,
      todays_rewards: todayRewards,
      pending_rewards: pendingRewards,
      claimable_rewards: claimableRewards,
      expected_hourly_devices: expectedHourlyDevices,
      current_hour: currentHour,
      hours_expected_so_far: hoursExpectedSoFar,
      hours_processed_today: hoursProcessedToday,
      effective_hours_for_expectations: effectiveHours,
      expected_rewards_by_now: expectedRewardsToday,
      system_status: systemStatus,
      issues: issues
    };
    
  } catch (error) {
    return {
      timestamp: new Date(),
      mode: process.env.TEST_MODE === 'true' ? 'TEST' : 'PRODUCTION',
      total_devices: 0,
      todays_rewards: 0,
      pending_rewards: 0,
      claimable_rewards: 0,
      expected_hourly_devices: 0,
      current_hour: 0,
      hours_expected_so_far: 0,
      hours_processed_today: 0,
      effective_hours_for_expectations: 0,
      expected_rewards_by_now: 0,
      system_status: 'ERROR',
      issues: [`Health check failed: ${error}`]
    };
  }
}

async function countProcessedHours(todayStart: Date, testMode: boolean): Promise<number> {
  // Count distinct hours that have rewards today from device-rewards.daily_rewards
  const pipeline = [
    { $unwind: "$daily_rewards" },
    {
      $match: {
        "daily_rewards.created_at": { $gte: todayStart }
      }
    },
    {
      $group: {
        _id: { $hour: "$daily_rewards.created_at" },
        count: { $sum: 1 }
      }
    },
    {
      $group: {
        _id: null,
        uniqueHours: { $sum: 1 }
      }
    }
  ];

  const result = await (testMode ? TestDeviceRewardModel : DeviceRewardModel)
    .aggregate(pipeline);

  return result.length > 0 ? result[0].uniqueHours : 0;
}

async function detailedHealthReport(): Promise<void> {
  const health = await healthCheck();
  
  console.log('\n=== DBREWARDS SYSTEM HEALTH REPORT ===');
  console.log(`Timestamp: ${health.timestamp.toISOString()}`);
  console.log(`Mode: ${health.mode}`);
  console.log(`Status: ${health.system_status}`);
  console.log('');
  
  console.log('=== DEVICE STATISTICS ===');
  console.log(`Total registered devices: ${health.total_devices}`);
  console.log(`Expected devices per hour: ${health.expected_hourly_devices}`);
  console.log('');
  
  console.log('=== PROCESSING STATISTICS ===');
  console.log(`Current hour: ${health.current_hour}`);
  console.log(`Hours processed today: ${health.hours_processed_today}`);
  console.log(`Rewards generated today: ${health.todays_rewards}`);
  console.log('');
  
  console.log('=== REWARD STATUS ===');
  console.log(`Pending rewards: ${health.pending_rewards}`);
  console.log(`Claimable rewards: ${health.claimable_rewards}`);
  console.log(`Total rewards: ${health.pending_rewards + health.claimable_rewards}`);
  console.log('');
  
  // Add database performance metrics
  console.log('=== DATABASE PERFORMANCE ===');
  const dbStats = dbPerformanceMonitor.getStats();
  console.log(`Query Statistics: ${dbStats.totalQueries} total, avg ${dbStats.averageDuration.toFixed(1)}ms`);
  console.log(`Slow Queries: ${dbStats.slowQueries} (${dbStats.totalQueries > 0 ? (dbStats.slowQueries / dbStats.totalQueries * 100).toFixed(1) : '0.0'}%)`);
  console.log(`Query Errors: ${dbStats.errorCount} (${dbStats.totalQueries > 0 ? (dbStats.errorCount / dbStats.totalQueries * 100).toFixed(1) : '0.0'}%)`);
  
  if (dbPerformanceMonitor.isPerformanceConcerning()) {
    console.log(`⚠️  Database performance is concerning`);
  } else {
    console.log(`✅ Database performance is good`);
  }
  
  // Show recent slow queries if any
  const slowQueries = dbPerformanceMonitor.getSlowQueries(3);
  if (slowQueries.length > 0) {
    console.log('Recent Slow Queries:');
    slowQueries.forEach((query, index) => {
      console.log(`  ${index + 1}. ${query.operation} on ${query.collection}: ${query.duration}ms`);
    });
  }
  
  console.log('');
  
  if (health.issues.length > 0) {
    console.log('=== ISSUES DETECTED ===');
    health.issues.forEach((issue, index) => {
      console.log(`${index + 1}. ${issue}`);
    });
  } else {
    console.log('=== NO ISSUES DETECTED ===');
    console.log('System is operating normally');
  }
  
  console.log('');
  console.log('=== RECOMMENDATIONS ===');
  
  if (health.system_status === 'CRITICAL') {
    console.log('🔴 CRITICAL: Immediate attention required');
    console.log('- Check system logs for errors');
    console.log('- Verify database connectivity');
    console.log('- Consider running audit and backpay tools');
  } else if (health.system_status === 'WARNING') {
    console.log('🟡 WARNING: Monitor closely');
    console.log('- Review processing logs');
    console.log('- Consider running health check more frequently');
  } else {
    console.log('✅ HEALTHY: System operating normally');
    console.log('- Continue regular monitoring');
    console.log('- Consider periodic audits');
  }
}

async function runHealthCheck(): Promise<void> {
  const args = process.argv.slice(2);
  const outputFormat = args.includes('--json') ? 'json' : 'detailed';
  const quiet = args.includes('--quiet');
  
  try {
    if (outputFormat === 'json') {
      const health = await healthCheck();
      console.log(JSON.stringify(health, null, 2));
    } else {
      if (!quiet) {
        await detailedHealthReport();
      } else {
        const health = await healthCheck();
        console.log(`STATUS: ${health.system_status} | Devices: ${health.total_devices} | Today's Rewards: ${health.todays_rewards} | Issues: ${health.issues.length}`);
      }
    }
  } catch (error) {
    console.error('Health check failed:', error);
    process.exit(1);
  }
  
  process.exit(0);
}

// Export for use in monitoring systems
export { healthCheck, detailedHealthReport };

// Run if called directly
if (require.main === module) {
  runHealthCheck();
}
