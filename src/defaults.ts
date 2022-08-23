export const defaults = {
    enabled: false,
    delegate: "delegate",
    passphrase: "delegate wallet mnemonic phrase",
    excludeSelfFrTx: true,
    mergeAddrsInTx: false,
    reservePaysFees: true,
    shareEarnedFees: false,
    reserveGetsFees: false,
    postInitInstantPay: false,
    plans: [
        {
            height: 0,
            share: 50,
            reserves: [
                {address: "reserve_wallet_address", share: 50}
            ],
            donations: [],
            blacklist: [],
            mincap: 0,
            maxcap: 0,
            payperiod: 24,
            payoffset: 0,
            guardtime: 10
        },
    ]
};
