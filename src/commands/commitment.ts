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

    public signature: string = "ll:commitment";

    public description: string = "Show voter commitment (continuous blocks voting balance not reduced) during a time frame";

    public configure(): void {
        this.definition
            .setFlag("token", "The name of the token", Joi.string().default("solar"))
            .setFlag("network", "The name of the network", Joi.string().valid(...Object.keys(Networks)))
            .setFlag("start", "Start date (YYYY-MM-DD HH:mm:ss), incl.", Joi.date().iso().required())
            .setFlag("end", "End date (YYYY-MM-DD HH:mm:ss), excl.", Joi.date().iso().required());
    }

    public async execute(): Promise<void> {
        const relayRunning = this.processManager.isOnline(`${this.getFlag("token")}-relay`);
        if (!relayRunning) {
            this.components.warning("Relay process is not online. Data retrieved may be outdated!");
        }
        const startDate = this.getFlag("start");
        const endDate = this.getFlag("end");
        const start = Math.floor(new Date(startDate).getTime() / 1000);
        const end = Math.floor(new Date(endDate).getTime() / 1000);
        if (end <= start) {
            this.components.error("End date must be later than start date");
            return;
        }
        const sqlite = new Database();
        sqlite.init(this.app.getCorePath("data"));
        const range = sqlite.getRangeBounds(start, end);
        this.components.log(`Range contains ${range.forgedBlock} blocks and bounds are:
(date)     : [${startDate}, ${endDate})
(unixstamp): [${start}, ${end})
(height)   : [${range.firstForged}, ${range.lastForged}]\n`)

        this.components.log("voter commitment during the range is:")
        console.log(sqlite.getVoterCommitment(start, end));
        console.log();

        this.components.log(`Committed addresses during the range, and respective valid voting balances at the beginning of the range (height ${range.firstForged}) are:`);
        const addresses = sqlite.getCommittedVoterAddresses(start, end).map( a => a.address);
        sqlite.getVoterAllocationAtHeight(range.firstForged)
              .filter( al => addresses.includes(al.address))
              .forEach( al => console.log(al.address, al.validVote.toFixed()));
    }
}
