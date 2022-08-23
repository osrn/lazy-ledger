import { Repositories } from "@solar-network/database";
import { Enums, Utils } from "@solar-network/crypto";
import { Container } from "@solar-network/kernel";

export const txRepositorySymbol = Symbol.for("LazyLedger<TxRepository>");

@Container.injectable()
export class TxRepository {
    @Container.inject(Container.Identifiers.DatabaseTransactionRepository)
    public readonly transactionRepository!: Repositories.TransactionRepository;

    /**
     * Retrieves a delegate's voters along with their voting weights at a given block height
     * 
     * @param end - block height
     * @param username - delegate username
     * @param public_key - delegate public key
     * @returns Promise<{object}[]> - voter public key, vote weight
     */
    public async getDelegateVotesByHeight(end: number, username: string, public_key: string): Promise<{ publicKey: string; percent: number }[]> {
        const query = 
           `SELECT
                q1.sender_public_key AS "publicKey", 
                (CASE WHEN jsonb_typeof(q1.voting_for) = 'array' THEN 100::numeric ELSE (q1.voting_for->'${username}')::numeric END) AS percent
            FROM (
                -- get most recent vote transactions of these voters at the same block height
                SELECT DISTINCT ON (q2.sender_public_key) q2.sender_public_key, q2.block_height, q2.asset->'votes' AS voting_for
                FROM transactions q2 INNER JOIN (
                    -- find all delegates voters at a given block height
                    SELECT DISTINCT ON (sender_public_key) sender_public_key, block_height
                    FROM transactions
                    WHERE ((type_group=${Enums.TransactionTypeGroup.Solar} AND type=${Enums.TransactionType.Solar.Vote}) 
                        OR (type_group=${Enums.TransactionTypeGroup.Core} AND type=${Enums.TransactionType.Core.Vote}))
                    AND block_height <= ${end}
                    AND REGEXP_REPLACE((asset::jsonb->'votes')::text, '[+]','')::jsonb ?| array['${username}', '${public_key}']
                    ORDER BY sender_public_key ASC, block_height DESC    
                ) AS q3 ON q2.sender_public_key = q3.sender_public_key
              WHERE ((q2.type_group=${Enums.TransactionTypeGroup.Solar} AND q2.type=${Enums.TransactionType.Solar.Vote}) 
                  OR (q2.type_group=${Enums.TransactionTypeGroup.Core} AND q2.type=${Enums.TransactionType.Core.Vote}))
                AND q2.block_height <= ${end}
              ORDER BY q2.sender_public_key ASC, q2.block_height DESC
            ) AS q1
            -- filter out those who no longer vote for the delegate
            WHERE REGEXP_REPLACE(q1.voting_for::text, '[+]','')::jsonb ?| array['${username}', '${public_key}']
            ORDER BY q1.sender_public_key ASC;`;
            
        //console.log(`query: ${query}`)
        const qresult = await this.transactionRepository.query(query);
        //console.log(`vote query result: ${JSON.stringify(qresult, null, "\t")}`);
        //return Utils.BigNumber.make(qresult[0].amount || Utils.BigNumber.ZERO);
        return qresult;
    }

    public async getNetBalanceByHeightRange(start: number, end: number, address: string, public_key: string): Promise<Utils.BigNumber> {
        // Get inbound Supply
        let balance = (await this.getDelegateNetRewardByHeightRange(start, end, public_key))
                      .plus(await this.getInboundTotalByHeightRange(start, end, address))
                      .minus(await this.getOutboundTotalByHeightRange(start, end, public_key));

        return balance;
        //return balance;
    }

    public async getDelegateNetRewardByHeightRange(start: number, end: number, generator: string): Promise<Utils.BigNumber> {
        const [query, parameters] = this.transactionRepository.manager.connection.driver.escapeQueryWithParameters(
           `SELECT COALESCE(SUM(amount), 0) AS amount FROM (
                SELECT mq.height, (reward - sq.devfund + total_fee - burned_fee) AS amount
                FROM blocks mq LEFT JOIN (
                    SELECT height, SUM(COALESCE(value::numeric,0)) AS devfund
                    FROM blocks LEFT JOIN LATERAL jsonb_each_text(blocks.dev_fund) ON TRUE 
                    WHERE height > :start AND height <= :end
                      AND generator_public_key = :generator
                    GROUP BY height
                ) AS sq ON sq.height = mq.height
                WHERE mq.height > :start AND mq.height <= :end
                  AND mq.generator_public_key = :generator
            ) AS zreport`,
            { start, end, generator },
            {},
        );
        //console.log(`query: ${query} params: ${parameters}`)
        const qresult = await this.transactionRepository.query(query, parameters);
        //console.log(`inbound Supply result: ${qresult[0].amount}`);
        return Utils.BigNumber.make(qresult[0].amount || Utils.BigNumber.ZERO);
    }

