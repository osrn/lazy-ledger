import { Constants, Managers, Networks, Types, Utils } from "@solar-network/crypto";
import { Container, Contracts } from "@solar-network/kernel";
import SQLite3 from "better-sqlite3";
import { ObjectId } from "bson";
import { inlineCode } from "discord.js";
import { emoji } from "node-emoji";
import { DiscordHelper, discordHelperSymbol } from "./discordhelper";
import { IAllocation, IBill, IForgedBlock, IForgingStats, IWorkerJob, PayeeTypes } from "./interfaces";
import { DbTaskQueue } from "./dbTaskQueue";

export const databaseSymbol = Symbol.for("LazyLedger<Database>");
const sqliteRunError: SQLite3.RunResult = { changes: -1, lastInsertRowid: 0 };
const taskQueueSize = 2;

@Container.injectable()
export class Database {
    @Container.inject(Container.Identifiers.LogService) 
    private readonly logger!: Contracts.Kernel.Logger;

    @Container.inject(discordHelperSymbol)
    private readonly dc!: DiscordHelper;

    private dbpath!: string;
    private database!: SQLite3.Database;
    private taskQueue!: DbTaskQueue;

    public init(dataPath?: string): SQLite3.Database {
        dataPath ||= process.env.CORE_PATH_DATA;
        this.dbpath = dataPath!;
        const dbfile = "lltbw/lazy-ledger.sqlite";
        if (this.logger) {
            this.logger.debug(`(LL) Opening database connection @ ${dataPath}/${dbfile}`);
        }
        // else {
        //     // no logger means called by a cli command
        //     console.log(`(LL) Opening database connection @ ${dataPath}/${dbfile}`);
        // }
        this.database = new SQLite3(`${dataPath}/${dbfile}`);
        return this.database;
    }
    
