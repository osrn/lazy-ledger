import { Managers, Transactions, Utils } from "@solar-network/crypto";
import { Container, Contracts, Providers, Utils as AppUtils} from "@solar-network/kernel";
import { IBill } from "./interfaces";
import { Database, databaseSymbol } from "./database";
import { ConfigHelper, configHelperSymbol } from "./config_helper";
import { Processor } from "./processor";
import { CronJob } from "cron";
import delay from "delay";
// import { Handlers } from "@solar-network/transactions";
// import { CoreTransactionType, TransactionType, TransactionTypeGroup } from "@packages/crypto/dist/enums";

export const tellerSymbol = Symbol.for("LazyLedger<Teller>");

// Destructure object to retrieve only needed properties
const unpack = ({y, m, d, q, payeeType, address}) => ({y, m, d, q, payeeType, address});
// flatten object values to construct a comparable string
const flatten = (obj) => (Object.values(obj).reduce((prev, curr) => prev + (prev === '' ? '' : ':') + String(curr), '' ));


@Container.injectable()
export class Teller{
    @Container.inject(Container.Identifiers.Application)
    private readonly app!: Contracts.Kernel.Application;

    @Container.inject(Container.Identifiers.LogService)
    private readonly logger!: Contracts.Kernel.Logger;

    @Container.inject(configHelperSymbol)
    private readonly configHelper!: ConfigHelper;

    @Container.inject(Symbol.for("LazyLedger<Processor>"))
    private readonly processor!: Processor;

    // @Container.inject(Container.Identifiers.TransactionHandlerRegistry)
    // @Container.tagged("state", "copy-on-write")
    // private readonly handlerRegistry!: Handlers.Registry;
    
    @Container.inject(Container.Identifiers.PoolProcessor)
    private readonly poolProcessor!: Contracts.Pool.Processor;

    @Container.inject(Container.Identifiers.PluginConfiguration)
    @Container.tagged("plugin", "@solar-network/pool")
    private readonly poolConfiguration!: Providers.PluginConfiguration;

    private sqlite!: Database;
    private cronStmt!: string;
    private cronJob!: CronJob;
    private active: boolean = false;
    // private balanceAfterLastTx: Utils.BigNumber = Utils.BigNumber.ZERO;
    // private active: boolean = false;

    public async boot(): Promise<void> {
        this.sqlite = this.app.get<Database>(databaseSymbol);
        this.cron();
        // if (this.configHelper.getConfig().postInitInstantPay) {
        //     this.instantPay();
        // }        
        this.logger.info("(LL) Teller boot complete");
    }

    private cron(): void {
        const plan = this.configHelper.getPresentPlan(); 
        
        if (plan.payperiod == 0) {
            this.logger.debug(`(LL) Teller schedule not started as Plan Payment Period is 0`);
        }
        else {
            // When relay starts, we do not know how long had it been since last CRON run. 
            // If payperiod < 1 day, no trouble CRON can start as of today, however if payperiod spans multiple days,
            // we need to find how many days since, and set an anchor point accordingly to run the next one right on schedule. 
            const lastcron_ts = AppUtils.formatTimestamp(this.sqlite.getLastPayAttempt()?.timestamp || 0).unix;
            const today = new Date();
            const daysSinceLastCron = (today.setUTCHours(0,0,0,0) - new Date(lastcron_ts * 1000).setUTCHours(0,0,0,0)) / 86400000; //set the clock to 00:00 before getting the day difference
            const diff = Math.floor(plan.payperiod / 24) - daysSinceLastCron; // has last payperiod expired?
            const cronStartDay = diff > 0 ? today.getDay() - diff : today.getDay();

            // Seconds: 0-59
            // Minutes: 0-59
            // Hours: 0-23
            // Day of Month: 1-31
            // Months: 0-11 (Jan-Dec)
            // Day of Week: 0-6 (Sun-Sat)
            // this.cronStmt = "0 0/2 * * * *"; // Temp cron every 2 minutes for testing with instead of the configured plan
            this.cronStmt = plan.payperiod <= 24 ? `0 ${plan.guardtime} ${plan.payoffset % plan.payperiod}/${plan.payperiod} * * *` 
                                                 : `0 ${plan.guardtime} ${plan.payoffset} ${cronStartDay}/${plan.payperiod} * *`;

            this.cronJob = new CronJob(this.cronStmt, this.getBill, null, true, undefined, this, undefined, 0);

            this.logger.debug(`(LL) Teller schedule ${this.cronStmt} started. Next 3 runs will be ${this.cronJob.nextDates(3)}`);
        }
    }

    public restartCron(): void {
        if (this.cronJob && this.cronJob.running) {
            this.cronJob.stop();
            this.logger.debug(`(LL) Teller renewing schedule. Active schedule ${this.cronStmt} stopped.`);
        }
        this.cron();
    }

