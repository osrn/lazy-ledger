import { Commands, Container } from "@solar-network/cli";
import { ProcessManager } from "@solar-network/cli/dist/services";
import { Networks } from "@solar-network/crypto";
import Joi from "joi";
import { Database } from "../database";

@Container.injectable()
export class Command extends Commands.Command {
    @Container.inject(Container.Identifiers.ProcessManager)
    private readonly processManager!: ProcessManager;

    public signature: string = "ll:lastpaid";

    public description: string = "Show summary|detail info about the last paid forged-block allocation";

    public configure(): void {
        this.definition
            .setFlag("token", "The name of the token", Joi.string().default("solar"))
            .setFlag("network", "The name of the network", Joi.string().valid(...Object.keys(Networks)))
            .setFlag("all", "List involved allocations", Joi.boolean().default(false))
            .setFlag("format", "Display output as standard, formatted JSON or raw", Joi.string().valid("std", "json", "raw").default("std"))
            .setFlag("json", "Short for format=\"all\". Overrides --format.", Joi.boolean().default(false))
            .setFlag("raw", "Short for format=\"raw\". Overrides --format and --json", Joi.boolean().default(false));
    }

    public async execute(): Promise<void> {
        const relayRunning = this.processManager.isOnline(`${this.getFlag("token")}-relay`);
        if (!relayRunning) {
            this.components.warning("Relay process is not online. Data retrieved may be outdated!");
        }
        const sqlite = new Database();
        sqlite.init(this.app.getCorePath("data"));
        const flag_all = this.getFlag("all");
        const format = this.getFlag("raw") ? "raw" : (this.getFlag("json") ? "json" : this.getFlag("format"));
        
        this.components.log(`Retrieving info about the last paid forged-block allocation ...`);
        const data = sqlite.getLastPaidSummary();
        switch (format) {
            case "raw": {
                console.log(data);
                break;
            }
            case "json": {
                console.log(JSON.stringify(data, null, 4))
                break;
            }
            default: {
                console.table(data);
            }
        }
        if (flag_all) {
            const data = sqlite.getLastPaidVoterAllocation();
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
                    data.forEach(item => console.table(item));
                }
            }
        }
    }
}