    public async boot(): Promise<void> {
        this.init();
        this.taskQueue = new DbTaskQueue(this.dbpath, taskQueueSize, this.logger);
        //NOTE: SQLITE fields data type definitions are just for documentation purposes by SQLite Design
        const t0 = Math.floor(new Date(Managers.configManager.getMilestone().epoch).getTime() / 1000);
        this.logger.info("(LL)[Database] creating tables ...");
        this.database.exec(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS forged_blocks (
    round INTEGER NOT NULL,
    height INTEGER NOT NULL PRIMARY KEY,
    timestamp NUMERIC NOT NULL,
    delegate TEXT NOT NULL,
    reward TEXT NOT NULL,
    solfunds TEXT NOT NULL,
    fees TEXT NOT NULL,
    burnedFees TEXT NOT NULL,
    votes TEXT,
    validVotes TEXT,
    orgValidVotes TEXT,
    voterCount INTEGER);
CREATE TABLE IF NOT EXISTS missed_blocks (
    round INTEGER NOT NULL,
    height INTEGER NOT NULL,
    delegate TEXT NOT NULL,
    timestamp NUMERIC PRIMARY KEY NOT NULL);
CREATE TABLE IF NOT EXISTS allocations (
    height INTEGER NOT NULL,
    address TEXT NOT NULL,
    payeeType INTEGER NOT NULL,
    balance TEXT NOT NULL,
    orgBalance TEXT NOT NULL,
    votePercent INTEGER NOT NULL,
    orgVotePercent INTEGER NOT NULL,
    validVote TEXT NOT NULL,
    shareRatio INTEGER,
    allotment TEXT,
    booked NUMERIC,
    transactionId TEXT,
    settled NUMERIC,
    PRIMARY KEY (height, address, payeeType)
);`
        );

        this.logger.info("(LL)[Database] creating indexes (this may take a while during first boot after an upgrade, pleas be patient) ..");
        let sqlstr = `
CREATE INDEX IF NOT EXISTS forged_blocks_delegate_timestamp ON forged_blocks (delegate, "timestamp");
CREATE INDEX IF NOT EXISTS forged_blocks_delegate_round on forged_blocks (delegate, round);
CREATE INDEX IF NOT EXISTS forged_blocks_timestamp ON forged_blocks ("timestamp");
CREATE INDEX IF NOT EXISTS forged_blocks_round_height_timestamp ON forged_blocks (round,height,"timestamp");
CREATE INDEX IF NOT EXISTS missed_blocks_delegate on missed_blocks (delegate);
CREATE INDEX IF NOT EXISTS allocations_transactionId ON allocations (transactionId);
CREATE INDEX IF NOT EXISTS allocations_booked ON allocations (booked);
CREATE INDEX IF NOT EXISTS allocations_settled ON allocations (settled);
CREATE INDEX IF NOT EXISTS allocations_address ON allocations (address);
CREATE INDEX IF NOT EXISTS allocations_address_payeetype_height ON allocations (address, payeeType, height);
`;
        const job: IWorkerJob = {
            id: new ObjectId().toHexString(),
            customer: "dbCreateIndexes",
            data: sqlstr,
        };
        try {
            await this.taskQueue.addTask(job);
        } 
        catch (error) {
            this.logger.critical("(LL) Error creating indexes");
            this.logger.critical(error.message);
            this.dc.sendmsg(`${emoji.biohazard_sign} Error creating database indexes`);
        }
        
        this.logger.info("(LL)[Database] (re)creating views ..");
        this.database.exec(`
CREATE VIEW IF NOT EXISTS missed_rounds AS
SELECT missed_blocks.*
FROM missed_blocks
LEFT OUTER JOIN forged_blocks
   ON missed_blocks.delegate = forged_blocks.delegate
  AND missed_blocks.round = forged_blocks.round
WHERE forged_blocks.delegate IS NULL;
DROP VIEW IF EXISTS forged_blocks_human;
CREATE VIEW forged_blocks_human AS
SELECT
    round,
    height,
    strftime('%Y-%m-%d %H:%M:%S', timestamp + ${t0}, 'unixepoch') AS forgedTime,
    reward / ${Constants.SATOSHI}.0 as reward,
    solfunds / ${Constants.SATOSHI}.0 as solfunds,
    fees / ${Constants.SATOSHI}.0 as fees,
    burnedFees / ${Constants.SATOSHI}.0 as burnedFees,
    (reward - solfunds)/ ${Constants.SATOSHI}.0 AS earnedRewards,
    (fees - burnedFees)/ ${Constants.SATOSHI}.0 AS earnedFees,
    (reward - solfunds + fees - burnedFees)/ ${Constants.SATOSHI}.0 AS netReward,
    voterCount AS voters,
    votes / ${Constants.SATOSHI}.0 AS votes,
    validVotes / ${Constants.SATOSHI}.0 AS validVotes
FROM
    forged_blocks;
DROP VIEW IF EXISTS allocated_human;
CREATE VIEW allocated_human AS
SELECT
    rowid,
    height,
    address,
    payeeType,
    balance / ${Constants.SATOSHI}.0 AS balance,
    votePercent,
    balance * votePercent / 100 / ${Constants.SATOSHI}.0 as vote,
    validVote / ${Constants.SATOSHI}.0 AS validVote,
    shareRatio,
    allotment / ${Constants.SATOSHI}.0 AS allotment,
    strftime('%Y-%m-%d %H:%M:%S', booked, 'unixepoch') AS bookedTime,
    transactionId,
    CASE
        WHEN settled = 0 THEN 0
        ELSE strftime('%Y-%m-%d %H:%M:%S', settled , 'unixepoch')
    END AS settledTime,
    orgBalance / ${Constants.SATOSHI}.0 AS orgBalance,
    orgVotePercent
FROM
    allocations
ORDER BY
    height DESC;
DROP VIEW IF EXISTS the_ledger;
CREATE VIEW the_ledger AS
SELECT
    fb.round,
    al.height,
    fb.forgedTime,
    fb.reward,
    fb.earnedRewards,
    fb.earnedFees,
    fb.netReward,
    fb.validVotes,
    al.address,
    al.payeeType,
    al.balance,
    al.votePercent,
    al.vote,
    al.validVote,
    al.shareRatio,
    al.allotment,
    al.bookedTime,
    al.transactionId,
    al.settledTime,
    al.orgBalance,
    al.orgVotePercent
FROM
    allocated_human al
LEFT JOIN forged_blocks_human fb ON
    al.height = fb.height;
DROP VIEW IF EXISTS newLedger;
CREATE VIEW newLedger AS 
SELECT
	al.rowid,
    fb.round, 
    al.height, 
    fb."timestamp" AS forgedSolarts,
	strftime('%Y-%m-%d %H:%M:%S', fb."timestamp" + ${t0}, 'unixepoch') AS forgedTime,
    al.address,
    al.payeeType,
    al.shareRatio AS bpShareRatio, 
    al.orgBalance, 
    al.balance,
    al.orgVotePercent,
    al.votePercent,
    fb.bpOrgValidVoteTotal, 
    fb.bpFinalValidVoteTotal,
    fb.bpNetBlockReward, 
    ROUND(fb.bpNetBlockReward * al.shareRatio * CAST(al.orgBalance AS INTEGER) * al.orgVotePercent / 100 / 100 / fb.bpOrgValidVoteTotal) AS orgAllotment,
    CAST(al.allotment AS INTEGER) AS finalAllotment,
    al.booked as bookedts,
    strftime('%Y-%m-%d %H:%M:%S', al.booked, 'unixepoch') AS bookedTime,
    al.settled as settledts,
    CASE
        WHEN settled = 0 THEN 0
        ELSE strftime('%Y-%m-%d %H:%M:%S', settled , 'unixepoch')
    END AS settledTime
FROM allocations al
LEFT JOIN (
    SELECT 
        "timestamp", 
        round, 
        height, 
        (reward - solfunds) AS bpNetBlockReward, 
        CAST(orgValidVotes AS INTEGER) AS bpOrgValidVoteTotal,
        CAST(validVotes AS INTEGER) AS bpFinalValidVoteTotal
    FROM forged_blocks
) AS fb 
ON al.height = fb.height;`);
        this.database.pragma("journal_mode = WAL");
        this.triggers(true);
        this.logger.info("(LL) Database boot complete");
    }

    public getGeneratorAtHeight(height: number): string {
        const response: string = this.database
            .prepare("SELECT delegate FROM forged_blocks WHERE height = ?")
            .pluck()
            .get(height);
        return response || "";
    }

    public getHeight(): number {
        const response = this.database
            .prepare("SELECT height FROM forged_blocks ORDER BY height DESC LIMIT 1")
            .pluck()
            .get();

        return response || 0;
    }

    public getLastForged(): IForgedBlock {
        const response = this.database
            .prepare("SELECT * FROM forged_blocks ORDER BY height DESC LIMIT 1")
            .get();

        response.reward = Utils.BigNumber.make(response.reward);
        response.solfunds = Utils.BigNumber.make(response.solfunds);
        response.fees = Utils.BigNumber.make(response.fees);
        response.burnedFees = Utils.BigNumber.make(response.burnedFees);
        response.votes = Utils.BigNumber.make(response.votes);
        response.validVotes = Utils.BigNumber.make(response.validVotes);
        response.orgValidVotes = Utils.BigNumber.make(response.orgValidVotes);
        return response;
    }

    public getVoterRecordAtHeight(address: string, height: number = 0): IAllocation {
        const result = this.database
            .prepare(`SELECT * FROM allocations WHERE address='${address}' AND height=${height ? height : "(SELECT MAX(height) FROM allocations)"}`)
            .get();
        
        if (result) {
            result.balance = Utils.BigNumber.make(result.balance);
            result.orgBalance = Utils.BigNumber.make(result.orgBalance);
            result.allotment = Utils.BigNumber.make(result.allotment);
            result.validVote = Utils.BigNumber.make(result.validVote);
        }
        return result || "";
    }
    
    public getAllVotersRecordsAtHeight(height: number = 0): IAllocation[] {
        const result = this.database
            .prepare(`SELECT * FROM allocations WHERE height=${height ? height : "(SELECT MAX(height) FROM allocations)"} AND payeeType = ${PayeeTypes.voter}`)
            .all();
        
        (result as unknown as IAllocation[]).forEach(r => { 
            r.balance = Utils.BigNumber.make(r.balance);
            r.orgBalance = Utils.BigNumber.make(r.orgBalance);
            r.allotment = Utils.BigNumber.make(r.allotment);
            r.validVote = Utils.BigNumber.make(r.validVote);
        });
        return result;
    }
    
    public getVoterLastRecord(address: string): IAllocation {
        const result = this.database
            .prepare(`SELECT * FROM allocations WHERE address='${address}' ORDER BY height DESC LIMIT 1`)
            .get();
        
        if (result) {
            result.balance = Utils.BigNumber.make(result.balance);
            result.orgBalance = Utils.BigNumber.make(result.orgBalance);
            result.allotment = Utils.BigNumber.make(result.allotment);
            result.validVote = Utils.BigNumber.make(result.validVote);
        }
        return result || "";
    }

    public async getSomeVotersLastRecords(addresses: string[]): Promise<IAllocation[]> {
        const sqlstr = 
           `SELECT m.* FROM allocations m INNER JOIN (
                SELECT rowid, address, MAX(height) as height from allocations 
                WHERE address IN (${[...addresses.map(e => `'${e}'`)]}) AND payeeType = ${PayeeTypes.voter}
                GROUP BY address
            ) AS g ON m.rowid = g.rowid
            ORDER by m.height DESC`;

        const job: IWorkerJob = {
            id: new ObjectId().toHexString(),
            customer: "getSomeVotersLastRecords",
            data: sqlstr,
        }
        try {
            const result: IAllocation[] = (await this.taskQueue.addTask(job)) as unknown as IAllocation[];
            result.forEach(r => { 
                r.balance = Utils.BigNumber.make(r.balance);
                r.orgBalance = Utils.BigNumber.make(r.orgBalance);
                r.allotment = Utils.BigNumber.make(r.allotment);
                r.validVote = Utils.BigNumber.make(r.validVote);
            });
            return result;
        } 
        catch (error) {
            this.logger.critical("(LL) Error retrieving voters' last allocation from the database");
            this.logger.critical(error.message);
            this.dc.sendmsg(`${emoji.biohazard_sign} Error retrieving voters' last allocation from the database`);
            return [];
        }
    }

