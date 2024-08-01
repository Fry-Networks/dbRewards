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
//open the xlsx file and read the data
import { connect, getConnection } from './db/connect';
import { Device, DeviceModel } from './db/devices-schema';
import UserModel from './db/users-schema';
import 'dotenv/config';
import { ProductModel } from './db/products-schema';

const main = async () => {
    //await filterDuplicates(config.excel_file_name);
    await connect();
    const connection = getConnection();
    const rewardsConfig = await connection.connection.collection('configs').findOne({ name: 'rewards' });
    const globalMulitplier = rewardsConfig ? rewardsConfig.multiplier : 1;
    console.log(globalMulitplier);
    //get the addresses from the xlsx file
    //get the name of the highest row of the 3rd column
    const addresses: string[] = [];
    const addressesCount = new Map<string, {
        devices_info: Array<{
            type: string,
            verified: boolean,
            need_transactions: boolean
        }>
    }>();

    const allDevices = await DeviceModel.find({ is_registered: true });
    const users = new Map<string, Device[]>(); //key: address, value: array of devices
    allDevices.map((device) => {
        const stringifiedId = device.user_id.toString();
        if (users.has(stringifiedId)) {
            const devicesArray = users.get(stringifiedId) as any[];
            devicesArray.push(device);
            users.set(stringifiedId, devicesArray);
        } else {
            users.set(stringifiedId, [device]);
        }
    });

    const userPromises = Array.from(users.entries()).map(async ([userId, devices]) => {
        const user = await UserModel.findById(userId);
        if (!user.address) return;
        // Prepare data for each device, including its type and verified status
        const deviceData = devices.map(device => ({
            type: device.miner_key.split('-')[0],
            verified: device.verified, // Assuming 'verified' is a boolean property of each device
            need_transactions: device.need_transactions
        }));

        if (addressesCount.has(user.address)) {
            const currentData = addressesCount.get(user.address)!;
            addressesCount.set(user.address, {
                // Spread the existing devices and add the new device data
                devices_info: [...currentData.devices_info, ...deviceData]
            });

        } else {
            addressesCount.set(user.address, {
                devices_info: deviceData // Set the new device data
            });
        }
        if (!addresses.includes(user.address)) {
            addresses.push(user.address);
        }
    });


    // This will wait for all the user promises to finish before continuing to the next row
    await Promise.all(userPromises);
    console.log(addressesCount);
    if (addresses.length === 0) {
        console.log("No addresses found");
        return;
    }
    console.log(await client.status().do());
    const account = mnemonicToSecretKey(process.env.MNEMONIC!);
    //send the same amount to each address of FrysCrypto (FRY) which has a contract number: 924268058
    const enc = new TextEncoder();
    const params = await client.getTransactionParams().do();
    const products = await ProductModel.find({});
    for (const address of addresses) {
        try {
            const devices = addressesCount.get(address)?.devices_info || [];
            const count = devices.filter((device) => device.need_transactions).length;
            const transactionsNeeded = 24 * count;
            console.log(devices)
            //Calculate the amount of FRY to send for the devices that need transactions (POC)
            const FRYamount_transactions = devices.filter((device) => device.need_transactions).reduce((acc, device) => {
                const associatedProduct = products.find((product) => product.key === device.type);
                console.log(associatedProduct)
                const reward = (device.verified ? associatedProduct?.reward?.verified : associatedProduct?.reward?.unverified) || 0;
                return acc + reward;
            }, 0);
            const lastTransactions = await indexer.lookupAccountTransactions(address).limit(transactionsNeeded + 10).do();
            //get all the transactions of the address that were done in the last 24 hours
            const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

            const lastTransactionsInLast24Hours: Array<any> = lastTransactions.transactions.filter((transaction: Transaction) => {
                const transactionDate = new Date(transaction['round-time'] * 1000);
                const isTheSender = transaction.sender === address;
                const isAmountZero = !transaction['asset-transfer-transaction'] || transaction['asset-transfer-transaction'].amount === 0;
                const isFRY = transaction['asset-transfer-transaction'] && transaction['asset-transfer-transaction']['asset-id'] === config.asset_index;
                return (transactionDate > oneDayAgo && isTheSender && isAmountZero && isFRY)
            });

            //if there is at least 24 transactions in the last 24 hours, with 0 amount, then send the FRY

            let mult = 1;
            if (lastTransactionsInLast24Hours.length >= transactionsNeeded) {
                mult = 1;
            } else {
                mult = lastTransactionsInLast24Hours.length / transactionsNeeded;
            }
            //Calculate the amount of FRY to send for the devices that need transactions (POC)
            const amountToSend_transactions = Math.floor(Math.round(FRYamount_transactions * mult * 100) / 100)
            //Calculate the amount of FRY to send for the devices that don't need transactions
            const amountToSend_devices = devices.filter((device) => !device.need_transactions).reduce((acc, device) => {
                const associatedProduct = products.find((product) => product.key === device.type);
                const reward = (device.verified ? associatedProduct?.reward?.verified : associatedProduct?.reward?.unverified) || 0;
                return acc + reward;
            }, 0);

            //Calculate the total amount of FRY to send
            const amountToSend = (amountToSend_transactions + amountToSend_devices) * globalMulitplier;
            


            console.log(`amount for ${address} is ${amountToSend} -- ${lastTransactionsInLast24Hours.length} transactions in the last 24 hours}`)

            if (amountToSend > 0) {

                if (!(await hasOptedInForAsset(address, config.asset_index))) {
                    console.log(`Address ${address} has not opted in for asset ${config.asset_index}. Sending opt-in transaction.`);
                    await optInForAsset(account, address, config.asset_index);
                }
                
                //make the note the list of devices that the address has
                const devicesList: Map<string, number> = new Map();
                devices.forEach((device) => {
                    if (devicesList.has(device.type)) {
                        devicesList.set(device.type, devicesList.get(device.type)! + 1);
                    } else {
                        devicesList.set(device.type, 1);
                    }
                });
                const str = Array.from(devicesList.entries()).map(([key, value]) => `${key} x${value}`).join('\n');
                const note = enc.encode(str);
                console.log(str);
                
                const txn = makeAssetTransferTxnWithSuggestedParamsFromObject({
                    from: account.addr,
                    to: address,
                    amount: amountToSend,
                    assetIndex: config.asset_index,
                    note: note,
                    suggestedParams: params,
                }
                );
                //convert the account sk object to Uint8Array
              //  const signedTxn = txn.signTxn(account.sk);
                // const tx = (await client.sendRawTransaction(signedTxn).do());
                //console.log("Transaction : " + tx.txId);
                
            } else {
                console.log('The address: ' + address + ' has no transactions in the last 24 hours');
            }
        } catch (e) {
            console.log(e);
            console.log('Error for address: ' + address);
            console.log('-------------------------------------');
        }
    }
};

main()

setInterval(main, 24 * 60 * 60 * 1000);

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
