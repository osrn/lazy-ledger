import { Commands, Container } from "@solar-network/cli";
import { ProcessManager } from "@solar-network/cli/dist/services";
import { Managers, Networks, Utils } from "@solar-network/crypto";
import { existsSync, lstatSync, readFileSync } from "fs";
import Joi from "joi";
import os from "os";
import { Database } from "../database";
import { joiRules } from "../confighelper";

@Container.injectable()
export class Command extends Commands.Command {
    @Container.inject(Container.Identifiers.ProcessManager)
    private readonly processManager!: ProcessManager;

    public signature: string = "ll:botscan";

    public description: string = "Scan the ledger for addresses and allocated rewards during the specified time frame";

    public configure(): void {
        this.definition
            .setFlag("token", "The name of the token", Joi.string().default("solar"))
            .setFlag("network", "The name of the network", Joi.string().valid(...Object.keys(Networks)))
            .setFlag("f", "path to json file with array of unique wallet addresses", Joi.string().required())
            .setFlag("start", "Start date (YYYY-MM-DDTHH:mm:ss.sssZ | YYYY-MM-DDTHH:mm:ss.sss+-hh:mm), included.", Joi.date().iso().required())
            .setFlag("end", "End date (YYYY-MM-DDTHH:mm:ss.sssZ | YYYY-MM-DDTHH:mm:ss.sss+-hh:mm), excluded.", Joi.date().iso().optional())
            .setFlag("format", "Display output as standard, formatted JSON or raw", Joi.string().valid("std", "json", "raw").default("std"))
            .setFlag("json", "Short for format=\"json\". Overrides --format.", Joi.boolean().default(false))
            .setFlag("raw", "Short for format=\"raw\". Overrides --format and --json", Joi.boolean().default(false));
    }

    public async execute(): Promise<void> {
        const relayRunning = this.processManager.isOnline(`${this.getFlag("token")}-relay`);
        if (!relayRunning) {
            this.components.warning("relay process is not online. data retrieved may be outdated!");
        }

        // read file
        let inputFile = this.getFlag("f");
        if (inputFile.startsWith("~")) inputFile = inputFile.replace('~', os.homedir());
        if (!existsSync(inputFile) || !lstatSync(inputFile).isFile()) {
            this.components.error(`file ${inputFile} not found or not a file!`);
            return;
        }

        // read configuration from file, merging with defaults as necessary
        const addresses = JSON.parse(readFileSync(inputFile).toString()) as unknown as string[];
        if (addresses.length === 0) {
            this.components.error(`file ${inputFile} contains no addresses`);
            return;
        }
        this.components.log(`parsed ${addresses.length} addresses from the input file: ${addresses}`);
        const network = this.getFlag("network");
        // first set the correct network so address validation can continue
        if (typeof network !== "undefined" && Object.keys(Networks).includes(network!)) {
            Managers.configManager.setFromPreset(network!);
        }
        const validation = joiRules.walletAddressList.validate(addresses);
        if (validation.error) {
            this.components.error(`file ${inputFile} ${validation.error.toString()}`);
            return;
        }

        const startDate = this.getFlag("start");
        let endDate = this.getFlag("end") || new Date().toISOString();
        const start = Math.floor(new Date(startDate).getTime() / 1000);
        const end = Math.floor(new Date(endDate).getTime() / 1000);
        if (end <= start) {
            this.components.error("Start date must be earlier than the end date (or now if end date not provided)");
            return;
        }
        const sqlite = new Database();
        sqlite.init(this.app.getCorePath("data"));
        const data = sqlite.scanBots(addresses, start, end, network);
        // list.forEach( e => { e.allotted = Utils.formatSatoshi(e.allotted) });
        this.components.log(`Scan matched ${data.length} records in the ledger during the specified time frame:
[date)     : [${new Date(startDate).toISOString()}, ${new Date(endDate).toISOString()})
[unixstamp): [${start}, ${end})`);

        const format = this.getFlag("raw") ? "raw" : (this.getFlag("json") ? "json" : this.getFlag("format"));
        switch (format) {
            case "raw": {
                data.forEach(item => console.log(item));
                break;
            }
            case "json": {
                data.forEach(item => console.log(JSON.stringify(item, null, 4)))
                break;
            }
            default: {                
                // console.table(formattedList);
                // create another object with index as the address value for printing out a nicer table
                // list.map(e => ({[e.address]: {blockcount: e.blockcount, allotted: Utils.formatSatoshi(e.allotted).toString()}}))
                //     .forEach(item => console.table(item));

                // const formattedData = data.map(e => ({ address: e.address, blockcount: e.blockcount, allotted: Utils.formatSatoshi(e.allotted).toString()}));
                const transform = (
                    ({ address, blockcount, orgAllotted, allotted }) => 
                    ({ address, blockcount, orgAllotted: Utils.formatSatoshi(orgAllotted).toString(), allotted: Utils.formatSatoshi(allotted).toString() })
                );
                const formattedData = data.map((e: any) => transform(e));
                this.components.table(["address", "blockcount", "orgAllotted", "allotted"], (table) => {
                    formattedData.forEach(e => table.push(Object.values(e)));
                });
            }
        }
    }
}