    public async getAllVotersLastRecords(): Promise<IAllocation[]> {
        const sqlstr = 
           `SELECT m.* FROM allocations m INNER JOIN (
                SELECT rowid, address, MAX(height) as height from allocations 
                WHERE payeeType = ${PayeeTypes.voter}
                GROUP BY address
            ) AS g ON m.rowid = g.rowid
            ORDER by m.height DESC`;
            // `SELECT m.* FROM allocations m INNER JOIN (
            //     SELECT address, MAX(height) as height from allocations
            //     WHERE payeeType = ${PayeeTypes.voter}
            //     GROUP BY address
            // ) AS g ON m.address = g.address AND m.height = g.height
            // WHERE payeeType = ${PayeeTypes.voter}
            // ORDER by m.height DESC`;

        const job: IWorkerJob = {
            id: new ObjectId().toHexString(),
            customer: "getAllVotersLastRecords",
            data: sqlstr,
        }
        try {
            const result: IAllocation[] = (await this.taskQueue.addTask(job)) as unknown as IAllocation[];
            result.forEach(r => { 
                r.balance = Utils.BigNumber.make(r.balance);
                r.orgBalance = Utils.BigNumber.make(r.orgBalance);
                r.allotment = Utils.BigNumber.make(r.allotment);
                r.validVote = Utils.BigNumber.make(r.validVote);
            });
            return result;
        } 
        catch (error) {
            this.logger.critical("(LL) Error retrieving voters' last allocations from the database");
            this.logger.critical(error.message);
            this.dc.sendmsg(`${emoji.biohazard_sign} Error retrieving voters' last allocations from the database`);
            return [];
        }
    }

