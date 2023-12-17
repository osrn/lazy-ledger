# Lazy-Ledger True Block Weight Reward Sharing Plugin for Solar Network

Solar Network Core Plugin for Rewards Bookkeeping and Payments Distribution. 

## Introduction
Lazy-Ledger is a core plugin utilizing core functions and events to share forging rewards with voters and other stakeholders. Rewards are calculated at each forged block then allocated amongst the stakeholders in compliance with the reward sharing plan(s) configured. Multiple plans can be scheduled with only one being active at a given block height & timestamp.

The ledger is stored in a local sqlite database where an entry is recorded for each voter for each block forged. An auto-recovery mechanism continuously checks for forks and aligns ledger database with the network in the case of block and transaction revert events.

A ledger record is composed of following metadata:
`block height`, `round`, `forged time`, `block reward`, `earned reward`[^1], `earned fees`[^2], `total valid votes`[^3], `recipient address`, `recipient type`, `valid voting balance`[^3], `share ratio`, `allotment`, `entry timestamp`, `payment transaction id`, `timestamp transaction forged`

All timestamps are unix except forged time, which is Solar epochstamp.

[^1]: block reward less protocol level fund donations

[^2]: block transaction fees less burned fees

[^3]: valid amount after mincap, maxcap, blacklist and anti-bot processing

Following the boot sequence plugin retrieves all past forged blocks from the core database, calculating stakeholders and allocations valid for the block's height & timestamp using the corresponding plan. Only blocks forged after first plan with non-zero allocation are retrieved for the sake of first-time synchronisation duration. Following initial sync, Ledger is updated in real time triggered by the core events.

Governed by the plan parameters, a periodic payment job distributes rewards to the stakeholders. Transaction fees are calculated dynamically. Transfer recipients and pool sender limits are respected. A debt is only settled when the corresponding reward payment transaction is forged, but unsettled back should the transaction is reverted afterwards.

The plugin can optionally be used for bookkeeping only; handling payments externally by directly accessing the database[^4].

[^4]: `~/.local/share/solar-core/{mainnet|testnet}/lltbw/lazy-ledger.sqlite`

### Voter protection
Plugin employs a protection mechanism against malicious bots (those making a roundtrip of votes &| funds among several addresses within the round) by looking ahead one forging cycle and reducing the valid votes of the offending addresses for the last block as per their actions. Consequently last block reward distribution recalculated to the benefit of other voters.

Offending address votes are recalculated when:
1. voting percentage is reduced
2. an outbound transfer is made

No action taken if **vote percent increases** or **funds received** or the **reward payment for that block is already in the transaction pool**.