    public instantPay(): void {
        if (!this.active) {
            this.logger.debug(`(LL) Post-init instant payment request granted.`);
            this.getBill();
        }
    }

    private async getBill(): Promise<IBill[]> {
        if (this.processor.isInitialSync()) {
            this.logger.debug(`(LL) Teller run skipped due Processor initial sync in progress. Next run is ${this.cronJob && this.cronJob.nextDates().toISOString()}`);
            return [];
        }
        this.active = true;
        this.configHelper.getConfig().postInitInstantPay = false;
        const now = new Date();
        this.logger.debug(`(LL) Teller run starting at ${now.toUTCString()}`);

        // Get the plan valid for timestamp = now
        const plan = this.configHelper.getPresentPlan();
        plan.payperiod ||= 24; // prevent div/0 if payperiod=0 with postInitInstantPay=true

        // Filter out delegate address in allocations query?
        const exclude: string | undefined = this.configHelper.getConfig().excludeSelfFrTx ? this.configHelper.getConfig().delegateAddress : undefined;
        // Fetch the allocations from local db
        const bill: IBill[] = this.sqlite.getBill(plan.payperiod, plan.payoffset, now, exclude);
        this.logger.debug(`(LL) Fetched ${bill.length} allocations from the database`);
        // this.logger.debug(`(LL) trace: bill:IBill[]=\n${JSON.stringify(bill, null, 4)}`);

        if (bill.length == 0) {
            this.logger.debug(`(LL) Teller run complete. Next run is ${this.cronJob && this.cronJob.nextDates().toISOString()}`);
            return [];
        }
        
        let pay_order = [...bill]; //work on a clone
        // pivot sum
        pay_order = this.objArrayPivotSum(pay_order, ['y', 'm', 'd', 'q', 'payeeType', 'address'], ['allotment']) as IBill[];
        this.logger.debug(`(LL) Allocations summarized to ${pay_order.length} bill items after pivoting by pay-period, type and address`);
        // this.logger.debug(`(LL) trace: after pivot sum, pay_order:IBill[]=\n${JSON.stringify(pay_order, null, 4)}`);

        let pay_orders: IBill[][] = [];

        if (this.configHelper.getConfig().mergeAddrsInTx) {
            // consolidate the addresses together into a summarized distinct array
            pay_orders.push(this.objArrayPivotSum(pay_order, ['address'], ['allotment']) as IBill[]);
            this.logger.debug(`(LL) Bill items produced ${pay_order.length > 0 ? 1 : 0} pay-order of ${pay_orders[0]?.length} items after consolidating on address`);
        }
        else { 
            // reorganize the pay_order in groups of payment periods, to be paid in seperate transactions
            pay_orders = this.objArrayGroupBy(pay_order, (obj) => [obj.y,obj.m,obj.d,obj.q]);
            this.logger.debug(`(LL) Bill items produced ${pay_orders.length} pay-orders after grouping by pay-period`);
        }
        // this.logger.debug(`(LL) trace: after pay_order regrouping pay_orders:IBill[][]=\n${JSON.stringify(pay_orders, null, 4)}`);
        
        let txCounter = 0;
        const maxTxPerSender = this.poolConfiguration.getRequired<number>("maxTransactionsPerSender");
        const maxAddressesPerTx = Managers.configManager.getMilestone().transfer.maximum || 256;
        const blockTime = Managers.configManager.getMilestone().blockTime || 8;

        for (const order of pay_orders) {
            if (order.length == 0) 
                break;
                
            let pay_order_chunks = [ order ];
            if (pay_order.length > maxAddressesPerTx) {
                pay_order_chunks = this.txChunks(order, maxAddressesPerTx);
            }
            this.logger.debug(`(LL) Pay-order will be processed in ${pay_order_chunks.length} chunks of transactions`);
            // this.logger.debug(`(LL) trace: order after chunking, pay_order_chunks:IBill[][]=\n${JSON.stringify(pay_order_chunks, null, 4)}`);

            let chunkCounter = 1;
            for (const chunk of pay_order_chunks) {
                // this.logger.debug(`(LL) trace: chunk about to be passed to pay processor, chunk:IBill[]=\n${JSON.stringify(chunk, null, 4)}`);
                if (txCounter >= maxTxPerSender) {
                    this.logger.debug(`(LL) Maximum transactions per sender limit (${maxTxPerSender}) reached. Waiting ${blockTime} seconds for the next block`);
                    await delay(blockTime * 1000); //await next forging slot
                    txCounter = 0;
                }
                // Unless mergeAddrsInTx enabled, chunk entries has the same y, m, d, q. Get the first entry to compose the memo
                const fe = chunk[0];
                let msgStamp = `${fe.y}-${fe.m}-${fe.d}-${fe.q}/${24/plan.payperiod}`;
                let msg = `${this.configHelper.getConfig().delegate} rewards for ${msgStamp}`;
                if (this.configHelper.getConfig().mergeAddrsInTx) {
                    msgStamp = "";
                    msg = `${this.configHelper.getConfig().delegate} reward sharing`;
                }

                // Pass to payment processor
                this.logger.debug(`(LL) Processing chunk#${chunkCounter} of pay-order ${msgStamp}`);
                const txid = await this.payBill(chunk, msg);

                // On return, add txid to relevant allocations in the local db
                if (txid && txid.length > 0) {
                    if (this.configHelper.getConfig().mergeAddrsInTx) {
                        // pay-order has distinct addresses. get those included in this transaction
                        const addrlist = chunk.map(e => e.address);
                        // filter the original bill (list of allocations) for these addresses, returning their rowid
                        const idlist: number[] = bill.filter(e => addrlist.includes(e.address)).map(e => e.rowid);
                        const { changes } = await this.sqlite.setTransactionId(txid, idlist);
                        this.logger.debug(`(LL) Wrote txid ${txid} to ${changes} allocations`);
                    }
                    else {
                        // pay-order has distinct y,m,d,q,type and address. get those included in this transaction
                        const addrlist = chunk.map(e => flatten(unpack(e)));
                        // filter the original bill (list of allocations) for these distinct entries, returning their rowid
                        const idlist: number[] = bill.filter(e => addrlist.includes(flatten(unpack(e)))).map(e => e.rowid);
                        const { changes } = await this.sqlite.setTransactionId(txid, idlist);
                        this.logger.debug(`(LL) Wrote txid ${txid} to ${changes} allocations`);
                    }
                    // Add transaction id to Processor's watchlist to confirm payment
                    this.processor.txWatchPoolAdd( [ txid ] );
                    this.logger.debug(`(LL) Added txid ${txid} to (transaction applied event) watchlist`);
                    txCounter += 1;
                }
                else {
                    //TODO: notify and log error
                }
                chunkCounter++;
                await delay(10);
            }

            if (txCounter >= maxTxPerSender) {
                this.logger.debug(`(LL) Maximum transactions per sender limit (${maxTxPerSender}) reached. Waiting ${blockTime} seconds for the next block`);
                await delay(blockTime * 1000); //await next forging slot
                txCounter = 0;
            }
            else {
                await delay(100);
            }
        }
        this.logger.debug(`(LL) Teller run complete. Next run is ${this.cronJob && this.cronJob.nextDates().toISOString()}`);
        this.active = false;
        return pay_order;
    }

