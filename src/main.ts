const token = '';
const server = 'https://xna-mainnet-api.algonode.cloud/';
const indexServer = 'https://mainnet-idx.algonode.cloud/';

const port = 443;
import { Algodv2, Indexer, makeAssetTransferTxnWithSuggestedParamsFromObject, mnemonicToSecretKey, Account } from 'algosdk';
const tokenToSend = {
    'X-API-Key': token
}

const client = new Algodv2(tokenToSend, server, port);

const indexer = new Indexer(tokenToSend, indexServer, port);

import config from '../config.json'
import { connect, getConnection } from './db/connect';
import { Device, DeviceModel } from './db/devices-schema';
import 'dotenv/config';
import { ProductModel } from './db/products-schema';
import * as forge from 'node-forge';
import * as fs from 'fs';
import * as path from 'path';
import { testMinerkeys } from './miner-keys';

function loadPrivateKey(pemFilePath: string): string {
    return fs.readFileSync(pemFilePath, 'utf8');
}
const privateKeyPath = path.resolve(__dirname, 'private_key.pem');
const privateKeyPem = loadPrivateKey(privateKeyPath);
const testMode = process.env.TEST_MODE ? process.env.TEST_MODE === "true" : false;

console.log('Test mode: ' + testMode);


function decryptWithPrivateKey(privateKeyPem: string, encryptedData: string): string {
    const privateKey = forge.pki.privateKeyFromPem(privateKeyPem);
    const encryptedBytes = forge.util.decode64(encryptedData);
    const decrypted = privateKey.decrypt(encryptedBytes, 'RSA-OAEP', {
        md: forge.md.sha256.create(),
        mgf1: forge.mgf.mgf1.create(forge.md.sha256.create())
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
    if (typeof stake_one !== 'number' || typeof stake_two !== 'number') {
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


const main = async () => {
    await connect();
    const connection = getConnection();
    const rewardsConfig = await connection.connection.collection('configs').findOne({ name: 'rewards' });
    if (!rewardsConfig?.enabled) {
        console.log('Rewards are disabled');
       return;
    }
    
    const globalMulitplier = rewardsConfig ? rewardsConfig.multiplier : 1;
    console.log(globalMulitplier);

    const allDevices = await DeviceModel.find({ is_registered: true}) as Device[];
    //const filtered = allDevices.filter((device) => device.reward_wallet)
    // const filtered = allDevices.filter((device) => device.miner_key.split('-')[0] == "CN");
    const filtered = allDevices;
    console.log(filtered);
    //console.log(await client.status().do());
    const account = mnemonicToSecretKey(process.env.MNEMONIC!);
    const algoBalance = await getAlgoBalance(account.addr);
    // console.log('Algo in rewarding wallet: ' + algoBalance);
    if (!algoBalance || algoBalance <= 1) {
        console.log('No algo or not enough algo is in rewarding wallet');
        return;
    }
    //send the same amount to each address of FrysCrypto (FRY) which has a contract number: 924268058
    const enc = new TextEncoder();
    const products = await ProductModel.find({});
    for (const device of filtered) {
        try {
            const params = await client.getTransactionParams().do();
            if (testMode && testMinerkeys.includes(device.miner_key) === false) {
                continue;
            }
            const product = products.find((product) => product.key === device.miner_key.split('-')[0]);
            if (!product) {
                console.log(`Product not found for miner ${device.miner_key}`);
                continue;
            }
            
            let amount;
            const address = device.reward_wallet;
            if(!address) {
                console.log(`No reward wallet for miner ${device.miner_key}`);
                continue;
            }

            const algoBalance = await getAlgoBalance(account.addr);
            if (!algoBalance || algoBalance <= 1) {
                console.log('No algo or not enough algo is in rewarding wallet');
                return;
            }

            // if (product.type === "hardware") {



            //     const transactionsNeeded = 24;
            //     //Calculate the amount of FRY to send for the devices that need transactions (POC)
            //     const lastTransactions = await indexer.lookupAccountTransactions(address).limit(transactionsNeeded + 150).do();
            //     //get all the transactions of the address that were done in the last 24 hours
            //     const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

            //     const lastTransactionsInLast24Hours: Array<any> = lastTransactions.transactions.filter((transaction: Transaction) => {
            //         const transactionDate = new Date(transaction['round-time'] * 1000);
            //         if(transactionDate < oneDayAgo) return false;
            //         const isTheSender = transaction.sender === address;
            //         if(!isTheSender) return false;
            //         const isAmountZero = !transaction['asset-transfer-transaction'] || transaction['asset-transfer-transaction'].amount === 0;
            //         if(!isAmountZero) return false;
            //         const isFRY = transaction['asset-transfer-transaction'] && transaction['asset-transfer-transaction']['asset-id'] === config.asset_index;
            //         if(!isFRY) return false;
            //         const note = transaction.note;
            //         const decodeBase64 = Buffer.from(note, 'base64').toString('utf-8');
            //         console.log(decodeBase64);
            //         try {
            //         const decrypted = decryptWithPrivateKey(privateKeyPem, decodeBase64);
            //         console.log(decrypted);
            //         const isSameDevice = decrypted == device.miner_key
            //         return (isSameDevice);
            //         } catch (e) {
            //             console.log(e);
            //             return false;
            //         }
                    
                    
            //     });
     
            //     //if there is at least 24 transactions in the last 24 hours, with 0 amount, then send the FRY

            //     let mult = 1;
            //     if (lastTransactionsInLast24Hours.length >= transactionsNeeded) {
            //         mult = 1;
            //     } else {
            //         mult = lastTransactionsInLast24Hours.length / transactionsNeeded;
            //     }

            //     const reward = (device.verified ? product?.reward.verified : product?.reward.unverified) ?? 0
            //     amount = Math.floor(device.byod ? Math.round(reward * mult * 100) / 200 : Math.round(reward * mult * 100) / 100) //byod devices get half the reward
            //     console.log(`amount for ${device.miner_key} is ${amount * globalMulitplier} -- ${lastTransactionsInLast24Hours.length} transactions in the last 24 hours}`)
            // } else 
            if (device.is_registered === false) {
                console.log('The miner: ' + device.miner_key + 'is not registered');
                continue;
            }

            if (device.verified && isStakeValid(product) === false) {
                console.log('The miner: ' + device.miner_key + 'is not allowed to stake');
                continue;
            }

            const stakeOneAmount = product.reward.stake?.stake_one ? product.reward.stake?.stake_one : 0;
            const stakeTwoAmount = product.reward.stake?.stake_two ? product.reward.stake?.stake_two : 0;
            const stakeByodOneAmount = Math.round(stakeOneAmount * 100) / 200;
            const stakeByodTwoAmount = Math.round(stakeTwoAmount * 100) / 200;

            if (device.verified && (stakeOneAmount !== device.staked?.amount && stakeTwoAmount !== device.staked?.amount 
                && stakeByodOneAmount !== device.staked?.amount && stakeByodTwoAmount !== device.staked?.amount)) {
                console.log('The miner: ' + device.miner_key + 'is staked invalid amount');
                continue;
            }

            if (device.verified)
            {
                amount = product?.reward.verified ?? 0
                amount = Math.round(amount * 100 * (device.staked?.type === "one" ? 1.5 : 3)) / 100; //Multiple reward amount following FIP-0007
                console.log(`amount for ${device.miner_key} is ${Math.round(amount * globalMulitplier * 100) / 100}`)
            } else {
                amount = (product?.reward.unverified) ?? 0;
                console.log(`amount for ${device.miner_key} is ${Math.round(amount * globalMulitplier * 100) / 100}`)
            }

            if (device.byod) { //if byod then reward must be in half
                amount = Math.round(amount *  100) / 200;
            }
            //Calculate the total amount of FRY to send
            const amountToSend = Math.round((amount) * globalMulitplier * 100) / 100 * 1_000_000;

            if (amount <= 0) {
                console.log('The miner: ' + device.miner_key + ' has no transactions in the last 24 hours');
                continue;
            }

            const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

            if (device.verified && (new Date(device.staked!.rewarded_time) > oneDayAgo))  {
                console.log('The miner: ' + device.miner_key + ' is not reach reward time');
                continue;
            }

            if (device.verified === false) {
                if (device.staked !== undefined && (new Date(device.staked!.rewarded_time) > oneDayAgo)) {
                    console.log('The miner: ' + device.miner_key + ' is not reach reward time');
                    continue;
                }
            }

            if (!(await hasOptedInForAsset(address, config.asset_index))) {
                console.log(`Address ${address} has not opted in for asset ${config.asset_index}. Sending opt-in transaction.`);
                await optInForAsset(account, address, config.asset_index);
            }

            // const note = enc.encode(device.miner_key.split('-')[1]);
            const note = enc.encode((device.byod ? 'BYOD - ' : '') + device.miner_key.split('-')[0] + '-' + device.miner_key.split('-')[1].slice(0, 6));
            
            const txn = makeAssetTransferTxnWithSuggestedParamsFromObject({
                from: account.addr,
                to: address,
                amount: amountToSend,
                assetIndex: config.asset_index,
                note: note,
                suggestedParams: params,
            }
            );

            // adjust the rewarded time with delta 
            const rewardedTime = new Date(device.staked?.rewarded_time ? device.staked.rewarded_time.getTime() + 24 * 60 * 60 * 1000 : Date.now());
            const updateResult = await DeviceModel.updateOne({miner_key:device.miner_key}, {$set: {
                'staked.rewarded_time': rewardedTime         
            }}); 
            
            if (updateResult.matchedCount > 0) {
                console.log('The miner: ' + device.miner_key + ' rewarded time updated successfully');
            } else {
                console.log('No matching device found');
                continue;
            }
            //convert the account sk object to Uint8Array
            const signedTxn = txn.signTxn(account.sk);
            const tx = (await client.sendRawTransaction(signedTxn).do());
            console.log("Transaction : " + tx.txId);
        } catch (e) {
            console.log(e);
            console.log('Error for miner: ' + device.miner_key);
            console.log('-------------------------------------');
        }
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
        console.error('Failed to fetch account balance:', error);
        return null;
    }
}

main()

setInterval(main, 10 * 60 * 1000);

async function hasOptedInForAsset(address: string, assetId: number): Promise<boolean> {
    const accountInfo = await client.accountInformation(address).do();
    const assets = accountInfo['assets'] || [];
    return assets.some((asset: any) => asset['asset-id'] === assetId);
}
async function optInForAsset(fromAccount: Account, toAddress: string, assetId: number): Promise<void> {
    const params = await client.getTransactionParams().do();
    const optInTxn = makeAssetTransferTxnWithSuggestedParamsFromObject({
        from: fromAccount.addr,
        to: toAddress,
        amount: 0,
        assetIndex: assetId,
        suggestedParams: params,
    });
    const signedOptInTxn = optInTxn.signTxn(fromAccount.sk);
    await client.sendRawTransaction(signedOptInTxn).do();
}

interface Transaction {
    'close-rewards': number;
    'closing-amount': number;
    'asset-transfer-transaction': {
        'amount': number;
        'asset-id': number;
    }
    'confirmed-round': number;
    fee: number;
    'first-valid': number;
    'genesis-hash': string;
    'genesis-id': string;
    id: string;
    'intra-round-offset': number;
    'last-valid': number;
    note: string;
    'payment-transaction': Object;
    'receiver-rewards': number;
    'round-time': number;
    sender: string;
    'sender-rewards': number;
    signature: Object;
    'tx-type': string;
}
/*
interface Device {
    _id: string;
    user_id: string;
    nickname?: string;
    miner_key: string;
    name: string;
    byod?: string;
    created_at: Date;
    position?: {
        lat: number;
        lng: number;
    };
    verified: boolean;
    reward_wallet?: string;
    is_registered: boolean;
    staked?: {
        amount: number;
        time: string;
        txId: string;
    }
    hexId?: string;
    address: string;
    email: string;
    __v: number;
}
*/