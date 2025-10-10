// Copies MongoDB collections between clusters with dry-run/execute/validate modes.
// Usage examples:
//   npm run migrate-all:dry -- --collections all
//   npm run migrate-all:execute -- --collections users,devices
//   npm run migrate-all:validate
import 'dotenv/config';
import { createHash } from 'node:crypto';
import type { Collection, Db, Document as MongoDocument, ObjectId, Filter } from 'mongodb';
import mongoose, { Connection } from 'mongoose';

type Mode = 'dry-run' | 'execute' | 'validate';

type DatabaseGroup = 'main' | 'creds';

type CollectionKey =
  | 'registration-users'
  | 'byod'
  | 'fry-conversion'
  | 'users'
  | 'devices'
  | 'hardware'
  // | 'device-rewards'; // disabled: managed by dedicated tooling

interface CollectionConfig {
  key: CollectionKey;
  label: string;
  db: DatabaseGroup;
  collection: string;
}

const COLLECTIONS: Record<CollectionKey, CollectionConfig> = {
  'registration-users': {
    key: 'registration-users',
    label: 'Registration Users',
    db: 'main',
    collection: 'registration-users',
  },
  byod: {
    key: 'byod',
    label: 'BYOD',
    db: 'main',
    collection: 'byod',
  },
  'fry-conversion': {
    key: 'fry-conversion',
    label: 'Fry Conversion',
    db: 'main',
    collection: 'fry-conversion',
  },
  users: {
    key: 'users',
    label: 'Users',
    db: 'main',
    collection: 'users',
  },
  devices: {
    key: 'devices',
    label: 'Devices',
    db: 'main',
    collection: 'devices',
  },
  // 'device-rewards': {
  //   key: 'device-rewards',
  //   label: 'Device Rewards',
  //   db: 'main',
  //   collection: 'device-rewards',
  // },
  hardware: {
    key: 'hardware',
    label: 'Hardware Credentials',
    db: 'creds',
    collection: 'hardware',
  },
};

const DEFAULT_COLLECTION_ORDER: CollectionKey[] = [
  'registration-users',
  'byod',
  'fry-conversion',
  'users',
  'devices',
  'hardware',
  // 'device-rewards',
];

interface ParsedArgs {
  mode: Mode;
  selectedCollections: CollectionConfig[];
}

interface EnvConfig {
  sourceUri: string;
  destUri: string;
  sourceDbMain: string;
  destDbMain: string;
  sourceDbCreds: string;
  destDbCreds: string;
}

interface IdSummary {
  ids: Set<string>;
  idMap?: Map<string, unknown>;
}

interface DryRunStats {
  sourceCount: number;
  destCount: number;
  toInsert: number;
  toReplace: number;
  destOnly: number;
}

interface ExecuteStats {
  sourceCount: number;
  destBeforeCount: number;
  inserted: number;
  upsertedExisting: number;
  modified: number;
}

interface ValidateStats {
  sourceCount: number;
  destCount: number;
  missingCount: number;
  extraCount: number;
  missingSamples: unknown[];
  extraSamples: unknown[];
  differingSamples: Array<{ id: unknown; sourceHash: string; destHash: string }>;
}

interface ResolvedConnections {
  source: Connection;
  dest: Connection;
  dbs: {
    source: Record<DatabaseGroup, Db>;
    dest: Record<DatabaseGroup, Db>;
  };
}

const BULK_BATCH_SIZE = 250;
const VALIDATE_SAMPLE_LIMIT = 5;

async function main(): Promise<void> {
  const env = parseEnv();
  const { mode, selectedCollections } = parseArgs(process.argv.slice(2));

  const connections = await connectAll(env);

  const closeAll = async () => {
    await Promise.allSettled([
      connections.source.close(true),
      connections.dest.close(true),
    ]);
  };

  process.on('SIGINT', async () => {
    console.log('\nReceived interrupt signal. Closing connections...');
    await closeAll();
    process.exit(1);
  });

  try {
    console.log(`Mode: ${mode}`);
    console.log(
      `Collections: ${selectedCollections
        .map((c) => `${c.key} (${c.db}.${c.collection})`)
        .join(', ') || 'none'}`,
    );

    for (const config of selectedCollections) {
      console.log(`\n=== ${config.label} [${config.db}.${config.collection}] ===`);
      const sourceCollection = connections.dbs.source[config.db].collection(config.collection);
      const destCollection = connections.dbs.dest[config.db].collection(config.collection);

      if (!sourceCollection || !destCollection) {
        console.warn('Skipping: collection not accessible on source or destination.');
        continue;
      }

      if (mode === 'dry-run') {
        const stats = await dryRunCollection(sourceCollection, destCollection);
        reportDryRun(stats);
      } else if (mode === 'execute') {
        const stats = await executeCollection(sourceCollection, destCollection);
        reportExecute(stats);
      } else {
        const stats = await validateCollection(sourceCollection, destCollection);
        reportValidate(stats);
      }
    }
  } finally {
    await closeAll();
  }
}