    public async getInboundTotalByHeightRange(start: number, end: number, receiver: string): Promise<Utils.BigNumber> {
        // inbound Transfers; all except HTLC
        const txtypes = [Enums.TransactionType.Core.HtlcLock, Enums.TransactionType.Core.HtlcClaim, Enums.TransactionType.Core.HtlcRefund];
        let [query, parameters] = this.transactionRepository.manager.connection.driver.escapeQueryWithParameters(
           `SELECT COALESCE(SUM(amount), 0) AS amount FROM (
                SELECT id, block_height, COALESCE(transactions.amount,0) + COALESCE(tx.amount,0) AS amount
                FROM transactions LEFT JOIN LATERAL jsonb_to_recordset(transactions.asset->'transfers') AS tx(amount bigint, "recipientId" text) ON TRUE
                WHERE block_height > :start AND block_height <= :end
                  AND (tx."recipientId" = :receiver OR transactions.recipient_id = :receiver)
                  AND type NOT IN (:...txtypes)
            ) AS zreport`,
            { start, end, receiver, txtypes },
            {},
        );
        //console.log(`query: ${query} params: ${parameters}`)
        let q1result = await this.transactionRepository.query(query, parameters);
        //console.log(`inbound transactions except htlc result: ${q1result[0].amount}`);
        let balance = Utils.BigNumber.make(q1result[0].amount || Utils.BigNumber.ZERO);

        // inbound Claimed-HTLC-Lock Transfers
        [query, parameters] = this.transactionRepository.manager.connection.driver.escapeQueryWithParameters(
           `SELECT COALESCE(SUM(amount),0) AS amount FROM (
                SELECT * FROM transactions
                WHERE block_height > :start AND block_height <= :end
                AND recipient_id = :receiver
                AND type_group = ${Enums.TransactionTypeGroup.Core}
                AND type = ${Enums.TransactionType.Core.HtlcLock} 
                AND id IN (
                    SELECT asset ->'claim'->>'lockTransactionId' FROM transactions 
                    WHERE block_height > :start AND block_height <= :end 
                      AND type_group = ${Enums.TransactionTypeGroup.Core} 
                      AND type=${Enums.TransactionType.Core.HtlcClaim}
                ) 
            ) AS zreport`,
            { start, end, receiver, txtypes },
            {},
        );
        //console.log(`query: ${query} params: ${parameters}`)
        let q2result = await this.transactionRepository.query(query, parameters);
        //console.log(`inbound claimed-htlc result: ${q2result[0].amount}`);
        balance = balance.plus(q2result[0].amount);

        return balance;
    }

    public async getOutboundTotalByHeightRange(start: number, end: number, sender: string): Promise<Utils.BigNumber> {
        // Outbound Transfers; all except HTLC
        const txtypes = [Enums.TransactionType.Core.HtlcLock, Enums.TransactionType.Core.HtlcClaim, Enums.TransactionType.Core.HtlcRefund];
        let [query, parameters] = this.transactionRepository.manager.connection.driver.escapeQueryWithParameters(
           `SELECT COALESCE(SUM(amount), 0) AS amount FROM (
                SELECT id, block_height, COALESCE(transactions.amount,0) + COALESCE(tx.amount,0) AS amount
                FROM transactions LEFT JOIN LATERAL jsonb_to_recordset(transactions.asset->'transfers') AS tx(amount bigint, "recipientId" text) ON TRUE
                WHERE block_height > :start AND block_height <= :end
                  AND sender_public_key = :sender
                  AND type NOT IN (:...txtypes)
            ) AS zreport`,
            { start, end, sender, txtypes },
            {},
        );
        //console.log(`query: ${query} params: ${parameters}`)
        let q1result = await this.transactionRepository.query(query, parameters);
        //console.log(`outbound transactions except htlc result: ${q1result[0].amount}`);
        let balance = Utils.BigNumber.make(q1result[0].amount || Utils.BigNumber.ZERO);

        // outbound Claimed-HTLC-Lock Transfers
        [query, parameters] = this.transactionRepository.manager.connection.driver.escapeQueryWithParameters(
           `SELECT COALESCE(SUM(amount),0) AS amount FROM (
                SELECT * FROM transactions
                WHERE block_height > :start AND block_height <= :end
                AND "sender_public_key" = :sender
                AND type_group = ${Enums.TransactionTypeGroup.Core}
                AND "type" = ${Enums.TransactionType.Core.HtlcLock} 
                AND id IN (
                    SELECT asset ->'claim'->>'lockTransactionId' FROM transactions 
                    WHERE block_height > :start AND block_height <= :end 
                      AND type_group = ${Enums.TransactionTypeGroup.Core} 
                      AND type=${Enums.TransactionType.Core.HtlcClaim}
                ) 
            ) AS zreport`,
            { start, end, sender, txtypes },
            {},
        );
        //console.log(`query: ${query} params: ${parameters}`)
        let q2result = await this.transactionRepository.query(query, parameters);
        //console.log(`outbound claimed-htlc result: ${result2[0].amount}`);
        balance = balance.plus(q2result[0].amount);

        // (outbound) transaction fees
        [query, parameters] = this.transactionRepository.manager.connection.driver.escapeQueryWithParameters(
           `SELECT COALESCE(SUM(fee),0) AS amount FROM (
                SELECT * FROM transactions
                WHERE "block_height" > :start AND "block_height" <= :end
                  AND sender_public_key = :sender
            ) AS zreport`,
            { start, end, sender },
            {},
        );
        //console.log(`query: ${query} params: ${parameters}`)
        let q3result = await this.transactionRepository.query(query, parameters);
        //console.log(`outbound fees result: ${q3result[0].amount}`);
        balance = balance.plus(q3result[0].amount);
        
        return balance;
    }
}