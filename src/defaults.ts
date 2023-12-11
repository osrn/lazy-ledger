export const defaults = {
    delegate: "bp",
    passphrase: "bp wallet mnemonic phrase",
    excludeSelfFrTx: true,
    mergeAddrsInTx: false,
    reservePaysFees: true,
    shareEarnedFees: false,
    reserveGetsFees: false,
    postInitInstantPay: false,
    antibot: true,
    whitelist: [],
    discord: {},
    plans: [
        {
            height: 0,
            timestamp: 0,
            share: 0,
            reserves: [
                {address: "reserve_wallet_address", share: 0}
            ],
            donations: [],
            blacklist: [],
            mincap: 0,
            maxcap: undefined,
            payperiod: 24,
            payoffset: 0,
            guardtime: 10
        },
    ]
};

export const baseplan = {
    height: 0,
    timestamp: 0,
    share: 0,
    reserves: [
        {address: "", share: 0}
    ],
    donations: [],
    blacklist: [],
    mincap: 0,
    maxcap: undefined,
    payperiod: 24,
    payoffset: 0,
    guardtime: 10
};
