import { Ed25519Keypair } from "@mysten/sui.js/keypairs/ed25519";
import { getFullnodeUrl, SuiClient } from "@mysten/sui.js/client";
import { initializeParas, NetworkType } from "../../types";
import { getCoinAmount, getCoinDecimal } from "../Coins";
import { TransactionBlock } from "@mysten/sui.js/transactions";
import { pool } from "../../address";
import { Pool, PoolConfig, CoinInfo } from "../../types";
import {
  depositCoin,
  depositCoinWithAccountCap,
  mergeCoins,
  getHealthFactor,
  withdrawCoin,
  withdrawCoinWithAccountCap,
  borrowCoin,
  repayDebt,
  SignAndSubmitTXB,
} from "../PTB";
import { config } from "../../address";
import { moveInspect } from "../CallFunctions";
import { AddressMap } from '../../address'


export class AccountManager {
  public keypair: Ed25519Keypair;
  public client: SuiClient;
  public address: string = "";

  /**
   * AccountManager class for managing user accounts.
   */
  constructor({ mnemonic = "", networkType, accountIndex = 0 }: initializeParas = {}) {

    this.keypair = Ed25519Keypair.deriveKeypair(mnemonic, this.getDerivePath(accountIndex));
    this.client = new SuiClient({
      url: getFullnodeUrl(networkType as NetworkType),
    });
    this.address = this.keypair.getPublicKey().toSuiAddress();
  }

  /**
   * Returns the derivation path for a given address index.
   * @param addressIndex - The index of the address.
   * @returns The derivation path.
   */
  getDerivePath(addressIndex: number) {

    return `m/44'/784'/0'/0'/${addressIndex}'`;
  };

  /**
   * Retrieves the public key associated with the account.
   * @returns The public key as a SuiAddress.
   */
  getPublicKey() {
    return this.keypair.getPublicKey().toSuiAddress();
  }

  /**
   * getAllCoins is an asynchronous function that retrieves all the coins owned by the account.
   * 
   * @param ifPrettyPrint - A boolean indicating whether to print the data in a pretty format. Default is true.
   * @returns A Promise that resolves to the data containing all the coins owned by the account.
   */
  async getAllCoins(ifPrettyPrint: boolean = true): Promise<any> {
    const allData = await this.client.getAllCoins({
      owner: this.address,
    });

    if (ifPrettyPrint) {
      allData.data.forEach((element: any) => {
        console.log("Coin Type: ", element.coinType, "| Obj id: ", element.coinObjectId, " | Balance: ", element.balance);
      });
    }

    return allData;
  }

  /**
   * getWalletBalance is an asynchronous function that retrieves the balance of all coins in the wallet.
   * 
   * @param ifPrettyPrint - A boolean indicating whether to print the data in a pretty format. Default is false.
   * @returns A Promise that resolves to an object containing the balance of each coin in the wallet.
   */
  async getWalletBalance(ifPrettyPrint: boolean = true): Promise<Record<string, number>> {
    const allData = await this.getAllCoins(false);
    const coinBalances: Record<string, number> = {};

    await Promise.all(allData.data.map(async (element: any) => {
      const coinType = element.coinType;
      const balance: any = element.balance;
      const decimal: any = await this.getCoinDecimal(coinType);

      if (coinBalances[coinType]) {
        coinBalances[coinType] += Number(balance) / Math.pow(10, decimal);
      } else {
        coinBalances[coinType] = Number(balance) / Math.pow(10, decimal);
      }

    }));

    if (ifPrettyPrint) {
      for (const coinType in coinBalances) {
        if (AddressMap.hasOwnProperty(coinType)) {
          console.log("Coin Type: ", AddressMap[coinType], "| Balance: ", coinBalances[coinType]);
        }
        else {
          console.log("Unknown Coin Type: ", coinType, "| Balance: ", coinBalances[coinType]);

        }
      }
    }
    return coinBalances;
  }