    public getLedgerAtHeight(height: number = 0): Object[] {
        const result = this.database
            .prepare(`SELECT * FROM the_ledger WHERE height=${height ? height : "(SELECT MAX(height) FROM forged_blocks)"}`)
            .all();
        
        return result;
    }

    public getLedgerAtRound(round: number = 0): Object[] {
        const result = this.database
            .prepare(`SELECT * FROM the_ledger WHERE round=${round ? round : "(SELECT MAX(round) FROM forged_blocks)"}`)
            .all();
        
        return result;
    }

    public getLastPayAttempt(): IForgedBlock {
        const response = this.database
            .prepare("SELECT * FROM allocations a WHERE transactionId IS NOT '' ORDER BY height DESC LIMIT 1")
            .get();
        
        return response;
    }

    public getLastPaidSummary(): { round: number; height: number; transactionId: string, settledTime: string } {
        const result = this.database
            .prepare(`SELECT round, height, transactionId, settledTime FROM the_ledger WHERE round = (SELECT MAX(round) FROM the_ledger WHERE settledTime != 0) ORDER BY settledTime DESC LIMIT 1`)
            .get();
        
        return result;
    }

    public getLastPaidVoterAllocation(): any {
        const result = this.database
            .prepare(`SELECT * FROM the_ledger WHERE round = (SELECT MAX(round) FROM the_ledger WHERE settledTime > 0)`)
            .all();
        
        return result;
    }

    // First of, last of and number of forged blocks between two dates,
    public getForgingStatsForTimeRange(start: number, end: number, network?: Types.NetworkName): IForgingStats {
        if (typeof network !== "undefined" && Object.keys(Networks).includes(network!)) {
            Managers.configManager.setFromPreset(network!);
        } 
        const t0 = Math.floor(new Date(Managers.configManager.getMilestone().epoch).getTime() / 1000);
        const result = this.database.prepare(
           `SELECT MIN(round) AS firstRound, MAX(round) AS lastRound, COUNT(round) AS roundCount,
                   MIN(height) AS firstForged, MAX(height) AS lastForged, COUNT(height) AS forgedCount,
                   SUM(reward) AS blockRewards, SUM(solfunds) AS blockFunds,
                   SUM(fees) as blockFees, SUM(burnedFees) AS burnedFees,
                   SUM(reward - solfunds) AS earnedRewards, SUM(fees - burnedFees) AS earnedFees,
                   FLOOR(ROUND(AVG(validVotes),0)) AS avgVotes, AVG(voterCount) as avgVoterCount
            FROM forged_blocks fb
            WHERE (${t0} + fb."timestamp") >= ${start}
              AND (${t0} + fb."timestamp") < ${end}`)
        .get();

        result.blockRewards =  Utils.BigNumber.make(result.blockRewards);
        result.blockFunds =  Utils.BigNumber.make(result.blockFunds);
        result.blockFees =  Utils.BigNumber.make(result.blockFees);
        result.burnedFees =  Utils.BigNumber.make(result.burnedFees);
        result.earnedRewards =  Utils.BigNumber.make(result.earnedRewards);
        result.earnedFees =  Utils.BigNumber.make(result.earnedFees);
        result.avgVotes =  Utils.BigNumber.make(result.avgVotes);
        
        return result;
    }

