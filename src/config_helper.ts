import { Constants, Utils } from "@solar-network/crypto";
import { Container, Contracts, Providers, Utils as AppUtils } from "@solar-network/kernel";
import { IConfig, IPlan } from "./interfaces";
import { baseplan } from "./defaults";

export const configHelperSymbol = Symbol.for("LazyLedger<ConfigHelper>");

@Container.injectable()
export class ConfigHelper {
    @Container.inject(Container.Identifiers.Application)
    private readonly app!: Contracts.Kernel.Application;

    @Container.inject(Container.Identifiers.PluginConfiguration)
    @Container.tagged("plugin", "@osrn/lazy-ledger")
    private readonly configuration!: Providers.PluginConfiguration;

    @Container.inject(Container.Identifiers.LogService)
    private readonly logger!: Contracts.Kernel.Logger;

    private config!: IConfig;
    private lastHeight: number = 0;
    private lastTimestamp: number = 0;

    // @Container.postConstruct()
    // public initialise(): void {
    //     console.log("(LL) config_helper.ts post-construct");
    // }

    public async boot(): Promise<boolean> {
        this.config = this.configuration.all() as unknown as IConfig;

        const walletRepository = this.app.getTagged<Contracts.State.WalletRepository>(
            Container.Identifiers.WalletRepository,
            "state",
            "blockchain",
        );
        if ( !(this.config.delegate && walletRepository.findByUsername(this.config.delegate)) ) {
            this.logger.error("(LL) Config error! Missing or invalid delegate username");
            return false;
        }
        this.config.delegateWallet = walletRepository.findByUsername(this.config.delegate!);
        this.config.delegateAddress = this.config.delegateWallet.getAddress();
        this.config.delegatePublicKey = this.config.delegateWallet.getPublicKey();

        if (!(this.config.plans && (this.config.plans.length > 0))) {
            this.logger.error("(LL) Config error. At least one reward sharing plan is required");
            return false;
        }
        const plans = this.config.plans;

        if (plans[0].share === undefined) {
            this.logger.error("(LL) Config error. First plan must declare a share ratio - even if 0");
            return false;
        }
        
        if (!(plans[0].reserves && plans[0].reserves[0].address !== undefined && plans[0].reserves[0].share !== undefined)) {
            this.logger.error("(LL) Config error. Base plan must declare a reserve address and share - even if delegate self and 0");
            return false;
        }

        this.logger.debug("(LL) Checking and fixing plan parameters...");
        // Fix invalid parameter values.
        if (plans[0].payperiod !== undefined && !([0,1,2,3,4,6,8,12,24].includes(plans[0].payperiod))) {
            plans[0].payperiod = 24;
        }
        if (plans[0].payperiod !== undefined && plans[0].payoffset > 24) {
            plans[0].payoffset = 0;
        }
        if (plans[0].payperiod !== undefined && plans[0].guardtime > 60) {
            plans[0].guardtime = 10;
        }

        plans[0].mincapSatoshi = plans[0].mincap ? Utils.BigNumber.make(plans[0].mincap).times(Constants.SATOSHI) : Utils.BigNumber.ZERO;
        if (plans[0].maxcap) {
            plans[0].maxcapSatoshi = Utils.BigNumber.make(plans[0].maxcap).times(Constants.SATOSHI);
        }

        // make sure the first plan contains height and timestamp, converting timehuman to unix timestamp on the fly
        plans[0].height ||= 0;
        if (plans[0].timestamp && typeof plans[0].timestamp === "string") {
            plans[0].timestamp = Math.floor(Date.parse(plans[0].timestamp as string) / 1000);
        }
        // check and initalize again if not defined or parse fails, rendering undefined again
        plans[0].timestamp ||= 0; 
        
        // make sure each plan contains at least a height and a timestamp, copying forward if missing
        for (let i = 1; i < this.config.plans.length; i++) {
            plans[i].height ||= plans[i-1].height;
            if (plans[i].timestamp && typeof plans[i].timestamp === "string") {
                plans[i].timestamp = Math.floor(Date.parse(plans[i].timestamp as string) / 1000);
            }
            plans[i].timestamp ||= plans[i-1].timestamp;

            // Fix invalid parameter values
            if ( plans[i].payperiod !== undefined && !([0,1,2,3,4,6,8,12,24].includes(plans[i].payperiod)) ) {
                plans[i].payperiod = 24;
            }
            if ( plans[i].payperiod !== undefined && plans[i].payoffset > 24 ) {
                plans[i].payoffset = 0;
            }
            if ( plans[i].payperiod !== undefined && plans[i].guardtime > 60 ) {
                plans[i].guardtime = 10;
            }

            // Convert parameters
            plans[i].mincapSatoshi = plans[i].mincap ? Utils.BigNumber.make(plans[i].mincap).times(Constants.SATOSHI) : Utils.BigNumber.ZERO;
            if (plans[i].maxcap) {
                plans[i].maxcapSatoshi = Utils.BigNumber.make(plans[i].maxcap).times(Constants.SATOSHI);
            }
        }

        // The first plan height must be zero - otherwise getPlan filter may return empty.
        // Insert a placeholder plan with 0 allocation, with delegate username copied backward
        if (plans[0].height != 0) {
            const plan0: IPlan = JSON.parse(JSON.stringify(baseplan));
            plan0.reserves[0].address = plans[0].reserves[0].address;
            plans.unshift(plan0);
        }

        const configShallowClone = {...this.config};
        // do not leak the passphrases to log
        configShallowClone.passphrase &&= "****************";
        configShallowClone.secondpass &&= "****************";
        this.logger.debug(`(LL) Effective configuration is:\n ${JSON.stringify(configShallowClone,null,4)}`);

        const present: IPlan = this.getPresentPlan();
        this.lastHeight = present.height!;
        this.lastTimestamp! = present.timestamp as number;

        this.logger.info("(LL) Config Helper boot complete");
        return true;
    }

    public getConfig() {
        return this.config;
    }

    public getPlan(height: number, epochstamp: number): IPlan {
        return Object.assign({},...(this.config.plans.filter( i => i.height! <= height && i.timestamp! <= AppUtils.formatTimestamp(epochstamp).unix )));
    }

    /**
     * Used during initial sync to ignore blocks before allocation starts.
     * @returns The first plan allocation starts
     */
    public getFirstAllocatingPlan(): IPlan | undefined {
        // FIXME: Assumes the plan declares a height. If a timestamp were declared instead, the function should find the first block height forged past this timestamp
        const plans = this.config.plans;
        for (let i = 0; i < plans.length; i++) {
            if (plans[i].share > 0 || plans[i].reserves[0]?.share > 0) {
                return plans[i];
            }
        }
        return undefined;
    }

    /**
     * Used by payment module to fetch last payment frequency and payment offset valid at the present time
     * Notice that, this will leak to previous plans outstanding payments if any.
     * Best option until the bill DB query updated to consider Plan specific payment frequency and offset.
     * @returns The last plan before now.
     */
    public getPresentPlan(): IPlan {
        const timeNow = Math.floor(Date.now() / 1000);
        return Object.assign({},...(this.config.plans.filter( i => i.timestamp! <= timeNow )));
    }

    public hasPresentPlanChanged(): boolean {
        const present: IPlan = this.getPresentPlan();
        if ( present.height! > this.lastHeight || present.timestamp! > this.lastTimestamp ) {
            this.lastHeight = present.height!;
            this.lastTimestamp! = present.timestamp as number;
            return true;
        }
        return false;
    }
}