  /**
   * Retrieves coin objects based on the specified coin type.
   * @param coinType - The coin type to retrieve coin objects for. Defaults to "0x2::sui::SUI".
   * @returns A Promise that resolves to the retrieved coin objects.
   */
  async getCoins(coinType: any = "0x2::sui::SUI") {
    const coinAddress = coinType.address ? coinType.address : coinType;

    const coininfo = await this.client.getCoins({
      owner: this.address,
      coinType: coinAddress
    })
    return coininfo;
  }


  /**
   * Creates an account capability.
   * @returns A Promise that resolves to the result of the account creation.
   */
  async createAccountCap() {
    let txb = new TransactionBlock();
    let sender = this.getPublicKey();
    txb.setSender(sender);

    const [ret] = txb.moveCall({
      target: `${config.ProtocolPackage}::lending::create_account`,
    });
    txb.transferObjects([ret], this.getPublicKey());
    const result = SignAndSubmitTXB(txb, this.client, this.keypair);
    return result;
  }

  /**
   * Sends coins to multiple recipients.
   * 
   * @param coinType - The type of coin to send.
   * @param recipient - An array of recipient addresses.
   * @param amounts - An array of amounts to send to each recipient.
   * @returns A promise that resolves to the result of the transaction.
   * @throws An error if the number of recipients does not match the number of amounts, or if the sender has insufficient balance.
   */
  async sendCoinToMany(
    coinType: any,
    recipient: string[],
    amounts: number[]
  ) {
    const coinAddress = coinType.address ? coinType.address : coinType;

    if (recipient.length !== amounts.length) {
      throw new Error(
        "transferSuiToMany: recipients.length !== amounts.length"
      );
    }
    let sender = this.getPublicKey();
    const coinBalance = await getCoinAmount(
      this.client,
      this.getPublicKey(),
      coinAddress
    );

    if (
      coinBalance > 0 &&
      coinBalance >= amounts.reduce((a, b) => a + b, 0)
    ) {
      const txb = new TransactionBlock();
      txb.setSender(sender);
      let getCoinInfo = await this.getCoins(
        coinAddress
      );
      let coins: any;
      if (coinAddress == "0x2::sui::SUI") {
        coins = txb.splitCoins(txb.gas, amounts);
      } else {
        //Merge other coins to one obj if there are multiple
        if (getCoinInfo.data.length >= 2) {
          let baseObj = getCoinInfo.data[0].coinObjectId;
          let i = 1;
          while (i < getCoinInfo.data.length) {
            txb.mergeCoins(baseObj, [getCoinInfo.data[i].coinObjectId]);
            i++;
          }
        }
        let mergedCoin = txb.object(getCoinInfo.data[0].coinObjectId);

        coins = txb.splitCoins(mergedCoin, amounts);
      }
      recipient.forEach((address, index) => {
        txb.transferObjects([coins[index]], address);
      });

      const result = SignAndSubmitTXB(txb, this.client, this.keypair);
      return result;
    } else {
      throw new Error("Insufficient balance for this Coin");
    }
  }

  /**
   * Sends a specified amount of coins to a recipient.
   * 
   * @param coinType - The type of coin to send.
   * @param recipient - The address of the recipient.
   * @param amount - The amount of coins to send.
   * @returns A promise that resolves when the coins are sent.
   */
  async sendCoin(
    coinType: any,
    recipient: string,
    amount: number
  ) {
    const coinAddress = coinType.address ? coinType.address : coinType;

    return await this.sendCoinToMany(
      coinAddress,
      [recipient],
      [amount]
    );
  }

  /**
   * Transfers multiple objects to multiple recipients.
   * @param objects - An array of objects to be transferred.
   * @param recipients - An array of recipients for the objects.
   * @returns A promise that resolves with the result of the transfer.
   * @throws An error if the length of objects and recipient arrays are not the same.
   */
  async transferObjsToMany(
    objects: string[],
    recipients: string[]
  ) {
    if (objects.length !== recipients.length) {
      throw new Error("The length of objects and recipient should be the same");
    } else {
      let sender = this.getPublicKey();
      const txb = new TransactionBlock();
      txb.setSender(sender);
      objects.forEach((object, index) => {
        txb.transferObjects([txb.object(object)], recipients[index]);
      });
      const result = SignAndSubmitTXB(txb, this.client, this.keypair);
      return result;
    }
  }