    private async payBill(payments: IBill[], msg: string): Promise<string | undefined> {
        const config = this.configHelper.getConfig();
        const plan = this.configHelper.getPresentPlan(); 
        const pool = this.app.get<Contracts.Pool.Service>(Container.Identifiers.PoolService);
        
        let nonce = pool.getPoolWallet(config.delegateAddress!)?.getNonce().plus(1) || config.delegateWallet!.getNonce().plus(1);
        // console.log("pool wallet"); console.log(pool.getPoolWallet(config.delegateAddress!));
        // console.log("delegate wallet"); console.log(config.delegateWallet);

        const dynfee = this.getDynamicFee(payments.length, msg.length, !!config.secondpass);

        const transaction = Transactions.BuilderFactory.multiPayment()
            .memo(msg)
            .nonce(nonce.toFixed())
            .fee(dynfee.toFixed());

        // this.logger.debug(`(LL) incoming pay order: ${JSON.stringify(payments)}`);
        this.logger.debug(`(LL) Constructing transaction...`);
        let txTotal: Utils.BigNumber = Utils.BigNumber.ZERO;
        let feeDeducted: boolean = false;
        for (const p of payments) {
            if (config.reservePaysFees && !feeDeducted && p.address === plan.reserves[0].address ) {
                const deducted = Utils.BigNumber.make(p.allotment).minus(dynfee).toFixed();
                transaction.addPayment(p.address, deducted);
                feeDeducted = true; //deduct the fee only once
            }
            else {
                transaction.addPayment(p.address, p.allotment);
            }
            txTotal = txTotal.plus(p.allotment);
        }
        const walletBalance = pool.getPoolWallet(config.delegateAddress!)?.getBalance() || config.delegateWallet!.getBalance();
        if (walletBalance.isLessThan(txTotal.plus(dynfee))) {
            this.logger.critical(`(LL) Insufficient wallet balance to execute this pay order. Available:${Utils.formatSatoshi(walletBalance)} Required:${Utils.formatSatoshi(txTotal.plus(dynfee))}`);
            return;
        }
        this.logger.debug(`(LL) Sufficient wallet balance to execute this pay order. Available:${Utils.formatSatoshi(walletBalance)} Required:${Utils.formatSatoshi(txTotal.plus(dynfee))}`);
        transaction.sign(config.passphrase);
        if (config.secondpass) {
            transaction.secondSign(config.secondpass);
        }
        
        const struct = transaction.getStruct();

        this.logger.debug(`(LL) Passing transaction to Pool Processor | ${JSON.stringify(struct)}`);
        const result = await this.poolProcessor.process([struct]);
        this.logger.debug(`(LL) Pool Processor answered with | ${JSON.stringify(result)}`);

        if (result.accept.length > 0) {
            this.logger.debug(`(LL) Transaction txid ${result.accept[0]} successfully sent!`);
        } 
        else {
            this.logger.error("(LL) An error occurred sending transaction:");
            if (result.invalid.length > 0) {
                this.logger.error(`(LL) ${result.errors![result.invalid[0]].type}: ${result.errors![result.invalid[0]].message}`);
            } else if (result.excess.length > 0) {
                this.logger.warning("(LL) Pool cannot currently accept this transaction, please try later");
            }
        }
        return result.accept[0];
    }

