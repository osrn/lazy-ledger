import { Commands, Container } from "@solar-network/cli";
import { ProcessManager } from "@solar-network/cli/dist/services";
import { Networks, Utils } from "@solar-network/crypto";
import Joi from "joi";
import { Database } from "../database";
import { objArrayPivotSum } from "../utils";

@Container.injectable()
export class Command extends Commands.Command {
    @Container.inject(Container.Identifiers.ProcessManager)
    private readonly processManager!: ProcessManager;

    public signature: string = "ll:antibot";

    public description: string = "List antibot detected voters, hit frequency and antibot adjusted allotments total during a time frame";

    public configure(): void {
        this.definition
            .setFlag("token", "The name of the token", Joi.string().default("solar"))
            .setFlag("network", "The name of the network", Joi.string().valid(...Object.keys(Networks)))
            .setFlag("start", "Start date (YYYY-MM-DDTHH:mm:ss.sssZ | YYYY-MM-DDTHH:mm:ss.sss+-hh:mm), included.", Joi.date().iso().required())
            .setFlag("end", "End date (YYYY-MM-DDTHH:mm:ss.sssZ | YYYY-MM-DDTHH:mm:ss.sss+-hh:mm), excluded.", Joi.date().iso().optional())
            .setFlag("format", "Display output as standard, formatted JSON or raw", Joi.string().valid("std", "json", "raw").default("std"))
            .setFlag("json", "Short for format=\"json\". Overrides --format.", Joi.boolean().default(false))
            .setFlag("raw", "Short for format=\"raw\". Overrides --format and --json", Joi.boolean().default(false));
    }

    public async execute(): Promise<void> {
        const relayRunning = this.processManager.isOnline(`${this.getFlag("token")}-relay`);
        if (!relayRunning) {
            this.components.warning("Relay process is not online. Data retrieved may be outdated!");
        }
        const startDate = this.getFlag("start");
        let endDate = this.getFlag("end") || new Date().toISOString();
        const start = Math.floor(new Date(startDate).getTime() / 1000);
        const end = Math.floor(new Date(endDate).getTime() / 1000);
        const network = this.getFlag("network");
        if (end <= start) {
            this.components.error("Start date must be earlier than the end date (or now if end date not provided)");
            return;
        }
        const sqlite = new Database();
        sqlite.init(this.app.getCorePath("data"));
        const data = sqlite.getAntibot(start, end, network);

        this.components.log(`Antibot has acted on ${data.length} addresses during the specified time frame:
[date)     : [${new Date(startDate).toISOString()}, ${new Date(endDate).toISOString()})
[unixstamp): [${start}, ${end})`);

        if (data.length === 0) return;

        const pivot: [ { orgAllotted: Utils.BigNumber; allotted: Utils.BigNumber }] = objArrayPivotSum(data, [], ['orgAllotted', 'allotted']) as unknown as [ { orgAllotted: Utils.BigNumber; allotted: Utils.BigNumber }];
        this.components.log(`\
total rewards called        : ${Utils.formatSatoshi(pivot[0].orgAllotted)}
total allotted after antibot: ${Utils.formatSatoshi(pivot[0].allotted)}`);

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
