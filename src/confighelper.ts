import { Constants, Identities, Networks, Utils } from "@solar-network/crypto";
import { Container, Contracts, Providers, Utils as AppUtils } from "@solar-network/kernel";
import { existsSync, lstatSync, readFileSync } from "fs";
import { name } from "./package-details.json";
import { IConfig, IPlan } from "./interfaces";
import { baseplan, defaults } from "./defaults";
import Joi from "joi";
import os from "os";
import { emoji } from "node-emoji";

export const configHelperSymbol = Symbol.for("LazyLedger<ConfigHelper>");
const appJson = "app.json";

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

    public async boot(): Promise<boolean> {
        // ~/.config/solar-core/{mainnet|testnet}/app.json should include path-to-config-file
        let configFile = this.configuration.get("configFile") as string;
        if (!configFile) {
            this.logger.emergency(`${name} plugin config error! Make sure ${this.app.configPath(appJson)} defines 'configFile' in plugin options`);
            return false;
        }
        if (configFile.startsWith("~")) configFile = configFile.replace('~', os.homedir());

        // configFile should exist
        if (!existsSync(configFile) || !lstatSync(configFile).isFile()) {
            this.logger.emergency(`${name} plugin config file ${configFile} not found or not a file!`);
            return false;
        }

        // read configuration from file, merging with defaults as necessary
        const configOptions = JSON.parse(readFileSync(configFile).toString()) as unknown as IConfig;
        this.config = Object.assign({}, defaults, configOptions);

        // validate config
        const validation = validConfig.validate(this.config);
        if (validation.error) {
            this.logger.emergency(validation.error.toString());
            this.logger.emergency(`${name} plugin config error! invalid settings in ${configFile}: ${validation.error.toString()}`);
            return false;
        }
        
        // validate bp
        const walletRepository = this.app.getTagged<Contracts.State.WalletRepository>(
            Container.Identifiers.WalletRepository,
            "state",
            "blockchain",
        );
        if (!walletRepository.hasByUsername(this.config.delegate!)) {
            this.logger.emergency(`${name} plugin config error! BP username ${this.config.delegate} is not registered in blockchain`);
            return false;
        }
        this.config.bpWallet = walletRepository.findByUsername(this.config.delegate!);
        if (!this.config.bpWallet.isDelegate()) {
            this.logger.emergency(`${name} plugin config error! Username ${this.config.delegate} exists but is not a Block Producer`);
            return false;
        }
        if (this.config.bpWallet.hasAttribute("delegate.resigned")) {
            // wallet.getAttribute("delegate.resigned") === Enums.DelegateStatus.PermanentResign
            // ? "permanent"
            // : "temporary";
            this.logger.emergency(`${name} plugin config error! BP ${this.config.delegate} is resigned`);
            return false;
        }
        this.config.bpWalletAddress = this.config.bpWallet.getAddress();
        this.config.bpWalletPublicKey = this.config.bpWallet.getPublicKey();

        // validate plans
        if (!(this.config.plans && (this.config.plans.length > 0))) {
            this.logger.emergency("(LL) Config error. At least one reward sharing plan is required");
            return false;
        }
        const plans = this.config.plans;

        if (plans[0].share === undefined) {
            this.logger.emergency("(LL) Config error. First plan must declare a share ratio - even if 0");
            return false;
        }
        
        if (!(plans[0].reserves && plans[0].reserves[0].address !== undefined && plans[0].reserves[0].share !== undefined)) {
            this.logger.emergency("(LL) Config error. Base plan must declare a reserve address and share - even if bp wallet address and 0");
            return false;
        }

        this.logger.debug("(LL) Checking and fixing plan parameters...");
        // Fix invalid parameter values.
        if (plans[0].payperiod !== undefined && !([0,1,2,3,4,6,8,12,24].includes(plans[0].payperiod))) {
            plans[0].payperiod = 24;
        }
        if (plans[0].payperiod !== undefined && plans[0].payoffset >= 24) {
            plans[0].payoffset = 0;
        }
        if (plans[0].payperiod !== undefined && plans[0].guardtime >= 60) {
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
            if (plans[i].mincap) {
                plans[i].mincapSatoshi = Utils.BigNumber.make(plans[i].mincap).times(Constants.SATOSHI);
            }
            if (plans[i].maxcap) {
                plans[i].maxcapSatoshi = Utils.BigNumber.make(plans[i].maxcap).times(Constants.SATOSHI);
            }
        }

        // The first plan height must be zero - otherwise getPlan filter may return empty.
        // Insert a placeholder plan with 0 allocation, with bp username copied backward
        if (plans[0].height != 0) {
            const plan0: IPlan = JSON.parse(JSON.stringify(baseplan));
            plan0.reserves[0].address = plans[0].reserves[0].address;
            plans.unshift(plan0);
        }

        // log the effective configuration, but do not leak the passphrases
        // const configShallowClone = {...this.config};
        const configShallowClone = deepCopy(this.config);
        configShallowClone.passphrase &&= "****************";
        configShallowClone.secondpass &&= "****************";
        if (typeof configShallowClone.discord?.webhookToken !== "undefined") {
            configShallowClone.discord.webhookToken = "****************";
        }
        this.logger.debug(`(LL) Effective configuration is:\n ${JSON.stringify(configShallowClone,null,4)}`);

        const present: IPlan = this.getPresentPlan();
        this.lastHeight = present.height!;
        this.lastTimestamp! = present.timestamp as number;

        this.logger.info(`(LL) ConfigHelper: loaded configuration ${emoji.white_check_mark}`);
        return true;
    }

    public getConfig() {
        return this.config;
    }

    public getPlan(height: number, epochstamp: number): IPlan {
        return Object.assign({},...(this.config.plans.filter( i => i.height! <= height && (i.timestamp! as number) <= AppUtils.formatTimestamp(epochstamp).unix )));
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
        return Object.assign({},...(this.config.plans.filter( i => (i.timestamp! as number) <= timeNow )));
    }

    public hasPresentPlanChanged(): boolean {
        const present: IPlan = this.getPresentPlan();
        if ( present.height! > this.lastHeight || (present.timestamp! as number) > this.lastTimestamp ) {
            this.lastHeight = present.height!;
            this.lastTimestamp! = present.timestamp as number;
            return true;
        }
        return false;
    }
}

