/**
 * FFG Fee Scanner
 * Scans for instant-claim fee inflows to sink addresses and accumulates
 * the Fry Fee Genesis share by asset ID in MongoDB. Idempotent.
 *
 * Only counts asset transfers RECEIVED by a configured sink address whose
 * SENDER is one of the reward-pool app escrow addresses — anything else
 * (dust, unrelated transfers) is not instant-claim fee.
 *
 * Token-version agnostic: asset IDs come solely from observed chain data.
 *
 * Usage: npm run ffg:scan
 * Environment:
 *   FFG_INDEXER_URL — Algorand indexer (default: https://mainnet-idx.4160.nodely.dev)
 *   FFG_ALGOD_URL   — Algorand algod   (default: https://mainnet-api.4160.nodely.dev)
 */

import axios from 'axios';
import mongoose from 'mongoose';
import algosdk from 'algosdk';
import { connect } from '../db/connect';
import process from 'process';
import 'dotenv/config';

async function scanFeeInflows(): Promise<void> {
  const indexerUrl = process.env.FFG_INDEXER_URL || 'https://mainnet-idx.4160.nodely.dev';
  const algodUrl = process.env.FFG_ALGOD_URL || 'https://mainnet-api.4160.nodely.dev';

  try {
    await connect();
    const mainDb = mongoose.connection.db;
    if (!mainDb) throw new Error('MongoDB connection db not initialized');

    const configColl = mainDb.collection('fry_fee_genesis');
    const config = (await configColl.findOne({ _id: 'config' } as any)) as any;
    if (!config) {
      console.error('ERROR: FFG config not found in fry_fee_genesis');
      process.exit(1);
    }
    if (config.active === false) {
      console.log('config.active=false — skipping scan');
      process.exit(0);
    }

    const statusRes = await axios.get(`${algodUrl}/v2/status`);
    const currentRound = statusRes.data['last-round'];
    const scannedFrom = (config.last_scanned_round || 0) + 1;
    const scannedTo = currentRound;
    if (scannedFrom > scannedTo) {
      console.log('Nothing to scan');
      process.exit(0);
    }
    console.log(`Scanning rounds ${scannedFrom}-${scannedTo} for fee inflows...`);

    const escrows = new Set<string>(
      (config.fee_source_app_ids || []).map((id: number) =>
        algosdk.getApplicationAddress(id).toString()
      )
    );

    const inflowsByAsset: Record<string, number> = {};
    let seen = 0;
    let matched = 0;

    for (const sinkAddr of config.fee_sink_addresses || []) {
      console.log(`  Checking sink address: ${sinkAddr}`);
      let nextToken = '';
      do {
        const params: any = {
          address: sinkAddr,
          'address-role': 'receiver',
          'tx-type': 'axfer',
          'min-round': scannedFrom,
          'max-round': scannedTo,
          limit: 1000,
        };
        if (nextToken) params.next = nextToken;

        const res = await axios.get(`${indexerUrl}/v2/transactions`, { params });
        for (const txn of res.data.transactions || []) {
          seen++;
          const ax = txn['asset-transfer-transaction'];
          if (!ax) continue;
          // address-role=receiver also matches close-to; require exact receiver
          if (ax.receiver !== sinkAddr) continue;
          // only fee flows originating from the reward-pool app escrows
          if (!escrows.has(txn.sender)) continue;
          const asaId = String(ax['asset-id']);
          inflowsByAsset[asaId] = (inflowsByAsset[asaId] || 0) + Number(ax.amount);
          matched++;
        }
        nextToken = res.data['next-token'] || '';
      } while (nextToken);
    }

    const accumulated: Record<string, number> = config.accumulated || {};
    const shareAddedByAsset: Record<string, number> = {};
    for (const [asaId, total] of Object.entries(inflowsByAsset)) {
      const share = Math.floor(((total as number) * config.fee_share_bps) / 10000);
      if (share <= 0) continue;
      shareAddedByAsset[asaId] = share;
      accumulated[asaId] = (accumulated[asaId] || 0) + share;
    }

    await configColl.updateOne(
      { _id: 'config' } as any,
      { $set: { accumulated, last_scanned_round: scannedTo, last_scan: new Date() } }
    );

    console.log('SCAN_COMPLETE');
    console.log(
      JSON.stringify(
        {
          scanned_from: scannedFrom,
          scanned_to: scannedTo,
          txns_seen: seen,
          txns_matched: matched,
          inflows_by_asset: inflowsByAsset,
          share_added_by_asset: shareAddedByAsset,
        },
        null,
        2
      )
    );

    await mongoose.connection.close();
    process.exit(0);
  } catch (err) {
    console.error('Scanner failed:', err);
    process.exit(1);
  }
}

scanFeeInflows();
