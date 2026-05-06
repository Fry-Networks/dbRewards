import http from 'http';
import crypto from 'crypto';
import { connect } from '../db/connect';
import { DeviceModel } from '../db/devices-schema';

// -- Eligible physical product wix_ids → virtual miner key prefixes --
const ELIGIBLE_PRODUCTS: Record<string, string> = {
  'b412a7f0-1f8b-4bc2-de21-2e1c37e02798': 'VRDN',  // RDN
  '2194eaeb-5e38-d78e-5b63-838be49946f1': 'VSDN',  // SDN
  'cadeb3b0-cf5b-ba2e-5dd5-632570a91a9e': 'VSVN',  // SVN
};

const PRODUCT_NAMES: Record<string, string> = {
  'VRDN': '$FRY Virtual Reward Decentralization Node',
  'VSDN': '$FRY Virtual Storage Decentralization Node',
  'VSVN': '$FRY Virtual Storage Validator Node',
};

const SYNC_INTERVAL_MS = parseInt(process.env.SYNC_INTERVAL_MS || '900000', 10);
const HEALTH_PORT = parseInt(process.env.HEALTH_PORT || '8085', 10);
const WIX_API_KEY = process.env.WIX_API_KEY!;
const WIX_SITE_ID = process.env.WIX_SITE_ID!;

// -- Health state --
let lastSync: string | null = null;
let nextSync: string | null = null;
let lastResult = { created: 0, skipped: 0, errors: 0 };
let authFormat: 'raw' | 'bearer' | null = null;

function log(msg: string): void {
  console.log(`[wix-sync] ${msg}`);
}

function generateMinerKey(prefix: string): string {
  return `${prefix}-${crypto.randomBytes(16).toString('hex').toUpperCase().slice(0, 32)}`;
}

async function wixFetch(body: object): Promise<any> {
  const url = 'https://www.wixapis.com/ecom/v1/orders/search';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'wix-site-id': WIX_SITE_ID,
  };

  const formats: Array<'raw' | 'bearer'> = authFormat
    ? [authFormat]
    : ['raw', 'bearer'];

  for (const fmt of formats) {
    headers['Authorization'] = fmt === 'bearer' ? `Bearer ${WIX_API_KEY}` : WIX_API_KEY;

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (res.status === 401 && !authFormat) {
      log(`Auth format '${fmt}' returned 401, trying next...`);
      continue;
    }

    if (!authFormat && res.ok) {
      authFormat = fmt;
      log(`Auth format '${fmt}' works, caching for session`);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Wix API ${res.status}: ${text.slice(0, 200)}`);
    }

    return res.json();
  }

  throw new Error('Wix API auth failed with both raw and Bearer formats');
}

async function sync(): Promise<void> {
  log('Starting sync...');
  let created = 0, skipped = 0, errors = 0;

  try {
    let hasMore = true;
    let cursorPaging: any = { limit: 50 };

    while (hasMore) {
      const data = await wixFetch({
        search: {
          filter: {
            status: 'APPROVED',
            archived: false,
            paymentStatus: 'PAID',
            fulfillmentStatus: { '$in': ['NOT_FULFILLED', 'PARTIALLY_FULFILLED'] },
          },
          cursorPaging,
        },
      });

      const orders = data.orders || [];
      if (orders.length === 0) break;

      for (const order of orders) {
        const buyerEmail = order.buyerInfo?.email;
        if (!buyerEmail) {
          log(`Order ${order.number}: no buyer email, skipping`);
          errors++;
          continue;
        }

        for (const li of order.lineItems || []) {
          const catalogItemId = li.catalogReference?.catalogItemId;
          const virtualPrefix = catalogItemId ? ELIGIBLE_PRODUCTS[catalogItemId] : null;
          if (!virtualPrefix) continue;

          const quantity = parseInt(li.quantity, 10) || 1;
          const lineItemId = li._id || li.id;
          if (!lineItemId) {
            log(`Order ${order.number}: line item missing ID, skipping`);
            errors++;
            continue;
          }

          for (let i = 0; i < quantity; i++) {
            const suffixedLineItemId = quantity === 1 ? lineItemId : `${lineItemId}-${i}`;
            const minerKey = generateMinerKey(virtualPrefix);

            try {
              await DeviceModel.collection.insertOne({
                miner_key: minerKey,
                name: PRODUCT_NAMES[virtualPrefix],
                email: buyerEmail,
                is_registered: true,
                created_at: new Date(),
                virtual: true,
                activated: false,
                activated_at: null,
                wix_order_id: order.id,
                wix_line_item_id: suffixedLineItemId,
                transitioned_at: null,
                transitioned_to_device: null,
                canceled_at: null,
                verified: false,
                reward_wallet: null,
                order: String(order.number),
              });
              created++;
              log(`Created ${virtualPrefix} for order ${order.number} line ${suffixedLineItemId}`);
            } catch (err: any) {
              if (err?.code === 11000) {
                skipped++;
              } else {
                log(`Error creating device for order ${order.number}: ${err.message}`);
                errors++;
              }
            }
          }
        }
      }

      const cursor = data.metadata?.cursors?.next;
      if (cursor) {
        cursorPaging = { limit: 50, cursor };
      } else {
        hasMore = false;
      }
    }
  } catch (err: any) {
    log(`Sync error: ${err.message}`);
    errors++;
  }

  lastSync = new Date().toISOString();
  nextSync = new Date(Date.now() + SYNC_INTERVAL_MS).toISOString();
  lastResult = { created, skipped, errors };
  log(`Sync complete: ${created} created, ${skipped} skipped, ${errors} errors`);
}

function startHealthServer(): void {
  const server = http.createServer((req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', lastSync, nextSync, lastResult }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(HEALTH_PORT, () => {
    log(`Health server on port ${HEALTH_PORT}`);
  });
}

async function main(): Promise<void> {
  log('Starting wix-sync service...');

  if (!WIX_API_KEY || !WIX_SITE_ID) {
    log('FATAL: WIX_API_KEY or WIX_SITE_ID not set');
    process.exit(1);
  }

  await connect();
  log('Connected to MongoDB');

  startHealthServer();
  await sync();

  setInterval(async () => {
    try { await sync(); }
    catch (err: any) { log(`Unhandled sync error: ${err.message}`); }
  }, SYNC_INTERVAL_MS);
}

process.on('uncaughtException', (err) => {
  log(`FATAL uncaughtException: ${err.message}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log(`FATAL unhandledRejection: ${reason}`);
  process.exit(1);
});

main().catch((err) => {
  log(`FATAL: ${err.message}`);
  process.exit(1);
});