  /**
   * Transfers an object to a recipient.
   * @param object - The object to be transferred.
   * @param recipient - The recipient of the object.
   * @returns A promise that resolves when the transfer is complete.
   */
  async transferObj(object: string, recipient: string) {
    return await this.transferObjsToMany([object], [recipient]);
  }

  /**
   * Deposits a specified amount of a given coin type to Navi.
   * @param coinType - The coin type to deposit.
   * @param amount - The amount to deposit.
   * @returns A promise that resolves to the result of the deposit transaction.
   * @throws An error if there is insufficient balance for the coin.
   */
  async depositToNavi(
    coinType: CoinInfo,
    amount: number
  ) {
    const coinSymbol = coinType.symbol;

    let txb = new TransactionBlock();
    let sender = this.getPublicKey();
    txb.setSender(sender);
    console.log(coinSymbol)
    const pool_real: PoolConfig = pool[coinSymbol as keyof Pool];

    let getCoinInfo = await this.getCoins(coinType.address);
    if (!getCoinInfo.data[0]) {
      throw new Error("Insufficient balance for this Coin");
    }
    if (coinSymbol == "Sui") {
      const [to_deposit] = txb.splitCoins(txb.gas, [amount]);
      depositCoin(txb, pool_real, to_deposit, amount);
    } else {
      //Try to merge all the tokens to one object
      const mergedCoinObject = mergeCoins(txb, getCoinInfo);
      depositCoin(txb, pool_real, mergedCoinObject, amount);
    }
    const result = SignAndSubmitTXB(txb, this.client, this.keypair);
    return result;
  }

  /**
   * Deposits a specified amount of a given coin type to Navi with an account cap address.
   * @param coinType - The coin type to deposit.
   * @param amount - The amount to deposit.
   * @param accountCapAddress - The account cap address.
   * @returns A promise that resolves to the result of the deposit transaction.
   * @throws An error if there is insufficient balance for the coin.
   */
  async depositToNaviWithAccountCap(
    coinType: CoinInfo,
    amount: number,
    accountCapAddress: string
  ) {
    const coinSymbol = coinType.symbol ? coinType.symbol : coinType;

    let txb = new TransactionBlock();
    let sender = this.getPublicKey();
    txb.setSender(sender);
    const pool_real: PoolConfig = pool[coinSymbol as keyof Pool];

    let getCoinInfo = await this.getCoins(coinType.address);
    if (!getCoinInfo.data[0]) {
      throw new Error("Insufficient balance for this Coin");
    }
    if (coinSymbol == "Sui") {
      const [to_deposit] = txb.splitCoins(txb.gas, [amount]);
      depositCoinWithAccountCap(txb, pool_real, to_deposit, accountCapAddress);
    } else {
      //Try to merge all the tokens to one object
      const mergedCoinObject = mergeCoins(txb, getCoinInfo);
      depositCoinWithAccountCap(
        txb,
        pool_real,
        mergedCoinObject,
        accountCapAddress
      );
    }
    const result = SignAndSubmitTXB(txb, this.client, this.keypair);
    return result;
  }

  /**
   * Withdraws a specified amount of coins.
   * @param coinType - The type of coin to withdraw.
   * @param amount - The amount of coins to withdraw.
   * @returns A promise that resolves to the result of the withdrawal.
   */
  async withdraw(coinType: CoinInfo, amount: number) {

    const coinSymbol = coinType.symbol ? coinType.symbol : coinType;
    let txb = new TransactionBlock();
    let sender = this.getPublicKey();
    txb.setSender(sender);
    const pool_real: PoolConfig = pool[coinSymbol as keyof Pool];
    console.log(pool_real)
    withdrawCoin(txb, pool_real, amount);
    const result = SignAndSubmitTXB(txb, this.client, this.keypair);
    return result;
  }