    public getVoterCommitment(start: number, end: number, network?: Types.NetworkName): {roundCount: number; blockCount: number; address: string; blocksVoteNotReduced: number; voteChanges?: number}[] {
        if (typeof network !== "undefined" && Object.keys(Networks).includes(network!)) {
            Managers.configManager.setFromPreset(network!);
        } 
        const t0 = Math.floor(new Date(Managers.configManager.getMilestone().epoch).getTime() / 1000);
        const result = this.database.prepare(
           `SELECT COUNT(fb.round) AS roundCount, COUNT(al.height) AS blockCount, al.address, SUM(CAST(al.validVote AS INTEGER) <= CAST(al.nextVote AS INTEGER)) AS blocksVoteNotReduced 
            FROM forged_blocks fb INNER JOIN (
                SELECT height, address, validVote, lead(validVote,1,0) OVER (PARTITION BY address ORDER BY height) as nextVote
                FROM allocations
                WHERE payeeType = ${PayeeTypes.voter}
                AND votePercent > 0
            ) AS al 
            ON fb.height = al.height
            WHERE (${t0} + fb."timestamp") >= ${start}
              AND (${t0} + fb."timestamp") < ${end}
            GROUP BY al.address`)
        .all();

        return result;
    }

    /**
     * List antibot detected voters, hit frequency and antibot adjusted allotments total during a time frame
     * @param start 
     * @param end 
     * @param network 
     * @returns 
     */
    public getAntibot(start: number, end: number, network?: Types.NetworkName): {address: string; blockcount: number; allotted: Utils.BigNumber}[] {
        if (typeof network !== "undefined" && Object.keys(Networks).includes(network!)) {
            Managers.configManager.setFromPreset(network!);
        } 
        const t0 = Math.floor(new Date(Managers.configManager.getMilestone().epoch).getTime() / 1000);
        const result = this.database.prepare(
            `SELECT address, COUNT(address) as blockcount, SUM(orgAllotment) as orgAllotted, SUM(finalAllotment) as allotted
            FROM newLedger
            WHERE (${t0} + forgedSolarts) >= ${start}
              AND (${t0} + forgedSolarts) < ${end} 
              AND (CAST(balance AS INTEGER) < CAST(orgBalance AS INTEGER) OR votePercent < orgVotePercent)
            GROUP BY address ORDER BY address ASC;`)
        .all();
        
        // convert allottments to bignumber
        result.forEach( e => { 
            e.orgAllotted = Utils.BigNumber.make(e.orgAllotted); 
            e.allotted = Utils.BigNumber.make(e.allotted); 
        });
        return result;
    }

    /**
     * Scan the ledger for addresses and allocated rewards during the specified time frame
     * @param start 
     * @param end 
     * @param network 
     * @returns 
     */
    public scanBots(addresses: string[], start: number, end: number, network?: Types.NetworkName): {address: string; blockcount: number; allotted: Utils.BigNumber}[] {
        if (typeof network !== "undefined" && Object.keys(Networks).includes(network!)) {
            Managers.configManager.setFromPreset(network!);
        } 
        const t0 = Math.floor(new Date(Managers.configManager.getMilestone().epoch).getTime() / 1000);
        const result = this.database.prepare(
           `SELECT address, COUNT(address) as blockcount, SUM(orgAllotment) as orgAllotted, SUM(finalAllotment) as allotted
            FROM newLedger
            WHERE address IN (${[...addresses.map(e => `'${e}'`)]})
              AND (${t0} + forgedSolarts) >= ${start}
              AND (${t0} + forgedSolarts) < ${end}
            GROUP BY address ORDER BY address ASC;`)
        .all();
        
        // convert allottments to bignumber
        result.forEach( e => { 
            e.orgAllotted = Utils.BigNumber.make(e.orgAllotted); 
            e.allotted = Utils.BigNumber.make(e.allotted); 
        });
        return result;
    }

    public getMissed(type: string, username: string, height: number): { height: number; timestamp: number }[] {
        const result: { height: number; timestamp: number }[] = [];
        if (type === "slots") {
            result.push(
                ...this.database
                    .prepare("SELECT height, timestamp FROM missed_blocks WHERE delegate = ?")
                    .all(username),
            );
        } else {
            result.push(
                ...this.database
                    .prepare(
                        "SELECT missed_blocks.height, missed_blocks.timestamp FROM missed_blocks LEFT OUTER JOIN forged_blocks ON missed_blocks.delegate = forged_blocks.delegate AND missed_blocks.round = forged_blocks.round WHERE missed_blocks.delegate = ? AND missed_blocks.height < ? AND forged_blocks.delegate IS NULL",
                    )
                    .all(username, height),
            );
        }
        return result;
    }