function parseEnv(): EnvConfig {
  const sourceUri = process.env.SRC_MONGO_URI?.trim();
  const destUri = process.env.DST_MONGO_URI?.trim();

  if (!sourceUri) {
    throw new Error('SRC_MONGO_URI must be set');
  }
  if (!destUri) {
    throw new Error('DST_MONGO_URI must be set');
  }

  return {
    sourceUri,
    destUri,
    sourceDbMain: process.env.SRC_DB_MAIN?.trim() || 'main',
    destDbMain: process.env.DST_DB_MAIN?.trim() || 'main',
    sourceDbCreds: process.env.SRC_DB_CREDS?.trim() || 'creds',
    destDbCreds: process.env.DST_DB_CREDS?.trim() || 'creds',
  };
}

function parseArgs(argv: string[]): ParsedArgs {
  let mode: Mode = 'dry-run';
  let collectionArg: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--execute') {
      if (mode === 'validate') {
        throw new Error('Cannot use --execute and --validate together');
      }
      mode = 'execute';
    } else if (arg === '--validate') {
      if (mode === 'execute') {
        throw new Error('Cannot use --execute and --validate together');
      }
      mode = 'validate';
    } else if (arg === '--dry-run') {
      mode = 'dry-run';
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else if (arg.startsWith('--collections')) {
      const [flag, value] = arg.split('=');
      if (value) {
        collectionArg = value;
      } else {
        const next = argv[i + 1];
        if (!next) {
          throw new Error('Missing value for --collections');
        }
        collectionArg = next;
        i += 1;
      }
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const selectedCollections = resolveCollections(collectionArg);

  return { mode, selectedCollections };
}

function printUsage(): void {
  console.log(`Usage: npx ts-node src/scripts/migrate-all.ts [options]\n\n` +
    'Options:\n' +
    '  --execute                Perform writes to destination database\n' +
    '  --validate               Compare source and destination collections (no writes)\n' +
    '  --dry-run                Preview operations (default)\n' +
    '  --collections <list>     Comma-separated collection keys or "all"\n' +
    '  --help, -h               Show this help message\n\n' +
    'Collection keys:\n' +
    `  ${Object.keys(COLLECTIONS).join(', ')}\n`);
}

function resolveCollections(collectionArg?: string): CollectionConfig[] {
  if (!collectionArg || collectionArg === 'all') {
    return DEFAULT_COLLECTION_ORDER.map((key) => COLLECTIONS[key]);
  }

  const rawKeys = collectionArg.split(',').map((value) => value.trim()).filter(Boolean);
  if (rawKeys.length === 0) {
    throw new Error('Collections list cannot be empty');
  }

  const deduped = Array.from(new Set(rawKeys)) as string[];
  const configs: CollectionConfig[] = deduped.map((key) => {
    if (!isCollectionKey(key)) {
      throw new Error(`Unknown collection key: ${key}`);
    }
    return COLLECTIONS[key];
  });

  return configs;
}

function isCollectionKey(value: string): value is CollectionKey {
  return value in COLLECTIONS;
}

async function connectAll(env: EnvConfig): Promise<ResolvedConnections> {
  const source = await createConnection(env.sourceUri, 'source');
  const dest = await createConnection(env.destUri, 'destination');

  const dbs = {
    source: {
      main: source.useDb(env.sourceDbMain, { useCache: true }).db,
      creds: source.useDb(env.sourceDbCreds, { useCache: true }).db,
    },
    dest: {
      main: dest.useDb(env.destDbMain, { useCache: true }).db,
      creds: dest.useDb(env.destDbCreds, { useCache: true }).db,
    },
  } as ResolvedConnections['dbs'];

  return { source, dest, dbs };
}

async function createConnection(uri: string, label: string): Promise<Connection> {
  console.log(`Connecting to ${label} cluster...`);
  const connection = mongoose.createConnection(uri, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 8000,
    socketTimeoutMS: 60000,
    retryReads: true,
    retryWrites: true,
  });

  connection.on('error', (err) => {
    console.error(`${label} connection error:`, err);
  });

  await connection.asPromise();
  console.log(`Connected to ${label} cluster.`);
  return connection;
}

