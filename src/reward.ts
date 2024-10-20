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
import { Device, DeviceModel, TestDeviceModel } from './db/devices-schema';
import 'dotenv/config';
import { Product, ProductModel } from './db/products-schema';
import * as forge from 'node-forge';
import * as fs from 'fs';
import * as path from 'path';
import { testMinerkeys } from './miner-keys';

interface ReturnDevice {
    device: Device;
    err: string;
}

const testMode = process.env.TEST_MODE && process.env.TEST_MODE === "true";
enum RUNNING_STEP {
    START = 0,
    GET_CHAIN_PARAM = 1,
    FIND_PRODUCT = 2,
    REWARD_WALLET_CHECK,
    GET_REWARD_AMOUNT,
    APPLY_MISSING_REWARD,
    DATA_UPDATED,
    END,
}

const DEBUG = process.env.DEBUG && process.env.DEBUG === "true";
const enc = new TextEncoder();

function getDaysConsideringTime(startDate: Date, endDate: Date): number {
    // Set both dates to midnight to ignore hour differences
    const start = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
    const end = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());

    // Get the difference in time in milliseconds
    const differenceInTime = end.getTime() - start.getTime();

    // Convert the difference to days (ignoring time)
    const differenceInDays = differenceInTime / (1000 * 60 * 60 * 24);

    return differenceInDays;
}

export const doRewards = async (devices: Device[], products: Product[], mainAccount: Account) : Promise<ReturnDevice[]> => {
    const   errDevices: ReturnDevice[] = [];
    let     chainParams: any;
    let     refreshParamCount = 0;
    const   currentDate = new Date(Date.now());
    // let     countForFaile = 0;
    let     processedCount = 0;

    for (const device of devices) {
        console.log(processedCount);
        processedCount++;
        let runningStep = RUNNING_STEP.START;
        try {
            //Refresh Alogrand chain params every 1K devices for refreshing block
            if (refreshParamCount === 0) {
                chainParams = await client.getTransactionParams().do();
            }
            refreshParamCount = (refreshParamCount + 1) % 1000;
            runningStep = RUNNING_STEP.GET_CHAIN_PARAM;

            const minerType = device.miner_key.split('-')[0];
            const product = products.find((product) => product.key === minerType);
            runningStep = RUNNING_STEP.FIND_PRODUCT;
            if (!product) {
                DEBUG && console.log(`Product not found for miner ${device.miner_key}`);
                continue;
            }

            const minerRewardAddr = device.reward_wallet;
            if (!minerRewardAddr) {
                DEBUG && console.log(`No reward wallet is set for miner ${device.miner_key}`);
                errDevices.push({device: device, err: 'No reward wallet'});
                continue;
            }

            let rewardAmount = 0;
            let err: string = '';
            DEBUG && console.log(`BYOD for device ${device.miner_key}: ${device.byod}`);
            DEBUG && console.log(`Staked: ${device.staked}`);
            DEBUG && console.log(`Reward time: ${device.staked?.rewarded_time}`)
            
            if (device.staked === undefined) {
                rewardAmount = product.reward.verified;
            } else {
                if (device.verified) {
                    const stakedAmount = device.staked.amount * ((device.byod !== undefined && device.byod.length > 0) ? 2 : 1);
                    
                    switch (device.staked.type) {
                        case 'one': {
                            if (stakedAmount === product.reward.stake?.stake_one) {
                                rewardAmount = Math.round(product.reward.verified * 100 * 1.5) / 100;
                            } else {
                                err = 'staked invalid amount';
                            }
                        }
                        break;
                        case 'two': {
                            if (stakedAmount === product.reward.stake?.stake_two) {
                                rewardAmount = Math.round(product.reward.verified * 100 * 3.0) / 100;
                            } else {
                                err = 'staked invalid amount';
                            }
                        }
                        break;
                        default: {
                            err = 'staked invalid amount';   
                        }
                    }
                } else {
                    rewardAmount = product.reward.verified;
                }
            }

            if (device.byod !== undefined && device.byod.length > 0) {
                rewardAmount = Math.round(rewardAmount / 2 * 100) / 100;
            }
            DEBUG && console.log(`Reward for device ${device.miner_key}: ${rewardAmount} $FRY`);


            runningStep = RUNNING_STEP.GET_REWARD_AMOUNT;
            if (rewardAmount <= 0) {
                DEBUG && console.log(`Invalid reward amount for device ${device.miner_key}`);
                errDevices.push({device: device, err: err});
                continue;
            }

            let rewardForDays = 1;
            DEBUG && console.log('Last rewarded time for device ' + device.miner_key + ' : ' + new Date(device.staked!.rewarded_time));
            if (device.staked?.rewarded_time !== undefined && device.staked?.rewarded_time.getFullYear() >= 2024) {
                if (new Date(device.staked.rewarded_time) > currentDate) {
                    DEBUG && console.log(`Rewarded Time is invalid for device ${device.miner_key}`);
                    errDevices.push({device: device, err: 'Invalid reward time'});
                    continue;
                }
                
                rewardForDays = testMode ? getThreeHourIntervals(new Date(device.staked.rewarded_time), currentDate) : getDaysConsideringTime(new Date(device.staked.rewarded_time), currentDate);
            }

            if (rewardForDays > 5) {
                DEBUG && console.log(`Missing days for device ${device.miner_key}: ${rewardForDays} days`);
                rewardForDays = 1;
            } else if (rewardForDays <= 0) {
                DEBUG && console.log(`Already got rewarded`);
                errDevices.push({device: device, err: 'Already rewarded'});
                continue;
            }

            rewardAmount = Math.round(rewardAmount * rewardForDays * 100) / 100;
            runningStep = RUNNING_STEP.APPLY_MISSING_REWARD;
            
            const amountToSend = testMode ? 0 : rewardAmount * 1_000_000;
            console.log(`Reward ${rewardAmount} $FRY for device ${device.miner_key}`);

                       
            
            const dataUpdateResult = testMode ? await TestDeviceModel.updateOne({miner_key: device.miner_key}, {$set: {
                'staked.rewarded_time': currentDate}}) : await DeviceModel.updateOne({miner_key: device.miner_key}, {$set: {
                'staked.rewarded_time': currentDate}});
            if (dataUpdateResult.matchedCount <= 0) {
                DEBUG && console.log(`Data update for device ${device.miner_key} is failed`);
                errDevices.push({device: device, err: 'Failed'});
                continue;
            }
            runningStep = RUNNING_STEP.DATA_UPDATED;

            

            const partOfMinerKey = device.miner_key.split('-')[1].slice(0, 6);
            const noteInfo = {
                BYOD: device.byod !== undefined && device.byod.length > 0,
                reward_amount: rewardAmount,
                rewardDays: rewardForDays,
                key: minerType + '-' + partOfMinerKey 
            }
            // const noteBasic = ((device.byod !== undefined && device.byod.length > 0) ? 'BYOD-' : '') + minerType + '-' + partOfMinerKey + '-' + rewardForDays + 'days';
            const noteBasic = JSON.stringify(noteInfo);
            console.log(`Note for device ${device.miner_key} is ${noteBasic}`);
            if (!(await hasOptedInForAsset(minerRewardAddr, config.asset_index))) {
                console.log(`Reward wallet ${minerRewardAddr} for device ${device.miner_key} is not opted in $FRY`);
                await optInForAsset(mainAccount, minerRewardAddr, config.asset_index);
            }
            const note = enc.encode(noteBasic);
            const txn = makeAssetTransferTxnWithSuggestedParamsFromObject({
                from: mainAccount.addr,
                to: minerRewardAddr,
                amount: amountToSend,
                assetIndex: config.asset_index,
                note: note,
                suggestedParams: chainParams
            });
            const signedTxn = txn.signTxn(mainAccount.sk);
            const tx = await client.sendRawTransaction(signedTxn).do();
            
            DEBUG && console.log(`Reward Transaction id for device ${device.miner_key}: ${tx}`);
            runningStep = RUNNING_STEP.END;
            
        } catch (error) {
            console.error(`Error for device ${device.miner_key} : ${error}`);
            errDevices.push({device: device, err: 'Failed'});
        }
    } 

    return errDevices;
}

