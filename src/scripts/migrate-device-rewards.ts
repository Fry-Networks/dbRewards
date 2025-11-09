/**
 * Raw `device-rewards` collection migrator.
 *
 * Copies documents from a source Mongo cluster into a destination cluster using
 * bulk replace/upsert operations.  Intended for cases where the aggregated
 * rewards collection needs to be cloned or synced independently of the rest of
 * the database.
 *
 * Environment:
 *   SOURCE_MONGO_URI   Connection string for the source cluster (required).
 *   DEST_MONGO_URI     Connection string for the destination cluster (required).
 *   SOURCE_DB_NAME     Optional database name (defaults to "main").
 *   DEST_DB_NAME       Optional database name (defaults to "main").
 *
 * Usage examples (npm scripts forward flags after `--`):
 *   npm run migrate-device-rewards                          # live copy of all docs
 *   npm run migrate-device-rewards:dry-run                  # report counts only
 *   npm run migrate-device-rewards:dry-run -- --prefix=BM   # dry run with miner prefix
 *   npm run migrate-device-rewards -- --prefix=EM-          # migrate subset by miner prefix
 *   npm run migrate-device-rewards -- --miner=EM-123,EM-456 # migrate explicit miner keys
 *   npm run migrate-device-rewards -- --batch-size=1000     # tune bulk batch size
 *
 * CLI flags:
 *   --dry-run            Summarise source/destination counts without writing.
 *   --batch-size=NUMBER  Override bulk batch size (default 500).
 *   --miner=LIST         Comma-separated list of miner keys to migrate.
 *   --prefix=VALUE       Restrict to miner keys beginning with VALUE.
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import type { AnyBulkWriteOperation, Collection } from 'mongodb';

type CliOptions = {
  dryRun: boolean;
  batchSize: number;
  minerKeys?: string[];
  prefix?: string;
};

type MigrationStats = {
  sourceCount: number;
  destCountBefore: number;
  processed: number;
  upserted: number;
  modified: number;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseArgs(argv: string[]): CliOptions {
  let dryRun = false;
  let batchSize = 500;
  let minerKeys: string[] | undefined;
  let prefix: string | undefined;

  for (const arg of argv) {
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg.startsWith('--batch-size=')) {
      const size = Number(arg.split('=')[1]);
      if (!Number.isFinite(size) || size <= 0) {
        throw new Error(`Invalid batch size: ${arg}`);
      }
      batchSize = Math.floor(size);
    } else if (arg.startsWith('--miner=')) {
      const list = arg.split('=')[1];
      minerKeys = list
        ?.split(',')
        .map((key) => key.trim())
        .filter(Boolean);
      if (!minerKeys?.length) {
        throw new Error('Expected at least one miner key for --miner');
      }
    } else if (arg.startsWith('--prefix=')) {
      prefix = arg.split('=')[1]?.trim();
      if (!prefix) {
        throw new Error('Expected value for --prefix');
      }
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { dryRun, batchSize, minerKeys, prefix };
}

function buildQuery(options: CliOptions): Record<string, unknown> {
  if (options.minerKeys && options.prefix) {
    throw new Error('Use either --miner or --prefix, not both.');
  }

  if (options.minerKeys) {
    return { miner_key: { $in: options.minerKeys } };
  }
  if (options.prefix) {
    return { miner_key: { $regex: `^${escapeRegExp(options.prefix)}` } };
  }
  return {};
}

async function connect(uri: string, dbName: string): Promise<mongoose.Connection> {
  const conn = mongoose.createConnection(uri, {
    dbName,
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 8000,
    socketTimeoutMS: 60000,
  });
  await conn.asPromise();
  return conn;
}

async function disconnect(conn?: mongoose.Connection): Promise<void> {
  if (!conn) return;
  await conn.close();
}

async function dryRun(
  sourceCollection: Collection,
  destCollection: Collection,
  query: Record<string, unknown>,
): Promise<void> {
  const [sourceCount, destCount] = await Promise.all([
    sourceCollection.countDocuments(query),
    destCollection.countDocuments(query),
  ]);

  console.log('🔍 Dry run summary');
  console.log('------------------');
  console.log(`Source count       : ${sourceCount.toLocaleString()}`);
  console.log(`Destination count  : ${destCount.toLocaleString()}`);
  console.log(
    `Delta              : ${(sourceCount - destCount).toLocaleString()} (source - dest)`,
  );
}

async function executeMigration(
  sourceCollection: Collection,
  destCollection: Collection,
  query: Record<string, unknown>,
  batchSize: number,
): Promise<MigrationStats> {
  const stats: MigrationStats = {
    sourceCount: await sourceCollection.countDocuments(query),
    destCountBefore: await destCollection.countDocuments(query),
    processed: 0,
    upserted: 0,
    modified: 0,
  };

  const cursor = sourceCollection.find(query).sort({ _id: 1 }).batchSize(batchSize);
  const flushSize = Math.max(200, Math.min(2000, batchSize * 2));
  let ops: AnyBulkWriteOperation[] = [];

  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    if (!doc) break;

    ops.push({
      replaceOne: {
        filter: { _id: doc._id },
        replacement: doc,
        upsert: true,
      },
    });

    if (ops.length >= flushSize) {
      const result = await destCollection.bulkWrite(ops, { ordered: false });
      stats.processed += ops.length;
      stats.upserted += result.upsertedCount ?? 0;
      stats.modified += result.modifiedCount ?? 0;
      ops = [];

      const pct = stats.sourceCount
        ? ((stats.processed / stats.sourceCount) * 100).toFixed(1)
        : '—';
      console.log(
        `⏳ Migrated ${stats.processed.toLocaleString()}/${stats.sourceCount.toLocaleString()} (${pct}%)`,
      );
    }
  }

  if (ops.length) {
    const result = await destCollection.bulkWrite(ops, { ordered: false });
    stats.processed += ops.length;
    stats.upserted += result.upsertedCount ?? 0;
    stats.modified += result.modifiedCount ?? 0;
  }

  return stats;
}

function report(stats: MigrationStats): void {
  const destAfter = stats.destCountBefore + stats.upserted;
  console.log('\n✅ Migration completed');
  console.log('-----------------------');
  console.log(`Source documents        : ${stats.sourceCount.toLocaleString()}`);
  console.log(`Destination before run  : ${stats.destCountBefore.toLocaleString()}`);
  console.log(`Operations processed    : ${stats.processed.toLocaleString()}`);
  console.log(`Upserts (new docs)      : ${stats.upserted.toLocaleString()}`);
  console.log(`Replacements modified   : ${stats.modified.toLocaleString()}`);
  console.log(`Destination after run   : ${destAfter.toLocaleString()}`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const query = buildQuery(options);

  const sourceUri = process.env.SOURCE_MONGO_URI?.trim();
  const destUri = process.env.DEST_MONGO_URI?.trim();

  if (!sourceUri) {
    throw new Error('SOURCE_MONGO_URI must be set');
  }
  if (!destUri) {
    throw new Error('DEST_MONGO_URI must be set');
  }

  const sourceDbName = process.env.SOURCE_DB_NAME?.trim() || 'main';
  const destDbName = process.env.DEST_DB_NAME?.trim() || 'main';

  let sourceConn: mongoose.Connection | undefined;
  let destConn: mongoose.Connection | undefined;

  try {
    console.log('🔌 Connecting to source cluster...');
    sourceConn = await connect(sourceUri, sourceDbName);
    console.log('🔌 Connecting to destination cluster...');
    destConn = await connect(destUri, destDbName);

    const sourceCollection = sourceConn.db.collection('device-rewards') as Collection;
    const destCollection = destConn.db.collection('device-rewards') as Collection;

    if (options.dryRun) {
      await dryRun(sourceCollection, destCollection, query);
      return;
    }

    const stats = await executeMigration(
      sourceCollection,
      destCollection,
      query,
      options.batchSize,
    );
    report(stats);
  } finally {
    await Promise.all([disconnect(sourceConn), disconnect(destConn)]);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  });
}

export {};
