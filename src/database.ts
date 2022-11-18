import { Constants, Managers, Networks, Types, Utils } from "@solar-network/crypto";
import { Container, Contracts } from "@solar-network/kernel";
import SQLite3 from "better-sqlite3";
import { IAllocation, IBill, IForgedBlock, IForgingStats, PayeeTypes } from "./interfaces";

export const databaseSymbol = Symbol.for("LazyLedger<Database>");
const sqliteRunError: SQLite3.RunResult = { changes: -1, lastInsertRowid: 0 };

@Container.injectable()
export class Database {
    @Container.inject(Container.Identifiers.LogService) 
    private readonly logger!: Contracts.Kernel.Logger;

    private database!: SQLite3.Database;

    public init(dataPath?: string) {
        dataPath ||= process.env.CORE_PATH_DATA;
        const dbfile = "lazy-ledger.sqlite";
        if (this.logger) 
            this.logger.debug(`(LL) Opening database connection @ ${dataPath}/${dbfile}`);
        else
            // no logger means called by a cli command
            console.log(`(LL) Opening database connection @ ${dataPath}/${dbfile}`);
        this.database = new SQLite3(`${dataPath}/${dbfile}`);
    }
    
    public async boot(): Promise<void> {
        this.init();
        //NOTE: SQLITE fields data type definitions are just for documentation purposes by SQLite Design
        const t0 = Math.floor(new Date(Managers.configManager.getMilestone().epoch).getTime() / 1000);
        this.database.exec(`
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS forged_blocks (round INTEGER NOT NULL, height INTEGER NOT NULL PRIMARY KEY, timestamp NUMERIC NOT NULL, delegate TEXT NOT NULL, reward TEXT NOT NULL, solfunds TEXT NOT NULL, fees TEXT NOT NULL, burnedFees TEXT NOT NULL, votes TEXT, validVotes TEXT, orgValidVotes TEXT, voterCount INTEGER) WITHOUT ROWID;
            CREATE TABLE IF NOT EXISTS missed_blocks (round INTEGER NOT NULL, height INTEGER NOT NULL, delegate TEXT NOT NULL, timestamp NUMERIC PRIMARY KEY NOT NULL) WITHOUT ROWID;
            CREATE TABLE IF NOT EXISTS allocations (height INTEGER NOT NULL, address TEXT NOT NULL, payeeType INTEGER NOT NULL, balance TEXT NOT NULL, orgBalance TEXT NOT NULL, votePercent INTEGER NOT NULL, orgVotePercent INTEGER NOT NULL, validVote TEXT NOT NULL, shareRatio INTEGER, allotment TEXT, booked NUMERIC, transactionId TEXT, settled NUMERIC, PRIMARY KEY (height, address, payeeType));
            CREATE VIEW IF NOT EXISTS missed_rounds AS SELECT missed_blocks.* FROM missed_blocks LEFT OUTER JOIN forged_blocks ON missed_blocks.delegate = forged_blocks.delegate AND missed_blocks.round = forged_blocks.round WHERE forged_blocks.delegate IS NULL;
            DROP VIEW IF EXISTS forged_blocks_human;
            CREATE VIEW forged_blocks_human AS
                SELECT round, height, strftime('%Y-%m-%d %H:%M:%S', timestamp+${t0}, 'unixepoch') AS forgedTime, 
                    reward/${Constants.SATOSHI}.0 as reward, solfunds/${Constants.SATOSHI}.0 as solfunds, fees/${Constants.SATOSHI}.0 as fees, burnedFees/${Constants.SATOSHI}.0 as burnedFees, 
                    (reward - solfunds)/${Constants.SATOSHI}.0 AS earnedRewards, 
                    (fees - burnedFees)/${Constants.SATOSHI}.0 AS earnedFees, 
                    (reward - solfunds + fees - burnedFees)/${Constants.SATOSHI}.0 AS netReward, 
                    voterCount AS voters, votes/${Constants.SATOSHI}.0 AS votes, validVotes/${Constants.SATOSHI}.0 AS validVotes 
                FROM forged_blocks;
            DROP VIEW IF EXISTS allocated_human;
            CREATE VIEW allocated_human AS
                SELECT rowid, height, address, payeeType, balance/${Constants.SATOSHI}.0 AS balance, votePercent, 
                    balance * votePercent / 100 / ${Constants.SATOSHI}.0 as vote, validVote/${Constants.SATOSHI}.0 AS validVote, 
                    shareRatio, allotment/${Constants.SATOSHI}.0 AS allotment, strftime('%Y-%m-%d %H:%M:%S', booked, 'unixepoch') AS bookedTime, 
                    transactionId, CASE WHEN settled = 0 THEN 0 ELSE strftime('%Y-%m-%d %H:%M:%S', settled , 'unixepoch') END AS settledTime, 
                    orgBalance/${Constants.SATOSHI}.0 AS orgBalance, orgVotePercent
                FROM allocations ORDER BY height DESC;
            DROP VIEW IF EXISTS the_ledger;
            CREATE VIEW the_ledger AS
                SELECT b.round, a.height, b.forgedTime, b.reward, b.earnedRewards, b.earnedFees, b.netReward, 
                    b.validVotes, a.address, a.payeeType, a.balance, a.votePercent, a.vote, a.validVote, 
                    a.shareRatio, a.allotment, a.bookedTime, a.transactionId, a.settledTime, a.orgBalance, a.orgVotePercent 
                FROM allocated_human a LEFT JOIN forged_blocks_human b ON a.height = b.height;
            CREATE INDEX IF NOT EXISTS forged_blocks_delegate_timestamp ON forged_blocks (delegate, timestamp);
            CREATE INDEX IF NOT EXISTS forged_blocks_delegate_round on forged_blocks (delegate, round);
            CREATE INDEX IF NOT EXISTS missed_blocks_delegate on missed_blocks (delegate);
        `);
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

    public getVoterAllocationAtHeight(height: number = 0): IAllocation[] {
        const result = this.database
            .prepare(`SELECT * FROM allocations WHERE height=${height ? height : "(SELECT MAX(height) FROM allocations)"} AND payeeType=${PayeeTypes.voter}`)
            .all();
        
        (result as unknown as IAllocation[]).forEach(r => { 
            r.balance = Utils.BigNumber.make(r.balance);
            r.orgBalance = Utils.BigNumber.make(r.orgBalance);
            r.allotment = Utils.BigNumber.make(r.allotment);
            r.validVote = Utils.BigNumber.make(r.validVote);
        });
        return result;
    }

    public getAllVotersLastAllocation(height: number = 0): IAllocation[] {
        const result = this.database.prepare(
           `SELECT m.* FROM allocations m INNER JOIN (
                SELECT address, MAX(height) as height from allocations
                WHERE payeeType = 1
                GROUP BY address
            ) AS g
            ON m.address = g.address
            AND m.height = g.height
            WHERE payeeType = 1
            ORDER by m.height ASC`)
        .all();
        
        (result as unknown as IAllocation[]).forEach(r => { 
            r.balance = Utils.BigNumber.make(r.balance);
            r.orgBalance = Utils.BigNumber.make(r.orgBalance);
            r.allotment = Utils.BigNumber.make(r.allotment);
            r.validVote = Utils.BigNumber.make(r.validVote);
        });
        return result;
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
                WHERE payeeType = 1
                AND votePercent > 0
            ) AS al 
            ON fb.height = al.height
            WHERE (${t0} + fb."timestamp") >= ${start}
              AND (${t0} + fb."timestamp") < ${end}
            GROUP BY al.address`)
        .all();

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

        //console.log(`(LL) query to run:\n ${sqlstr}`);
        return result;
    }

    // public getPending(period: number, offset: number, scope: PendingTypes, network?: Types.NetworkName): any {
    //     if (typeof network !== "undefined" && Object.keys(Networks).includes(network!)) {
    //         Managers.configManager.setFromPreset(network!);
    //     } 
    //     const t0 = Math.floor(new Date(Managers.configManager.getMilestone().epoch).getTime() / 1000);
    //     const now = new Date();

    //     // Amount to be retrieved is;
    //     //  -- all pending up until last payment period if PendingType.due
    //     //  -- all pending from last payment period to now if PendingType.current
    //     //  -- anything pending
    //     period ||= 24; // prevent div/0 against period=0 leakage
    //     if (scope === PendingTypes.due || scope === PendingTypes.current) {
    //         // TODO: Handle case period > 24

    //         // find when the current payment slot ended to exclude blocks forged after that
    //         // (e.g. until 06:59:59 if offset is 3 and payperiod is 4) where q would be 2 of 6
    //         now.setUTCHours(now.getUTCHours() - ((now.getUTCHours() - offset) % period), 0, 0, 0)
    //     }
    //     // cutoff time is current time only with PendingTypes.all
    //     const cutoffts = Math.floor(now.getTime() / 1000)
    //     const bracket = (scope === PendingTypes.current) ? ">" : "<";

    //     const result = this.database.prepare(
    //        `SELECT MIN(round) AS minRound, MAX(round) AS maxRound, COUNT(round) AS rounds, 
	//                MIN(height) AS minHeight, MAX(height) AS maxHeight, COUNT(height) AS blocks, 
	//                SUM(reward) AS blockRewards, SUM(solfunds) AS blockFunds, 
	//                SUM(fees) as blockFees, SUM(burnedFees) AS burnedFees, 
	//                SUM(earnedRewards) AS earnedRewards, SUM(earnedFees) AS earnedFees
    //         FROM forged_blocks_human fbh 
    //         -- As unpaid allocations may span intermittent block ranges, 
    //         -- we just cannot sum a fixed range of blocks to find due amount.
    //         -- Thus, match against a filtered list
    //         WHERE height IN (
    //         	SELECT DISTINCT al.height
	//             FROM allocations al INNER JOIN (SELECT height, ${t0} + timestamp as rts FROM forged_blocks) AS fb
	//             ON al.height = fb.height 
	//             WHERE al.allotment > 0 
	//             AND al.transactionId = ''
	//             AND fb.rts ${bracket} ${cutoffts})`)
    //     .all();

    //     //console.log(`(LL) query to run:\n ${sqlstr}`);
    //     return result;
    // }

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

        //console.log(`(LL) query to run:\n ${sqlstr}`);

        try {
            const result: IBill[] = this.database
            .prepare(sqlstr)
            .all();
            return result;
        } catch (error) {
            this.logger.error("(LL) Error retrieving bill from the database");
            this.logger.error(error.message);
            return [];
        }
    }

