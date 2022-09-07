# Lazy-Ledger True Block Weight Reward Sharing Plugin for Solar Network

Solar Network Core Plugin for Rewards Bookkeeping and Payments Distribution. 

## Introduction
Lazy-Ledger is a core plugin utilizing core functions and events to share forging rewards with voters and other stakeholders. Rewards are calculated at each forged block then allocated amongst the stakeholders in compliance with the reward sharing plan(s) configured. Mutltiple plans can be scheduled only one being active at a given block height & timestamp.

The ledger is stored as a local database where an entry is recorded for each stakeholder for each block forged. An auto-recovery mechanism continuously checks for block reverts, aligning ledger database with the network.

A ledger record is composed of following metadata:
`block height`, `round`, `forged time`, `block reward`, `earned reward`[^1], `earned fees`[^2], `total valid votes`[^3], `recipient address`, `recipient type`, `valid voting balance`[^3], `share ratio`, `allotment`, `entry timestamp`, `payment transaction id`, `timestamp transaction forged`

All timestamps are unix except forged time, which is Solar epochstamp.

[^1]: block reward less protocol level fund donations

[^2]: block transaction fees less burned fees

[^3]: valid amount after mincap, maxcap, blacklist and anti-bot processing

Following the boot sequence plugin retrieves all past forged blocks from the core database, calculating stakeholders and allocations valid for the block's height & timestamp using the corresponding plan. Following initial sync, Ledger is updated in real time triggered by the core events.

Governed by the plan parameters, a periodic payment job distributes rewards to the stakeholders. Transaction fee is calculated dynamically. Transfer recipients and pool sender limits are respected. A debt is only settled when the corresponding transaction is forged, but unsettled back should the transaction is reverted afterwards.

The plugin can optionally be used for bookkeeping only; handling payments externally by directly accessing the database[^4].

[^4]: `.local/share/solar-core/{mainnet|testnet}/lazy-ledger.sqlite`

### Voter protection
Plugin employs a protection mechanism against malicious bots (those making a roundtrip of votes &| funds among several addresses within the round) by looking ahead one forging cycle and reducing the valid votes of the offending addresses for the last block as per their actions. Consequently last block allocation distribution recalculated to the benefit of all stakeholders.

Offending address votes are recalculated only when:
1. voting percentage is reduced
2. an outbound transfer is made

No action taken if **vote percent increases** or **funds received** or the **allocation for that block is already in transaction pool**.

## Installation
```bash
solar plugin:install https://github.com/osrn/lazy-ledger.git
```

or
```bash
. ~/.solar/.env
cd ~/solar-core/plugins
git clone https://github.com/osrn/lazy-ledger
cd lazy-ledger
pnpm install && pnpm build
cd ~/.local/share/solar-core/testnet/plugins/
mkdir '@osrn' && cd '@osrn'
ln -s ~/solar-core/plugins/lazy-ledger lazy-ledger
```

## Configuration
The plugin must be configured by adding a section in `~/.config/solar-core/{mainnet|testnet}/app.json`. Add a new entry to the end of the `plugins` section within the `relay` block. A sample entry is provided [below](#sample-configuration). Configuration options explanied [here](#config-options).

This sample config will;
- allocate 100% to reserve address until block height 100000, paying every 24 hours at 00:10 UTC
- allocate 50% to voters, 50% to reserve address starting with block 100000 until 2022-08-14T23:59:59.999 UTC, paying every 24 hours at 00:10 UTC
- allocate 90% to voters, 10% to reserve address between 2022-08-15T00:00:00.000Z and 2022-08-22T00:00:00.000Z, paying every 6 hours at 10 minutes past UTC.
- allocate 50% to voters, 50% to reserve address after 2022-08-22T00:00:00.000, paying every 24 hours at 00:10 UTC

Payment plans follows a milestone principle: higher index properties override the lower ones, where an effective plan is produced against the height and timestamp for a given forged block. There is no in built plan sorting, thus **_linear scheduling is your responsibility_**.

> You should always take your plans' payment schedule into consideration should you ever need to execute `solar snapshot:truncate|rollback` on your relay independent of the rest of the network; as this will revert the plugin database to rollback height after relay restarts, erasing any subsequent payment records. This may lead to duplicate payments for previously distributed rewards unless the whole network had rolled back. Making a database backup in advance and setting the base plan height to first unpaid allocation's forged block is a recommended practice before any such destructive operation.

### Sample configuration
```json
    "relay": {
        "plugins": [
            ...,
            {
                "package": "@osrn/lazy-ledger",
                "options": {
                    "enabled": true,
                    "delegate": "delegate_username",
                    "passphrase": "delegate wallet mnemonic phrase",
                    "excludeSelfFrTx": true,
                    "mergeAddrsInTx": false,
                    "reservePaysFees": true,
                    "shareEarnedFees": false,
                    "reserveGetsFees": false,
                    "postInitInstantPay": false,
                    "antibot": true,
                    "whitelist": [],
                    "plans": [
                        {
                            "height": 0,
                            "share": 0,
                            "reserves": [
                                {"address": "reserve_wallet_address", "share": 100}
                            ],
                            "donations": [],
                            "blacklist": [],
                            "mincap": 0,
                            "maxcap": 0,
                            "payperiod": 24,  
                            "payoffset": 0, 
                            "guardtime": 10 
                        },
                        {
                            "height": 100000,
                            "share": 65,
                            "reserves": [
                                {"address": "reserve_wallet_address", "share": 35}
                            ]
                        }
                        {
                            "timestamp": "2022-08-15T00:00:00.000Z",
                            "share": 90,
                            "reserves": [
                                {"address": "reserve_wallet_address", "share": 10}
                            ],
                            "payperiod": 6
                        },
                        {
                            "timestamp": "2022-08-22T00:00:00.000Z",
                            "share": 50,
                            "reserves": [
                                {"address": "reserve_wallet_address", "share": 50}
                            ],
                            "payperiod": 24
                        }
                    ]
                }
            },
        ]
    },
```

### Config Options

| Name | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| enabled | boolean | false | plugin enabled |
| delegate | string | | delegate username |
| plans | Array\<Plan\> | |reward sharing plans |
| passphrase | string | | delegate wallet passphrase |
| secondpass | string | | delegate wallet second passphrase |
| excludeSelfFrTx | boolean | true |exclude delegate address from payment transaction if reserve=delegate or delegate self voting |
| mergeAddrsInTx | boolean | false | pivot payment transaction on recipient address. Best to use when catching up with several past due payments to reduce transaction size, hence the tx fee |
| reservePaysFees | boolean | true | deduct transaction fee from the first reserve address allocation (at the time of actual transaction) \| delegate wallet needs sufficient funds for paying fees otherwise |
| shareEarnedFees | boolean | false | include earned transaction fees (=unburned 10%) in reserve, voter and donee allocations |
| reserveGetsFees | boolean | false | when earned fees are not shared, allocate transaction fees to the first reserve address \| stays in delegate wallet otherwise) |
| postInitInstantPay | boolean | false | make a payment run immediately after plugin starts following initial sync |
| antibot | boolean | true | anti-bot processing active if true |
| whitelist | string[] | [] | addresses exempt from anti-bot processing (delegate address is automatically whitelisted) |