    public getPendingSimple(): any {
        let fromHeight = this.getLastPaidSummary()?.height;

        if (!fromHeight) {
            fromHeight = this.database
                .prepare("SELECT MIN(height) FROM allocations WHERE allotment > 0 ORDER BY height LIMIT 1")
                .pluck()
                .get();
        }

        if (typeof fromHeight === "undefined") {
            return undefined;
        }

        const result = this.database.prepare(
           `SELECT MIN(round) AS minRound, MAX(round) AS maxRound, COUNT(round) AS rounds, 
	               MIN(height) AS minHeight, MAX(height) AS maxHeight, COUNT(height) AS blocks, 
	               ROUND(SUM(reward),8) AS blockRewards, ROUND(SUM(solfunds),8) AS blockFunds, 
	               ROUND(SUM(fees),8) as blockFees, ROUND(SUM(burnedFees),8) AS burnedFees, 
	               ROUND(SUM(earnedRewards),8) AS earnedRewards, ROUND(SUM(earnedFees),8) AS earnedFees
            FROM forged_blocks_human fbh 
            WHERE height > ${fromHeight}`)
        .get();

        return result;
    }

    public getBill(period: number, offset: number, now: Date, exclude: string | undefined = undefined): IBill[] {
        const t0 = Math.floor(new Date(Managers.configManager.getMilestone().epoch).getTime() / 1000);
        
        // retrieve the data in chunks of payperiod; 
        // slice the unixstamp(*) the block was forged into its date components y,m,d and q, where q is 1,2,3,4,6,8,12,24 (if payperiod <= 24)
        // note: unixtime is shifted back by offset hours to get the blocks forged in a 24 hours time span from offset to offset
        // TODO: q > 24 (every n days) logic is not fully vetted hence not allowed by the config helper in this release
        let partition = "";

        let until = 0;
        period ||= 24; // prevent div/0 against period=0 leakage
        if (period <= 24) {
            // find when the current payment slot ended to exclude blocks forged after that
            // (e.g. until 06:59:59 if offset is 3 and payperiod is 4) where q would be 2 of 6
            now.setUTCHours(now.getUTCHours() - ((now.getUTCHours() - offset) % period), 0, 0, 0)
            until = Math.floor(now.getTime() / 1000)
            partition = `strftime('%d', fb.ts, 'unixepoch') AS d, 1 + (strftime('%H', fb.ts, 'unixepoch') / ${period}) AS q,`;
        }
        else {
            period = Math.floor(period / 24);
            partition = `0 AS d, 1 + (strftime('%d', fb.ts, 'unixepoch') / ${period}) AS q,`;
        };

        let excludeCriteria = exclude ? "AND ADDRESS != '" + exclude + "'" : ""; 
        const sqlstr = 
            `SELECT rowid,
                strftime('%Y', fb.ts, 'unixepoch') AS y, 
                strftime('%m', fb.ts, 'unixepoch') AS m,
                ${partition}
                al.address, al.payeeType, al.allotment
            FROM (
                SELECT rowid, height, address, payeeType, allotment
                FROM allocations
                WHERE allotment > 0 AND transactionId = '' AND settled = 0
                ${excludeCriteria}
            ) al LEFT JOIN (
                -- shift epochstamp with epoch and payment time offset
                SELECT height, ${t0} + timestamp - ( ${offset} * 60 * 60 ) AS ts, ${t0} + timestamp as rts
                FROM forged_blocks
            ) fb 
            ON al.height = fb.height
            WHERE fb.rts < ${until}`;

        try {
            const result: IBill[] = this.database
            .prepare(sqlstr)
            .all();
            return result;
        } catch (error) {
            this.logger.critical("(LL) Error retrieving bill from the database");
            this.logger.critical(error.message);
            this.dc.sendmsg(`${emoji.biohazard_sign} Error retrieving bill from the database`);
            return [];
        }
    }

    public async getUnsettledAllocations(): Promise<string[]> {
        const sqlstr = 
            `SELECT DISTINCT transactionId FROM allocations a WHERE transactionId != '' AND settled = 0`;

        const job: IWorkerJob = {
            id: new ObjectId().toHexString(),
            customer: "getUnsettledAllocations",
            data: sqlstr,
        }
        try {
            const result = (await this.taskQueue.addTask(job)) as unknown as IAllocation[];
            result.forEach(r => { 
                r.balance = Utils.BigNumber.make(r.balance);
                r.orgBalance = Utils.BigNumber.make(r.orgBalance);
                r.allotment = Utils.BigNumber.make(r.allotment);
                r.validVote = Utils.BigNumber.make(r.validVote);
            });
            return result.map( (r) => r.transactionId );
        } 
        catch (error) {
            this.logger.critical("(LL) Error retrieving unsettled allocations from the database");
            this.logger.critical(error.message);
            this.dc.sendmsg(`${emoji.biohazard_sign} Error retrieving unsettled allocations from the database`);
            return [];
        }
    }