function getThreeHourIntervals(startDate: Date, endDate: Date) {
    // Get the difference in milliseconds
    const differenceInMs = endDate.getTime() - startDate.getTime();

    // Convert the difference into hours
    const totalHours = differenceInMs / (1000 * 60 * 60);

    // Calculate how many 3-hour intervals are there
    const threeHourIntervals = Math.floor(totalHours / 3);

    return threeHourIntervals;
}

function generateRandomNumberString(length: number, options?: { includeLeadingZeroes?: boolean }): string {
    const digits = [];
    const includeLeadingZeroes = options?.includeLeadingZeroes || false;

    for (let i = 0; i < length; i++) {
        if (i === 0 && !includeLeadingZeroes) {
            // Ensure the first digit is not zero if leading zeroes are not allowed
            digits.push(Math.floor(Math.random() * 9) + 1);
        } else {
            // For the rest of the digits, generate a number between 0 and 9
            digits.push(Math.floor(Math.random() * 10));
        }
    }

    return digits.join('-Optin');
}

async function hasOptedInForAsset(address: string, assetId: number): Promise<boolean> {
    const accountInfo = await client.accountInformation(address).do();
    const assets = accountInfo['assets'] || [];
    return assets.some((asset: any) => asset['asset-id'] === assetId);
}
async function optInForAsset(fromAccount: Account, toAddress: string, assetId: number): Promise<void> {
    const enc = new TextEncoder();
    const note = enc.encode(generateRandomNumberString(10));
    const params = await client.getTransactionParams().do();
    const optInTxn = makeAssetTransferTxnWithSuggestedParamsFromObject({
        from: fromAccount.addr,
        to: toAddress,
        amount: 0,
        assetIndex: assetId,
        suggestedParams: params,
        note: note
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