  /**
   * Withdraws a specified amount of coins with an account cap.
   * 
   * @param coinType - The type of coin to withdraw.
   * @param withdrawAmount - The amount of coins to withdraw.
   * @param accountCapAddress - The address of the account cap.
   * @returns A promise that resolves to the result of the withdrawal.
   */
  async withdrawWithAccountCap(
    coinType: CoinInfo,
    withdrawAmount: number,
    accountCapAddress: string
  ) {
    const coinSymbol = coinType.symbol ? coinType.symbol : coinType;

    let txb = new TransactionBlock();
    let sender = this.getPublicKey();
    txb.setSender(sender);
    const pool_real: PoolConfig = pool[coinSymbol as keyof Pool];
    withdrawCoinWithAccountCap(
      txb,
      pool_real,
      accountCapAddress,
      withdrawAmount,
      sender
    );

    const result = SignAndSubmitTXB(txb, this.client, this.keypair);
    return result;
  }

  /**
   * Borrows a specified amount of a given coin.
   * 
   * @param coinType - The type of coin to borrow.
   * @param borrowAmount - The amount of the coin to borrow.
   * @returns A promise that resolves to the result of the borrowing operation.
   */
  async borrow(
    coinType: CoinInfo,
    borrowAmount: number
  ) {
    const coinSymbol = coinType.symbol ? coinType.symbol : coinType;

    let txb = new TransactionBlock();
    let sender = this.getPublicKey();
    txb.setSender(sender);
    const pool_real: PoolConfig = pool[coinSymbol as keyof Pool];
    borrowCoin(txb, pool_real, borrowAmount);
    const result = SignAndSubmitTXB(txb, this.client, this.keypair);
    return result;
  }

  /**
   * Repays a specified amount of a given coin type.
   * 
   * @param coinType - The coin type or coin symbol to repay.
   * @param repayAmount - The amount to repay.
   * @returns A promise that resolves to the result of the repayment transaction.
   * @throws An error if there is insufficient balance for the specified coin.
   */
  async repay(coinType: CoinInfo, repayAmount: number) {
    const coinSymbol = coinType.symbol ? coinType.symbol : coinType;

    let txb = new TransactionBlock();
    let sender = this.getPublicKey();
    txb.setSender(sender);
    const pool_real: PoolConfig = pool[coinSymbol as keyof Pool];

    let getCoinInfo = await this.getCoins(coinType.address);
    if (!getCoinInfo.data[0]) {
      throw new Error("Insufficient balance for this Coin");
    }
    if (coinSymbol == "Sui") {
      const [to_deposit] = txb.splitCoins(txb.gas, [repayAmount]);

      repayDebt(txb, pool_real, to_deposit, repayAmount);
    } else {
      //Try to merge all the tokens to one object
      const mergedCoinObject = mergeCoins(txb, getCoinInfo);
      repayDebt(txb, pool_real, mergedCoinObject, repayAmount);
    }

    const result = SignAndSubmitTXB(txb, this.client, this.keypair);
    return result;
  }

  /**
   * Retrieves the health factor for a given address.
   * @param address - The address for which to retrieve the health factor. Defaults to the instance's address.
   * @returns The health factor as a number.
   */
  async getHealthFactor(address: string = this.address) {
    const result: any = await moveInspect(this.client, this.getPublicKey(), `${config.ProtocolPackage}::logic::user_health_factor`, [
      '0x06', // clock object id
      config.StorageId, // object id of storage
      config.PriceOracle, // object id of price oracle
      address, // user address
    ]);
    const healthFactor = Number(result[0]) / Math.pow(10, 27);

    return healthFactor;
  }

