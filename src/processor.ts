import { Interfaces, Utils } from "@solar-network/crypto";
import { DatabaseService, Repositories } from "@solar-network/database";
import { Container, Contracts, Enums as AppEnums, Services, Utils as AppUtils } from "@solar-network/kernel";
import { IAllocation, IForgedBlock, IMissedBlock, PayeeTypes } from "./interfaces";
import { ConfigHelper, configHelperSymbol } from "./config_helper";
import { Database, databaseSymbol } from "./database";
import { Teller, tellerSymbol } from "./teller";
import { TxRepository, txRepositorySymbol } from "./tx_repository";
import delay from "delay";

export const processorSymbol = Symbol.for("LazyLedger<Processor>");

@Container.injectable()
export class Processor {
    @Container.inject(Container.Identifiers.Application)
    private readonly app!: Contracts.Kernel.Application;

    @Container.inject(Container.Identifiers.DatabaseBlockRepository)
    private readonly blockRepository!: Repositories.BlockRepository;

    // @Container.inject(Container.Identifiers.PluginConfiguration)
    // @Container.tagged("plugin", "@osrn/lazy-ledger")
    // //private readonly configuration!: Providers.PluginConfiguration;

    @Container.inject(configHelperSymbol)
    private readonly configHelper!: ConfigHelper;

    @Container.inject(Container.Identifiers.DatabaseService)
    private readonly database!: DatabaseService;

    @Container.inject(Container.Identifiers.EventDispatcherService)
    private readonly events!: Contracts.Kernel.EventDispatcher;

    @Container.inject(Container.Identifiers.LogService)
    private readonly logger!: Contracts.Kernel.Logger;

    @Container.inject(Container.Identifiers.WalletRepository)
    @Container.tagged("state", "blockchain")
    private readonly walletRepository!: Contracts.State.WalletRepository;

    //@Container.inject(Container.Identifiers.DatabaseTransactionRepository)
    // private readonly transactionRepository!: Repositories.TransactionRepository;

    @Container.inject(txRepositorySymbol)
    private readonly transactionRepository!: TxRepository;

    private active: boolean = true;
    private initial: boolean = false;
    private lastFetchedBlockHeight: number = 0;
    private sqlite!: Database;
    private teller!: Teller;
    private syncing: boolean = false;
    //private config!: IConfig;
    private txWatchPool: Set<string> = new Set();

    public async boot(): Promise<void> {
        this.sqlite = this.app.get<Database>(databaseSymbol);
        this.teller = this.app.get<Teller>(tellerSymbol);
        this.init();
        this.logger.info("(LL) Processor boot complete");
    }

    private isActive(): boolean {
        return this.active;
    }

    public isSyncing(): boolean {
        return this.syncing;
    }

    public isInitialSync(): boolean {
        return this.initial;
    }

    private finishedInitialSync(): void {
        this.logger.info("(LL) Finished (initial|catch-up) sync");
        this.setInitialSync(false);
        if (this.configHelper.getConfig().postInitInstantPay) {
            this.configHelper.getConfig().postInitInstantPay = false;
            this.teller.instantPay();
        }        
    }

    /*private calcDbRoundHeight(): number {
        return AppUtils.roundCalculator.calculateRound(this.sqlite.getHeight()).roundHeight;
    }*/

    private async getLastBlock(): Promise<Interfaces.IBlockData | undefined> {
        return await this.blockRepository.findLatest();
    }

    private async getLastBlockHeight(): Promise<number> {
        return (await this.getLastBlock())!.height;
    }

    private async getLastForgedBlock(): Promise<Interfaces.IBlockData | undefined> {
        // TODO: Is this the best method for the task?
        const lastForgedBlockId: string = this.configHelper.getConfig().delegateWallet!.getAttribute("delegate.lastBlock");
        return (await this.blockRepository.findById(lastForgedBlockId));
    }

    private async getLastForgedBlockHeight(): Promise<number> {
        // TODO: Is this the best method for the task?
        return (await this.getLastForgedBlock())!.height;
    }

    public txWatchPoolAdd(txids: string[]): void {
        txids.forEach((id) => this.txWatchPool.add(id));
    }

