import { Commands, Container } from "@solar-network/cli";
import { ProcessManager } from "@solar-network/cli/dist/services";
import { Networks } from "@solar-network/crypto";
import { Utils } from "@solar-network/kernel";
import Joi from "joi";
import { Database } from "../database";

@Container.injectable()
export class Command extends Commands.Command {
    @Container.inject(Container.Identifiers.ProcessManager)
    private readonly processManager!: ProcessManager;

    // @Container.inject(databaseSymbol)
    // private readonly sqlite!: Database;

    public signature: string = "ll:alloc";

    public description: string = "Show allocation at given block height or round";

    public configure(): void {
        this.definition
            .setFlag("token", "The name of the token", Joi.string().default("solar"))
            .setFlag("network", "The name of the network", Joi.string().valid(...Object.keys(Networks)))
            .setFlag("height", "Block height. Last block if empty or 0.", Joi.number().integer().min(0))
            .setFlag("round", "Round. Last round if empty or 0.", Joi.number().integer().min(0));
    }

    public async execute(): Promise<void> {
        const relayRunning = this.processManager.isOnline(`${this.getFlag("token")}-relay`);
        if (!relayRunning) {
            this.components.warning("Relay process is not online. Data retrieved may be outdated!");
        }
        const sqlite = new Database();
        sqlite.init(this.app.getCorePath("data"));
        let round = this.getFlag("round");
        if (!round) {
            const height = this.getFlag("height");
            if (height) {
                round = Utils.roundCalculator.calculateRound(height).round;
            }
        }
        round ||= 0; // if still undefined set to 0
        this.components.log(`Retrieving data from ${round > 0 ? "forged round: " + round : "last forged round"} ...`);
        console.log(sqlite.getLedgerAtRound(round));
    }
}
