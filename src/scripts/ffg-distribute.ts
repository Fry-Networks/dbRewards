/**
 * FFG Distribution — MANUAL TRIGGER ONLY.
 *
 * Enumerates current Fry Fee Genesis holders from on-chain 'o'-prefix boxes,
 * computes per-PASS share (accumulated / total_minted), pays each holder
 * per_pass * passes_held.
 *
 * Dry-run (FFG_DISTRIBUTION_MNEMONIC unset): prints full plan, exits 0.
 * Live: sends axfers, records distribution docs, decrements accumulated by
 * the amount ACTUALLY sent (never zeroes blindly).
 *
 * Token-version agnostic: distributable assets come solely from the
 * accumulated ledger — no ASA IDs in code.
 *
 * Usage: npm run ffg:distribute
 * Environment:
 *   FFG_ALGOD_URL             — algod (default: https://mainnet-api.4160.nodely.dev)
 *   FFG_DISTRIBUTION_MNEMONIC — optional sender mnemonic; unset = DRY RUN
 *                               If unset and SA token available, attempts 1Password load via:
 *                               op://FryFarm/FryMinerRewardPool Fee Address/recovery_phrase
 */

import axios from 'axios';
import mongoose from 'mongoose';
import algosdk from 'algosdk';
import { connect } from '../db/connect';
import process from 'process';
import 'dotenv/config';
import { execFileSync } from 'child_process';
import fs from 'fs';

async function loadMnemonicFromOpService(): Promise<string | undefined> {
  // Check if /etc/opt/dbrewards/op_service_account_token exists
  const saTokenPath = '/etc/opt/dbrewards/op_service_account_token';
  if (!fs.existsSync(saTokenPath)) {
    return undefined;
  }

  try {
    // Read the SA token
    const saToken = fs.readFileSync(saTokenPath, 'utf-8').trim();
    // Use execFileSync with environment variable (safe from injection)
    const mnemonic = execFileSync('op', ['read', 'op://FryFarm/FryMinerRewardPool Fee Address/recovery_phrase'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: saToken }
    }).trim();
    return mnemonic || undefined;
  } catch (err) {
    // Silently fail if op read fails (no service account token set, secret not found, etc.)
    return undefined;
  }
}

async function distributeFFGFees(): Promise<void> {
  const algodUrl = process.env.FFG_ALGOD_URL || 'https://mainnet-api.4160.nodely.dev';
  let mnemonicPhrase = process.env.FFG_DISTRIBUTION_MNEMONIC;

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

    const accumulated: Record<string, number> = config.accumulated || {};
    const positive = Object.entries(accumulated).filter(([, v]) => (v as number) > 0);
    if (positive.length === 0) {
      console.log('No accumulated fees to distribute');
      process.exit(0);
    }

    // If no mnemonic env var, try 1Password fallback
    if (!mnemonicPhrase) {
      console.log('FFG_DISTRIBUTION_MNEMONIC not set, attempting 1Password load...');
      mnemonicPhrase = await loadMnemonicFromOpService();
      if (!mnemonicPhrase) {
        console.log('No 1Password mnemonic available either — DRY_RUN mode');
      }
    }

    // Enumerate holders: 'o' + uint64_be8(token_id) -> 32-byte owner pubkey
    const appId = config.contract_app_id;
    console.log(`Enumerating holders from app ${appId}...`);
    const boxesRes = await axios.get(`${algodUrl}/v2/applications/${appId}/boxes`, {
      params: { max: 0 },
    });
    const holders: Record<string, number> = {};
    let totalMinted = 0;
    for (const b of boxesRes.data.boxes || []) {
      const name = Buffer.from(b.name, 'base64');
      if (name.length !== 9 || name[0] !== 0x6f) continue; // only 'o' boxes
      const boxRes = await axios.get(`${algodUrl}/v2/applications/${appId}/box`, {
        params: { name: `b64:${b.name}` },
      });
      const owner = algosdk.encodeAddress(Buffer.from(boxRes.data.value, 'base64'));
      holders[owner] = (holders[owner] || 0) + 1;
      totalMinted++;
    }
    const holderCount = Object.keys(holders).length;
    console.log(`total_minted=${totalMinted} unique_holders=${holderCount}`);

    // Per-PASS share; holder payout = per_pass * passes held
    const plan: Array<{
      asset_id: number;
      per_pass: number;
      total: number;
      payouts: Array<{ addr: string; amount: number }>;
    }> = [];
    for (const [asaIdStr, totalRaw] of positive) {
      const total = totalRaw as number;
      const perPass = totalMinted > 0 ? Math.floor(total / totalMinted) : 0;
      if (perPass <= 0) {
        console.log(`Asset ${asaIdStr}: per-pass share is 0 — skipping`);
        continue;
      }
      const payouts = Object.entries(holders)
        .map(([addr, n]) => ({ addr, amount: perPass * (n as number) }))
        .filter((p) => p.amount > 0);
      plan.push({
        asset_id: parseInt(asaIdStr, 10),
        per_pass: perPass,
        total: payouts.reduce((s, p) => s + p.amount, 0),
        payouts,
      });
    }

    console.log('\n=== DISTRIBUTION PLAN ===');
    for (const p of plan) {
      console.log(
        `asset ${p.asset_id}: ${p.per_pass}/pass -> ${p.payouts.length} payouts, total ${p.total}`
      );
    }
    if (plan.length === 0) {
      console.log('Nothing distributable');
      process.exit(0);
    }

    if (!mnemonicPhrase) {
      console.log('\nDRY_RUN_COMPLETE (no FFG_DISTRIBUTION_MNEMONIC — no sends)');
      process.exit(0);
    }

    // LIVE
    const sender = algosdk.mnemonicToSecretKey(mnemonicPhrase);
    const algod = new algosdk.Algodv2('', algodUrl, '');
    const docs: any[] = [];
    for (const p of plan) {
      const txids: string[] = [];
      for (const payout of p.payouts) {
        const sp = await algod.getTransactionParams().do();
        const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
          from: sender.addr,
          to: payout.addr,
          amount: payout.amount,
          assetIndex: p.asset_id,
          suggestedParams: sp,
        });
        const { txId } = await algod.sendRawTransaction(txn.signTxn(sender.sk)).do();
        await algosdk.waitForConfirmation(algod, txId, 8);
        txids.push(txId);
        console.log(`sent ${payout.amount} of ${p.asset_id} -> ${payout.addr.slice(0, 8)}... ${txId}`);
      }
      docs.push({
        epoch_ts: Math.floor(Date.now() / 1000),
        asset_id: p.asset_id,
        total_amount: p.total,
        per_pass: p.per_pass,
        holder_count: p.payouts.length,
        txids,
        distributed_at: new Date(),
      });
      // decrement only what was actually sent, after sending
      await configColl.updateOne(
        { _id: 'config' } as any,
        { $inc: { [`accumulated.${p.asset_id}`]: -p.total } }
      );
    }
    if (docs.length) {
      await mainDb.collection('fry_fee_genesis_distributions').insertMany(docs as any);
    }

    console.log('\nDISTRIBUTION_COMPLETE');
    console.log(
      JSON.stringify(
        docs.map((d) => ({ asset_id: d.asset_id, total: d.total_amount, txn_count: d.txids.length })),
        null,
        2
      )
    );

    await mongoose.connection.close();
    process.exit(0);
  } catch (err) {
    console.error('Distribution failed:', err);
    process.exit(1);
  }
}

distributeFFGFees();
