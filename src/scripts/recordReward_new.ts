// NEW: Device-centric reward recording - aggregates rewards per device with multi-token support
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
  const entryStatus: 'accruing' | 'pending' = WEEKLY_REWARDS_ENABLED ? 'accruing' : 'pending';

  // Get all reward tokens for this product (handles both new rewards[] and legacy scalar)
  const rewardTokens = getRewardAssetsForMode(product, undefined);
  
  if (rewardTokens.length === 0) {
    DEBUG && console.log(`No reward tokens configured for product ${product.key}`);
    return false;
  }

  DEBUG &&
    console.log(
      `Recording device reward ${availableAmount} for miner ${device.miner_key} (${entryStatus}) [sim=${currentDate.toISOString()}] tokens=${rewardTokens.length}`
    );

  try {
    // First, get current reward count for this device to calculate reward_number
    const existingDevice: DeviceReward | null = await (testMode ? TestDeviceRewardModel : DeviceRewardModel)
      .findOne({ miner_key: device.miner_key });

    const nextRewardNumber = (existingDevice?.reward_count || 0) + 1;

    // Loop over each reward token and create daily entry
    const dailyRewardEntries = [];
    const incFields: Record<string, number> = { reward_count: 1 };
    let tokenIndex = 0;

    for (const token of rewardTokens) {
      const assetId = token.asa_id;
      
      // Check for duplicate daily rows for the same date/asset
      if (existingDevice) {
        const duplicateEntry = existingDevice.daily_rewards?.find(r => r.date === dateString && r.asset_id === assetId);
        if (duplicateEntry) {
          DEBUG && console.log(`Skip duplicate daily entry for ${device.miner_key} on ${dateString} (asset ${assetId}, status ${duplicateEntry.status})`);
          continue; // Skip this token, move to next
        }
      }

      // Calculate amount for this token (if multiple tokens, distribute proportionally or use fixed)
      // For now, use the token's configured amount; caller can adjust if needed
      const tokenAmount = token.amount !== undefined ? token.amount : availableAmount;
      
      // Build daily reward entry
      dailyRewardEntries.push({
        date: dateString,
        amount: tokenAmount,
        status: entryStatus,
        asset_id: assetId,
        created_at: currentDate,
        reward_number: nextRewardNumber + tokenIndex
      });

      // Update accumulators based on asset type
      if (!WEEKLY_REWARDS_ENABLED) {
        if (isTfryAsset(assetId)) {
          applyTfryDelta(incFields, { pending: tokenAmount });
        } else {
          // For non-tFRY tokens, increment generic total_pending
          incFields.total_pending = (incFields.total_pending || 0) + tokenAmount;
          // Also increment token_totals accumulator
          incFields[`token_totals.${assetId}.pending`] = (incFields[`token_totals.${assetId}.pending`] || 0) + tokenAmount;
        }
      }

      tokenIndex++;
    }

    if (dailyRewardEntries.length === 0) {
      DEBUG && console.log(`All tokens skipped for ${device.miner_key} on ${dateString} (duplicates)`);
      return true;
    }

    // Use findOneAndUpdate with upsert to create or update device reward document
    const result = await (testMode ? TestDeviceRewardModel : DeviceRewardModel)
      .findOneAndUpdate(
        { miner_key: device.miner_key },
        {
          $inc: incFields,
          $push: {
            daily_rewards: { $each: dailyRewardEntries }
          },
          $set: {
            last_updated: currentDate,
            last_reward_date: currentDate
          },
          $setOnInsert: {
            first_reward_date: currentDate,
            total_claimable: 0,
            total_claimed: 0,
            token_totals: {}
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

    DEBUG && console.log(`Successfully recorded device reward #${nextRewardNumber} for ${device.miner_key} (${dailyRewardEntries.length} tokens)`);
    return true;
    
  } catch (error) {
    DEBUG && console.error(`Failed to record device reward for ${device.miner_key}:`, error);
    return false;
  }
};