    private async init(): Promise<void> {
        const lastForgedBlock: Interfaces.IBlockData | undefined = await this.getLastForgedBlock();
        const lastForgedBlockHeight: number = lastForgedBlock!.height;
        const lastForgedBlockTimestamp: number = lastForgedBlock!.timestamp;

        this.lastFetchedBlockHeight = this.sqlite.getHeight();

        // roll back if block reverted or a network roll-back occurred
        if (this.lastFetchedBlockHeight > lastForgedBlockHeight) {
            this.sqlite.purgeFrom(lastForgedBlockHeight + 1, lastForgedBlockTimestamp + 1);
            this.lastFetchedBlockHeight = this.sqlite.getHeight();
        }

        // database is behind the network. catch-up.
        if (lastForgedBlockHeight !== this.sqlite.getHeight()) {
            this.setInitialSync(true);
            this.sync();
        }
        else {
            if (this.configHelper.getConfig().postInitInstantPay) {
                this.configHelper.getConfig().postInitInstantPay = false;
                this.teller.instantPay();
            }    
        }

        // find unsettled allocations and stamp if forged
        this.txWatchPoolAdd(this.sqlite.getUnsettledAllocations());
        for (const txid of this.txWatchPool) {
            const forgedTx = await this.transactionRepository.transactionRepository.findById(txid);
            if ( forgedTx ) {
                if (this.sqlite.settleAllocation(txid, AppUtils.formatTimestamp(forgedTx.timestamp).unix).changes > 0) {
                    this.txWatchPool.delete(txid!);
                }
            }
            else {
                this.logger.critical(`(LL) Detected an unsettled allocation in database marked with a non-existing tx with id ${txid}`);
                //TODO: erase the TXid? or leave it to the delegate to inspect and manually delete
                //TOOD: should this check be run as a periodic job, rather than running at relay restart only? (hence erase TXid can be paid in next payment run)
            }
        }
                
        this.events.listen(AppEnums.BlockEvent.Applied, {
            handle: async ({ data }) => {
                // console.log(`(LL) received new block applied event at ${data.height} forged by ${data.generatorPublicKey}`)

                // wait until block is in block repository
                while (data.height > (await this.getLastBlockHeight())) {
                    await delay(100);
                }
                
                if (this.configHelper.getConfig().delegatePublicKey === data.generatorPublicKey) {
                    this.logger.debug(`(LL) Received new block applied event at ${data.height} forged by us`)
                    this.sync();
                }

                // Restart Teller cron if a new plan is in effect by this height/time
                if (this.configHelper.hasPresentPlanChanged()) {
                    this.teller.restartCron();
                }
                // else {
                //     console.log(`(LL) block at ${data.height} with ${data.generatorPublicKey} is not of interest`);
                // }
            },
        });

        this.events.listen(AppEnums.BlockEvent.Reverted, {
            handle: async ({ data }) => {
                // console.log(`(LL) received block reverted event at ${data.height} forged by ${data.generatorPublicKey}`)

                if (this.configHelper.getConfig().delegatePublicKey === data.generatorPublicKey) {
                    this.logger.debug(`(LL) Received block reverted event at ${data.height} previously forged by us`)
                    this.sqlite.purgeFrom(data.height, data.timestamp);
                    this.lastFetchedBlockHeight = this.sqlite.getHeight();
                }
                // else {
                //     console.log(`(LL) block at ${data.height} with ${data.generatorPublicKey} is not of interest`);
                // }

                // Restart Teller cron if a new plan is in effect by this height/time
                if (this.configHelper.hasPresentPlanChanged()) {
                    this.teller.restartCron();
                }
            }
        });

        this.events.listen(AppEnums.RoundEvent.Missed, {
            handle: async ({ data }) => {
                //TODO: handle this in later versions with telegram|discord integration
            },
        });

        this.events.listen(AppEnums.TransactionEvent.Applied, {
            handle: async ({ data }) => {
                // TODO: Do not process if plan at height has payperiod=0, meaning plugin provides database only, payment is handled externally
                // console.log(`(LL) received transaction applied event with id ${data.id}`)
                const d: Interfaces.ITransactionData = data as Interfaces.ITransactionData;
                if (this.txWatchPool.has(d.id!)) {
                    this.logger.debug(`(LL) Received transaction applied event with id ${data.id} which is in the watchlist`)

                    // wait until block is in block repository
                    while (d.blockHeight! > (await this.getLastBlockHeight())) {
                        await delay(100);
                    }

                    // transactions v2 and v3 no longer has a timetamp. Find it from the block it was forged in
                    // and marked the allocation settled.
                    const bl = await this.blockRepository.findByHeight(d.blockHeight!);
                    if (bl && this.sqlite.settleAllocation(d.id!, AppUtils.formatTimestamp(bl.timestamp).unix).changes > 0) {
                        this.txWatchPool.delete(d.id!);
                    }
                }
            },
        });

        this.events.listen(AppEnums.TransactionEvent.Reverted, {
            handle: async ({ data }) => {
                // TODO: Do not process if plan at height has payperiod=0, meaning plugin provides database only, payment is handled externally
                this.logger.debug(`(LL) Received transaction reverted event with id ${data.id}`);

                // Hopefully not many TX reverted events will occur, since the query needs to be executed for each and every one
                // Alternative: keep another watchlist; but it is more expensive
                (this.sqlite.clearTransactionId(data.id).changes > 0);
            },
        });
    }

