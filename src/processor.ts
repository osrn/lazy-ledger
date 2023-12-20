import { Constants, Enums, Interfaces, Utils } from "@solar-network/crypto";
import { DatabaseService, Repositories } from "@solar-network/database";
import { Container, Contracts, Enums as AppEnums, Utils as AppUtils } from "@solar-network/kernel";
import { inlineCode } from "discord.js";
import { emoji } from "node-emoji";
import { IAllocation, IConfig, IForgedBlock, IMissedBlock, PayeeTypes } from "./interfaces";
import { ConfigHelper, configHelperSymbol } from "./confighelper";
import { Database, databaseSymbol } from "./database";
import { DiscordHelper, discordHelperSymbol } from "./discordhelper";
import { Teller, tellerSymbol } from "./teller";
import { TxRepository, txRepositorySymbol } from "./tx_repository";
import { name, version } from "./package-details.json";
import { msToHuman } from "./utils";
import {setTimeout} from "node:timers/promises";

export const processorSymbol = Symbol.for("LazyLedger<Processor>");

@Container.injectable()
export class Processor {
    @Container.inject(Container.Identifiers.Application)
    private readonly app!: Contracts.Kernel.Application;

    @Container.inject(Container.Identifiers.DatabaseBlockRepository)
    private readonly blockRepository!: Repositories.BlockRepository;

    @Container.inject(configHelperSymbol)
    private readonly configHelper!: ConfigHelper;

    @Container.inject(discordHelperSymbol)
    private readonly dc!: DiscordHelper;

    @Container.inject(Container.Identifiers.DatabaseService)
    private readonly database!: DatabaseService;

    @Container.inject(Container.Identifiers.EventDispatcherService)
    private readonly events!: Contracts.Kernel.EventDispatcher;

    @Container.inject(Container.Identifiers.LogService)
    private readonly logger!: Contracts.Kernel.Logger;

    @Container.inject(Container.Identifiers.WalletRepository)
    @Container.tagged("state", "blockchain")
    private readonly walletRepository!: Contracts.State.WalletRepository;

    @Container.inject(txRepositorySymbol)
    private readonly transactionRepository!: TxRepository;

    private initialSync: boolean = false;
    private lastProcessedBlockHeight: number = 0;
    private sqlite!: Database;
    private teller!: Teller;
    private syncing: boolean = false;
    //private config!: IConfig;
    private txWatchPool: Set<string> = new Set();
    // private lastVoterAllocation!: IAllocation[];

    public async boot(): Promise<void> {
        this.dc.sendmsg(`**${name} v${version}** booting ${emoji.high_brightness}`);
        // this.dc.sendmsg(`**${name} v${version}** booting ${emoji.high_brightness}\n**config**\n${inlineCode(logline)}`);
        this.sqlite = this.app.get<Database>(databaseSymbol);
        this.teller = this.app.get<Teller>(tellerSymbol);
        await this.init();
        this.logger.info("(LL) Processor boot complete");
    }

    public isSyncing(): boolean {
        return this.syncing;
    }

    public isInitialSync(): boolean {
        return this.initialSync;
    }

    private finishedInitialSync(): void {
        this.logger.info("(LL) Finished (initial|catch-up) sync");
        this.initialSync = false;
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
        // getting last forged block with the core functions is slower then direct database access!
        // const myLastForgedBlock: { id: string; height: number; username: string; timestamp: number } = (await this.blockRepository.getLastForgedBlocks())
        //     .filter( e => e.username === this.configHelper.getConfig().delegate)[0];
        // return await this.blockRepository.findByHeight(myLastForgedBlock.height);

        return this.transactionRepository.getLastForgedBlock(this.configHelper.getConfig().delegate);
    }

    // private async getLastForgedBlockHeight(): Promise<number> {
    //     const lastForgedBlock = await this.getLastForgedBlock();
    //     return lastForgedBlock ? lastForgedBlock.height : 0;
    // }

    public txWatchPoolAdd(txids: string[]): void {
        txids.forEach((id) => this.txWatchPool.add(id));
    }

