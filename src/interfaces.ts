import { Contracts } from "@solar-network/kernel";
import { Utils } from "@solar-network/crypto";

export interface IConfig extends Record<string, any> {
    delegate: string;           // bp username
    plans: Array<IPlan>;        // reward sharing plans
    passphrase: string;         // bp wallet mnemonic passphrase
    secondpass: string;         // bp wallet second passphrase
    excludeSelfFrTx: boolean;   // include bp in transaction if reserve=bp or bp self voting
    mergeAddrsInTx: boolean;    // summarize payments to same recipient
    reservePaysFees: boolean;   // deduct transaction fee from the first reserve address allocation (at the time of actual payment) | bp wallet needs sufficient funds for fee otherwise
    shareEarnedFees: boolean;   // include earned transaction fees (=unburned 10%) in reserve, voter and donee allocations
    reserveGetsFees: boolean;   // when earned fees are not shared, allocate transaction fees to the first reserve address | stays in bp wallet otherwise)
    postInitInstantPay: boolean;// make a payment run immediately after plugin starts following initial sync
    antibot: boolean;           // anti-bot processing active if true
    whitelist: string[];        // addresses exempt from anti-bot processing (bp address is automatically whitelisted)
    discord?: {webhookId: string, webhookToken: string, mention: string, botname: string};
    bpWallet?: Contracts.State.Wallet; // for internal use
    bpWalletAddress?: string;   // for internal use
    bpWalletPublicKey?: string; // for internal use
}

export interface IPlan extends Record<string, any> {
    height?: number;
    timestamp?: number | string;// unix timestamp (not Solar epochStamp) | YYYY-MM-DDTHH:mm:ss.sssZ | YYYY-MM-DDTHH:mm:ss.sss+-hh:mm
    share: number;              // voter share ratio. 0-100, up to 2 decimal places
    reserves: Array<IPayee>;    // recipients for rewards kept
    donations: Array<IPayee>;   // recipients for donations
    // share + reserves[].share + donations[].share = 100 recommended but not enforced! by the plugin
    mincap: number;             // minimum voter wallet balance eligible for rewards allocation (SXP)
    maxcap: number;             // maximum vote weight from an address (SXP)
    blacklist: string[];        // addresses blacklisted from rewards allocation
    payperiod: number;          // Payment cycle - every [0,1,2,3,4,6,8,12,24] hours. 0 if plugin should not handle payment.
    payoffset: number;          // 0-23. new cycle begins at UTC 00:00 + offset hrs.
    guardtime: number;          // 0-59. delay in minutes before preparing the payment order at the end of a payment cycle - precaution against block reverts
}

export interface IPayee {
    address: string;
    share: number;
}

export interface IForgedBlock {
    round: number; 
    height: number; 
    timestamp: number; 
    delegate: string; 
    reward: Utils.BigNumber;
    solfunds: Utils.BigNumber;
    fees: Utils.BigNumber;
    burnedFees: Utils.BigNumber;
    votes: Utils.BigNumber;
    validVotes: Utils.BigNumber;
    orgValidVotes: Utils.BigNumber;
    voterCount: number;
}

export interface IMissedBlock { 
    round: number; 
    height: number; 
    delegate: string; 
    timestamp: number 
};

export interface IAllocation {
    height: number;                 // allocation for block height
    address: string;                // payee wallet address
    payeeType: PayeeTypes;          // payee type
    balance: Utils.BigNumber;       // wallet balance. 0 if reserve|donee
    orgBalance: Utils.BigNumber;    // original wallet balance before antibot. 0 if reserve|donee
    votePercent: number;            // percent voting for bp. 0 if reserve|donee
    orgVotePercent: number;         // original percent voting for bp before antibot. 0 if reserve|donee
    validVote: Utils.BigNumber;     // effective voting balance after mincap|maxcap|blacklist|antibot. 0 if reserve|donee
    shareRatio: number;             // reward share percentage at block height
    allotment: Utils.BigNumber;     // reward amount allocated
    booked: number;                 // unix timestamp the allocation done
    transactionId: string;          // transaction id for payment accepted in pool
    settled: number;                // unix timestamp transaction forged 
}

export interface IForgingStats {
    firstRound: number;
    lastRound: number;
    roundCount: number;
    firstForged: number; 
    lastForged:number;
    forgedCount: number; 
    blockRewards: Utils.BigNumber;
    blockFunds: Utils.BigNumber;
    blockFees: Utils.BigNumber;
    burnedFees: Utils.BigNumber;
    earnedRewards: Utils.BigNumber;
    earnedFees: Utils.BigNumber;
    avgVotes: Utils.BigNumber;
    avgVoterCount: number;
}

export enum PayeeTypes {
    reserve = 0,
    voter,
    donee
}

export interface IBill { 
    rowid: number;
    y: string, 
    m: string, 
    d: string, 
    q: number, 
    payeeType: number, 
    address: string, 
    allotment: string 
}

export enum PendingTypes {
    due = 0,
    current,
    all
}
