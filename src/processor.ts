import { Constants, Enums, Interfaces, Utils } from "@solar-network/crypto";
import { DatabaseService, Repositories } from "@solar-network/database";
import { Container, Contracts, Enums as AppEnums, Utils as AppUtils } from "@solar-network/kernel";
import { IAllocation, IConfig, IForgedBlock, IMissedBlock, PayeeTypes } from "./interfaces";
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

    private initial: boolean = false;
    private lastFetchedBlockHeight: number = 0;
    private sqlite!: Database;
    private teller!: Teller;
    private syncing: boolean = false;
    //private config!: IConfig;
    private txWatchPool: Set<string> = new Set();
    // private lastVoterAllocation!: IAllocation[];

    public async boot(): Promise<void> {
        this.sqlite = this.app.get<Database>(databaseSymbol);
        this.teller = this.app.get<Teller>(tellerSymbol);
        this.init();
        this.logger.info("(LL) Processor boot complete");
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
        return this.transactionRepository.getLastForgedBlock(this.configHelper.getConfig().delegate);

        // Initially used method below retired as lastBlock attribute sporadically disappears from the delegate record
        // if (this.configHelper.getConfig().delegateWallet!.hasAttribute("delegate.lastBlock")) {
        //     const lastForgedBlockId: string = this.configHelper.getConfig().delegateWallet!.getAttribute("delegate.lastBlock");
        //     return (await this.blockRepository.findById(lastForgedBlockId));
        // }
        // return undefined;
    }

    private async getLastForgedBlockHeight(): Promise<number> {
        const lastForgedBlock = await this.getLastForgedBlock();
        return lastForgedBlock ? lastForgedBlock.height : 0;
    }

    public txWatchPoolAdd(txids: string[]): void {
        txids.forEach((id) => this.txWatchPool.add(id));
    }

    private async init(): Promise<void> {
        const lastForgedBlock: Interfaces.IBlockData | undefined = await this.getLastForgedBlock();
        const lastForgedBlockHeight: number = lastForgedBlock ? lastForgedBlock!.height : 0;
        const lastForgedBlockTimestamp: number = lastForgedBlock ? lastForgedBlock!.timestamp : 0;

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
                this.logger.critical(`(LL) Detected an unsettled allocation marked with an invalid tx ${txid}`);
                //TODO: erase the TXid? or leave it to the delegate to inspect and manually delete
                //TODO: should this check be run as a periodic job, rather than running at relay restart only? (hence erased TXid can be paid in next payment run)
            }
        }
                
        this.events.listen(AppEnums.BlockEvent.Applied, {
            handle: async ({ data }) => {
                // console.log(`(LL) received new block applied event at ${data.height} forged by ${data.generatorPublicKey}`)

                // wait until block is in repository
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

                // Restart Teller cron if a new plan is in effect by this height/time
                if (this.configHelper.hasPresentPlanChanged()) {
                    this.teller.restartCron();
                }
            }
        });

        this.events.listen(AppEnums.RoundEvent.Missed, {
            handle: async ({ data }) => {
                //TODO: to be handled with telegram|discord integration
            },
        });

        this.events.listen(AppEnums.TransactionEvent.Applied, {
            handle: async ({ data }) => {
                const txData: Interfaces.ITransactionData = data as Interfaces.ITransactionData;
                // console.log(`(LL) received transaction applied event with data ${JSON.stringify(txData,null,4)}`)

                if (txData.typeGroup == Enums.TransactionTypeGroup.Core && txData.type == Enums.TransactionType.Core.Transfer) {
                    // wait until block is in block repository
                    while (txData.blockHeight! > (await this.getLastBlockHeight())) {
                        await delay(100);
                    }
                    const txBlock = await this.blockRepository.findByHeight(txData.blockHeight!);

                    // If the transaction is in the watch list, mark the allocation payment as settled
                    if (this.txWatchPool.has(txData.id!)) {
                        this.logger.debug(`(LL) Received a transaction applied event ${data.id} which is in the watchlist`)

                        // Transactions v2 and v3 no longer has a timetamp. Get it from the block it was forged in
                        if (txBlock && this.sqlite.settleAllocation(txData.id!, AppUtils.formatTimestamp(txBlock.timestamp).unix).changes > 0) {
                            this.logger.debug(`(LL) Marked allocations with txid ${data.id} as settled`)
                            this.txWatchPool.delete(txData.id!);
                        }
                    }
                    // Anti-bot: check for voter originated outbound transfers within 1 round following a forged block - only during real-time processing
                    // and reduce valid vote to the new wallet amount if voter wallet made an outbound transfer within the round
                    // TODO: currently checking for transfer transaction only. voter can still game the system with an HTLC-lock then immediate claim to new wallet.
                    else if (!this.isInitialSync()) {
                        while (this.isSyncing()) {
                            await delay(100);
                        }
                        const config: IConfig = this.configHelper.getConfig();
                        const whitelist = [...config.whitelist, config.delegateAddress];
                        const lastForgedBlock: IForgedBlock = this.sqlite.getLastForged();
                        const lastVoterAllocation: IAllocation[] = this.sqlite.getLastVoterAllocation();

                        if (lastForgedBlock && lastVoterAllocation.length > 0) { // always true unless brand new delegate
                            const txRound = AppUtils.roundCalculator.calculateRound(txData.blockHeight!);
                            
                            if (txRound.round - lastForgedBlock.round <= 1) { // look ahead 1 round
                                const vrecord = lastVoterAllocation.filter( v => !whitelist.includes(v.address)) // exclude white-list
                                                                   .find( v => v.address === txData.senderId); 

                                // sender is a voter. recalculate the voter's valid vote and update last forged block allocations
                                // ("lastVoterAllocation before");console.log(lastVoterAllocation);
                                if (vrecord) {
                                    const txAmount = txData.asset?.transfers?.map(v => v.amount).reduce( (prev,curr) => prev.plus(curr), Utils.BigNumber.ZERO) || Utils.BigNumber.ZERO;
                                    this.logger.debug(`(LL) Anti-bot detected voter ${vrecord.address} balance reduction of ${txAmount.div(Constants.SATOSHI).toFixed()} SXP within round [${lastForgedBlock.round}-${txRound.round}].`)
                                    this.logger.debug(`(LL) Redistributing block allocations for height ${lastForgedBlock.height}.`)

                                    vrecord.balance = vrecord.balance.minus(txAmount).minus(txData.fee); // reduce balance at forged block by the txamount
                                    if (vrecord.balance.isNegative()) // We check outbound transfers only. Voter may have received funds before sending out.
                                        vrecord.balance = Utils.BigNumber.ZERO;
                                    const vote = vrecord.balance.times(Math.round(vrecord.votePercent * 100)).div(10000);
                                    const plan = this.configHelper.getPlan(lastForgedBlock.height, lastForgedBlock.timestamp);
                                    vrecord.validVote = vote.isLessThan(plan.mincap) || plan.blacklist.includes(vrecord.address) ? 
                                        Utils.BigNumber.ZERO : (plan.maxcap && vote.isGreaterThan(plan.maxcap) ? Utils.BigNumber.make(plan.maxcap) : vote);
                
                                    // recalculate allotments for all voters with the new vote distribution
                                    const validVotes = lastVoterAllocation.map( o => o.validVote).reduce((prev, curr) => prev.plus(curr), Utils.BigNumber.ZERO);
                                    const earned_tx_fees = lastForgedBlock.fees.minus(lastForgedBlock.burnedFees);
                                    const netReward = lastForgedBlock.reward.minus(lastForgedBlock.devfund).plus(this.configHelper.getConfig().shareEarnedFees ? earned_tx_fees : Utils.BigNumber.ZERO);
                                    lastVoterAllocation.forEach(v => v.allotment = validVotes.isZero() ? 
                                        Utils.BigNumber.ZERO : netReward.times(Math.round(v.shareRatio * 100)).div(10000).times(v.validVote).div(validVotes)
                                    );
                                    // console.log("lastVoterAllocation after");console.log(lastVoterAllocation);
                                    this.sqlite.updateValidVote(lastVoterAllocation);
                                }
                            }
                        }
                    }
                }
            },
        });

        this.events.listen(AppEnums.VoteEvent.Vote, {
            handle: async ({ data }) => {
                // console.log(`(LL) received vote event with id ${JSON.stringify(data, null, 4)}`);
                const config: IConfig = this.configHelper.getConfig();

                // Anti-bot: check for vote changes within 1 round following a forged block - only during real-time processing
                // and reduce the valid vote to the new voting amount
                if (!this.isInitialSync() && data.previousVotes && Object.keys(data.previousVotes).includes(config.delegate)) {
                    while (this.isSyncing()) {
                        await delay(100);
                    }
                    const lastForgedBlock: IForgedBlock = this.sqlite.getLastForged();
                    const lastVoterAllocation: IAllocation[] = this.sqlite.getLastVoterAllocation();
                    
                    if (lastForgedBlock && lastVoterAllocation.length > 0) { // always true unless brand new delegate
                        const txRound = AppUtils.roundCalculator.calculateRound(data.transaction.blockHeight);
                        
                        if (txRound.round - lastForgedBlock.round <= 1) { // look ahead 1 round
                            const whitelist = [...config.whitelist, config.delegateAddress];
                            const vrecord = lastVoterAllocation.filter( v => !whitelist.includes(v.address)) // exclude white-list
                                                               .find( v => v.address === data.transaction.senderId); 

                            // sender is a voter. If vote is reduced (or unvoted), recalculate the voter's valid vote and update last forged block allocations
                            // console.log("lastVoterAllocation before");console.log(lastVoterAllocation);
                            if (vrecord) {                                
                                const votePercent = data.wallet.votingFor[config.delegate]?.percent || 0;
                                if (votePercent < vrecord.votePercent) {
                                    this.logger.debug(`(LL) Anti-bot detected voter ${vrecord.address} vote percent reduction (${vrecord.votePercent} => ${votePercent}) within round [${lastForgedBlock.round}-${txRound.round}].`)
                                    this.logger.debug(`(LL) Redistributing block allocations for height ${lastForgedBlock.height}.`)

                                    vrecord.votePercent = votePercent; // reduce vote percent at forged block to the new value
                                    const vote = vrecord.balance.times(Math.round(vrecord.votePercent * 100)).div(10000);
                                    const plan = this.configHelper.getPlan(lastForgedBlock.height, lastForgedBlock.timestamp);
                                    vrecord.validVote = vote.isLessThan(plan.mincap) || plan.blacklist.includes(vrecord.address) ? 
                                        Utils.BigNumber.ZERO : (plan.maxcap && vote.isGreaterThan(plan.maxcap) ? Utils.BigNumber.make(plan.maxcap) : vote);
                                    
                                    // recalculate allotments for all voters with the new vote distribution
                                    const validVotes = lastVoterAllocation.map( o => o.validVote).reduce((prev, curr) => prev.plus(curr), Utils.BigNumber.ZERO);
                                    const earned_tx_fees = lastForgedBlock.fees.minus(lastForgedBlock.burnedFees);
                                    const netReward = lastForgedBlock.reward.minus(lastForgedBlock.devfund).plus(this.configHelper.getConfig().shareEarnedFees ? earned_tx_fees : Utils.BigNumber.ZERO);
                                    lastVoterAllocation.forEach(v => v.allotment = validVotes.isZero() ? 
                                        Utils.BigNumber.ZERO : netReward.times(Math.round(v.shareRatio * 100)).div(10000).times(v.validVote).div(validVotes)
                                    );
                                    // console.log("lastVoterAllocation after");console.log(lastVoterAllocation);                                    
                                    this.sqlite.updateValidVote(lastVoterAllocation);
                                }
                            }
                        }
                    }
                }
            },
        });

        this.events.listen(AppEnums.TransactionEvent.Reverted, {
            handle: async ({ data }) => {
                // TODO: Do not process if plan at height has payperiod=0, meaning plugin provides database only, payment is handled externally
                this.logger.debug(`(LL) Received transaction reverted event with id ${data.id}`);

                // Hopefully not many TX reverted events will occur, since the query needs to be executed for each and every one
                // Alternative: keep another watchlist; but it could be more expensive then SQL
                (this.sqlite.clearTransactionId(data.id).changes > 0);
            },
        });
    }

    private async processBlocks(blocks): Promise<void> {
        const forgedBlocks: IForgedBlock[] = [];
        const missedBlocks: IMissedBlock[] = [];
        const allocations: IAllocation[] = [];

        const blockarray: Interfaces.IBlockData[] = blocks as Interfaces.IBlockData[];
        const blockheights = blockarray.map((block) => block.height);
        this.logger.debug(`(LL) Received batch of ${blocks.length} blocks to process | heights: ${blockheights.toString()}`);

        for (let blockCounter = 0; blockCounter < blocks.length; blockCounter++) {
            const block: Interfaces.IBlockData = blocks[blockCounter];
            const round = AppUtils.roundCalculator.calculateRound(block.height);
            const generatorWallet: Contracts.State.Wallet = this.walletRepository.findByPublicKey(block.generatorPublicKey); // reading from the forged block instead of config.delegateWallet
            const generator: string = block.height == 1 ? generatorWallet.getAddress() : generatorWallet.getAttribute("delegate.username");
            const devfund: Utils.BigNumber = Object.values(block.devFund!).reduce((a, b) => a.plus(b), Utils.BigNumber.ZERO);
            const voters: { height:number; address: string; balance: Utils.BigNumber; percent: number; vote: Utils.BigNumber; validVote: Utils.BigNumber}[] = [];

            this.logger.debug(`(LL) Processing block | round:${round.round } height:${block.height} timestamp:${block.timestamp} delegate: ${generator} reward:${block.reward} devfund:${devfund} block_fees:${block.totalFee} burned_fees:${block.burnedFee}`)

            const plan = this.configHelper.getPlan(block.height, block.timestamp);
            const voter_roll = await this.transactionRepository.getDelegateVotesByHeight(block.height, generator, block.generatorPublicKey);
            const lastVoterAllocation: IAllocation[] = this.sqlite.getLastVoterAllocation();
            for (const v of voter_roll) {
                const walletAddress: string = this.walletRepository.findByPublicKey(v.publicKey).getAddress();
                let startFrom: number = 0;
                let prevBalance: Utils.BigNumber = Utils.BigNumber.ZERO;
                if (lastVoterAllocation.length > 0 && lastVoterAllocation[0].height < block.height) {
                    const vrecord: IAllocation | undefined = lastVoterAllocation.find( v => v.address ===walletAddress);
                    if (vrecord) {
                        startFrom = vrecord.height;
                        prevBalance = vrecord.orgBalance;
                    }
                }
                const walletBalance = prevBalance.plus(await this.transactionRepository.getNetBalanceByHeightRange(startFrom, block.height, walletAddress, v.publicKey));
                const vote = walletBalance.times(Math.round(v.percent * 100)).div(10000);
                const validVote = vote.isLessThan(plan.mincap) || plan.blacklist.includes(walletAddress) ? 
                    Utils.BigNumber.ZERO : (plan.maxcap && vote.isGreaterThan(plan.maxcap) ? Utils.BigNumber.make(plan.maxcap) : vote);

                voters.push({
                    height: block.height,
                    address: walletAddress,
                    balance: walletBalance,
                    percent: v.percent,
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
                orgValidVotes: validVotes,
                voterCount: voters.length,
            });

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
                    balance: Utils.BigNumber.ZERO,
                    orgBalance: Utils.BigNumber.ZERO,
                    votePercent: 0,
                    orgVotePercent: 0,
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
                    balance: Utils.BigNumber.ZERO,
                    orgBalance: Utils.BigNumber.ZERO,
                    votePercent: 0,
                    orgVotePercent: 0,
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
                    balance: v.balance,
                    orgBalance: v.balance,
                    votePercent: v.percent,
                    orgVotePercent: v.percent,
                    validVote: v.validVote,
                    shareRatio: plan.share,
                    allotment: validVotes.isZero() ? Utils.BigNumber.ZERO : netReward.times(Math.round(plan.share * 100)).div(10000).times(v.validVote).div(validVotes),
                    booked: timeNow,
                    transactionId: "",
                    settled: 0
                });
            }
            //console.log(`(LL) allocations after voters\n${JSON.stringify(allocations)}`);
        }
        this.sqlite.insert(forgedBlocks, missedBlocks, allocations);
        //this.lastVoterAllocation = [...allocations].filter( a => a.payeeType === PayeeTypes.voter);
        this.logger.debug(`(LL) Completed processing batch of ${blocks.length} blocks`);
    }

    private setInitialSync(state): void {
        this.initial = state;
    }

    private setSyncing(state): void {
        this.syncing = state;
    }

    private async sync(): Promise<void> {
        if (this.isSyncing()) {
            this.logger.debug(`(LL) Active sync &| block processing in effect. Skipping.`)
            return;
        }
        this.logger.debug("(LL) Starting sync...")
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
                    this.logger.debug(`(LL) Sync complete | lastChainedBlockHeight:${lastChainedBlockHeight} lastForgedBlockHeight:${lastForgedBlockHeight} lastStoredBlockHeight:${lastStoredBlockHeight}\n`)
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