    public getUnsettledAllocations(): string[] {
        try {
            const result = this.database
            .prepare(`SELECT DISTINCT transactionId FROM allocations a WHERE transactionId != '' AND settled = 0`)
            .all();
            return result.map( (r) => r.transactionId )
        } catch (error) {
            this.logger.error("(LL) Error retrieving unsettled allocations from the database");
            this.logger.error(error.message);
            return [];
        }
    }

    public async setTransactionId(txid: string, idlist: number[]): Promise<SQLite3.RunResult> {
        // this.logger.debug(`(LL) Writing txid ${txid} to allocations`);
        const sqlstr = 
           `UPDATE allocations 
            SET transactionId = '${txid}'
            WHERE rowid IN (${[...idlist]})`;

        try {
            // console.log(`(LL) trace: query to run:\n ${sqlstr}`);
            const result: SQLite3.RunResult = this.database
                .prepare(sqlstr)
                .run();
            
            // console.log("(LL) trace: query result:", result);
            return result;
        } catch (error) {
            this.logger.error(`(LL) Error writing txid ${txid} to allocations`);
            this.logger.error(error.message);
            return sqliteRunError;
        }
    }

    public async clearTransactionId(txid: string): Promise<SQLite3.RunResult> {
        // this.logger.debug(`(LL) Clearing txid ${txid} from allocations`);
        const sqlstr = `UPDATE allocations SET transactionId = '', settled = 0 WHERE transactionId = '${txid}'`;
        //console.log(`(LL) query to run:\n ${sqlstr}`);

        try {
            const result: SQLite3.RunResult = this.database
                .prepare(sqlstr)
                .run();
            //console.log(`(LL) query result:\n ${result}`);
            return result;
        } catch (error) {
            this.logger.error(`(LL) DB Error clearing txid ${txid} from allocations`);
            this.logger.error(error.message);
            return sqliteRunError;
        }
}

