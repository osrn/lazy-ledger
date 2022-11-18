import { Commands, Container } from "@solar-network/cli";
import { ProcessManager } from "@solar-network/cli/dist/services";
import { Networks } from "@solar-network/crypto";
import Joi from "joi";
import { Database } from "../database";

@Container.injectable()
export class Command extends Commands.Command {
    @Container.inject(Container.Identifiers.ProcessManager)
    private readonly processManager!: ProcessManager;

    // @Container.inject(databaseSymbol)
    // private readonly sqlite!: Database;

    public signature: string = "ll:pending";

    public description: string = "Show pending (=unpaid) allocations since last payment";

    public configure(): void {
        this.definition
            .setFlag("token", "The name of the token", Joi.string().default("solar"))
            .setFlag("network", "The name of the network", Joi.string().valid(...Object.keys(Networks)))
            // .setArgument("scope", "Result scope. due, current or all", Joi.string().valid("due", "current", "all"))
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
        // let scope = this.getArgument("scope");
        // if (!scope) {
        //     this.components.error("Please specify scope: due, current or all");
        //     return;
        // }
        
        const data = sqlite.getPendingSimple();
        const format = this.getFlag("raw") ? "raw" : (this.getFlag("json") ? "json" : this.getFlag("format"));
        this.components.log(`Retrieving pending allocations since last payment ...`);
        if (typeof data === "undefined" || data?.blockRewards === null) {
            console.log("nothing pending yet.")
        }
        else {
            switch (format) {
                case "raw": {
                    this.components.log(data);
                    break;
                }
                case "json": {
                    this.components.log(JSON.stringify(data, null, 4));
                    break;
                }
                default: {
                    console.table(data);
                }
            }
        }
    }
}
