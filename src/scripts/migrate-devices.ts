import mongoose from 'mongoose';
import 'dotenv/config';
import { DeviceModel } from '../db/devices-schema';

interface MigrationConfig {
  sourceUri: string;
  destUri: string;
  batchSize: number;
  dryRun: boolean;
  dateThreshold: Date;
  includeDevices: boolean;
  includeRewards: boolean;
  forceUpdate: boolean;
  rawDevices?: boolean; // if true, bypass Mongoose validation and copy raw docs
}

interface MigrationStats {
  totalFound: number;
  toInsert: number;
  toUpdate: number;
  toSkip: number;
  errors: Array<{ device: any; error: string }>;
  processed: number;
}

class DeviceMigrator {
  private config: MigrationConfig;
  private sourceConnection: mongoose.Connection | null = null;
  private destConnection: mongoose.Connection | null = null;
  private stats: MigrationStats;

  constructor(config: MigrationConfig) {
    this.config = config;
    this.stats = {
      totalFound: 0,
      toInsert: 0,
      toUpdate: 0,
      toSkip: 0,
      errors: [],
      processed: 0
    };
  }

  async connect(): Promise<void> {
    try {
      console.log('🔌 Connecting to source database...');
      const src = mongoose.createConnection(this.config.sourceUri, {
        dbName: 'main',
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
      });
      await src.asPromise();
      this.sourceConnection = src;
      console.log('✅ Source database connected to main database');

      console.log('🔌 Connecting to destination database...');
      const dest = mongoose.createConnection(this.config.destUri, {
        dbName: 'main',
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
      });
      await dest.asPromise();
      this.destConnection = dest;
      console.log('✅ Destination database connected to main database');
    } catch (error) {
      console.error('❌ Database connection failed:', error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.sourceConnection) {
      await this.sourceConnection.close();
      console.log('📤 Source database disconnected');
    }
    if (this.destConnection) {
      await this.destConnection.close();
      console.log('📤 Destination database disconnected');
    }
  }

  async getTargetDevices(): Promise<any[]> {
    if (!this.sourceConnection) {
      throw new Error('Source connection not established');
    }

    const SourceDevice = this.sourceConnection.model('devices', DeviceModel.schema);
    // Fetch ALL devices from source (no prefix filter)
    const devices = await SourceDevice.find({}).lean();

    this.stats.totalFound = devices.length;
    console.log(`📊 Found ${devices.length} devices to migrate (all devices)`);
    
    return devices;
  }

  async analyzeDevice(device: any): Promise<'insert' | 'update' | 'skip'> {
    if (!this.destConnection) {
      throw new Error('Destination connection not established');
    }

    const DestDevice = this.destConnection.model('devices', DeviceModel.schema);
    
    const existingDevice = await DestDevice.findOne({ miner_key: device.miner_key }).lean();
    
    // Debug logging for the first few devices
    if (this.stats.processed < 5) {
      console.log(`🔍 DEBUG: Checking device ${device.miner_key}`);
      console.log(`🔍 DEBUG: Found existing device: ${existingDevice ? 'YES' : 'NO'}`);
      if (existingDevice) {
        console.log(`🔍 DEBUG: Existing device created_at: ${existingDevice.created_at}`);
        console.log(`🔍 DEBUG: Date threshold: ${this.config.dateThreshold}`);
      }
    }
    
    if (!existingDevice) {
      return 'insert';
    }

    // Force update overrides threshold logic
    if (this.config.forceUpdate) {
      return 'update';
    }

    // Update only if existing device meets threshold criterion
    if (existingDevice.created_at && existingDevice.created_at >= this.config.dateThreshold) {
      return 'update';
    }

    return 'skip';
  }

  async processBatch(devices: any[]): Promise<void> {
    if (!this.destConnection) {
      throw new Error('Destination connection not established');
    }

    const DestDevice = this.destConnection.model('devices', DeviceModel.schema);
    
    for (const device of devices) {
      try {
        const action = await this.analyzeDevice(device);
        
        if (!this.config.dryRun) {
          switch (action) {
            case 'insert':
              // Remove _id to let MongoDB generate a new one
              const { _id, ...deviceData } = device;
              await DestDevice.create(deviceData);
              this.stats.toInsert++;
              break;
              
            case 'update':
              // Remove _id and update by miner_key
              const { _id: updateId, ...updateData } = device;
              await DestDevice.updateOne(
                { miner_key: device.miner_key },
                { $set: updateData }
              );
              this.stats.toUpdate++;
              break;
              
            case 'skip':
              this.stats.toSkip++;
              break;
          }
        } else {
          // Dry run with schema validation check (to catch required-field issues ahead of time)
          switch (action) {
            case 'insert':
              {
                const doc = new DestDevice(device);
                const err = doc.validateSync();
                if (err) {
                  this.stats.errors.push({
                    device: { miner_key: device.miner_key, name: device.name },
                    error: err.message
                  });
                } else {
                  this.stats.toInsert++;
                }
              }
              break;
            case 'update':
              {
                const doc = new DestDevice(device);
                const err = doc.validateSync();
                if (err) {
                  this.stats.errors.push({
                    device: { miner_key: device.miner_key, name: device.name },
                    error: err.message
                  });
                } else {
                  this.stats.toUpdate++;
                }
              }
              break;
            case 'skip':
              this.stats.toSkip++;
              break;
          }
        }
        
        this.stats.processed++;
        
      } catch (error) {
        this.stats.errors.push({
          device: { miner_key: device.miner_key, name: device.name },
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  async migrate(): Promise<void> {
    if (this.config.includeDevices) {
      if (this.config.rawDevices) {
        console.log('\n🛠️ Starting RAW devices migration (source → dest)...');
        console.log(`📦 Batch size: ${this.config.batchSize}`);
        console.log(`🔍 Mode: ${this.config.dryRun ? 'DRY RUN' : 'LIVE MIGRATION'}`);
        console.log('─'.repeat(60));

        await migrateDevicesRaw(this.sourceConnection!, this.destConnection!, this.config.batchSize, this.config.dryRun);
      } else {
      console.log('\n🛠️ Starting device migration...');
      console.log(`📅 Date threshold: ${this.config.dateThreshold.toISOString()}${this.config.forceUpdate ? ' (force-update enabled)' : ''}`);
      console.log(`📦 Batch size: ${this.config.batchSize}`);
      console.log(`🔍 Mode: ${this.config.dryRun ? 'DRY RUN' : 'LIVE MIGRATION'}`);
      console.log('─'.repeat(60));

      const devices = await this.getTargetDevices();
      
      if (devices.length === 0) {
        console.log('✅ No devices found to migrate');
      } else {
        const totalBatches = Math.ceil(devices.length / this.config.batchSize);
        
        for (let i = 0; i < devices.length; i += this.config.batchSize) {
          const batch = devices.slice(i, i + this.config.batchSize);
          const batchNumber = Math.floor(i / this.config.batchSize) + 1;
          
          console.log(`\n📦 Processing device batch ${batchNumber}/${totalBatches} (${batch.length} devices)...`);
          
          await this.processBatch(batch);
          
          const progress = ((this.stats.processed / devices.length) * 100).toFixed(1);
          console.log(`⏳ Progress: ${this.stats.processed}/${devices.length} (${progress}%)`);
        }

        this.printSummary();
      }
    }
    }

    if (this.config.includeRewards) {
      console.log('\n🪙 Starting rewards migration (source → dest)...');
      console.log(`📦 Batch size: ${this.config.batchSize}`);
      console.log(`🔍 Mode: ${this.config.dryRun ? 'DRY RUN' : 'LIVE MIGRATION'}`);
      console.log('─'.repeat(60));

      await migrateRewardsRaw(this.sourceConnection!, this.destConnection!, this.config.batchSize, this.config.dryRun);
    }
  }

  printSummary(): void {
    console.log('\n' + '='.repeat(60));
    console.log('📊 MIGRATION SUMMARY');
    console.log('='.repeat(60));
    console.log(`📥 Total devices found: ${this.stats.totalFound}`);
    console.log(`➕ Devices to insert: ${this.stats.toInsert}`);
    console.log(`🔄 Devices to update: ${this.stats.toUpdate}`);
    console.log(`⏭️  Devices to skip: ${this.stats.toSkip}`);
    console.log(`❌ Errors: ${this.stats.errors.length}`);
    console.log(`✅ Successfully processed: ${this.stats.processed - this.stats.errors.length}`);
    
    if (this.stats.errors.length > 0) {
      console.log('\n❌ ERRORS:');
      this.stats.errors.forEach((error, index) => {
        console.log(`${index + 1}. Device: ${error.device.miner_key} (${error.device.name})`);
        console.log(`   Error: ${error.error}`);
      });
    }
    
    if (this.config.dryRun) {
      console.log('\n🔍 This was a DRY RUN - no changes were made to the destination database');
      console.log('💡 Run without --dry-run flag to perform the actual migration');
    } else {
      console.log('\n✅ Migration completed successfully!');
    }
  }
}

/**
 * Raw rewards migration using native collections to preserve full documents.
 * Performs upsert-by-_id replacement to avoid duplicates and keep freshest data.
 */
async function migrateRewardsRaw(
  sourceConn: mongoose.Connection,
  destConn: mongoose.Connection,
  batchSize: number,
  dryRun: boolean
): Promise<void> {
  const sourceCol = sourceConn.db.collection('rewards');
  const destCol = destConn.db.collection('rewards');

  const total = await sourceCol.estimatedDocumentCount();
  console.log(`📊 Source rewards count: ${total.toLocaleString()}`);

  if (dryRun) {
    console.log('🔍 Dry run: would upsert all source rewards into destination');
    return;
  }

  const cursor = sourceCol.find({}).sort({ _id: 1 }).batchSize(batchSize);
  let processed = 0;
  let ops: any[] = [];
  const bulkSize = Math.max(200, Math.min(2000, batchSize * 4));

  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    if (!doc) break;
    ops.push({
      replaceOne: {
        filter: { _id: doc._id },
        replacement: doc,
        upsert: true
      }
    });
    if (ops.length >= bulkSize) {
      await destCol.bulkWrite(ops, { ordered: false });
      processed += ops.length;
      ops = [];
      const pct = ((processed / total) * 100).toFixed(1);
      console.log(`⏳ Rewards progress: ${processed.toLocaleString()}/${total.toLocaleString()} (${pct}%)`);
    }
  }

  if (ops.length) {
    await destCol.bulkWrite(ops, { ordered: false });
    processed += ops.length;
  }

  console.log(`✅ Rewards migration completed: ${processed.toLocaleString()} operations`);
}

/**
 * Raw devices migration using native collections (bypasses Mongoose validation).
 * Performs upsert-by-_id replacement to keep the source document exactly.
 */
async function migrateDevicesRaw(
  sourceConn: mongoose.Connection,
  destConn: mongoose.Connection,
  batchSize: number,
  dryRun: boolean
): Promise<void> {
  // Ensure connections are ready
  if (!sourceConn.db) {
    await sourceConn.asPromise();
  }
  if (!destConn.db) {
    await destConn.asPromise();
  }
  const sourceCol = sourceConn.db.collection('devices');
  const destCol = destConn.db.collection('devices');

  const total = await sourceCol.estimatedDocumentCount();
  console.log(`📊 Source devices count: ${total.toLocaleString()}`);

  if (dryRun) {
    console.log('🔍 Dry run: would upsert all source devices into destination');
    return;
  }

  const cursor = sourceCol.find({}).sort({ _id: 1 }).batchSize(batchSize);
  let processed = 0;
  let ops: any[] = [];
  const bulkSize = Math.max(200, Math.min(2000, batchSize * 4));

  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    if (!doc) break;
    ops.push({
      replaceOne: {
        filter: { _id: doc._id },
        replacement: doc,
        upsert: true
      }
    });
    if (ops.length >= bulkSize) {
      await destCol.bulkWrite(ops, { ordered: false });
      processed += ops.length;
      ops = [];
      const pct = ((processed / total) * 100).toFixed(1);
      console.log(`⏳ Devices progress: ${processed.toLocaleString()}/${total.toLocaleString()} (${pct}%)`);
    }
  }

  if (ops.length) {
    await destCol.bulkWrite(ops, { ordered: false });
    processed += ops.length;
  }

  console.log(`✅ Devices migration completed: ${processed.toLocaleString()} operations`);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const includeArg = args.find(a => a.startsWith('--include='));
  const onlyArg = args.find(a => a.startsWith('--only='));
  const includeDevices = onlyArg ? onlyArg.includes('devices') : includeArg ? includeArg.includes('devices') : true;
  const includeRewards = onlyArg ? onlyArg.includes('rewards') : includeArg ? includeArg.includes('rewards') : true;
  const forceUpdate = args.includes('--force-update');
  const rawDevices = args.includes('--raw-devices') || args.includes('--raw');
  const thresholdArg = args.find(a => a.startsWith('--threshold=') || a.startsWith('--since='));
  const thresholdStr = thresholdArg ? (thresholdArg.split('=')[1] || '').trim() : '';
  
  // Validate environment variables
  const sourceUri = process.env.SOURCE_MONGO_URI;
  const destUri = process.env.DEST_MONGO_URI;
  
  if (!sourceUri) {
    console.error('❌ SOURCE_MONGO_URI environment variable is required');
    process.exit(1);
  }
  
  if (!destUri) {
    console.error('❌ DEST_MONGO_URI environment variable is required');
    process.exit(1);
  }

  // Date threshold: default July 1st, 2025; override via --threshold=YYYY-MM-DD or ISO
  const dateThreshold = thresholdStr ? new Date(thresholdStr) : new Date('2025-07-01T00:00:00.000Z');
  
  const config: MigrationConfig = {
    sourceUri,
    destUri,
    batchSize: 250,
    dryRun,
    dateThreshold,
    includeDevices,
    includeRewards,
    forceUpdate,
    rawDevices
  };

  const migrator = new DeviceMigrator(config);
  
  try {
    await migrator.connect();
    await migrator.migrate();
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  } finally {
    await migrator.disconnect();
  }
}

// Run if called directly
if (require.main === module) {
  main().catch(console.error);
}

export { DeviceMigrator, MigrationConfig };