    public async setTransactionId(txid: string, idlist: number[]): Promise<SQLite3.RunResult> {
        const sqlstr = 
           `UPDATE allocations 
            SET transactionId = '${txid}'
            WHERE rowid IN (${[...idlist]})`;

        try {
            const result: SQLite3.RunResult = this.database
                .prepare(sqlstr)
                .run();
            
            return result;
        } catch (error) {
            this.logger.critical(`(LL) Error writing txid ${txid} to allocations`);
            this.logger.critical(error.message);
            this.dc.sendmsg(`${emoji.biohazard_sign} Error writing txid ${inlineCode(txid)} to allocations`);
            return sqliteRunError;
        }
    }

    public async clearTransactionId(txid: string): Promise<SQLite3.RunResult> {
        const sqlstr = `UPDATE allocations SET transactionId = '', settled = 0 WHERE transactionId = '${txid}'`;

        try {
            const result: SQLite3.RunResult = this.database
                .prepare(sqlstr)
                .run();

            return result;
        } catch (error) {
            this.logger.critical(`(LL) DB Error clearing txid ${txid} from allocations`);
            this.logger.critical(error.message);
            this.dc.sendmsg(`${emoji.biohazard_sign} Error clearing txid ${inlineCode(txid)} from allocations`);
            return sqliteRunError;
        }
}

    public async settleAllocation(txid: string, timestamp: number): Promise<SQLite3.RunResult> {
        const sqlstr = `UPDATE allocations SET settled = ${timestamp} WHERE transactionId = '${txid}' AND settled = 0`;

        try {    
            const result: SQLite3.RunResult = this.database
                .prepare(sqlstr)
                .run();
            return result;
        } catch (error) {
            this.logger.critical(`(LL) Error stamping allocations with txid ${txid} as settled`);
            this.logger.critical(error.message);
            this.dc.sendmsg(`${emoji.biohazard_sign} Error stamping allocations with txid ${inlineCode(txid)} as settled`);
            return sqliteRunError;
        }
}

    public updateValidVote(allocations: IAllocation[]): void {
        const updateAllocated: SQLite3.Statement<any[]> = this.database.prepare(
           `UPDATE allocations 
            SET balance = :balance,
                votePercent = :votePercent,
                validVote = :validVote, 
                allotment = :allotment
            WHERE allocations.height = :height
                AND address = :address
                AND payeeType = :payeeType
                AND transactionId = ''`,
        );
        const updateForged: SQLite3.Statement<any[]> = this.database.prepare(
            `UPDATE forged_blocks SET validVotes = :validVotes WHERE height = :height`,
        );
 
        try {
            this.database.transaction(() => {
                for (const alloc of allocations) {
                    updateAllocated.run({
                        height: alloc.height,
                        address: alloc.address,
                        payeeType: alloc.payeeType,
                        balance: alloc.balance.toFixed(),
                        votePercent: alloc.votePercent,
                        validVote: alloc.validVote.toFixed(),
                        allotment: alloc.allotment.toFixed()
                    });
                }
                const validVotes: Utils.BigNumber = allocations.map( o => o.validVote).reduce((prev, curr) => prev.plus(curr), Utils.BigNumber.ZERO);
                updateForged.run({ height: allocations[0].height, validVotes: validVotes.toFixed() });
            })();
        } catch (error) {
            this.logger.critical("(LL) Error updating last vote allocations");
            this.logger.critical(error.message);
            this.dc.sendmsg(`${emoji.biohazard_sign} Error updating last vote allocations`);
        }
    }

