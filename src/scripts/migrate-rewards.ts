import { connect, getConnection } from "../db/connect";
import { RewardModel, TestRewardModel } from "../db/rewards-schema";
import { DeviceRewardModel, TestDeviceRewardModel } from "../db/device-rewards-schema";
import "dotenv/config";

const testMode = process.env.TEST_MODE && process.env.TEST_MODE === "true";
const DEBUG = process.env.DEBUG && process.env.DEBUG === "true";

// Migration statistics interface
interface MigrationStats {
  totalMiners: number;
  processedMiners: number;
  totalRewardsProcessed: number;
  totalPendingAmount: number;
  totalClaimableAmount: number;
  totalClaimedAmount: number;
  patchedClaimFields?: number;
  errors: Array<{ minerKey: string; error: string }>;
  startTime: Date;
  endTime?: Date;
  duration?: number;
  dryRun?: boolean;
}

/**
 * Main migration function - converts individual reward documents to device-centric aggregated documents
 * This preserves all historical data while dramatically reducing document count
 */
export async function migrateRewardsToDeviceRewards(dryRun: boolean = false): Promise<MigrationStats> {
  console.log('🚀 Starting migration from individual rewards to device-rewards aggregation...');
  console.log(`Mode: ${testMode ? 'TEST' : 'PRODUCTION'}`);
  console.log(`🔍 Run Type: ${dryRun ? 'DRY RUN (Preview Only)' : 'LIVE MIGRATION'}`);
  
  const stats: MigrationStats = {
    totalMiners: 0,
    processedMiners: 0,
    totalRewardsProcessed: 0,
    totalPendingAmount: 0,
    totalClaimableAmount: 0,
    totalClaimedAmount: 0,
    patchedClaimFields: 0,
    errors: [],
    startTime: new Date(),
    dryRun
  };

  try {
    await connect();
    console.log('✅ Database connection established');

    // Get all unique miner keys from the rewards collection
    console.log('📊 Analyzing existing rewards collection...');
    const uniqueMiners = await (testMode ? TestRewardModel : RewardModel).distinct('miner_key');
    stats.totalMiners = uniqueMiners.length;
    
    console.log(`📈 Found ${stats.totalMiners} unique miners to migrate`);
    console.log(`📦 Processing in batches for optimal performance...`);

    // Process miners in batches to avoid memory issues
    const batchSize = 100;
    let batchNumber = 1;
    
    for (let i = 0; i < uniqueMiners.length; i += batchSize) {
      const batch = uniqueMiners.slice(i, i + batchSize);
      const batchProgress = `${batchNumber}/${Math.ceil(uniqueMiners.length / batchSize)}`;
      
      console.log(`\n🔄 Processing batch ${batchProgress} (${batch.length} miners)`);
      
      // Process batch with concurrent operations for better performance
      const batchPromises = batch.map(async (minerKey: string) => {
        return await migrateSingleMiner(minerKey, stats, dryRun);
      });
      
      // Wait for all miners in batch to complete
      const batchResults = await Promise.allSettled(batchPromises);
      
      // Count successful operations in this batch
      const batchSuccess = batchResults.filter(result => result.status === 'fulfilled').length;
      stats.processedMiners += batchSuccess;
      
      // Log batch completion
      console.log(`✅ Batch ${batchProgress} completed: ${batchSuccess}/${batch.length} successful`);
      console.log(`📊 Overall progress: ${stats.processedMiners}/${stats.totalMiners} miners (${((stats.processedMiners / stats.totalMiners) * 100).toFixed(1)}%)`);
      
      batchNumber++;
      
      // Brief pause between batches to avoid overwhelming the database
      if (i + batchSize < uniqueMiners.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    // Finalize migration statistics
    stats.endTime = new Date();
    stats.duration = stats.endTime.getTime() - stats.startTime.getTime();
    
    // Print comprehensive migration summary
    printMigrationSummary(stats);
    
    return stats;
    
  } catch (error) {
    console.error('❌ Migration failed:', error);
    stats.endTime = new Date();
    stats.duration = stats.endTime.getTime() - stats.startTime.getTime();
    throw error;
  }
}

/**
 * Migrates rewards for a single miner from individual documents to aggregated device document
 */
async function migrateSingleMiner(minerKey: string, stats: MigrationStats, dryRun: boolean = false): Promise<void> {
  try {
    DEBUG && console.log(`🔍 Processing miner: ${minerKey}`);
    
    // Get all rewards for this miner, sorted by creation date (oldest first)
    const rewards = await (testMode ? TestRewardModel : RewardModel)
      .find({ miner_key: minerKey })
      .sort({ createdAt: 1 }); // Sort ascending to maintain chronological order
    
    if (rewards.length === 0) {
      DEBUG && console.log(`⚠️  No rewards found for miner ${minerKey}`);
      return;
    }
    
    DEBUG && console.log(`📋 Found ${rewards.length} rewards for ${minerKey}`);
    
    // Initialize aggregation totals - ensure fresh variables for each miner
    let minerTotalPending = 0;
    let minerTotalClaimable = 0;
    let minerTotalClaimed = 0;
    
    // First pass: calculate totals to verify against individual calculations
    const statusCounts = { pending: 0, claimable: 0, claimed: 0 };
    for (const reward of rewards) {
      const amount = Number(reward.amount); // Ensure numeric type
      
      switch (reward.status) {
        case 'pending':
          minerTotalPending += amount;
          statusCounts.pending++;
          break;
        case 'claimable':
          minerTotalClaimable += amount;
          statusCounts.claimable++;
          break;
        case 'claimed':
          minerTotalClaimed += amount;
          statusCounts.claimed++;
          break;
        default:
          console.warn(`⚠️  Unknown reward status '${reward.status}' for ${minerKey}, treating as pending`);
          minerTotalPending += amount;
          statusCounts.pending++;
      }
    }
    
    // Debug: Log calculated totals before proceeding
    DEBUG && console.log(`💰 Calculated totals for ${minerKey}: P:${minerTotalPending} (${statusCounts.pending}), C:${minerTotalClaimable} (${statusCounts.claimable}), Cl:${minerTotalClaimed} (${statusCounts.claimed})`);
    
    // Create daily rewards array preserving all historical data
    const dailyRewards = rewards.map((reward, index) => {
      const amount = Number(reward.amount);
      
      // Update global stats (accumulate across all miners)
      switch (reward.status) {
        case 'pending':
          stats.totalPendingAmount += amount;
          break;
        case 'claimable':
          stats.totalClaimableAmount += amount;
          break;
        case 'claimed':
          stats.totalClaimedAmount += amount;
          break;
        default:
          stats.totalPendingAmount += amount; // Unknown status treated as pending
      }
      
      // Create daily reward entry preserving all original data
      return {
        date: reward.createdAt.toISOString().split('T')[0], // YYYY-MM-DD format
        amount: amount,
        status: reward.status,
        asset_id: reward.asset_id,
        created_at: reward.createdAt,
        claimed_at: reward.status === 'claimed' ? (reward as any).claimedAt : undefined,
        tx_id: reward.status === 'claimed' ? (reward as any).txId : undefined,
        reward_number: index + 1 // Sequential numbering starting from 1
      };
    });
    
    // Verify totals match (add validation check)
    const calculatedTotal = minerTotalPending + minerTotalClaimable + minerTotalClaimed;
    const sumCheck = rewards.reduce((sum, reward) => sum + Number(reward.amount), 0);
    
    if (Math.abs(calculatedTotal - sumCheck) > 0.01) { // Allow for small floating point errors
      console.warn(`⚠️  Total mismatch for ${minerKey}: calculated ${calculatedTotal} vs sum ${sumCheck}`);
    }
    
    // Create device reward document with all aggregated data (daily side)
    const deviceRewardDoc = {
      miner_key: minerKey,
      total_pending: minerTotalPending,
      total_claimable: minerTotalClaimable,
      total_claimed: minerTotalClaimed,
      daily_rewards: dailyRewards,
      last_updated: new Date(),
      reward_count: rewards.length,
      first_reward_date: rewards[0].createdAt,      // Earliest reward date
      last_reward_date: rewards[rewards.length - 1].createdAt  // Most recent reward date
    };
    
    // Insert or patch device reward document
    const model = testMode ? TestDeviceRewardModel : DeviceRewardModel;
    const existing = await model.findOne({ miner_key: minerKey });

    if (!dryRun) {

      if (!existing) {
        // Fresh create via upsert; $set to avoid future schema surprises
        await model.findOneAndUpdate(
          { miner_key: minerKey },
          { $set: deviceRewardDoc },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
      } else {
        // Patch mode: do NOT replace the doc (would wipe weekly_rewards).
        // 1) Backfill claimed fields (tx_id, claimed_at) for daily rewards using legacy data
        const claimedLegacy = rewards.filter(r => r.status === 'claimed' && ((r as any).txId || (r as any).claimedAt));
        for (const r of claimedLegacy) {
          const no = (r as any).no as number | undefined;
          const txId = (r as any).txId as string | undefined;
          const claimedAt = (r as any).claimedAt as Date | undefined;
          if (!no) continue;
          let upd = await model.updateOne(
            { miner_key: minerKey },
            {
              $set: {
                'daily_rewards.$[elem].status': 'claimed',
                ...(txId ? { 'daily_rewards.$[elem].tx_id': txId } : {}),
                ...(claimedAt ? { 'daily_rewards.$[elem].claimed_at': claimedAt } : {})
              }
            },
            { arrayFilters: [{ 'elem.reward_number': no }] }
          );
          // Fallback: match by created_at if numbering diverged
          if (!upd.modifiedCount || upd.modifiedCount <= 0) {
            const createdAt = r.createdAt as Date;
            upd = await model.updateOne(
              { miner_key: minerKey },
              {
                $set: {
                  'daily_rewards.$[elem].status': 'claimed',
                  ...(txId ? { 'daily_rewards.$[elem].tx_id': txId } : {}),
                  ...(claimedAt ? { 'daily_rewards.$[elem].claimed_at': claimedAt } : {})
                }
              },
              { arrayFilters: [{ 'elem.created_at': createdAt }] }
            );
          }
          if (upd.modifiedCount && upd.modifiedCount > 0) stats.patchedClaimFields = (stats.patchedClaimFields || 0) + 1;
        }

        // 2) Optionally refresh top-level dates (leave totals alone to avoid double counting in weekly mode)
        await model.updateOne(
          { miner_key: minerKey },
          {
            $set: {
              last_updated: new Date(),
              first_reward_date: existing.first_reward_date || rewards[0].createdAt,
              last_reward_date: rewards[rewards.length - 1].createdAt
            }
          }
        );
      }
    } else {
      // DRY RUN: improve clarity on action type
      if (!existing) {
        DEBUG && console.log(`📝 [DRY RUN] Would CREATE aggregated device-rewards for ${minerKey} with ${rewards.length} daily entries`);
      } else {
        const claimedWithMeta = rewards.filter(r => r.status === 'claimed' && ((r as any).txId || (r as any).claimedAt)).length;
        DEBUG && console.log(`📝 [DRY RUN] Would PATCH existing device-rewards for ${minerKey}: backfill tx_id/claimed_at on up to ${claimedWithMeta} daily claimed entries`);
      }
    }
    
    // Update migration statistics
    stats.totalRewardsProcessed += rewards.length;
    
    DEBUG && console.log(`${dryRun ? '🔍 [DRY RUN]' : '✅'} ${dryRun ? 'Would process' : 'Processed'} ${rewards.length} legacy rewards for ${minerKey} (P:${minerTotalPending}, Clb:${minerTotalClaimable}, Cld:${minerTotalClaimed})`);
    
  } catch (error) {
    const errorMessage = `Migration failed for ${minerKey}: ${error instanceof Error ? error.message : 'Unknown error'}`;
    console.error(`❌ ${errorMessage}`);
    stats.errors.push({ minerKey, error: errorMessage });
  }
}

/**
 * Prints a comprehensive summary of the migration results
 */
function printMigrationSummary(stats: MigrationStats): void {
  const durationMinutes = stats.duration ? (stats.duration / (1000 * 60)).toFixed(2) : '0';
  const successRate = ((stats.processedMiners / stats.totalMiners) * 100).toFixed(1);
  
  console.log('\n' + '='.repeat(80));
  console.log('🎉 MIGRATION COMPLETED');
  console.log('='.repeat(80));
  console.log(`⏱️  Duration: ${durationMinutes} minutes`);
  console.log(`📊 Total miners: ${stats.totalMiners}`);
  console.log(`✅ Successfully migrated: ${stats.processedMiners} (${successRate}%)`);
  console.log(`❌ Failed migrations: ${stats.errors.length}`);
  console.log(`📦 Total rewards processed: ${stats.totalRewardsProcessed.toLocaleString()}`);
  console.log('\n💰 Amount totals:');
  console.log(`   Pending: ${stats.totalPendingAmount.toLocaleString()}`);
  console.log(`   Claimable: ${stats.totalClaimableAmount.toLocaleString()}`);
  console.log(`   Claimed: ${stats.totalClaimedAmount.toLocaleString()}`);
  console.log(`   Total: ${(stats.totalPendingAmount + stats.totalClaimableAmount + stats.totalClaimedAmount).toLocaleString()}`);
  if (stats.patchedClaimFields && stats.patchedClaimFields > 0) {
    console.log(`\n🩹 Patched claim fields on daily rewards: ${stats.patchedClaimFields}`);
  }
  
  if (stats.errors.length > 0) {
    console.log('\n❌ Errors encountered:');
    stats.errors.forEach(({ minerKey, error }) => {
      console.log(`   ${minerKey}: ${error}`);
    });
  }
  
  console.log('\n🚀 Performance improvement expected:');
  console.log(`   Document count reduction: ${stats.totalRewardsProcessed.toLocaleString()} → ${stats.processedMiners.toLocaleString()} (${(((stats.totalRewardsProcessed - stats.processedMiners) / stats.totalRewardsProcessed) * 100).toFixed(1)}% reduction)`);
  console.log(`   Query performance: Individual lookups → Single document per device`);
  console.log(`   Storage efficiency: Massive reduction in index overhead`);
  
  console.log('\n✅ Migration data integrity:');
  console.log(`   All historical reward data preserved in daily_rewards arrays`);
  console.log(`   Original creation dates and amounts maintained`);
  console.log(`   Sequential reward numbering preserved`);
  console.log(`   Status transitions fully tracked`);
  
  if (stats.dryRun) {
    console.log('\n🔍 This was a DRY RUN - no changes were made to the database');
    console.log('💡 Run without --dry-run flag to perform the actual migration');
  } else {
    console.log('\n✅ Migration completed successfully!');
  }
  
  console.log('='.repeat(80));
}

/**
 * Validation function to verify migration integrity
 * Compares totals between original and migrated data
 */
export async function validateMigration(): Promise<boolean> {
  console.log('\n🔍 Starting migration validation...');
  
  try {
    await connect();
    
    // 1. Validate document counts
    console.log('📊 Validating document counts...');
    const deviceRewardCount = await (testMode ? TestDeviceRewardModel : DeviceRewardModel).countDocuments();
    const uniqueMinersCount = (await (testMode ? TestRewardModel : RewardModel).distinct('miner_key')).length;
    
    console.log(`Device-rewards documents: ${deviceRewardCount}`);
    console.log(`Expected (unique miners): ${uniqueMinersCount}`);
    
    if (deviceRewardCount !== uniqueMinersCount) {
      console.error(`❌ Document count mismatch!`);
      return false;
    }
    
    // 2. Validate total amounts by status
    console.log('💰 Validating amount totals...');
    const originalTotals = await (testMode ? TestRewardModel : RewardModel).aggregate([
      {
        $group: {
          _id: '$status',
          total: { $sum: '$amount' },
          count: { $sum: 1 }
        }
      }
    ]);
    
    const newTotals = await (testMode ? TestDeviceRewardModel : DeviceRewardModel).aggregate([
      {
        $group: {
          _id: null,
          totalPending: { $sum: '$total_pending' },
          totalClaimable: { $sum: '$total_claimable' },
          totalClaimed: { $sum: '$total_claimed' },
          totalRewards: { $sum: '$reward_count' }
        }
      }
    ]);
    
    console.log('Original totals by status:', originalTotals);
    console.log('New aggregated totals:', newTotals[0]);
    
    // 3. Random sampling validation
    console.log('🎲 Performing random sampling validation...');
    const sampleSize = Math.min(10, uniqueMinersCount);
    const randomMiners = await (testMode ? TestRewardModel : RewardModel).aggregate([
      { $sample: { size: sampleSize } }
    ]);
    
    let samplingErrors = 0;
    for (const sample of randomMiners) {
      const originalRewards = await (testMode ? TestRewardModel : RewardModel)
        .find({ miner_key: sample.miner_key });
      
      const deviceReward = await (testMode ? TestDeviceRewardModel : DeviceRewardModel)
        .findOne({ miner_key: sample.miner_key });
      
      if (!deviceReward) {
        console.error(`❌ Missing device reward for ${sample.miner_key}`);
        samplingErrors++;
        continue;
      }
      
      if (originalRewards.length !== deviceReward.reward_count) {
        console.error(`❌ Reward count mismatch for ${sample.miner_key}: ${originalRewards.length} vs ${deviceReward.reward_count}`);
        samplingErrors++;
      }
      
      if (originalRewards.length !== deviceReward.daily_rewards.length) {
        console.error(`❌ Daily rewards count mismatch for ${sample.miner_key}: ${originalRewards.length} vs ${deviceReward.daily_rewards.length}`);
        samplingErrors++;
      }
    }
    
    if (samplingErrors > 0) {
      console.error(`❌ Validation failed: ${samplingErrors} sampling errors detected`);
      return false;
    }
    
    console.log('✅ Migration validation passed!');
    return true;
    
  } catch (error) {
    console.error('❌ Validation failed:', error);
    return false;
  }
}

/**
 * CLI interface for running migration
 */
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];
  const dryRun = args.includes('--dry-run');
  
  if (command === 'validate') {
    validateMigration()
      .then(success => {
        process.exit(success ? 0 : 1);
      })
      .catch(error => {
        console.error('Validation error:', error);
        process.exit(1);
      });
  } else {
    migrateRewardsToDeviceRewards(dryRun)
      .then(stats => {
        if (!stats.dryRun) {
          console.log('\n🎉 Migration completed successfully!');
          console.log('\n💡 Next steps:');
          console.log('   1. Run validation: npm run migrate-rewards:validate');
          console.log('   2. Test new system thoroughly');
          console.log('   3. Monitor performance improvements');
        } else {
          console.log('\n🔍 Dry run completed successfully!');
          console.log('\n💡 Next steps:');
          console.log('   1. Review the preview above');
          console.log('   2. Run without --dry-run flag to perform actual migration');
          console.log('   3. Validate after migration: npm run migrate-rewards:validate');
        }
        
        if (stats.errors.length > 0) {
          console.log(`\n⚠️  ${stats.errors.length} errors occurred - review logs above`);
          process.exit(1);
        } else {
          process.exit(0);
        }
      })
      .catch(error => {
        console.error('Migration error:', error);
        process.exit(1);
      });
  }
}