async function dryRunCollection(
  source: Collection<MongoDocument>,
  dest: Collection<MongoDocument>,
): Promise<DryRunStats> {
  const destSummary = await fetchIdSummary(dest, false);

  let toInsert = 0;
  let matched = 0;
  let sourceCount = 0;

  const cursor = source.find({}, { projection: { _id: 1 } });
  for await (const doc of cursor) {
    sourceCount += 1;
    const key = makeIdKey(doc._id);
    if (destSummary.ids.has(key)) {
      matched += 1;
    } else {
      toInsert += 1;
    }
  }

  const destCount = destSummary.ids.size;
  const destOnly = Math.max(destCount - matched, 0);

  return {
    sourceCount,
    destCount,
    toInsert,
    toReplace: matched,
    destOnly,
  };
}

async function executeCollection(
  source: Collection<MongoDocument>,
  dest: Collection<MongoDocument>,
): Promise<ExecuteStats> {
  const destSummary = await fetchIdSummary(dest, false);
  const destBeforeCount = destSummary.ids.size;

  let inserted = 0;
  let upsertedExisting = 0;
  let modified = 0;
  let sourceCount = 0;

  const bulkOps: Parameters<typeof dest.bulkWrite>[0] = [];

  const cursor = source.find({});
  for await (const doc of cursor) {
    sourceCount += 1;
    const key = makeIdKey(doc._id);
    if (destSummary.ids.has(key)) {
      upsertedExisting += 1;
    } else {
      inserted += 1;
    }

    bulkOps.push({
      replaceOne: {
        filter: { _id: doc._id },
        replacement: doc,
        upsert: true,
      },
    });

    if (bulkOps.length >= BULK_BATCH_SIZE) {
      modified += await flushBulk(dest, bulkOps);
    }
  }

  if (bulkOps.length > 0) {
    modified += await flushBulk(dest, bulkOps);
  }

  return {
    sourceCount,
    destBeforeCount,
    inserted,
    upsertedExisting,
    modified,
  };
}

async function validateCollection(
  source: Collection<MongoDocument>,
  dest: Collection<MongoDocument>,
): Promise<ValidateStats> {
  const [sourceSummary, destSummary] = await Promise.all([
    fetchIdSummary(source, true),
    fetchIdSummary(dest, true),
  ]);

  let missingCount = 0;
  const missingSamples: unknown[] = [];
  for (const key of sourceSummary.ids) {
    if (!destSummary.ids.has(key)) {
      missingCount += 1;
      if (missingSamples.length < VALIDATE_SAMPLE_LIMIT) {
        missingSamples.push(sourceSummary.idMap?.get(key));
      }
    }
  }

  let extraCount = 0;
  const extraSamples: unknown[] = [];
  for (const key of destSummary.ids) {
    if (!sourceSummary.ids.has(key)) {
      extraCount += 1;
      if (extraSamples.length < VALIDATE_SAMPLE_LIMIT) {
        extraSamples.push(destSummary.idMap?.get(key));
      }
    }
  }

  const differingSamples: Array<{ id: unknown; sourceHash: string; destHash: string }> = [];
  if (missingCount === 0 && extraCount === 0) {
    let inspected = 0;
    for (const key of sourceSummary.ids) {
      if (inspected >= VALIDATE_SAMPLE_LIMIT) {
        break;
      }
      const sourceId = sourceSummary.idMap?.get(key);
      const destId = destSummary.idMap?.get(key);
      if (sourceId === undefined || destId === undefined) {
        continue;
      }

      const sourceFilter = buildIdFilter(sourceId);
      const destFilter = buildIdFilter(destId);
      if (!sourceFilter || !destFilter) {
        continue;
      }

      const [sourceDoc, destDoc] = await Promise.all([
        source.findOne(sourceFilter),
        dest.findOne(destFilter),
      ]);

      if (!sourceDoc || !destDoc) {
        continue;
      }

      const sourceHash = hashDoc(sourceDoc);
      const destHash = hashDoc(destDoc);

      if (sourceHash !== destHash) {
        differingSamples.push({ id: sourceId, sourceHash, destHash });
      }

      inspected += 1;
      if (differingSamples.length >= VALIDATE_SAMPLE_LIMIT) {
        break;
      }
    }
  }

  return {
    sourceCount: sourceSummary.ids.size,
    destCount: destSummary.ids.size,
    missingCount,
    extraCount,
    missingSamples,
    extraSamples,
    differingSamples,
  };
}

async function fetchIdSummary(collection: Collection<MongoDocument>, includeValues: boolean): Promise<IdSummary> {
  const ids = new Set<string>();
  const idMap = includeValues ? new Map<string, unknown>() : undefined;

  const cursor = collection.find({}, { projection: { _id: 1 } });
  for await (const doc of cursor) {
    const key = makeIdKey(doc._id);
    ids.add(key);
    if (idMap && !idMap.has(key)) {
      idMap.set(key, doc._id);
    }
  }

  return { ids, idMap };
}

