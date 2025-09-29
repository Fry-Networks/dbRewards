import readline from 'readline';
import { connect, getConnection } from "../db/connect";
import { DeviceModel, TestDeviceModel, Device } from "../db/devices-schema";
import { ProductModel, Product } from "../db/products-schema";
import { RewardModel, TestRewardModel, Reward } from "../db/rewards-schema";
import { 
  isNodeProduct, 
  isRegistrationNeeded, 
  isNodeStakingNeeded, 
  isRegistrationStaked, 
  isNodeStaked 
} from "../reward";
import "dotenv/config";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

interface RewardDiscrepancy {
  reward: Reward;
  device: Device | null;
  product: Product | null;
  currentAmount: number;
  expectedAmount: number;
  issue: string;
}

interface DateRangeOption {
  name: string;
  start: Date;
  end: Date;
  description: string;
}

interface CorrectionSummary {
  totalRewardsAnalyzed: number;
  totalDiscrepancies: number;
  zeroAmountRewards: number;
  incorrectAmountRewards: number;
  totalCurrentAmount: number;
  totalExpectedAmount: number;
  estimatedCorrection: number;
}

function question(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

function calculateExpectedReward(device: Device, product: Product): number {
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

async function findRewardDiscrepancies(dateRange?: { start: Date; end: Date }, dryRun: boolean = false): Promise<RewardDiscrepancy[]> {
  const testMode = process.env.TEST_MODE === 'true';
  const discrepancies: RewardDiscrepancy[] = [];
  
  if (dryRun) {
    console.log('🔍 DRY RUN MODE - Analyzing reward discrepancies (no changes will be made)...');
  } else {
    console.log('Analyzing reward discrepancies...');
  }
  
  // Build query for rewards
  let rewardQuery: any = {};
  if (dateRange) {
    rewardQuery.createdAt = {
      $gte: dateRange.start,
      $lte: dateRange.end
    };
    console.log(`Date filter: ${dateRange.start.toDateString()} to ${dateRange.end.toDateString()}`);
  }
  
  // Get all rewards (or in date range)
  const rewards = await (testMode ? TestRewardModel : RewardModel)
    .find(rewardQuery)
    .lean() as Reward[];
  
  console.log(`Analyzing ${rewards.length} reward records...`);
  
  // Get all devices and products
  const devices = await (testMode ? TestDeviceModel : DeviceModel)
    .find({ is_registered: true })
    .lean() as Device[];
  
  const products = await ProductModel.find({}).lean() as Product[];
  
  // Create lookup maps for efficiency
  const deviceMap = new Map<string, Device>();
  devices.forEach(device => {
    deviceMap.set(device.miner_key, device);
  });
  
  const productMap = new Map<string, Product>();
  products.forEach(product => {
    productMap.set(product.key, product);
  });
  
  let processed = 0;
  for (const reward of rewards) {
    processed++;
    if (processed % 1000 === 0) {
      console.log(`Processed ${processed}/${rewards.length} rewards`);
    }
    
    const device = deviceMap.get(reward.miner_key);
    if (!device) {
      discrepancies.push({
        reward,
        device: null,
        product: null,
        currentAmount: reward.amount,
        expectedAmount: 0,
        issue: 'Device not found'
      });
      continue;
    }
    
    const minerType = device.miner_key.split("-")[0];
    const product = productMap.get(minerType);
    if (!product) {
      discrepancies.push({
        reward,
        device,
        product: null,
        currentAmount: reward.amount,
        expectedAmount: 0,
        issue: 'Product not found'
      });
      continue;
    }
    
    const expectedAmount = calculateExpectedReward(device, product);
    const currentAmount = reward.amount;
    
    // Check for discrepancies
    if (currentAmount === 0) {
      discrepancies.push({
        reward,
        device,
        product,
        currentAmount,
        expectedAmount,
        issue: 'Zero amount'
      });
    } else if (Math.abs(currentAmount - expectedAmount) > 0.01) {
      discrepancies.push({
        reward,
        device,
        product,
        currentAmount,
        expectedAmount,
        issue: 'Incorrect amount'
      });
    }
  }
  
  console.log(`\nFound ${discrepancies.length} discrepancies`);
  return discrepancies;
}

async function displayDiscrepancySummary(discrepancies: RewardDiscrepancy[], dateRange?: { start: Date; end: Date }): Promise<CorrectionSummary> {
  const summary: CorrectionSummary = {
    totalRewardsAnalyzed: 0,
    totalDiscrepancies: discrepancies.length,
    zeroAmountRewards: 0,
    incorrectAmountRewards: 0,
    totalCurrentAmount: 0,
    totalExpectedAmount: 0,
    estimatedCorrection: 0
  };
  
  discrepancies.forEach(disc => {
    switch (disc.issue) {
      case 'Zero amount':
        summary.zeroAmountRewards++;
        break;
      case 'Incorrect amount':
        summary.incorrectAmountRewards++;
        break;
    }
    
    summary.totalCurrentAmount += disc.currentAmount;
    summary.totalExpectedAmount += disc.expectedAmount;
  });
  
  summary.estimatedCorrection = summary.totalExpectedAmount - summary.totalCurrentAmount;
  
  console.log('\n=== 📊 DISCREPANCY ANALYSIS SUMMARY ===');
  if (dateRange) {
    console.log(`📅 Date Range: ${dateRange.start.toDateString()} to ${dateRange.end.toDateString()}`);
  } else {
    console.log(`📅 Date Range: All rewards analyzed`);
  }
  console.log(`📈 Total discrepancies found: ${summary.totalDiscrepancies}`);
  console.log(`🚫 Zero amount rewards: ${summary.zeroAmountRewards}`);
  console.log(`⚠️  Incorrect amount rewards: ${summary.incorrectAmountRewards}`);
  console.log(`💰 Current total amount: ${summary.totalCurrentAmount.toFixed(2)}`);
  console.log(`💎 Expected total amount: ${summary.totalExpectedAmount.toFixed(2)}`);
  console.log(`📈 Estimated correction: +${summary.estimatedCorrection.toFixed(2)}`);
  
  if (summary.zeroAmountRewards > 0) {
    const zeroAmountCorrection = discrepancies
      .filter(d => d.issue === 'Zero amount')
      .reduce((sum, d) => sum + d.expectedAmount, 0);
    console.log(`   └─ From zero amounts: +${zeroAmountCorrection.toFixed(2)}`);
  }
  
  if (summary.incorrectAmountRewards > 0) {
    const incorrectAmountCorrection = discrepancies
      .filter(d => d.issue === 'Incorrect amount')
      .reduce((sum, d) => sum + (d.expectedAmount - d.currentAmount), 0);
    console.log(`   └─ From incorrect amounts: +${incorrectAmountCorrection.toFixed(2)}`);
  }
  
  // Show sample discrepancies by type
  console.log('\n=== 🔍 SAMPLE DISCREPANCIES ===');
  
  const zeroAmountSamples = discrepancies.filter(d => d.issue === 'Zero amount').slice(0, 5);
  if (zeroAmountSamples.length > 0) {
    console.log('\n💥 Zero Amount Rewards (sample):');
    zeroAmountSamples.forEach((disc, index) => {
      console.log(`   ${index + 1}. ${disc.device?.miner_key || 'Unknown'}: 0 → ${disc.expectedAmount}`);
    });
  }
  
  const incorrectAmountSamples = discrepancies.filter(d => d.issue === 'Incorrect amount').slice(0, 5);
  if (incorrectAmountSamples.length > 0) {
    console.log('\n⚠️  Incorrect Amount Rewards (sample):');
    incorrectAmountSamples.forEach((disc, index) => {
      console.log(`   ${index + 1}. ${disc.device?.miner_key || 'Unknown'}: ${disc.currentAmount} → ${disc.expectedAmount}`);
    });
  }
  
  const deviceNotFoundSamples = discrepancies.filter(d => d.issue === 'Device not found').slice(0, 3);
  if (deviceNotFoundSamples.length > 0) {
    console.log('\n❌ Device Not Found Issues (sample):');
    deviceNotFoundSamples.forEach((disc, index) => {
      console.log(`   ${index + 1}. ${disc.reward.miner_key}: Device no longer exists`);
    });
  }
  
  if (discrepancies.length > 15) {
    console.log(`\n... and ${discrepancies.length - 15} more discrepancies`);
  }
  
  return summary;
}

async function correctRewardAmounts(discrepancies: RewardDiscrepancy[], summary: CorrectionSummary, dryRun: boolean = false): Promise<void> {
  const testMode = process.env.TEST_MODE === 'true';
  
  if (dryRun) {
    console.log('\n🔍 DRY RUN - Preview of corrections that would be made:');
    console.log(`📝 Would correct ${discrepancies.length} reward amounts`);
    console.log(`💰 Total amount correction: +${summary.estimatedCorrection.toFixed(2)}`);
    console.log('\n✨ No changes made in dry run mode');
    return;
  }
  
  console.log(`\n🚀 Correcting ${discrepancies.length} reward amounts...`);
  console.log(`💰 Total amount correction: +${summary.estimatedCorrection.toFixed(2)}`);
  
  const confirm = await question('\n⚠️  Are you sure you want to proceed with these corrections? (yes/no): ');
  if (confirm.toLowerCase() !== 'yes') {
    console.log('❌ Correction cancelled');
    return;
  }
  
  let corrected = 0;
  let errors = 0;
  const BATCH_SIZE = 100;
  const correctableDiscrepancies = discrepancies.filter(disc => 
    disc.issue !== 'Device not found' && disc.issue !== 'Product not found'
  );
  
  console.log(`\n📊 Processing ${correctableDiscrepancies.length} correctable rewards in batches of ${BATCH_SIZE}...`);
  
  for (let i = 0; i < correctableDiscrepancies.length; i += BATCH_SIZE) {
    const batch = correctableDiscrepancies.slice(i, i + BATCH_SIZE);
    const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(correctableDiscrepancies.length / BATCH_SIZE);
    
    const bulkOps = batch.map(disc => ({
      updateOne: {
        filter: { _id: disc.reward._id },
        update: { $set: { amount: disc.expectedAmount } }
      }
    }));
    
    try {
      const result = await (testMode ? TestRewardModel : RewardModel)
        .bulkWrite(bulkOps);
      
      corrected += result.modifiedCount;
      console.log(`✅ Batch ${batchNumber}/${totalBatches}: Corrected ${result.modifiedCount}/${batch.length} rewards`);
      
      if (result.modifiedCount !== batch.length) {
        errors += (batch.length - result.modifiedCount);
        console.log(`   ⚠️  ${batch.length - result.modifiedCount} rewards in this batch were not updated`);
      }
      
    } catch (error) {
      errors += batch.length;
      console.error(`❌ Batch ${batchNumber}/${totalBatches} failed:`, error);
    }
    
    // Progress indicator
    const progress = ((i + batch.length) / correctableDiscrepancies.length * 100).toFixed(1);
    console.log(`   📈 Progress: ${progress}% (${Math.min(i + batch.length, correctableDiscrepancies.length)}/${correctableDiscrepancies.length})`);
  }
  
  console.log(`\n🎉 Correction completed!`);
  console.log(`✅ Successfully corrected: ${corrected} reward amounts`);
  if (errors > 0) {
    console.log(`❌ Failed to correct: ${errors} reward amounts`);
  }
  console.log(`💰 Total amount added: +${summary.estimatedCorrection.toFixed(2)}`);
}

async function exportDiscrepancies(discrepancies: RewardDiscrepancy[], filename?: string): Promise<void> {
  const fs = require('fs');
  const csvFilename = filename || `reward_discrepancies_${new Date().toISOString().split('T')[0]}.csv`;
  
  const csvHeader = 'miner_key,reward_id,current_amount,expected_amount,issue,created_at,device_verified,device_staked_type\n';
  
  const csvRows = discrepancies.map(disc => {
    return [
      disc.device?.miner_key || 'Unknown',
      disc.reward._id,
      disc.currentAmount,
      disc.expectedAmount,
      disc.issue,
      disc.reward.createdAt,
      disc.device?.verified || false,
      disc.device?.staked?.type || 'none'
    ].join(',');
  }).join('\n');
  
  fs.writeFileSync(csvFilename, csvHeader + csvRows);
  console.log(`Discrepancies exported to ${csvFilename}`);
}

async function parseDate(dateStr: string): Promise<Date | null> {
  // Support DD/MM/YYYY format
  const match = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  
  const [, day, month, year] = match;
  const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
  
  // Validate date
  if (date.getDate() !== parseInt(day) || 
      date.getMonth() !== parseInt(month) - 1 || 
      date.getFullYear() !== parseInt(year)) {
    return null;
  }
  
  return date;
}

function getPredefinedDateRanges(): DateRangeOption[] {
  const today = new Date();
  
  return [
    {
      name: "August 18-27, 2025 (First problematic period)",
      start: new Date(2025, 7, 18), // August 18
      end: new Date(2025, 7, 27),   // August 27
      description: "Original problematic period with incorrect reward calculations"
    },
    {
      name: "September 2 - Today (Second problematic period)",
      start: new Date(2025, 8, 2),  // September 2
      end: today,
      description: "Recent problematic period with incorrect reward calculations"
    },
    {
      name: "All problematic periods (Aug 18-27 + Sep 2-Today)",
      start: new Date(2025, 7, 18), // August 18
      end: today,
      description: "Both known problematic periods combined"
    }
  ];
}

async function getDateRange(): Promise<{ start: Date; end: Date } | undefined> {
  console.log('\n=== DATE RANGE SELECTION ===');
  
  const predefinedRanges = getPredefinedDateRanges();
  
  console.log('Select a date range:');
  predefinedRanges.forEach((range, index) => {
    console.log(`${index + 1}. ${range.name}`);
    console.log(`   ${range.start.toDateString()} to ${range.end.toDateString()}`);
    console.log(`   ${range.description}`);
  });
  console.log(`${predefinedRanges.length + 1}. Single specific date`);
  console.log(`${predefinedRanges.length + 2}. Custom date range`);
  console.log(`${predefinedRanges.length + 3}. Analyze all rewards (no date filter)`);
  
  const choice = await question(`\nChoose option (1-${predefinedRanges.length + 3}): `);
  const choiceNum = parseInt(choice);
  
  if (choiceNum >= 1 && choiceNum <= predefinedRanges.length) {
    const selectedRange = predefinedRanges[choiceNum - 1];
    console.log(`\nSelected: ${selectedRange.name}`);
    console.log(`Date range: ${selectedRange.start.toDateString()} to ${selectedRange.end.toDateString()}`);
    return { start: selectedRange.start, end: selectedRange.end };
  } else if (choiceNum === predefinedRanges.length + 1) {
    // Single specific date
    let targetDate: Date | null = null;
    while (!targetDate) {
      const dateStr = await question('Enter specific date (DD/MM/YYYY): ');
      targetDate = await parseDate(dateStr);
      if (!targetDate) {
        console.log('Invalid date format. Please use DD/MM/YYYY');
      }
    }
    
    // Set to start of day for start, end of day for end
    const startDate = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 0, 0, 0);
    const endDate = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 23, 59, 59);
    
    console.log(`\nSelected single date: ${targetDate.toDateString()}`);
    return { start: startDate, end: endDate };
  } else if (choiceNum === predefinedRanges.length + 2) {
    // Custom date range
    let startDate: Date | null = null;
    while (!startDate) {
      const startDateStr = await question('Enter start date (DD/MM/YYYY): ');
      startDate = await parseDate(startDateStr);
      if (!startDate) {
        console.log('Invalid date format. Please use DD/MM/YYYY');
      }
    }
    
    let endDate: Date | null = null;
    while (!endDate) {
      const endDateStr = await question('Enter end date (DD/MM/YYYY): ');
      endDate = await parseDate(endDateStr);
      if (!endDate) {
        console.log('Invalid date format. Please use DD/MM/YYYY');
      } else if (endDate < startDate) {
        console.log('End date must be after start date');
        endDate = null;
      }
    }
    
    // Set times for full day coverage
    const fullStartDate = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate(), 0, 0, 0);
    const fullEndDate = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate(), 23, 59, 59);
    
    console.log(`\nSelected custom range: ${startDate.toDateString()} to ${endDate.toDateString()}`);
    return { start: fullStartDate, end: fullEndDate };
  } else if (choiceNum === predefinedRanges.length + 3) {
    console.log('\nAnalyzing all rewards (no date filter)');
    return undefined;
  } else {
    console.log('Invalid choice, analyzing all rewards');
    return undefined;
  }
}