## Installation
**Preferred method:**
```bash
solar plugin:install https://github.com/osrn/lazy-ledger.git
```
Then, proceed to [configuration section](#configuration).

**Manual install:**
```bash
. ~/.solar/.env
cd ~/solar-core/plugins
git clone https://github.com/osrn/lazy-ledger
cd lazy-ledger
CFLAGS="$CFLAGS" CPATH="$CPATH" LDFLAGS="$LDFLAGS" LD_LIBRARY_PATH="$LD_LIBRARY_PATH" pnpm install
pnpm build
# Following is necessary for solar registration of cli commands
cd ~/.local/share/solar-core/{mainnet|testnet}/plugins/
mkdir '@osrn' && cd '@osrn'
ln -s ~/solar-core/plugins/lazy-ledger lazy-ledger
```
Then, proceed to [configuration section](#configuration).

## Upgrade
## Upgrading to latest version 
Last version 0.2.0 contains breaking changes. See [Release notes](#release-020) to upgrade.

**Standart update procedure (unless otherwise instructed in release notes)**
```bash
. ~/.solar/.env
cd ~/solar-core/plugins/lazy-ledger
git pull
pnpm build
pm2 restart solar-relay
```


## Configuration
The plugin must be configured by adding a section in `~/.config/solar-core/{mainnet|testnet}/app.json` at the end of the `plugins` within the `relay` block. A sample entry is provided [below](#sample-configuration). Configuration options are explanied [here](#config-options).

The sample config will;
- allocate 100% to reserve address starting with 90000 until block height 100000, paying every 24 hours at 00:10 UTC
- allocate 50% to voters, 50% to reserve address starting with block 100000 until 2022-08-14T23:59:59.999 UTC, paying every 24 hours at 00:10 UTC
- allocate 90% to voters, 10% to reserve address between 2022-08-15T00:00:00.000Z and 2022-08-22T00:00:00.000Z, paying every 6 hours at 10 minutes past UTC.
- allocate 50% to voters, 50% to reserve address after 2022-08-22T00:00:00.000, paying every 24 hours at 00:10 UTC

Payment plans follows a milestone principle: higher index properties override the lower ones, where an effective plan is produced against the height and timestamp for a given forged block. There is no in built plan sorting, thus **_linear scheduling is your responsibility_**.

> :warning: You should always take your plans' payment schedule into consideration should you ever need to execute `solar snapshot:truncate|rollback` on your relay independent of the rest of the network; as this will revert the plugin database to rollback height after relay restarts, erasing any subsequent payment records. This may lead to duplicate payments for previously distributed rewards unless the whole network had rolled back. Making a database backup in advance and setting the base plan height to first unpaid allocation's forged block is a recommended practice before any such destructive operation.

### Sample configuration > app.json
```json
    "relay": {
        "plugins": [
            ...,
            {
                "package": "@osrn/lazy-ledger",
                "options": {
                    "enabled": true,
                    "configFile": "~/solar-core/plugins/lazy-ledger/config.json"
                }
            },
        ]
    },
```

### Sample configuration > config.json
```json
{
    "delegate": "block producer username",
    "passphrase": "block producer wallet mnemonic phrase",
    "rewardMemo": "",
    "rewardStamp": true,
    "excludeSelfFrTx": true,
    "mergeAddrsInTx": false,
    "reservePaysFees": true,
    "shareEarnedFees": false,
    "reserveGetsFees": false,
    "postInitInstantPay": false,
    "antibot": true,
    "whitelist": [],
    "discord": {
        "webhookId": "discord channel webhook id",
        "webhookToken": "discord channel webhook token",
        "mention": "discord userid to mention for alerts",
        "botname": "discord bot name to show in bot messages, 3-12 characters long. Default: Bot."
    },
    "plans": [
        {
            "height": 90000,
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
            "share": 50,
            "reserves": [
                {"address": "reserve_wallet_address", "share": 50}
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
```

### Config Options

| Name | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| delegate | string | | bp username |
| plans | Array\<Plan\> | |reward sharing plans |
| passphrase | string | | bp wallet passphrase |
| secondpass | string | | bp wallet second passphrase |
| rewardMemo | string | _**bp username**_ rewards | reward transaction memo |
| rewardStamp | boolean | true | append reward time period stamp to the memo e.g. `for 2023-12-10-1/24` |
| excludeSelfFrTx | boolean | true |exclude bp wallet address from payment transaction if reserve address=bp address or bp self voting |
| mergeAddrsInTx | boolean | false | pivot payment transaction on recipient address. Best to use when catching up with several past due payments to reduce transaction size, hence the tx fee |
| reservePaysFees | boolean | true | deduct transaction fee from the first reserve address allocation (at the time of actual transaction) \| bp wallet needs sufficient funds for paying fees otherwise |
| shareEarnedFees | boolean | false | include earned transaction fees (=unburned 10%) in reserve, voter and donee allocations |
| reserveGetsFees | boolean | false | when earned fees are not shared, allocate transaction fees to the first reserve address \| stays in bp wallet otherwise) |
| postInitInstantPay | boolean | false | make a payment run immediately after plugin starts following initial sync |
| antibot | boolean | true | anti-bot processing active if true |
| whitelist | string[] | [] | addresses exempt from anti-bot processing (bp wallet address is automatically whitelisted) |

### Plan

| Name | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| height? | number | 0 | Activate plan at this height. Mandatory only for first non-zero allocation plan.|
| timestamp? | number \| string | | Activate plan at this time. Optional.<br>unix timestamp (not Solar epochStamp) \| YYYY-MM-DDTHH:mm:ss.sssZ \| YYYY-MM-DDTHH:mm:ss.sss+-hh:mm |
| share | number | 50 | voter share ratio. 0-100, up to 2 decimal places | 
| reserves | Array\<Payee\> | | recipients for rewards kept. Mandatory for first (base) plan |
| donations | Array\<Payee\> | [] | recipients for donations |
| mincap | number | 0 | minimum voter wallet balance eligible for rewards allocation (SXP)|
| maxcap | number | 0 | maximum vote weight from an address (SXP)|
| blacklist | string[] | [] | addresses blacklisted from rewards allocation |
| payperiod | number | 24 | payment cycle - every [0,1,2,3,4,6,8,12,24] hours. Zero will not handle payment - except the case when `postInitInstantPay` is true|
| payoffset | number | 0 | new cycle begins at UTC 00:00 + offset hrs. 0-23. |
| guardtime | number | 10 | delay in minutes before preparing the payment order at the end of a payment cycle - precaution against block reverts. 0-59. |

>share + reserves[].share + donations[].share = 100 recommended, but not enforced!

>payperiod:24, payoffset:18, guardtime:30 will schedule daily payments at 18:30 UTC, for allocations from 18:00 UTC previous day to UTC 18:00 today. 

### Payee
| Name | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| address | string | | recipient wallet address | 
| share | number | 50 | share ratio. 0-100, up to 2 decimal places | 

## Running
Configure, then restart relay. First time sync may take ~15+mins depending on the node capacity and how far back your first non-zero allocation plan's height goes.

## CLI
List of Lazy-Ledger commands can be viewed with `solar help`.<br>
Command specific help can be displayed with `solar ll:<command> --help`.
<br><br>

### :alloc
**`solar ll:alloc [--round m | --height n] [--raw | --json | --format="std | json | raw"]`**<br>
shows the block allocation at given round or height; former having priority over the latter if both provided. Last round if arguments skipped.
```
Flags
--height     Block height. Last block if missing or 0.
--round      Round. Last round if missing or 0.
--format     Display output as standard, formatted JSON or raw
--json       Short for format="json". Overrides --format
--raw        Short for format="raw". Overrides --format and --json
```
```bash
solar ll:alloc
```
```
Retrieving data from last block ...
[
  {
    round: 24824,
    height: 1315624,
    forgedTime: '20220908-201736',
    reward: 11,
    earnedRewards: 9.9,
    earnedFees: 0,
    netReward: 9.9,
    validVotes: 2323102.02340695,
    address: 'D646b6dx3sW5NAgMDTKAZ2hdC57K1BeRaK',
    payeeType: 1,
    balance: 107246009.42079204,
    votePercent: 1.89,
    vote: 2026949.5780529696,
    validVote: 2026949.57805296,
    shareRatio: 20,
    allotment: 1.7275867,
    bookedTime: '20220908-201737',
    transactionId: '',
    settledTime: 0,
    orgBalance: 107246009.42079204,
    orgVotePercent: 1.89
  },
  ...
]
```
---
### :lastpaid
**`solar ll:lastpaid [--all] [--raw | --json | --format="std | json | raw"]`**<br>
shows summary|detail info about the last paid forged-block allocation - summary if flag skipped.
```
Flags 
--all        list involved allocations.
--format     Display output as standard, formatted JSON or raw
--json       Short for format="json". Overrides --format
--raw        Short for format="raw". Overrides --format and --json
```
```bash
solar ll:lastpaid
```
```
Retrieving info about the last paid forged-block allocation ...
{
  round: 24583,
  height: 1302858,
  transactionId: 'f26f6ae548592eeda6c27e6e7ce2b63f01fcceedb7b9a3090c7f7ec59c4c2df8',
  settledTime: '20220907-161312'
}
```
---
### :pending
**`solar ll:pending [--raw | --json | --format="std | json | raw"]`**<br>
shows pending (=unpaid) allocations since last payment.
```
Flags:
--format     Display output as standard, formatted JSON or raw
--json       Short for format="json". Overrides --format
--raw        Short for format="raw". Overrides --format and --json
```
```bash
solar ll:pending
```
```
Retrieving pending allocations since last payment ...
┌───────────────┬─────────────┐
│    (index)    │   Values    │
├───────────────┼─────────────┤
│   minRound    │      1      │
│   maxRound    │    1429     │
│    rounds     │    1430     │
│   minHeight   │     45      │
│   maxHeight   │    75726    │
│    blocks     │    1430     │
│ blockRewards  │  16817.375  │
│  blockFunds   │  840.36875  │
│   blockFees   │      0      │
│  burnedFees   │      0      │
│ earnedRewards │ 15977.00625 │
│  earnedFees   │      0      │
└───────────────┴─────────────┘
```
---
### :commitment
**`solar ll:commitment --start <datetime> --end <datetime> [-v]`**<br>
shows voter commitment (voting balance not reduced) during a time frame
```
Flags
--start      Start date (YYYY-MM-DDTHH:mm:ss.sssZ | YYYY-MM-DDTHH:mm:ss.sss+-hh:mm), included.
--end        End date (YYYY-MM-DDTHH:mm:ss.sssZ | YYYY-MM-DDTHH:mm:ss.sss+-hh:mm), excluded.
--v          Show detailed information for each voter
```
```bash
solar ll:commitment --start=2022-09-16T18:00:00Z --end=2022-09-18 -v
```
```
(LL) Opening database connection @ /home/solar/.local/share/solar-core/testnet/lltbw/lazy-ledger.sqlite
Range contains 255 blocks and bounds are:
[date)     : [Fri Sep 16 2022 21:00:00 GMT+0300 (GMT+03:00), Sun Sep 18 2022 03:00:00 GMT+0300 (GMT+03:00))
[unixstamp): [1663351200, 1663459200)
[round]    : [1704, 1958]
[height]   : [90311, 103743]

Forging stats over the range are:
Rewards    : 2549.0
Funds      : 254.90000000
Fees       : 0.0
Burned fees: 0.0
Earned rwds: 2294.10000000
Earned fees: 0.0
Votes (avg): 9842471.67608968
Voters(avg): 2

Committed addresses over the range - with respective valid voting balances at the beginning of the range (height 90311) - are:
DNrxmrPcZrcRgv9ZbR1N5iTyeVJbE5Ukqc 1032347894645

Voters and commitment details:
{
  roundCount: 255,
  blockCount: 255,
  address: 'DNrxmrPcZrcRgv9ZbR1N5iTyeVJbE5Ukqc',
  blocksVoteNotReduced: 255,
  voteChanges: 0
}
{
  roundCount: 255,
  blockCount: 255,
  address: 'DTEBVe6YqNoAy1DJzzcToiRnsapN7WUJk7',
  blocksVoteNotReduced: 225,
  voteChanges: 30
}
```
---
### :antibot
**`solar ll:antibot --start <datetime> [--end <datetime>] [--raw | --json | --format="std | json | raw"]`**<br>
lists antibot detected voters, hit frequency and antibot adjusted allotments total during a time frame
```
Flags
--start      Start date (YYYY-MM-DDTHH:mm:ss.sssZ | YYYY-MM-DDTHH:mm:ss.sss+-hh:mm), included.
--end        End date (YYYY-MM-DDTHH:mm:ss.sssZ | YYYY-MM-DDTHH:mm:ss.sss+-hh:mm), excluded.
--format     Display output as standard, formatted JSON or raw
--json       Short for format="all". Overrides --format
--raw        Short for format="raw". Overrides --format and --json
```
```bash
solar ll:antibot --start=2023-12-01T00:00:00Z
```
```
(LL) Opening database connection @ /home/solar/.local/share/solar-core/testnet/lltbw/lazy-ledger.sqlite
Antibot has detected 1 addresses during the given timeframe:
[date)     : [2023-01-01T00:00:00.000Z, 2023-12-11T20:23:14.304Z)
[unixstamp): [1672531200, 1702326194)
┌────────────────────────────────────┬──────┬──────────┐
│              (index)               │ hits │ allotted │
├────────────────────────────────────┼──────┼──────────┤
│ D5amxBtrXduR8M97xA2KvU1zp5UnJC2oZR │  1   │ '0 tSXP' │
└────────────────────────────────────┴──────┴──────────┘
```
---
### :rollback
**`solar ll:rollback <height>`**<br>
deletes all records starting with (and including) the first block of the round for the given height.
```
Arguments
height    Block height
```
```bash
solar ll:rollback 100000
✔ This will remove all records in LL database STARTING WITH & INCLUDING height 99959 which is the first block of the round 1887 and is irreversible. Are you sure? › (y/N)
```

## Logs
Uses the core logger utility with (LL) prefix.<br>
Use `pm2 logs solar-relay` or `less -R +F ~/.pm2/logs/solar-relay-out.log` to watch the logs in real time.<br>
Use `grep "(LL)" ~/.pm2/logs/solar-relay-out.log` or `less -R ~/.pm2/logs/solar-relay-out.log` then less command `&\(LL\)` to filter for Lazy-Ledger output.

```log
--- boot
@osrn/Lazy-Ledger (LL) Reward Sharing Plugin registered +1s 663ms
(LL) Database boot complete
(LL) Processor boot complete
(LL) Teller schedule 0 8 0/24 * * * started. Next 3 runs will be Mon Sep 12 2022 00:08:00 GMT+0000,Tue Sep 13 2022 00:08:00 GMT+0000,Wed Sep 14 2022 00:08:00 GMT+0000
(LL) Teller boot complete
(LL) Plugin boot complete +8s 844ms
--- initial sync
(LL) Starting (initial|catch-up) sync ...
(LL) Received batch of 133 blocks to process | heights: 1794003,1794102,1794143,1794166,1794221,1794263,1794318,...
(LL) Processing block | round:33850 height:1794003 timestamp:14361288 bp: osrn reward:1237500000 solfunds:61875000 block_fees:0 burned_fees:0
(LL) block processed in 0h:04':19".813ms
(LL) Completed processing batch of 1 blocks in 0h:00':04".498ms
(LL) Sync complete | lastChainedBlockHeight:1801089 lastForgedBlockHeight:1801051 lastStoredBlockHeight:1801051
(LL) backlog processed in 0h:09':26".629ms
(LL) Finished (initial|catch-up) sync
--- normal opearation / allocation
(LL) Received new block applied event at 1805087 forged by us
(LL) Starting  sync ...
(LL) Received batch of 1 blocks to process | heights: 1805087
(LL) Processing block | round:34059 height:1805087 timestamp:14449968 bp: osrn reward:1275000000 solfunds:63750000 block_fees:0 burned_fees:0
(LL) Completed processing batch of 1 blocks in 0h 00' 01" 533ms
(LL) Sync complete | lastChainedBlockHeight:1805087 lastForgedBlockHeight:1805087 lastStoredBlockHeight:1805087
--- Anti-bot
(LL) Anti-bot detected voter S********************************g vote percent reduction (100 => 0) within round [34027-34028].
(LL) Redistributing block allocations for height 1803391.
(LL) Anti-bot detected voter S********************************t balance reduction of 73** SXP within round [34061-34061].
(LL) Redistributing block allocations for height 1805186.
--- Payment
(LL) Teller run starting at Mon, 12 Sep 2022 00:08:00 GMT
(LL) Fetched 250 bill items from the database
(LL) Bill reduced to 250 items after filtering out bp address
(LL) Bill produced 2 pay-orders after grouping by pay-period
(LL) Pay-order will be processed in 1 chunks of transactions
(LL) Passing transaction to Pool Processor | {"fee":"17603842","headerType":0,"id":"71f63492736bca143ae5cac1f4effd0ffb2c9561770b59dfcc1e572f993fac1e","memo":"osrn rewards for 2022-09-10-1/1","s
(LL) Transaction 1a160ef3e5786b482b97535a40a428a9697d48cb408b72295c0dda23039af24f successfully sent!
(LL) Teller run complete. Next run is 2022-09-13T00:08:00.000Z
(LL) Received a transaction applied event 71f63492736bca143ae5cac1f4effd0ffb2c9561770b59dfcc1e572f993fac1e which is in the watchlist
(LL) Marked allocations with txid 71f63492736bca143ae5cac1f4effd0ffb2c9561770b59dfcc1e572f993fac1e as settled
```

## Accuracy checks
Right after you forged a block, query the database[^4] for last block voters with `solar ll:alloc`, 
then compare `balance|orgBalance`, `votePercent|orgVotePercent` and `vote|validVote` against api output at `https://{t}api.solar.org/api/delegates/username/voters` taken within 1 block time (~8 secs). Note that `balance`, `votePercent` and `validVote` are effected by cap, blacklist and anti-bot.

You are welcome to make any other accuracy checks by direct database query.

## Version Info

### Release 0.2.0
#### Before upgrading
1. stop relay `pm2 stop solar-relay`
1. backup your database `tar -cPzf ~/lazy-ledger.backup-$(date +%Y%m%d-%H%M%S).tar.gz ~/.local/share/solar-core/{mainnet|testnet}/lazy-ledger*`
1. create a subfolder and move your database:
```bash
cd  ~/.local/share/solar-core/{mainnet|testnet}
mkdir lltbw
mv lazy-ledger.sqlite* lltbw
cd ~
```

##### To upgrade
1. Pull, update dependencies and rebuild.
```bash
cd  ~/solar-core/plugins/lazy-ledger
. ~/.solar/.env
git pull
CFLAGS="$CFLAGS" CPATH="$CPATH" LDFLAGS="$LDFLAGS" LD_LIBRARY_PATH="$LD_LIBRARY_PATH" pnpm install
pnpm build
cd ~
```
2. create a config file and move your config options from `app.json` to `your-config.json` as described above in [sample configuration section](#configuration)
3. add the config file path to app.json as described above in [sample configuration section](#configuration)
4. restart relay `pm2 restart solar-relay`

#### Changes
- **Breaking!** moved sqlite database file location. See upgrade instructions.
- **Breaking!** separated configuration from Solar app.json. Now, app.json only defines whether the plugin is enabled and plugin configuration file path.
- new cli command `antibot`. added option to list antibot detected voters, hit frequency and antibot adjusted allotments total during a time frame.
- new configuration options rewardMemo and rewardStamp. allows for customized reward transaction memo
- stricter config options validation.
- discord notifications 
    - when plugin boots
    - when reward payments done
    - for critical errors or warnings
- replaced term `delegate` with `bp` in messages and notifications as applicable
- performance improvements and bug squash
    - added new indexes to the sqlite database<sup>(*)</sup>
    - increased block processing speed when blocks are being retrieved in real time by utilizing the current information available from the blockRepository rather than replaying the transactions happened since last block forged on top of the state last saved in the local sqlite database
    - fixed mainloop blocking when retrieving voter last balances from local db when processing a backlog of blocks with large number of voters
    - fixed plan payperiod auto correction when out-of-bounds
    - fixed plan mincap creation issue while plan does not specify one
    - added version information to boot time log messages
    - package `delay-5.0.0` replaced with `node:timers/promises`
    - cleanup obselete comments and dead code

> <sup>(*)</sup> You may observe a prolonged plugin database boot duration during the first restart after the upgrade, due to creation of new indexes.


### Release 0.1.2
**Changes**

- Fixed issue `RangeError [ERR_OUT_OF_RANGE] exception when serializing transaction`<br>

When `reservePaysFees` option is enabled, the transaction fee is deducted from the reserve's reward allocation when constructing the rewards payment transaction. This is a preference to ensure rewards due can be paid even if the bp wallet is empty to start with.<br>

Exception is raised due to negative transfer amount and the issue surfaces under a potentially rare condition: 
1. reservePaysFees option enabled (default)
1. bp reserve wallet is self voting, 
1. in populated pay-order, reserve wallet voter allotment (payeeType=voter) comes before reserve wallet reserve allotment (payeeType=reserve) in the array
1. reserve wallet voter allocation is less than the required transaction fee :beetle:

The issue is now fixed and tx fee is deducted only from reserve's allocation (payeeType=0) and when it can cover the fee.<br>
The algorithm is also improved in order to:
- Try subsequent reserve wallets if first one cannot cover the costs
- Log a warning if none of the reserve wallet allocations meet the criteria (in which case tx fee will be paid from the bp wallet as if  `reservePaysFees=false`).

> :warning: Important : Moving forward, tx fee will not be deducted from any reserve allocations when `mergeAddrsInTx=true`, consequently requiring bp wallet to have enough funds to pay full rewards+txfee.

### Release 0.1.1
**Changes**
- Fixed issue `missing Satoshi conversion when reading mincap & maxcap from config`

### Release 0.1.0
**Changes**
- Fixed issue `large number of voters may block main loop when writing txid to allocations`
- Added `rowid`column to allocations table
- Changed datetime string format from `%Y%m%d-%H%M%S` to `%Y-%m-%d %H:%M:%S` in database views
- Added try/catch blocks to database calls
- Moved utility functions to separate library
- Fixed typeof check

**Before upgrading to this release**
1. stop relay `pm2 stop solar-relay`
1. backup your database `tar -cPzf ~/lazy-ledger.backup-$(date +%Y%m%d-%H%M%S).tar.gz ~/.local/share/solar-core/{mainnet|testnet}/lazy-ledger*`
1. modify database table:
```bash
sqlite3 ~/.local/share/solar-core/{mainnet|testnet}/lazy-ledger.sqlite
```
```SQL
ALTER TABLE allocations RENAME TO allocations_old;
CREATE TABLE allocations (height INTEGER NOT NULL, address TEXT NOT NULL, payeeType INTEGER NOT NULL, balance TEXT NOT NULL, orgBalance TEXT NOT NULL, votePercent INTEGER NOT NULL, orgVotePercent INTEGER NOT NULL, validVote TEXT NOT NULL, shareRatio INTEGER, allotment TEXT, booked NUMERIC, transactionId TEXT, settled NUMERIC, PRIMARY KEY (height, address, payeeType));
INSERT INTO allocations SELECT * FROM allocations_old;
SELECT COUNT(*) FROM allocations_old; --- note the length
SELECT COUNT(*) FROM allocations; --- compare to above
DROP TABLE allocations_old;
```

### Release 0.0.9
requires `@solar-network/: ^4.1.2 || ^4.1.2-next.0`

### Release 0.0.5
requires `@solar-network/: ^4.1.0 || ^4.1.0-next.5`

## Roadmap
Not necessarily in this order;
- [ ] Database backup and periodic cleanup
- [ ] Better logging
- [ ] Reload config without relay restart
- [ ] Web|console dashboard
- [ ] Payment periods > 24h
- [X] Command to list antibot detected vote hoppers
- [X] Custom transaction memo
- [X] Move configuration from app.json to own config.json
- [X] ~~Telegram~~|Discord notifications

See [open issues](https://github.com/osrn/lazy-ledger/issues) for a full list of proposed features (and known issues).

## Contributing

If you have a suggestion for improvement open an issue with the tag "enhancement" or fork & create a pull request. Any contributions are **greatly appreciated**. <br>

## Credits

- [All Contributors](../../contributors)
- [osrn](https://github.com/osrn)

## Acknowledgments

* [Alessiodf](https://github.com/alessiodf/) Solar Core Developer, aka Gym, for his help and guidance, especially navigating the Solar Core maze and his insights on inner working principles
* [Galperins4](https://github.com/galperins4/) Solar Block Producer, aka Goose, for many concepts and ideas initially developed in his TBW scripts

## License

[MIT](LICENSE) © [osrn](https://github.com/osrn)