    private async processBlocks(blocks): Promise<void> {
        const forgedBlocks: IForgedBlock[] = [];
        const missedBlocks: IMissedBlock[] = [];
        const allocations: IAllocation[] = [];

        // Check if Genesis Round wallet[0] has delegate.username attribute
        // TODO: Why?? Is this really needed?? If so, move this back into calling code block; no need to repeat at each pagination!
        const genesisRound: Contracts.State.Wallet[] = (await this.app
            .get<Services.Triggers.Triggers>(Container.Identifiers.TriggerService)
            .call("getActiveDelegates", {roundInfo: AppUtils.roundCalculator.calculateRound(1),})) as Contracts.State.Wallet[];
        if (!genesisRound[0].hasAttribute("delegate.username")) {
            return;
        }
        const blockarray: Interfaces.IBlockData[] = blocks as Interfaces.IBlockData[];
        const blockheights = blockarray.map((block) => block.height);
        this.logger.debug(`(LL) Received batch of ${blocks.length} blocks to process | heights: ${blockheights.toString()}`);

        for (let blockCounter = 0; blockCounter < blocks.length; blockCounter++) {
            const block: Interfaces.IBlockData = blocks[blockCounter];
            const round = AppUtils.roundCalculator.calculateRound(block.height);
            const generatorWallet: Contracts.State.Wallet = this.walletRepository.findByPublicKey(block.generatorPublicKey); // reading from the forged block instead of config.delegateWallet for the plugin may process multiple delegates' payments in the future
            const generator: string = block.height == 1 ? generatorWallet.getAddress() : generatorWallet.getAttribute("delegate.username");
            const devfund: Utils.BigNumber = Object.values(block.devFund!).reduce((a, b) => a.plus(b), Utils.BigNumber.ZERO);
            const voters: { height:number; address: string; balance: Utils.BigNumber; percent: number; vote: Utils.BigNumber; validVote: Utils.BigNumber}[] = [];

            this.logger.debug(`(LL) Processing block | round:${round.round } height:${block.height} timestamp:${block.timestamp} delegate: ${generator} reward:${block.reward} devfund:${devfund} block_fees:${block.totalFee} burned_fees:${block.burnedFee}`)

            const plan = this.configHelper.getPlan(block.height, block.timestamp);
            const voter_roll = await this.transactionRepository.getDelegateVotesByHeight(block.height, generator, block.generatorPublicKey);
            for (const v of voter_roll) {
                const walletAddress: string = this.walletRepository.findByPublicKey(v.publicKey).getAddress();
                const walletBalance = await this.transactionRepository.getNetBalanceByHeightRange(0, block.height, walletAddress, v.publicKey);
                const vote = walletBalance.times(Math.round(v.percent * 100)).div(10000);
                const validVote = vote.isLessThan(plan.mincap) || plan.blacklist.includes(walletAddress) ? 
                    Utils.BigNumber.ZERO : (plan.maxcap && vote.isGreaterThan(plan.maxcap) ? Utils.BigNumber.make(plan.maxcap) : vote);

                voters.push({
                    height: block.height,
                    address: walletAddress,
                    percent: v.percent,
                    balance: walletBalance,
                    vote: vote,
                    validVote: validVote
                });
            }
            //console.log(`(LL) voters\n${JSON.stringify(voters)}`);
            const votes: Utils.BigNumber = voters.map( o => o.vote).reduce((a, b) => a.plus(b), Utils.BigNumber.ZERO);
            const validVotes: Utils.BigNumber = voters.map( o => o.validVote).reduce((a, b) => a.plus(b), Utils.BigNumber.ZERO);
            const timeNow = Math.floor(Date.now() / 1000);
            //console.log(`(LL) forged blocks before\n${JSON.stringify(forgedBlocks)}`);
            forgedBlocks.push({ 
                round: round.round, 
                height: block.height, 
                timestamp: block.timestamp, 
                delegate: generator, 
                reward: block.reward, 
                devfund: devfund, 
                fees: block.totalFee, 
                burnedFees: block.burnedFee === undefined ? Utils.BigNumber.ZERO : block.burnedFee, 
                votes: votes,
                validVotes: validVotes,
                voterCount: voters.length,
            });
            //console.log(`(LL) forged blocks after\n${JSON.stringify(forgedBlocks)}`);

            // const netReward = block.reward.plus(block.totalFee).minus(block.burnedFee!).minus(devfund);
            const earned_tx_fees = block.totalFee.minus(block.burnedFee!);
            const netReward = block.reward.minus(devfund).plus(this.configHelper.getConfig().shareEarnedFees ? earned_tx_fees : Utils.BigNumber.ZERO);
            //console.log(`(LL) allocations before\n${JSON.stringify(allocations)}`);

            for (const r of plan.reserves) {
                let allotted = netReward.times(Math.round(r.share * 100)).div(10000);
                if (!this.configHelper.getConfig().shareEarnedFees && this.configHelper.getConfig().reserveGetsFees && r.address === plan.reserves[0].address) {
                        allotted = allotted.plus(earned_tx_fees);
                }
                allocations.push({
                    height: block.height,
                    address: r.address,
                    payeeType: PayeeTypes.reserve,  
                    vote: Utils.BigNumber.ZERO,
                    validVote: Utils.BigNumber.ZERO,
                    shareRatio: r.share,
                    allotment: allotted,
                    booked: timeNow,
                    transactionId: "",
                    settled: 0
                });
            }
            //console.log(`(LL) allocations after reserves\n${JSON.stringify(allocations)}`);
            for (const d of plan.donations) {
                allocations.push({
                    height: block.height,
                    address: d.address,
                    payeeType: PayeeTypes.donee,  
                    vote: Utils.BigNumber.ZERO,
                    validVote: Utils.BigNumber.ZERO,
                    shareRatio: d.share,
                    allotment: netReward.times(Math.round(d.share * 100)).div(10000),
                    booked: timeNow,
                    transactionId: "",
                    settled: 0
                });
            }
            //console.log(`(LL) allocations after donations\n${JSON.stringify(allocations)}`);
            //console.log(`(LL) voters\n${JSON.stringify(voters)}`);
            for (const v of voters) {
                allocations.push({
                    height: block.height,
                    address: v.address,
                    payeeType: PayeeTypes.voter,  
                    vote: v.vote,
                    validVote: v.validVote,
                    shareRatio: plan.share,
                    allotment: validVotes.isZero() ? Utils.BigNumber.ZERO : netReward.times(Math.round(plan.share * 100)).div(10000).times(v.vote).div(validVotes),
                    booked: timeNow,
                    transactionId: "",
                    settled: 0
                });

            }
            //console.log(`(LL) allocations after voters\n${JSON.stringify(allocations)}`);
        }
        this.sqlite.insert(forgedBlocks, missedBlocks, allocations);
        this.logger.debug(`(LL) Completed processing batch of ${blocks.length} blocks`);
    }

