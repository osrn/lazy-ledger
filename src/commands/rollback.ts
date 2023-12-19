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

    public signature: string = "ll:rollback";

    public description: string = "Rollback to the start of the round for the given height";

    public configure(): void {
        this.definition
            .setFlag("token", "The name of the token", Joi.string().default("solar"))
            .setFlag("network", "The name of the network", Joi.string().valid(...Object.keys(Networks)))
            .setArgument("height", "Block height", Joi.number().integer().min(0).required());
    }

    public async execute(): Promise<void> {
        const relayRunning = this.processManager.isOnline(`${this.getFlag("token")}-relay`);
        if (relayRunning) {
            this.components.error("Stop the relay process before rolling back!");
            return;
        }
        const sqlite = new Database();
        sqlite.init(this.app.getCorePath("data"));
        const height = this.getArgument("height");
        const round = Utils.roundCalculator.calculateRound(height);
        const { confirm } = await this.components.prompt({
            type: "confirm",
            name: "confirm",
            message: `This will remove all records in LL database STARTING WITH & INCLUDING height ${round.roundHeight} which is the first block of the round ${round.round} and is irreversible. Are you sure?`,
        });
        if (confirm) {
            this.components.log(`Deleting data from ${round.roundHeight} ...`);
            sqlite.rollback(round.roundHeight);
            this.components.log("Rollback complete. Your last forged block allocation now is:");
            sqlite.getLedgerAtRound().forEach(item => console.log(item));
        }
    }
}
