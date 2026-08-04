/**
 * FFG MongoDB Config Setup
 * Initializes fry_fee_genesis and fry_fee_genesis_distributions collections
 * Run via: npm run setup-ffg-mongo
 */

import mongoose from 'mongoose';
import { connect } from '../db/connect';
import process from 'process';
import 'dotenv/config';

async function setupFFGConfig() {
  try {
    // Connect to MongoDB using the existing dbRewards connection
    await connect();

    // Get the main database (already set by connect())
    const mainDb = mongoose.connection.db;
    if (!mainDb) {
      throw new Error('MongoDB connection db not initialized');
    }

    // Create or update config doc
    const result = await mainDb.collection('fry_fee_genesis').updateOne(
      { _id: 'config' } as any,
      {
        $set: {
          _id: 'config',
          collection_name: 'Fry Fee Genesis Pass',
          total_supply: 2000,
          contract_app_id: 3635869971,
          app_address: 'NJKHDGBS5DRHQWQUW25OYCQ63MJOGY2OB6MEDTDZKHF5PACN32SFI3YSPI',
          fee_source: 'instant_claim',
          fee_share_bps: 1000,
          fee_sink_addresses: ['U5TA6XANQ7G3XTKTBP5VEUXHSHZO2GWMZN75OU3BIHTQ5D7LDXZA7ATXSI'],
          fee_source_app_ids: [3633170823],
          accumulated: {},
          last_scanned_round: 63052207,
          distribution_frequency: 'monthly',
          active: true,
          created_at: new Date()
        }
      },
      { upsert: true }
    );

    // Create index on distributions collection
    await mainDb.collection('fry_fee_genesis_distributions').createIndex({ distributed_at: -1 });

    // Print confirmation
    const configDoc = await mainDb.collection('fry_fee_genesis').findOne({ _id: 'config' } as any);
    console.log('CONFIG_CREATED');
    console.log(JSON.stringify(configDoc, null, 2));

    await mongoose.connection.close();
    process.exit(0);
  } catch (err) {
    console.error('Setup failed:', err);
    process.exit(1);
  }
}

setupFFGConfig();