    private setInitialSync(state): void {
        this.initial = state;
    }

    private setSyncing(state): void {
        this.syncing = state;
    }

    private async sync(): Promise<void> {
        if (this.isSyncing() || !this.isActive()) {
            this.logger.debug(`(LL) Already syncing?${this.isSyncing()} active?${this.isActive()}. sync request disregarded.`)
            return;
        }
        this.logger.debug("(LL) Starting sync")
        this.setSyncing(true);
        let loop: boolean = true;
        while (loop) {
            const lastStoredBlockHeight: number = this.sqlite.getHeight();
            const lastChainedBlockHeight: number = await this.getLastBlockHeight();
            const lastForgedBlockHeight: number = await this.getLastForgedBlockHeight();

            if (lastStoredBlockHeight < lastForgedBlockHeight && this.lastFetchedBlockHeight < lastChainedBlockHeight) {
                const blocks: Contracts.Shared.DownloadBlock[] = await this.database.getBlocksForDownload(
                    this.lastFetchedBlockHeight + 1,
                    10000,
                    true);

                if (blocks.length) { //actually redundant when lastFetchedBlockHeight < lastChainedBlockHeight
                    this.lastFetchedBlockHeight = blocks[blocks.length -1].height;
                    const delegatesBlocks = blocks.filter((block) => block.generatorPublicKey === this.configHelper.getConfig().delegatePublicKey);

                    if (delegatesBlocks.length) {
                        await this.processBlocks(delegatesBlocks);
                    } 
                }
                else {
                    loop = false;
                }
            }
            else {
                loop = false;
                this.logger.debug(`(LL) Sync complete | lastChainedBlockHeight:${lastChainedBlockHeight} lastForgedBlockHeight:${lastForgedBlockHeight} lastStoredBlockHeight:${lastStoredBlockHeight}\n`)
                if (this.isInitialSync() && lastStoredBlockHeight === lastForgedBlockHeight) {
                    this.finishedInitialSync();
                }
            }
        }
        this.setSyncing(false);
    }
}