  /**
   * Retrieves the dynamic health factor for a given user in a specific pool.
   * @param sender - The address of the user.
   * @param poolName - The name of the pool.
   * @param estimateSupply - The estimated supply value (default: 0).
   * @param estimateBorrow - The estimated borrow value (default: 0).
   * @param is_increase - A boolean indicating whether the health factor is increasing (default: true).
   * @returns The health factor for the user in the pool.
   * @throws Error if the pool does not exist.
   */
  async getDynamicHealthFactorAll(sender: string, poolName: string, estimateSupply: number = 0, estimateBorrow: number = 0, is_increase: boolean = true) {
    const _pool: PoolConfig = pool[poolName as keyof Pool];
    if (!_pool) {
      throw new Error("Pool does not exist");
    }

    const result: any = await moveInspect(this.client, this.getPublicKey(), `${config.ProtocolPackage}::dynamic_calculator::dynamic_health_factor`, [
      '0x06', // clock object id
      config.StorageId, // object id of storage
      config.PriceOracle, // object id of price oracle
      _pool.poolId,
      sender, // user address,
      _pool.assetId,
      estimateSupply,
      estimateBorrow,
      is_increase
    ], [_pool.type]);

    const healthFactor = Number(result[0]) / Math.pow(10, 27);


    if (estimateSupply > 0) {
      console.log('With EstimateSupply Change: ', `${estimateSupply}`, ' address: ', `${sender}`, ' health factor is: ', healthFactor.toString());
    }
    else if (estimateBorrow > 0) {
      console.log('With EstimateBorrow Change: ', `${estimateBorrow}`, ' address: ', `${sender}`, ' health factor is: ', healthFactor.toString());
    }
    else {
      console.log('address: ', `${sender}`, ' health factor is: ', healthFactor.toString());
    }
  }

  /**
   * Retrieves the decimal value for a given coin type.
   * If the coin type has an address property, it uses that address. Otherwise, it uses the coin type itself.
   * 
   * @param coinType - The coin type or coin object.
   * @returns The decimal value of the coin.
   */
  async getCoinDecimal(coinType: any) {

    const coinAddress = coinType.address ? coinType.address : coinType;

    const decimal = await getCoinDecimal(this.client, coinAddress);
    return decimal;
  }

  parseResult(msg: any) {
    console.log(JSON.stringify(msg, null, 2));
  }

  /**
   * Retrieves the reserves using the client's `getDynamicFields` method.
   * Parses the result using the `parseResult` method.
   */
  async getReserves() {
    const result = await this.client.getDynamicFields({ parentId: config.ReserveParentId });
    return result;
  }

  /**
   * Retrieves the detailed information of a reserve based on the provided asset ID.
   * @param assetId - The ID of the asset for which to retrieve the reserve details.
   * @returns A Promise that resolves to the parsed result of the reserve details.
   */
  async getReservesDetail(assetId: number) {
    const result = await this.client.getDynamicFieldObject({ parentId: config.ReserveParentId, name: { type: 'u8', value: assetId } });
    return result;
  }

  /**
   * Retrieves the NAVI portfolio for the current account.
   * @param ifPrettyPrint - A boolean indicating whether to print the portfolio in a pretty format. Default is true.
   * @returns A Promise that resolves to a Map containing the borrow and supply balances for each reserve.
   */
  async getNAVIPortfolio(ifPrettyPrint: boolean = true): Promise<Map<string, { borrowBalance: number, supplyBalance: number }>> {
    const balanceMap = new Map<string, { borrowBalance: number, supplyBalance: number }>();
    if (ifPrettyPrint) {
      console.log("| Reserve Name | Borrow Balance | Supply Balance |");
      console.log("|--------------|----------------|----------------|");
    }
    await Promise.all(Object.keys(pool).map(async (poolKey) => {
      const reserve: PoolConfig = pool[poolKey as keyof Pool];
      const decimal = await getCoinDecimal(this.client, reserve.type);
      const borrowBalance: any = await this.client.getDynamicFieldObject({ parentId: reserve.borrowBalanceParentId, name: { type: 'address', value: this.getPublicKey() } });
      const supplyBalance: any = await this.client.getDynamicFieldObject({ parentId: reserve.supplyBalanceParentId, name: { type: 'address', value: this.getPublicKey() } });

      const borrowValue = borrowBalance && borrowBalance.data?.content?.fields.value !== undefined ? borrowBalance.data?.content?.fields.value / Math.pow(10, decimal) : 0;
      const supplyValue = supplyBalance && supplyBalance.data?.content?.fields.value !== undefined ? supplyBalance.data?.content?.fields.value / Math.pow(10, decimal) : 0;
      if (ifPrettyPrint) {
        console.log(`| ${reserve.name} | ${borrowValue} | ${supplyValue} |`);
      }
      balanceMap.set(reserve.name, { borrowBalance: borrowValue, supplyBalance: supplyValue });
    }));

    return balanceMap;
  }

}