async function runRewardAudit(): Promise<void> {
  try {
    await connect();
    
    console.log('\n=== 🔧 ENHANCED REWARD AUDIT & CORRECTION TOOL ===');
    console.log('This tool will identify and correct rewards with incorrect amounts');
    console.log('Specifically targeting periods with known issues from the old system\n');
    
    // Get date range
    const dateRange = await getDateRange();
    
    // Ask about dry run mode
    const dryRunChoice = await question('\n🔍 Run in dry-run mode first? (recommended) (yes/no): ');
    const dryRun = dryRunChoice.toLowerCase() === 'yes';
    
    // Find discrepancies
    const discrepancies = await findRewardDiscrepancies(dateRange, dryRun);
    
    if (discrepancies.length === 0) {
      console.log('\n🎉 Excellent! No discrepancies found. All rewards are correct.');
      return;
    }
    
    // Display summary
    const summary = await displayDiscrepancySummary(discrepancies, dateRange);
    
    if (dryRun) {
      // In dry run mode, show what would be corrected
      await correctRewardAmounts(discrepancies, summary, true);
      
      console.log('\n=== 🔄 DRY RUN COMPLETE ===');
      const proceedChoice = await question('Run again in LIVE mode to make actual corrections? (yes/no): ');
      
      if (proceedChoice.toLowerCase() === 'yes') {
        console.log('\n🚀 Switching to LIVE mode...\n');
        const liveDiscrepancies = await findRewardDiscrepancies(dateRange, false);
        const liveSummary = await displayDiscrepancySummary(liveDiscrepancies, dateRange);
        await correctRewardAmounts(liveDiscrepancies, liveSummary, false);
      } else {
        console.log('✅ Audit complete. No changes made.');
      }
      
      return;
    }
    
    // Live mode - ask what to do
    console.log('\n=== 🎯 CORRECTION OPTIONS ===');
    console.log('1. 🔧 Correct all reward amounts (recommended)');
    console.log('2. 📄 Export discrepancies to CSV only');
    console.log('3. 🔧📄 Correct amounts AND export CSV');
    console.log('4. 🚪 Exit without making changes');
    
    const choice = await question('\nChoose option (1-4): ');
    
    switch (choice) {
      case '1':
        await correctRewardAmounts(discrepancies, summary, false);
        break;
      case '2':
        await exportDiscrepancies(discrepancies);
        break;
      case '3':
        await exportDiscrepancies(discrepancies);
        await correctRewardAmounts(discrepancies, summary, false);
        break;
      case '4':
        console.log('👋 Exiting without changes');
        break;
      default:
        console.log('❌ Invalid choice');
    }
    
  } catch (error) {
    console.error('💥 Reward audit failed:', error);
  } finally {
    rl.close();
    process.exit(0);
  }
}

// Run if called directly
if (require.main === module) {
  runRewardAudit();
}

export { runRewardAudit, findRewardDiscrepancies, correctRewardAmounts };