const isWalletAddress = (address: string) => {
    if (!Identities.Address.validate(address)) {
        throw new Error(`${address} is not a valid wallet address`);
    }
    return address;
};

const joiRules = {
    bpUsername: Joi.string().min(1).max(20).regex(/^(?!_)(?=.*[a-z!@$&_.])([a-z0-9!@$&_.]?)+$/),
    walletAddress: Joi.string().length(34).custom(isWalletAddress),
    walletAddressList: Joi.array().items(Joi.string().length(34).custom(isWalletAddress)).unique(),
    mnemonic: Joi.string().min(1),
    txMemo: Joi.string().max(255).allow('', null),
    percentage: Joi.number().integer().min(0).max(100),
    positiveInt: Joi.number().integer().min(0),
    positiveIntOrNull: Joi.number().integer().min(0).allow(null),
    yesOrNo: Joi.string().valid("y", "n", "Y", "N", "yes", "no"),
    date: Joi.date().iso().required(),
    network: Joi.string().valid(...Object.keys(Networks)),
    slot: Joi.number().integer().min(1).max(53),
    discord: Joi.object({
        webhookId: Joi.string(), 
        webhookToken: Joi.string(), 
        mention: Joi.string().optional(), 
        botname: Joi.string().min(3).max(12).optional(),
    }),
};

const validConfig = Joi.object({
    delegate: joiRules.bpUsername.required(),
    passphrase: joiRules.mnemonic.required(),
    secondpass: joiRules.mnemonic.allow(null, '').optional(),
    excludeSelfFrTx: Joi.boolean().optional(),
    mergeAddrsInTx: Joi.boolean().optional(),
    reservePaysFees: Joi.boolean().optional(),
    shareEarnedFees: Joi.boolean().optional(),
    reserveGetsFees: Joi.boolean().optional(),
    postInitInstantPay: Joi.boolean().optional(),
    antibot: Joi.boolean().optional(),
    whitelist: joiRules.walletAddressList.optional(),
    discord: joiRules.discord.optional(),
    plans: Joi.any().optional(),
});

function deepCopy(oldObj: any): any {
    return JSON.parse(JSON.stringify(oldObj));
};
