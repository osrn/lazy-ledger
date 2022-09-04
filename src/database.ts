import { Managers, Utils } from "@solar-network/crypto";
import { Container, Contracts } from "@solar-network/kernel";
import SQLite3 from "better-sqlite3";
import { IAllocation, IBill, IForgedBlock, PayeeTypes } from "./interfaces";

export const databaseSymbol = Symbol.for("LazyLedger<Database>");

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
            console.log(`(LL) Opening database connection @ ${dataPath}/${dbfile}`);
        this.database = new SQLite3(`${dataPath}/${dbfile}`);
    }
    
    public async boot(): Promise<void> {
        this.init();
        //NOTE: SQLITE fields data type definitions are just documentation
        this.database.exec(`
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS forged_blocks (round INTEGER NOT NULL, height INTEGER NOT NULL PRIMARY KEY, timestamp NUMERIC NOT NULL, delegate TEXT NOT NULL, reward TEXT NOT NULL, solfunds TEXT NOT NULL, fees TEXT NOT NULL, burnedFees TEXT NOT NULL, votes TEXT, validVotes TEXT, orgValidVotes TEXT, voterCount INTEGER) WITHOUT ROWID;
            CREATE TABLE IF NOT EXISTS missed_blocks (round INTEGER NOT NULL, height INTEGER NOT NULL, delegate TEXT NOT NULL, timestamp NUMERIC PRIMARY KEY NOT NULL) WITHOUT ROWID;
            CREATE TABLE IF NOT EXISTS allocations (height INTEGER NOT NULL, address TEXT NOT NULL, payeeType INTEGER NOT NULL, balance TEXT NOT NULL, orgBalance TEXT NOT NULL, votePercent INTEGER NOT NULL, orgVotePercent INTEGER NOT NULL, validVote TEXT NOT NULL, shareRatio INTEGER, allotment TEXT, booked NUMERIC, transactionId TEXT, settled NUMERIC, PRIMARY KEY (height, address, payeeType)) WITHOUT ROWID;
            CREATE VIEW IF NOT EXISTS missed_rounds AS SELECT missed_blocks.* FROM missed_blocks LEFT OUTER JOIN forged_blocks ON missed_blocks.delegate = forged_blocks.delegate AND missed_blocks.round = forged_blocks.round WHERE forged_blocks.delegate IS NULL;
            DROP VIEW IF EXISTS forged_blocks_human;
            CREATE VIEW forged_blocks_human AS
                SELECT round, height, strftime('%Y%m%d-%H%M%S', timestamp+1647453600, 'unixepoch') AS forgedTime, 
                    reward/100000000.0 as reward, solfunds/100000000.0 as solfunds, fees/100000000.0 as fees, burnedFees/100000000.0 as burnedFees, 
                    (reward - solfunds)/100000000.0 AS earnedRewards, 
                    (fees - burnedFees)/100000000.0 AS earnedFees, 
                    (reward - solfunds + fees - burnedFees)/100000000.0 AS netReward, 
                    voterCount AS voters, votes/100000000.0 AS votes, validVotes/100000000.0 AS validVotes 
                FROM forged_blocks;
            DROP VIEW IF EXISTS allocated_human;
            CREATE VIEW allocated_human AS
                SELECT height, address, payeeType, balance/100000000.0 AS balance, votePercent, 
                    balance * votePercent / 100 / 100000000.0 as vote, validVote/100000000.0 AS validVote, 
                    shareRatio, allotment/100000000.0 AS allotment, strftime('%Y%m%d-%H%M%S', booked, 'unixepoch') AS bookedTime,
                    transactionId, CASE WHEN settled = 0 THEN 0 ELSE strftime('%Y%m%d-%H%M%S', settled , 'unixepoch') END AS settledTime, 
                    orgBalance/100000000.0 AS orgBalance, orgVotePercent
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

    public getLastVoterAllocation(height: number = 0): IAllocation[] {
        const result = this.database
            .prepare(`SELECT * FROM allocations WHERE height=${height ? height : "(SELECT MAX(height) FROM allocations)"} AND payeeType=${PayeeTypes.voter}`)
            .all();
        
        (result as unknown as IAllocation[]).forEach(r => { 
            r.balance = Utils.BigNumber.make(r.balance);
            r.orgBalance = Utils.BigNumber.make(r.balance);
            r.allotment = Utils.BigNumber.make(r.allotment);
            r.validVote = Utils.BigNumber.make(r.validVote);
        });
        return result;
    }

    public getTheLedgerAt(height: number = 0): Object[] {
        const result = this.database
            .prepare(`SELECT * FROM the_ledger WHERE height=${height ? height : "(SELECT MAX(height) FROM allocations)"}`)
            .all();
        
        return result;
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

    public getLastPayAttempt(): IForgedBlock {
        const response = this.database
            .prepare("SELECT * FROM allocations a WHERE transactionId IS NOT '' ORDER BY height DESC LIMIT 1")
            .get();
        
        return response;
    }

    public getLastPaid(): IForgedBlock {
        const response = this.database
            .prepare("SELECT * FROM allocations a WHERE settled > 0 ORDER BY height DESC LIMIT 1")
            .get();

        console.log("(LL) getLastPaid()", JSON.stringify(response, null, 4));
        return response;
        //return response ? response[0] : {};
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

    public getBill(period: number, offset: number, now: Date): IBill[] {
        const t0 = Math.floor(new Date(Managers.configManager.getMilestone().epoch).getTime() / 1000);
        
        // retrieve the data in chunks of payperiod; 
        // slice the unixstamp(*) the block was forged into its date components y,m,d and q, where q is 1,2,3,4,6,8,12 (if payperiod <= 24)
        // note: unixtime is shifted back offset to get blocks forged in a 24 hours time span from offset to offset
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

        const sqlstr = `SELECT y, m, d, q, payeeType, address, COUNT(allotment) AS duration, SUM(allotment) AS allotment FROM (
            SELECT 
              strftime('%Y', fb.ts, 'unixepoch') AS y, 
              strftime('%m', fb.ts, 'unixepoch') AS m,
              ${partition}
              al.address, al.payeeType, al.allotment
            FROM (
                SELECT height, address, payeeType, allotment FROM allocations
                WHERE allotment > 0 AND transactionId = '') al
            LEFT JOIN (
              -- shift epochstamp with epoch and payment time offset
              SELECT height, ${t0} + timestamp - ( ${offset} * 60 * 60 ) AS ts
              FROM forged_blocks
            ) fb 
            ON al.height = fb.height
            WHERE fb.ts < ${until}
        )
        GROUP BY y,m,d,q,payeeType,address`;

        //console.log(`(LL) query to run:\n ${sqlstr}`);
        const result: IBill[] = this.database
            .prepare(sqlstr)
            .all();
        return result;
    }

    public getUnsettledAllocations(): string[] {
        const result = this.database
            .prepare(`SELECT DISTINCT transactionId FROM allocations a 
            WHERE transactionId != '' AND settled = 0`)
            .all();
        return result.map( (r) => r.transactionId )
    }

    public setTransactionId(txid: string, period: number, offset: number, now: Date, y: string, m: string, d: string, q: number, address: string): SQLite3.RunResult {
        const t0 = Math.floor(new Date(Managers.configManager.getMilestone().epoch).getTime() / 1000);
        let until = 0;
        period ||= 24; // prevent div/0 against period=0 leakage
        if (period <= 24) {
            // find when the current payment slot ended to exclude blocks forged after that
            // (e.g. until = 06:59:59, if offset is 3 and payperiod is 4 where q would be 2 of 6)
            now.setUTCHours(now.getUTCHours() - ((now.getUTCHours() - offset) % period), 0, 0, 0)
            until = Math.floor(now.getTime() / 1000)
        }

        const sqlstr = `UPDATE allocations 
        SET transactionId = '${txid}'
        FROM (
            SELECT height, ${t0} + timestamp - ( ${offset} * 60 * 60 ) AS ts
            FROM forged_blocks
        ) AS fb
        WHERE allocations.height = fb.height
            AND transactionId = ''
            AND allotment > 0
            AND fb.ts < ${until}
            AND strftime('%Y', fb.ts, 'unixepoch') = '${y}'
            AND strftime('%m', fb.ts, 'unixepoch') = '${m}'
            AND strftime('%d', fb.ts, 'unixepoch') = '${d}'
            AND 1+strftime('%H', fb.ts, 'unixepoch')/${period} = ${q}
            AND address = '${address}'`;

        //console.log(`(LL) query to run:\n ${sqlstr}`);
        const result: SQLite3.RunResult = this.database
            .prepare(sqlstr)
            .run();

        // console.log("(LL)", txid, period, offset, until, y, m, d, q, address, "query result:", result);
        return result;
    }

    public clearTransactionId(txid: string): SQLite3.RunResult {
        const sqlstr = `UPDATE allocations SET transactionId = '', settled = 0 WHERE transactionId = '${txid}'`;

        //console.log(`(LL) query to run:\n ${sqlstr}`);
        const result: SQLite3.RunResult = this.database
            .prepare(sqlstr)
            .run();
        //console.log(`(LL) query result:\n ${result}`);
        return result;
    }

    public settleAllocation(txid: string, timestamp: number): SQLite3.RunResult {
        const sqlstr = `UPDATE allocations SET settled = ${timestamp} WHERE transactionId = '${txid}'`;

        //console.log(`(LL) query to run:\n ${sqlstr}`);
        const result: SQLite3.RunResult = this.database
            .prepare(sqlstr)
            .run();
        //console.log(`q(LL) uery result:\n ${result}`);
        return result;
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
            this.logger.error("(LL) Error saving to database");
            this.logger.error(error.message);
        }
    }

    public purgeFrom(height: number, timestamp: number): void {
        const deleteForged: SQLite3.Statement<any[]> = this.database.prepare(
            "DELETE FROM forged_blocks WHERE height >= :height OR timestamp >= :timestamp",
        );
        const deleteMissed: SQLite3.Statement<any[]> = this.database.prepare(
            "DELETE FROM missed_blocks WHERE height >= :height OR timestamp >= :timestamp",
        );
        const deleteAllocated: SQLite3.Statement<any[]> = this.database.prepare(
            "DELETE FROM allocations WHERE height >= :height",
        );
        this.database.transaction(() => {
            deleteForged.run({ height, timestamp });
            deleteMissed.run({ height, timestamp });
            deleteAllocated.run({ height });
        })();
    }

    public truncate(): void {
        this.triggers(false);
        const truncateForged: SQLite3.Statement<any[]> = this.database.prepare("DELETE FROM forged_blocks");
        const truncateMissed: SQLite3.Statement<any[]> = this.database.prepare("DELETE FROM missed_blocks");
        const truncateAllocated: SQLite3.Statement<any[]> = this.database.prepare("DELETE FROM allocations");
        this.database.transaction(() => {
            truncateForged.run();
            truncateMissed.run();
            truncateAllocated.run();
        })();
        this.triggers(true);
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