    public insert(
        forgedBlocks: IForgedBlock[],
        missedBlocks: { round: number; height: number; delegate: string; timestamp: number }[],
        allocations: IAllocation[]
    ): void {
        const insertForged: SQLite3.Statement<any[]> = this.database.prepare(
            "INSERT INTO forged_blocks VALUES (:round, :height, :timestamp, :delegate, :reward, :solfunds, :fees, :burnedFees, :votes, :validVotes, :orgValidVotes, :voterCount)",
        );
        const insertMissed: SQLite3.Statement<any[]> = this.database.prepare(
            "INSERT INTO missed_blocks VALUES (:round, :height, :delegate, :timestamp)",
        );
        const insertAllocated: SQLite3.Statement<any[]> = this.database.prepare(
            "INSERT INTO allocations VALUES (:height, :address, :payeeType, :balance, :orgBalance, :votePercent, :orgVotePercent, :validVote, :shareRatio, :allotment, :booked, :transactionId, :settled)",
        );
        const deleteForged: SQLite3.Statement<any[]> = this.database.prepare(
            "DELETE FROM forged_blocks WHERE height >= :height OR timestamp >= :timestamp",
        );
        const deleteMissed: SQLite3.Statement<any[]> = this.database.prepare(
            "DELETE FROM missed_blocks WHERE height >= :height OR timestamp >= :timestamp",
        );
        const deleteAllocated: SQLite3.Statement<any[]> = this.database.prepare(
            "DELETE FROM missed_blocks WHERE height >= :height",
        );

        try {
            this.database.transaction(() => {
                deleteForged.run({ height: forgedBlocks[0].height, timestamp: forgedBlocks[0].timestamp });
                deleteMissed.run({ height: forgedBlocks[0].height, timestamp: forgedBlocks[0].timestamp });
                deleteAllocated.run({ height: forgedBlocks[0].height });
                for (const block of forgedBlocks) {
                    //wrap IBlockForged in array to avoid Type Object must have a Symbol.iterator error
                    //Yet the following will suffer from fields expanding as BigNumber { value: }
                    //insertForged.run({ ...[block] }[0]);
                    insertForged.run({
                        round: block.round, 
                        height: block.height, 
                        timestamp: block.timestamp,
                        delegate: block.delegate,
                        reward: block.reward.toFixed(),
                        solfunds: block.solfunds.toFixed(),
                        fees: block.fees.toFixed(),
                        burnedFees: block.burnedFees.toFixed(),
                        votes: block.votes.toFixed(),
                        validVotes: block.validVotes.toFixed(),
                        orgValidVotes: block.orgValidVotes.toFixed(),
                        voterCount: block.voterCount              
                    });
                }
                for (const block of missedBlocks) {
                    insertMissed.run(block);
                }
                for (const alloc of allocations) {
                    insertAllocated.run({
                        height: alloc.height,
                        address: alloc.address,
                        payeeType: alloc.payeeType,
                        balance: alloc.balance.toFixed(),
                        orgBalance: alloc.orgBalance.toFixed(),
                        votePercent: alloc.votePercent,
                        orgVotePercent: alloc.orgVotePercent,
                        validVote: alloc.validVote.toFixed(),
                        shareRatio: alloc.shareRatio,
                        allotment: alloc.allotment.toFixed(),
                        booked: alloc.booked,
                        transactionId: alloc.transactionId,
                        settled: alloc.settled
                    });
                }
            })();
        } catch (error) {
            this.logger.critical("(LL) Error saving processed blocks to database");
            this.logger.critical(error.message);
            this.dc.sendmsg(`${emoji.biohazard_sign} Error saving processed blocks to database`);
        }
    }

    public purgeFrom(height: number, timestamp: number): void {
        this.logger.debug(`(LL) Purging blocks with height >= ${height} or timestamp >= ${timestamp}`);
        const deleteForged: SQLite3.Statement<any[]> = this.database.prepare(
            "DELETE FROM forged_blocks WHERE height >= :height OR timestamp >= :timestamp",
        );
        const deleteMissed: SQLite3.Statement<any[]> = this.database.prepare(
            "DELETE FROM missed_blocks WHERE height >= :height OR timestamp >= :timestamp",
        );
        const deleteAllocated: SQLite3.Statement<any[]> = this.database.prepare(
            "DELETE FROM allocations WHERE height >= :height",
        );

        try {
            this.database.transaction(() => {
                deleteForged.run({ height, timestamp });
                deleteMissed.run({ height, timestamp });
                deleteAllocated.run({ height });
            })();
        } catch (error) {
            this.logger.critical("(LL) Error purging blocks from the database");
            this.logger.critical(error.message);
            this.dc.sendmsg(`${emoji.biohazard_sign} Error purging blocks from the database`);
        }
    }

    public rollback(height: number): void {
        // called from cli when relay is NOT runningi hence cannot use this.logger
        console.log(`(LL) Rolling back the database to height < ${height}`);
        const truncateForged: SQLite3.Statement<any[]> = this.database.prepare("DELETE FROM forged_blocks WHERE height >= :height");
        const truncateMissed: SQLite3.Statement<any[]> = this.database.prepare("DELETE FROM missed_blocks WHERE height >= :height");
        const truncateAllocated: SQLite3.Statement<any[]> = this.database.prepare("DELETE FROM allocations WHERE height >= :height");
        
        try {
            this.triggers(false);
            this.database.transaction(() => {
                truncateForged.run({height});
                truncateMissed.run({height});
                truncateAllocated.run({height});
            })();
            this.triggers(true);
        } catch (error) {
            console.log("(LL) Error rolling back the database!");
            console.log(error.message);
        }
    }

    private triggers(create: boolean): void {
    }
}
