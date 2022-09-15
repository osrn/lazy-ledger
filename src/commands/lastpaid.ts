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

    public signature: string = "ll:lastpaid";

    public description: string = "Show last paid allocation summary|detail";

    public configure(): void {
        this.definition
            .setFlag("token", "The name of the token", Joi.string().default("solar"))
            .setFlag("network", "The name of the network", Joi.string().valid(...Object.keys(Networks)))
            .setFlag("all", "list involved allocations", Joi.boolean().default(false));
    }

    public async execute(): Promise<void> {
        const relayRunning = this.processManager.isOnline(`${this.getFlag("token")}-relay`);
        if (!relayRunning) {
            this.components.warning("Relay process is not online. Data retrieved may be outdated!");
        }
        const sqlite = new Database();
        sqlite.init(this.app.getCorePath("data"));
        const flag_all = this.getFlag("all");
        this.components.log(`Retrieving data for the last paid allocation ...`);
        if (!flag_all) {
            console.log(sqlite.getLastPaidSummary());
        }
        else {
            sqlite.getLastPaidVoterAllocation().forEach( item => console.log(item) );
        }
    }
}