    public async settleAllocation(txid: string, timestamp: number): Promise<SQLite3.RunResult> {
        // this.logger.debug(`(LL) Stamping allocations with txid ${txid} as settled`);
        const sqlstr = `UPDATE allocations SET settled = ${timestamp} WHERE transactionId = '${txid}' AND settled = 0`;
        //console.log(`(LL) query to run:\n ${sqlstr}`);

        try {    
            const result: SQLite3.RunResult = this.database
                .prepare(sqlstr)
                .run();
            //console.log(`(LL) query result:\n ${result}`);
            return result;
        } catch (error) {
            this.logger.error(`(LL) Error stamping allocations with txid ${txid} as settled`);
            this.logger.error(error.message);
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
        //console.log(`(LL) query to run:\n ${sqlstr}`);
 
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
            this.logger.error("(LL) Error updating last vote allocations");
            this.logger.error(error.message);
        }
    }

    public insert(
        forgedBlocks: IForgedBlock[],
        missedBlocks: { round: number; height: number; delegate: string; timestamp: number }[],
        allocations: IAllocation[]
    ): void {
        // console.log(`(LL) allocations:\n ${JSON.stringify(allocations)}`);
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
            this.logger.error("(LL) Error saving processed blocks to database");
            this.logger.error(error.message);
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
            this.logger.error("(LL) Error purging blocks from the database");
            this.logger.error(error.message);
        }
    }

    public rollback(height: number): void {
        this.logger.debug(`(LL) Rolling back the database to height < ${height}`);
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
            this.logger.error("(LL) Error rolling back the database");
            this.logger.error(error.message);
        }
    }

    private triggers(create: boolean): void {
        /*if (create) {
            this.database.exec(
                "CREATE TRIGGER IF NOT EXISTS monotonic_blocks BEFORE INSERT ON forged_blocks BEGIN SELECT CASE WHEN (SELECT height FROM forged_blocks ORDER BY height DESC LIMIT 1) != NEW.height - 1 THEN RAISE (ABORT,'Forged block height did not increment monotonically') END; END",
            );
            this.database.exec(
                "CREATE TRIGGER IF NOT EXISTS forged_for_missed BEFORE INSERT ON missed_blocks BEGIN SELECT CASE WHEN (SELECT height FROM forged_blocks WHERE height = NEW.height) != NEW.height THEN RAISE (ABORT,'Missed block height did not have a matching forged height') END; END",
            );
        } else {
            this.database.exec("DROP TRIGGER IF EXISTS monotonic_blocks");
            this.database.exec("DROP TRIGGER IF EXISTS forged_for_missed");
        }*/
    }
}