    /*private dynamicFee({addonBytes, satoshiPerByte, transaction}: Contracts.Shared.DynamicFeeContext): Utils.BigNumber {
        addonBytes = addonBytes || 0;

        if (satoshiPerByte <= 0) {
            satoshiPerByte = 1;
        }

        const transactionSizeInBytes: number = Math.round(transaction.serialised.length / 2);
        return Utils.BigNumber.make(addonBytes + transactionSizeInBytes).times(satoshiPerByte);
    }

    private getMinimumFee(transaction: Interfaces.ITransaction): Utils.BigNumber {
        const milestone = Managers.configManager.getMilestone();

        if (milestone.dynamicFees && milestone.dynamicFees.enabled) {
            const addonBytes: number = milestone.dynamicFees.addonBytes[transaction.key];

            const minFee: Utils.BigNumber = this.dynamicFee({
                transaction,
                addonBytes,
                satoshiPerByte: milestone.dynamicFees.minFee,
            });

            return minFee;
        }
        return Utils.BigNumber.ZERO;
    }*/

    private getDynamicFee(rcptCount:number, memoSize:number, hasSecondSig: boolean): Utils.BigNumber {
        const milestone = Managers.configManager.getMilestone();

        if (milestone.dynamicFees && milestone.dynamicFees.enabled) {
            const addonBytes: number = milestone.dynamicFees.addonBytes.transfer;
            let satoshiPerByte: number = milestone.dynamicFees.minFee;
            if (satoshiPerByte <= 0) {
                satoshiPerByte = 1;
            }

            const size = 125 + (hasSecondSig ? 64 : 0) + memoSize + (29 * rcptCount);
            const transactionSizeInBytes: number = Math.round(size / 2);
            return Utils.BigNumber.make(addonBytes + transactionSizeInBytes).times(satoshiPerByte);
        }
        return Utils.BigNumber.ZERO;
    }

    private txChunks(arr: any[], len: number) {
        const chunks: any[] = [];
        let i = 0,
            n = arr.length;
        while (i < n) {
            chunks.push(arr.slice(i, i += len));
        }
        return chunks;
    }

    /**
     * Calculates the sum of values in an object array grouped by specified keys
     * @param object_array 
     * @param group_by_keys ['property1', 'property2']
     * @param sum_keys ['property3', 'property4']
     * @returns [{},]
     */
    private objArrayPivotSum(object_array, group_by_keys, sum_keys) {
        return Object.values(
            object_array.reduce((acc, curr) => {
                const group = group_by_keys.map(k => curr[k]).join('-');
                acc[group] = acc[group] || Object.fromEntries(group_by_keys.map(k => [k, curr[k]]).concat(sum_keys.map(k => [k, 0])));
                // sum_keys.forEach(k => acc[group][k] += curr[k]);
                sum_keys.forEach(k => acc[group][k] = Utils.BigNumber.make(acc[group][k]).plus(curr[k]));
                return acc;
            }, {})
        );
    }

    /**
     * Returns a new array grouped by specified properties
     * @param obj_array 
     * @param group_by_keys (obj) => [obj.property1,obj.property2]
     * @returns [[{},]]
     */
    private objArrayGroupBy(obj_array, group_by_keys) {
        const groups = {};
        obj_array.forEach(item => {
            const group = JSON.stringify(group_by_keys(item));
            groups[group] = groups[group] || [];
            groups[group].push(item);
        });
        return Object.keys(groups).map( (group) => groups[group] );
    }
}