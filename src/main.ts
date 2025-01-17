const token = "";
const server = "https://xna-mainnet-api.algonode.cloud/";
const indexServer = "https://mainnet-idx.algonode.cloud/";

const port = 443;
import {
  Algodv2,
  Indexer,
  makeAssetTransferTxnWithSuggestedParamsFromObject,
  mnemonicToSecretKey,
  Account,
} from "algosdk";
const tokenToSend = {
  "X-API-Key": token,
};

const client = new Algodv2(tokenToSend, server, port);

const indexer = new Indexer(tokenToSend, indexServer, port);

import config from "../config.json";
import { connect, getConnection } from "./db/connect";
import { Device, DeviceModel, TestDeviceModel } from "./db/devices-schema";
import "dotenv/config";
import { ProductModel } from "./db/products-schema";
import * as forge from "node-forge";
import * as fs from "fs";
import * as path from "path";
import { testMinerkeys } from "./miner-keys";
import { doRewards } from "./reward";
import mongoose from "mongoose";

function loadPrivateKey(pemFilePath: string): string {
  return fs.readFileSync(pemFilePath, "utf8");
}
const privateKeyPath = path.resolve(__dirname, "private_key.pem");
const privateKeyPem = loadPrivateKey(privateKeyPath);
const testMode = process.env.TEST_MODE
  ? process.env.TEST_MODE === "true"
  : false;

console.log("Test mode: " + testMode);

function decryptWithPrivateKey(
  privateKeyPem: string,
  encryptedData: string
): string {
  const privateKey = forge.pki.privateKeyFromPem(privateKeyPem);
  const encryptedBytes = forge.util.decode64(encryptedData);
  const decrypted = privateKey.decrypt(encryptedBytes, "RSA-OAEP", {
    md: forge.md.sha256.create(),
    mgf1: forge.mgf.mgf1.create(forge.md.sha256.create()),
  });
  return decrypted;
}

const isStakeValid = (product: any): boolean => {
  if (!product.reward.stake) {
    // stake is undefined or null, return false if it must be present
    return false;
  }

  const { stake_one, stake_two } = product.reward.stake;

  // Check if both stake_one and stake_two are defined and are numbers
  if (typeof stake_one !== "number" || typeof stake_two !== "number") {
    return false;
  }

  // Optionally: Check for more specific validation rules (e.g., stake values must be positive)
  if (stake_one < 0 || stake_two < 0) {
    return false; // Example rule: stakes cannot be negative
  }

  // All checks passed, return true
  return true;
};

const unverifyRewardDate = new Date(Date.now());

const ensureCollectionsExist = async (
  db: mongoose.Connection,
  collections: string[]
) => {
  const existingCollections = await db.db.listCollections().toArray();
  const existingNames = existingCollections.map((col) => col.name);

  for (const collectionName of collections) {
    if (!existingNames.includes(collectionName)) {
      await db.createCollection(collectionName);
      console.log(`Collection '${collectionName}' created.`);
    } else {
      console.log(`Collection '${collectionName}' already exists.`);
    }
  }
};

const main = async () => {
  await connect();
  const connection = getConnection();
  const db = connection.connection;

  await ensureCollectionsExist(db, ["rewards", "test-rewards"]);

  const rewardsConfig = await connection.connection
    .collection("configs")
    .findOne({ name: "rewards" });
  if (!testMode && !rewardsConfig?.enabled) {
    console.log("Rewards are disabled");
    return;
  }

  const globalMulitplier = rewardsConfig ? rewardsConfig.multiplier : 1;
  console.log(globalMulitplier);

  const allDevices = testMode
    ? ((await TestDeviceModel.find({ is_registered: true })) as Device[])
    : ((await DeviceModel.find({ is_registered: true })) as Device[]);
  //const filtered = allDevices.filter((device) => device.reward_wallet)
  // const filtered = allDevices.filter((device) => device.miner_key.split('-')[0] == "CN");
  let filtered = allDevices;
  console.log(filtered);
  //console.log(await client.status().do());
  const account = mnemonicToSecretKey(process.env.MNEMONIC!);
  //send the same amount to each address of FrysCrypto (FRY) which has a contract number: 924268058
  const products = await ProductModel.find({});
  let retryCount = 0;

  while (retryCount < 5) {
    const errDevices = await doRewards(filtered, products, account);

    errDevices.map((value) => {
      console.log(
        `Failed to reward for device ${value.device.miner_key} with error: ${value.err}`
      );
    });

    const retryRewardDevices = errDevices
      .filter((value) => {
        if (value.err === "Failed") {
          return true;
        }

        return false;
      })
      .map((value) => value.device);

    if (retryRewardDevices.length === 0) {
      break;
    } else {
      console.log(`Failed to reward for ${retryRewardDevices.length} devices`);
    }

    filtered = retryRewardDevices;
    retryCount++;

    await sleep(10 * 60 * 1000);
  }

  if (retryCount >= 5) {
    console.log(`Failed in daily reward for all miners`);
  } else {
    console.log(`Success in daily reward for all miners`);
  }
};

async function getAlgoBalance(address: string) {
  try {
    // Fetch account information
    const accountInfo = await client.accountInformation(address).do();

    // Extract balance (in microAlgos, so divide by 1e6 to get Algo)
    const balanceInMicroAlgos = accountInfo.amount;
    const balanceInAlgos = balanceInMicroAlgos / 1e6;

    // console.log(`Algo balance for ${address}: ${balanceInAlgos} Algos`);
    return balanceInAlgos;
  } catch (error) {
    console.error("Failed to fetch account balance:", error);
    return null;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// main();
// setInterval(main, testMode ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000);

let updatedDate = new Date(0);
async function rewardSystem() {
  const currentDate = new Date(Date.now());
  if (
    currentDate.getDate() !== updatedDate.getDate() &&
    currentDate.getHours() >= 18
  ) {
    updatedDate = currentDate;
    await main();
  }
}

rewardSystem();
setInterval(rewardSystem, 60 * 60 * 1000);