### Plan

| Name | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| height? | number | 0 | Activate plan at this height. Optional.|
| timestamp? | number \| string | | Activate plan at this time. Optional.<br>unix timestamp (not Solar epochStamp) \| YYYY-MM-DDTHH:mm:ss.sssZ \| YYYY-MM-DDTHH:mm:ss.sss+-hh:mm |
| share | number | 50 | voter share ratio. 0-100, up to 2 decimal places | 
| reserves | Array\<Payee\> | | recipients for rewards kept. Mandatory for first (base) plan |
| donations | Array\<Payee\> | [] | recipients for donations |
| mincap | number | 0 | minimum voter wallet balance eligible for rewards allocation |
| maxcap | number | 0 | maximum vote weight from an address |
| blacklist | string[] | [] | addresses blacklisted from rewards allocation |
| payperiod | number | 24 | Payment cycle - every [0,1,2,3,4,6,8,12,24] hours. Zero if plugin should not handle payment |
| payoffset | number | 0 | new cycle begins at UTC 00:00 + offset hrs. 0-23. |
| guardtime | number | 10 | delay in minutes before preparing the payment order at the end of a payment cycle - precaution against block reverts. 0-59. |

>share + reserves[].share + donations[].share = 100 recommended, but not enforced!

>payperiod:24, payoffset:3, guardtime:30 will schedule payments at 00:30 Turkish time, daily for allocations from 21:00 UTC previous day to UTC 21:00 today.

### Payee
| Name | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| address | string | | recipient wallet address | 
| share | number | 50 | share ratio. 0-100, up to 2 decimal places | 

## Running
Configure, then restart relay. First time sync may take ~10+mins for 1.2M blocks depending on the node capacity.

## CLI
`solar ll:alloc [height]` : shows the block allocation at given block height. Last block if argument skipped.

`solar ll:lastpaid [--all]` : shows the last paid allocations. summary if flag skipped.

`solar ll:rollback <height>` : deletes all records starting with (and including) the first block of the round for the given height.

## Logs
Uses the core logger with (LL) prefix. Type `pm2 logs solar-relay` or `less -R +F ~/.pm2/logs/solar-relay-out.log` to watch the logs in real time. `grep "(LL)" ~/.pm2/logs/solar-relay-out.log` or `less -R ~/.pm2/logs/solar-relay-out.log` then less command `&(LL)` to filter for Lazy-Ledger output.

## Accuracy checks
Query the database[^4] for last block voters just after you forged a block with `solar ll:alloc`,

then compare the `balance|orgBalance`, `votePercent|orgVotePercent` and `vote|validVote` against api results at `https://tapi.solar.org/api/delegates/username/voters`, within the window of one forging cycle (or block time if any of the protocol level funded wallets are voting for you). Note that `balance`, `votePercent` and `validVote` are effected by cap, blacklist and anti-bot.

You are welcome to make any other accuracy calculation by direct database query.

## Version Info
- Release 0.0.5 - requires `@solar-network/: ^4.1.0 || ^4.1.0-next.5`
## Roadmap
Not necessarily in this order;

- [ ] Web|console dashboard
- [ ] Telegram|Discord integration
- [ ] Database backup
- [ ] Transaction memo customization
- [ ] Payment periods > 24h

See the [open issues](https://github.com/osrn/lazy-ledger/issues) for a full list of proposed features (and known issues).

## Contributing

If you have a suggestion for improvement open an issue with the tag "enhancement" or fork & create a pull request. Any contributions are **greatly appreciated**. <br>

## Credits

- [All Contributors](../../contributors)
- [osrn](https://github.com/osrn)

## Acknowledgments

* [Alessiodf](https://github.com/alessiodf/) Solar Core Developer, aka Gym, for his help and guidance, especially navigating the Solar Core maze and his insights on inner working principles
* [Galperins4](https://github.com/galperins4/) Solar Delegate, aka Goose, for many concepts and ideas initially developed in his TBW scripts

## License

[MIT](LICENSE) © [osrn](https://github.com/osrn)