    private async init(): Promise<void> {
        // let tick = Date.now();
        const lastForgedBlock: Interfaces.IBlockData | undefined = await this.getLastForgedBlock();
        const lastForgedBlockHeight: number = lastForgedBlock ? lastForgedBlock!.height : 0;
        // this.logger.debug(`(LL) Retrieved last forged block height in ${msToHuman(Date.now() - tick)}`);
        // tick = Date.now();
        this.lastProcessedBlockHeight = this.sqlite.getHeight();
        // this.logger.debug(`(LL) Retrieved lastProcessedBlockHeight in ${msToHuman(Date.now() - tick)}`);

        // roll back if local db is ahead of the network, purging from the start of the round
        // (solar snapshot:rollback always starts from the start of the round, during which we may have 
        // a different forging slot - hence height - from the one we had forged in that round. 
        // (Cleaning from the lastForgedBlockHeight would have left rogue block heights in the local db, 
        // if new forging slot were to be later than the old one)
        if (this.lastProcessedBlockHeight > lastForgedBlockHeight) {
            this.logger.warning(`(LL) Network fork&|rollback detected > Local database will be rolled back now.`);
            this.dc.sendmsg(`${emoji.rotating_light} Network fork&|rollback detected > Local database will be rolled back now. See relay logs for detailed information.`);
            const lastForgedRound = AppUtils.roundCalculator.calculateRound(lastForgedBlockHeight);
            const block = await this.blockRepository.findByHeight(lastForgedRound.roundHeight);

            if (!block) {
                const logline = `Unexpected error during rollback! Calculated round height ${lastForgedRound.roundHeight} does not exist in repository`;
                this.logger.emergency(`(LL) ${logline} | lastForgedBlock: ${lastForgedBlock} lastProcessedBlockHeight: ${this.lastProcessedBlockHeight} lastForgedRound: ${lastForgedRound}`);
                this.dc.sendmsg(`${emoji.scream} ${logline}. See relay logs for detailed information.`);
                throw new Error(`Unexpected error! Block to roll back to does not exist in repository`);
            }
            else {
                this.sqlite.purgeFrom(block.height, block.timestamp);
                this.lastProcessedBlockHeight = this.sqlite.getHeight();    
            }
        }
        else {
            // catch-up if local database is behind the network
            if (lastForgedBlockHeight !== this.lastProcessedBlockHeight) {
                this.initialSync = true;
                this.sync();
            }
            else {
                if (this.configHelper.getConfig().postInitInstantPay) {
                    this.configHelper.getConfig().postInitInstantPay = false;
                    this.teller.instantPay();
                }
            }
        }

        // find unsettled allocations and stamp if forged
        // tick = Date.now();
        this.txWatchPoolAdd(await this.sqlite.getUnsettledAllocations());
        // this.logger.debug(`(LL) Retrieved UnsettledAllocations in ${msToHuman(Date.now() - tick)}`);
        for (const txid of this.txWatchPool) {
            const forgedTx = await this.transactionRepository.transactionRepository.findById(txid);
            if (forgedTx) {
                const queryResult = await this.sqlite.settleAllocation(txid, AppUtils.formatTimestamp(forgedTx.timestamp).unix);
                this.logger.debug(`(LL) Stamped ${queryResult.changes} allocations having txid ${txid} as settled`);
                this.txWatchPool.delete(txid!);
            }
            else {
                const logline = `Detected an unsettled allocation marked with an invalid tx`;
                this.logger.critical(`(LL) ${logline} ${txid}`);
                this.dc.sendmsg(`${emoji.rotating_light} ${logline} ${inlineCode(txid)}`);
                // TODO: erase the TXid? or leave it to the bp to inspect and manually delete
                // TODO: can be run as a periodic job, rather than running at relay restart only? (hence erased TXid can be paid in next payment run)
            }
        }

        // insert event listeners
        this.events.listen(AppEnums.BlockEvent.Applied, {
            handle: async ({ data }) => {
                // wait until block is in block repository
                while (data.height > (await this.getLastBlockHeight())) {
                    await setTimeout(100);
                }
                
                if (this.configHelper.getConfig().bpWalletPublicKey === data.generatorPublicKey) {
                    this.logger.debug(`(LL) Received new block applied event at ${data.height} forged by us`);
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

                if (this.configHelper.getConfig().bpWalletPublicKey === data.generatorPublicKey) {
                    const logline = "Received block revert event for a block previously forged by us > height:";
                    this.logger.debug(`(LL) ${logline} ${data.height}`);
                    this.sqlite.purgeFrom(data.height, data.timestamp);
                    this.lastProcessedBlockHeight = this.sqlite.getHeight();
                    this.dc.sendmsg(`${emoji.rotating_light} ${logline} ${inlineCode(data.height)}`);
                }

                // Restart Teller cron if a new plan is in effect by this height/time
                if (this.configHelper.hasPresentPlanChanged()) {
                    this.teller.restartCron();
                }
            }
        });

        // listen transaction events for the purpose of 1) recording payment settlements back to the db 2) antibot actions
        this.events.listen(AppEnums.TransactionEvent.Applied, {
            handle: async ({ data }) => {
                const txData: Interfaces.ITransactionData = data as Interfaces.ITransactionData;
                // console.log(`(LL) received transaction applied event with data ${JSON.stringify(txData,null,4)}`)

                if (txData.typeGroup == Enums.TransactionTypeGroup.Core && txData.type == Enums.TransactionType.Core.Transfer) {
                    // wait until block is in block repository
                    while (txData.blockHeight! > (await this.getLastBlockHeight())) {
                        await setTimeout(100);
                    }
                    const txBlock = await this.blockRepository.findByHeight(txData.blockHeight!);
                    const config: IConfig = this.configHelper.getConfig();

                    // If the transaction is in the watch list, mark the allocation payment as settled
                    if (this.txWatchPool.has(txData.id!)) {
                        this.logger.debug(`(LL) Received a transaction applied event with txid ${txData.id} which is in the watchlist`);

                        // Transactions v2 and v3 no longer has a timetamp. Get it from the block it was forged in
                        if (txBlock) {
                            const queryResult = await this.sqlite.settleAllocation(txData.id!, AppUtils.formatTimestamp(txBlock.timestamp).unix);
                            this.logger.debug(`(LL) Stamped ${queryResult.changes} allocations having txid ${txData.id} as settled`);
                            this.txWatchPool.delete(txData.id!);
                        }
                    }
                    // Anti-bot: check for voter originated outbound transfers within 1 round following a forged block - only during real-time processing
                    // and reduce valid vote to the new wallet amount if voter wallet made an outbound transfer within the round
                    else if (config.antibot && !this.initialSync) {
                        while (this.syncing) {
                            await setTimeout(100); //TODO: just return and not wait?
                        }
                        const whitelist = [...config.whitelist, config.bpWalletAddress];
                        const lastForgedBlock: IForgedBlock = this.sqlite.getLastForged();
                        const lastVoterAllocation: IAllocation[] = this.sqlite.getAllVotersRecordsAtHeight();

                        if (lastForgedBlock && lastVoterAllocation.length > 0) { // always true unless you are a brand new bp
                            const txRound = AppUtils.roundCalculator.calculateRound(txData.blockHeight!);
                            
                            if (txRound.round - lastForgedBlock.round <= 1) { // look ahead 1 round. TODO: look further ahead?
                                const vrecord = lastVoterAllocation.filter( v => !whitelist.includes(v.address)) // exclude white-list
                                                                   .find( v => v.address === txData.senderId); 

                                // sender is a voter. recalculate the voter's valid vote and update last forged block allocations
                                // console.log("lastVoterAllocation before");console.log(lastVoterAllocation);
                                if (vrecord) {
                                    const txAmount = txData.asset?.transfers?.map(v => v.amount).reduce( (prev,curr) => prev.plus(curr), Utils.BigNumber.ZERO) || Utils.BigNumber.ZERO;
                                    this.logger.debug(`(LL) Anti-bot detected voter ${vrecord.address} balance reduction of ${txAmount.div(Constants.SATOSHI).toFixed()} SXP within round [${lastForgedBlock.round}-${txRound.round}].`);
                                    // console.log("registry before");console.log(vrecord);
                                    this.logger.debug(`(LL) Redistributing block allocations for height ${lastForgedBlock.height}.`);

                                    vrecord.balance = vrecord.balance.minus(txAmount).minus(txData.fee); // reduce balance at forged block by the txamount
                                    if (vrecord.balance.isNegative()) // We check outbound transfers only. Voter may have received funds before sending out.
                                        vrecord.balance = Utils.BigNumber.ZERO;
                                    const vote = vrecord.balance.times(Math.round(vrecord.votePercent * 100)).div(10000);
                                    const plan = this.configHelper.getPlan(lastForgedBlock.height, lastForgedBlock.timestamp);
                                    vrecord.validVote = vote.isLessThan(plan.mincapSatoshi) || plan.blacklist.includes(vrecord.address) ? 
                                        Utils.BigNumber.ZERO : (plan.maxcapSatoshi && vote.isGreaterThan(plan.maxcapSatoshi) ? plan.maxcapSatoshi : vote);

                                    // recalculate allotments for all voters with the new vote distribution
                                    const validVotes = lastVoterAllocation.map( o => o.validVote).reduce((prev, curr) => prev.plus(curr), Utils.BigNumber.ZERO);
                                    const earned_tx_fees = lastForgedBlock.fees.minus(lastForgedBlock.burnedFees);
                                    const netReward = lastForgedBlock.reward.minus(lastForgedBlock.solfunds).plus(this.configHelper.getConfig().shareEarnedFees ? earned_tx_fees : Utils.BigNumber.ZERO);
                                    lastVoterAllocation.forEach(v => v.allotment = validVotes.isZero() ? 
                                        Utils.BigNumber.ZERO : netReward.times(Math.round(v.shareRatio * 100)).div(10000).times(v.validVote).div(validVotes)
                                    );
                                    // console.log("registry after");console.log(vrecord);
                                    this.sqlite.updateValidVote(lastVoterAllocation);
                                }
                            }
                        }
                    }
                }
            },
        });

        // listen vote events for the purpose of antibot actions
        this.events.listen(AppEnums.VoteEvent.Vote, {
            handle: async ({ data }) => {
                // console.log(`(LL) received vote event with id ${JSON.stringify(data, null, 4)}`);
                const config: IConfig = this.configHelper.getConfig();

                // Anti-bot: check for vote changes within 1 round following a forged block - only during real-time processing
                // and reduce the valid vote to the new voting amount
                if (config.antibot && !this.initialSync && data.previousVotes && Object.keys(data.previousVotes).includes(config.delegate)) {
                    while (this.syncing) {
                        await setTimeout(100);
                    }
                    const lastForgedBlock: IForgedBlock = this.sqlite.getLastForged();
                    const lastVoterAllocation: IAllocation[] = this.sqlite.getAllVotersRecordsAtHeight();
                    
                    if (lastForgedBlock && lastVoterAllocation.length > 0) { // always true unless brand new bp
                        const txRound = AppUtils.roundCalculator.calculateRound(data.transaction.blockHeight);
                        
                        if (txRound.round - lastForgedBlock.round <= 1) { // look ahead 1 round
                            const whitelist = [...config.whitelist, config.bpWalletAddress];
                            const vrecord = lastVoterAllocation.filter( v => !whitelist.includes(v.address)) // exclude white-list
                                                               .find( v => v.address === data.transaction.senderId); 

                            // sender is a voter. If vote is reduced (or unvoted), recalculate the voter's valid vote and update last forged block allocations
                            // console.log("lastVoterAllocation before");console.log(lastVoterAllocation);
                            if (vrecord) {
                                const votePercent = data.wallet.votingFor[config.delegate]?.percent || 0;
                                if (votePercent < vrecord.votePercent) {
                                    this.logger.debug(`(LL) Anti-bot detected voter ${vrecord.address} vote percent reduction (${vrecord.votePercent} => ${votePercent}) within round [${lastForgedBlock.round}-${txRound.round}].`);
                                    this.logger.debug(`(LL) Redistributing block allocations for height ${lastForgedBlock.height}.`);

                                    vrecord.votePercent = votePercent; // reduce vote percent at forged block to the new value
                                    const vote = vrecord.balance.times(Math.round(vrecord.votePercent * 100)).div(10000);
                                    const plan = this.configHelper.getPlan(lastForgedBlock.height, lastForgedBlock.timestamp);
                                    vrecord.validVote = vote.isLessThan(plan.mincapSatoshi) || plan.blacklist.includes(vrecord.address) ? 
                                        Utils.BigNumber.ZERO : (plan.maxcapSatoshi && vote.isGreaterThan(plan.maxcapSatoshi) ? plan.maxcapSatoshi : vote);
                                    
                                    // recalculate allotments for all voters with the new vote distribution
                                    const validVotes = lastVoterAllocation.map( o => o.validVote).reduce((prev, curr) => prev.plus(curr), Utils.BigNumber.ZERO);
                                    const earned_tx_fees = lastForgedBlock.fees.minus(lastForgedBlock.burnedFees);
                                    const netReward = lastForgedBlock.reward.minus(lastForgedBlock.solfunds).plus(this.configHelper.getConfig().shareEarnedFees ? earned_tx_fees : Utils.BigNumber.ZERO);
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
                this.logger.debug(`(LL) Received transaction reverted event with txid ${data.id}`);

                // Hopefully not many TX reverted events will occur, since the query needs to be executed for each and every one
                // Alternative: keep another watchlist; but it could be more expensive then SQL
                const { changes } = await this.sqlite.clearTransactionId(data.id);
                this.logger.debug(`(LL) Cleared txid ${data.id} from ${changes} allocations`);
                this.dc.sendmsg(`${emoji.rotating_light} Received transaction reverted event with txid ${data.id}`);
            },
        });
    }

    private async processBlocks(blocks): Promise<void> {
        const tick0 = Date.now();
        const blockarray: Interfaces.IBlockData[] = blocks as Interfaces.IBlockData[];
        const blockheights = blockarray.map((block) => block.height);
        this.logger.debug(`(LL) Received batch of ${blocks.length} blocks to process | heights: ${blockheights.toString()}`);
        
        for (let blockCounter = 0; blockCounter < blocks.length; blockCounter++) {
            const tick1 = Date.now();

            const forgedBlocks: IForgedBlock[] = [];
            const missedBlocks: IMissedBlock[] = [];
            const allocations: IAllocation[] = [];

            const block: Interfaces.IBlockData = blocks[blockCounter];
            const round = AppUtils.roundCalculator.calculateRound(block.height);
            const generatorWallet: Contracts.State.Wallet = this.walletRepository.findByPublicKey(block.generatorPublicKey); // reading from the forged block instead of config.delegateWallet
            const generator: string = block.height == 1 ? generatorWallet.getAddress() : generatorWallet.getAttribute("delegate.username");
            const solfunds: Utils.BigNumber = Object.values(block.donations!).reduce((a, b) => a.plus(b), Utils.BigNumber.ZERO);
            const voters: { height:number; address: string; balance: Utils.BigNumber; percent: number; vote: Utils.BigNumber; validVote: Utils.BigNumber}[] = [];

            const lastChainedBlockHeight: number = await this.getLastBlockHeight();
            this.logger.debug(`(LL) Last chained: #${lastChainedBlockHeight} | Now processing block round:${round.round } height:${block.height} timestamp:${block.timestamp} bp: ${generator} reward:${block.reward} solfunds:${solfunds} block_fees:${block.totalFee} burned_fees:${block.burnedFee}`)

            const plan = this.configHelper.getPlan(block.height, block.timestamp);
            const config = this.configHelper.getConfig();
            let tick = Date.now();

            if (lastChainedBlockHeight === block.height) { 
                // if we are not processing the backlog but operating in real time
                // retrieve the voters and their balances from the blockchain
                const myVoters = this.walletRepository
                    .allByPublicKey()
                    .filter((wallet) => !wallet.getVoteBalance(config.delegate).isZero())
                    .map ( (w) => {
                        const vote = w.getVoteBalance(config.delegate);
                        const validVote = vote.isLessThan(plan.mincapSatoshi) || plan.blacklist.includes(w.getAddress()) ? 
                            Utils.BigNumber.ZERO : (plan.maxcapSatoshi && vote.isGreaterThan(plan.maxcapSatoshi) ? plan.maxcapSatoshi : vote);
    
                        return {
                            height: block.height,
                            address: w.getAddress(),
                            balance: w.getBalance(),
                            percent: (w.getAttribute("votes") as Map<string, number>).get(config.delegate)!,
                            vote,
                            validVote: validVote
                        }
                    });
                this.logger.debug(`(LL) voter roll and voter balances retrieved from walletrepository (live) in ${msToHuman(Date.now() - tick)}`);
                voters.push(...myVoters);
            }
            else {
                const voter_roll: { address: string; publicKey: string; percent: number }[] = await this.transactionRepository.getDelegateVotesByHeight(block.height, generator, block.generatorPublicKey); // TODO: needs optimization.
                this.logger.debug(`(LL) voter roll retrieved from blockchain (Solar db) in ${msToHuman(Date.now() - tick)}`);
                tick = Date.now();
                // const lastVoterAllocation: IAllocation[] = await this.sqlite.getAllVotersLastRecord();
                const lastVoterRecord: IAllocation[] = await this.sqlite.getSomeVotersLastRecords(voter_roll.map(v => v.address!));
                this.logger.debug(`(LL) voters last known balances retrieved from LazyLedger db in ${msToHuman(Date.now() - tick)}`);
                tick = Date.now();
                let voterIndex=1;
                for (const v of voter_roll) {
                    const tick2 = Date.now();
                    // const walletAddress: string = this.walletRepository.findByPublicKey(v.publicKey).getAddress();
                    let startFrom: number = 0;
                    let prevBalance: Utils.BigNumber = Utils.BigNumber.ZERO;
                    if (lastVoterRecord.length > 0 && lastVoterRecord[0].height < block.height) {
                        const vrecord: IAllocation | undefined = lastVoterRecord.find( e => e.address === v.address! );
                        if (vrecord) {
                            startFrom = vrecord.height;
                            prevBalance = vrecord.orgBalance;
                        }
                    }
                    const walletBalance = prevBalance.plus(await this.transactionRepository.getNetBalanceByHeightRange(startFrom, block.height, v.address!, v.publicKey));
                    const vote = walletBalance.times(Math.round(v.percent * 100)).div(10000);
                    const validVote = vote.isLessThan(plan.mincapSatoshi) || plan.blacklist.includes(v.address) ? 
                        Utils.BigNumber.ZERO : (plan.maxcapSatoshi && vote.isGreaterThan(plan.maxcapSatoshi) ? plan.maxcapSatoshi : vote);
    
                    voters.push({
                        height: block.height,
                        address: v.address,
                        balance: walletBalance,
                        percent: v.percent,
                        vote: vote,
                        validVote: validVote
                    });
                    // Voter processing times will be the longest first time a voter is processed as transactions to build wallet balance will be fetched from the solar database from the very beginning.
                    // Log the progress to ease observers mind
                    if (startFrom == 0) {
                        this.logger.debug(`(LL) Voter ${voterIndex} / ${voter_roll.length} processed in ${msToHuman(Date.now() - tick2)}`);
                    }
                    voterIndex++;
                    // await setTimeout(100); // getNetBalanceByHeightRange may take a long time blocking the other relay processes
                }
                this.logger.debug(`(LL) voters balances at height ${block.height} reconstructed from blockchain (Solar db) records in ${msToHuman(Date.now() - tick)}`);
            }

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
                solfunds: solfunds, 
                fees: block.totalFee, 
                burnedFees: block.burnedFee === undefined ? Utils.BigNumber.ZERO : block.burnedFee, 
                votes: votes,
                validVotes: validVotes,
                orgValidVotes: validVotes,
                voterCount: voters.length,
            });

            const earned_tx_fees = block.totalFee.minus(block.burnedFee!);
            const netReward = block.reward.minus(solfunds).plus(this.configHelper.getConfig().shareEarnedFees ? earned_tx_fees : Utils.BigNumber.ZERO);

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
                    // orgAllotment: validVotes.isZero() ? Utils.BigNumber.ZERO : netReward.times(Math.round(plan.share * 100)).div(10000).times(v.validVote).div(validVotes),
                    booked: timeNow,
                    transactionId: "",
                    settled: 0
                });
            }
            //console.log(`(LL) allocations after voters\n${JSON.stringify(allocations)}`);
            this.logger.debug(`(LL) block #${block.height} processed in ${msToHuman(Date.now() - tick1)}`);;
            this.sqlite.insert(forgedBlocks, missedBlocks, allocations);
            this.lastProcessedBlockHeight = block.height;
        }
        //this.lastVoterAllocation = [...allocations].filter( a => a.payeeType === PayeeTypes.voter);
        this.logger.debug(`(LL) Completed processing batch of ${blocks.length} blocks in ${msToHuman(Date.now() - tick0)}`);
    }

    private async sync(): Promise<void> {
        if (this.syncing) {
            this.logger.debug(`(LL) Active sync &| block processing in effect. Skipping.`);
            return;
        }
        this.syncing = true;
        this.logger.info(`(LL) Starting ${this.initialSync ? "(initial|catch-up) " : ""}sync ...`);
        const tick0 = Date.now();
        let loop: boolean = true;
        while (loop) {
            let tick1 = Date.now();
            const lastChainedBlockHeight: number = await this.getLastBlockHeight();
            this.logger.debug(`lastChainedBlockHeight retrieved in ${msToHuman(Date.now() - tick1)}`);
            // const lastForgedBlockHeight: number = await this.getLastForgedBlockHeight();
            tick1 = Date.now();
            const lastForgedBlock: Interfaces.IBlockData | undefined = await this.getLastForgedBlock();
            this.logger.debug(`lastForgedBlock retrieved in ${msToHuman(Date.now() - tick1)}`);
            const lastForgedBlockHeight: number = lastForgedBlock ? lastForgedBlock!.height : 0;
            const ourEpoch = this.configHelper.getFirstAllocatingPlan()?.height || 0; // NOTE TO SELF: must be run after async calls above

            // if initial sync, ignore all blocks until the height allocations starts
            const lastProcessedBlockHeight: number = this.sqlite.getHeight() || (ourEpoch < lastChainedBlockHeight ? ourEpoch : lastChainedBlockHeight);
            this.logger.debug(`(LL) assessing sync status > Last chained: #${lastChainedBlockHeight} | Last forged: #${lastForgedBlockHeight} | Last processed: #${lastProcessedBlockHeight}`);

            // roll back if local db is ahead of the network, purging from the start of the round we last forged
            if (this.lastProcessedBlockHeight > lastForgedBlockHeight || this.lastProcessedBlockHeight > lastChainedBlockHeight) {
                this.logger.warning(`(LL) Network fork&|rollback detected > Local database will be rolled back now.`);
                this.dc.sendmsg(`${emoji.rotating_light} Network fork&|rollback detected > Local database will be rolled back now. See relay logs for detailed information.`);
                    // we should never arrive here as in the event of a fork, necessary actions will be taken at BlockEvent.Reverted event handler and local db will be rolled back properly
                const lastForgedRound = AppUtils.roundCalculator.calculateRound(lastForgedBlockHeight);
                const block = await this.blockRepository.findByHeight(lastForgedRound.roundHeight);

                if (!block) {
                    this.logger.emergency(`(LL) Unexpected error. Need to roll back to height ${lastForgedRound.roundHeight} but no such height exists in block repository. lastForgedBlock: ${lastForgedBlock} lastProcessedBlockHeight: ${this.lastProcessedBlockHeight} lastForgedRound: ${lastForgedRound}`);
                    this.dc.sendmsg(`${emoji.scream} Unexpected error. Need to roll back to height ${lastForgedRound.roundHeight} but no such height exists in block repository. lastForgedBlock: ${lastForgedBlock} lastProcessedBlockHeight: ${this.lastProcessedBlockHeight} lastForgedRound: ${lastForgedRound}`);
                    throw new Error(`Unexpected error! Block to roll back to does not exist in repository`);
                }
                else {
                    this.sqlite.purgeFrom(block.height, block.timestamp);
                    this.lastProcessedBlockHeight = this.sqlite.getHeight();    
                }
            }

            if (lastProcessedBlockHeight < lastForgedBlockHeight && this.lastProcessedBlockHeight < lastChainedBlockHeight) { 
                // lastProcessedBlockHeight < lastForgedBlockHeight: are we lagging
                // this.lastProcessedBlockHeight < lastChainedBlockHeight: has blockchain rolled-back since we last fetched from block repository
                const blocks: Contracts.Shared.DownloadBlock[] = await this.database.getBlocksForDownload(
                    lastProcessedBlockHeight + 1,
                    10000,
                    true);

                if (blocks.length) { //actually redundant when lastProcessedBlockHeight < lastChainedBlockHeight
                    const delegatesBlocks = blocks.filter((block) => block.generatorPublicKey === this.configHelper.getConfig().bpWalletPublicKey);

                    if (delegatesBlocks.length) {
                        await this.processBlocks(delegatesBlocks);
                    } 
                }
                else {
                    loop = false;
                    this.logger.info(`(LL) Sync complete in ${msToHuman(Date.now() - tick0)} > Last chained: #${lastChainedBlockHeight} | Last forged: #${lastForgedBlockHeight} | Last processed: #${lastProcessedBlockHeight}---`);
                }
            }
            else {
                loop = false;
                if (this.initialSync && lastProcessedBlockHeight === lastForgedBlockHeight) {
                    this.logger.debug(`(LL) backlog processed in ${msToHuman(Date.now() - tick0)}`);
                    this.finishedInitialSync();
                }
                this.logger.info(`(LL) Sync complete in ${msToHuman(Date.now() - tick0)} > Last chained: #${lastChainedBlockHeight} | Last forged: #${lastForgedBlockHeight} | Last processed: #${lastProcessedBlockHeight}---`);
            }
        }
        this.syncing =false;
    }
}