async function flushBulk(
  dest: Collection<MongoDocument>,
  ops: Parameters<typeof dest.bulkWrite>[0],
): Promise<number> {
  const batch = ops.splice(0, ops.length);
  if (batch.length === 0) {
    return 0;
  }

  const result = await dest.bulkWrite(batch, { ordered: false });
  return result.modifiedCount ?? 0;
}

function makeIdKey(id: unknown): string {
  if (id instanceof mongoose.Types.ObjectId) {
    return `oid:${id.toHexString()}`;
  }

  if (isObjectId(id)) {
    return `oid:${(id as ObjectId).toHexString()}`;
  }

  if (typeof id === 'string') {
    return `str:${id}`;
  }

  if (typeof id === 'number') {
    return `num:${id}`;
  }

  if (id instanceof Date) {
    return `date:${id.toISOString()}`;
  }

  if (ArrayBuffer.isView(id)) {
    const view = id as ArrayBufferView;
    const buffer = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
    return `bin:${buffer.toString('base64')}`;
  }

  if (id && typeof id === 'object') {
    const bsonType = (id as { _bsontype?: string })._bsontype;
    const serialized = serializeUnknown(id);
    return `${bsonType ?? 'obj'}:${serialized}`;
  }

  return `other:${String(id)}`;
}

function isObjectId(value: unknown): value is ObjectId {
  return Boolean(value) && typeof value === 'object' && (value as { _bsontype?: string })._bsontype === 'ObjectId';
}

function serializeUnknown(value: unknown): string {
  if (!value || typeof value !== 'object') {
    return String(value);
  }

  if (typeof (value as { toHexString?: () => string }).toHexString === 'function') {
    return (value as { toHexString: () => string }).toHexString();
  }

  if (typeof (value as { toString?: () => string }).toString === 'function') {
    return (value as { toString: () => string }).toString();
  }

  try {
    return JSON.stringify(value);
  } catch (error) {
    return '[Unserializable Object]';
  }
}

function canonicalize(value: unknown): unknown {
  if (value === null) {
    return null;
  }

  if (value instanceof Date) {
    return { $date: value.toISOString() };
  }

  if (value instanceof mongoose.Types.ObjectId || isObjectId(value)) {
    const hex = (value as ObjectId).toHexString?.() || (value as mongoose.Types.ObjectId).toHexString();
    return { $oid: hex };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }

  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    const buffer = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
    return { $binary: buffer.toString('base64') };
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort((a, b) => a[0].localeCompare(b[0]));
    const normalized: Record<string, unknown> = {};
    for (const [key, entryValue] of entries) {
      normalized[key] = canonicalize(entryValue);
    }
    return normalized;
  }

  return value;
}

function hashDoc(doc: MongoDocument): string {
  const normalized = canonicalize(doc);
  const json = JSON.stringify(normalized);
  return createHash('sha256').update(json).digest('hex');
}

function reportDryRun(stats: DryRunStats): void {
  console.log(`Source documents : ${stats.sourceCount}`);
  console.log(`Destination docs : ${stats.destCount}`);
  console.log(`Would insert     : ${stats.toInsert}`);
  console.log(`Would upsert     : ${stats.toReplace}`);
  console.log(`Dest only (keep) : ${stats.destOnly}`);
}

function reportExecute(stats: ExecuteStats): void {
  console.log(`Source documents     : ${stats.sourceCount}`);
  console.log(`Destination before   : ${stats.destBeforeCount}`);
  console.log(`Inserted new docs    : ${stats.inserted}`);
  console.log(`Upserted existing    : ${stats.upsertedExisting}`);
  console.log(`Modified (reported)  : ${stats.modified}`);
  console.log(`Destination estimated: ${stats.destBeforeCount + stats.inserted}`);
}

function reportValidate(stats: ValidateStats): void {
  console.log(`Source documents  : ${stats.sourceCount}`);
  console.log(`Destination docs  : ${stats.destCount}`);
  console.log(`Missing in dest   : ${stats.missingCount}`);
  console.log(`Extra in dest     : ${stats.extraCount}`);

  if (stats.missingSamples.length > 0) {
    console.log('Sample missing IDs:', stats.missingSamples);
  }

  if (stats.extraSamples.length > 0) {
    console.log('Sample extra IDs  :', stats.extraSamples);
  }

  if (stats.differingSamples.length > 0) {
    console.log('Differing samples :');
    for (const sample of stats.differingSamples) {
      console.log(`  _id=${serializeUnknown(sample.id)} source=${sample.sourceHash} dest=${sample.destHash}`);
    }
  }
}

function buildIdFilter(id: unknown): Filter<MongoDocument> | null {
  if (id === null || id === undefined) {
    return null;
  }

  return { _id: id as any };
}

main().catch((error) => {
  console.error('Migration script failed:', error);
  process.exitCode = 1;
});
