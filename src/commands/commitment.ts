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

    public description: string = "Show voter commitment (voting balance not reduced) during a time frame";

    public configure(): void {
        this.definition
            .setFlag("token", "The name of the token", Joi.string().default("solar"))
            .setFlag("network", "The name of the network", Joi.string().valid(...Object.keys(Networks)))
            .setFlag("start", "Start date (YYYY-MM-DDTHH:mm:ss.sssZ | YYYY-MM-DDTHH:mm:ss.sss+-hh:mm), included.", Joi.date().iso().required())
            .setFlag("end", "End date (YYYY-MM-DDTHH:mm:ss.sssZ | YYYY-MM-DDTHH:mm:ss.sss+-hh:mm), excluded.", Joi.date().iso().required());
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
        const network = this.getFlag("network");
        if (end <= start) {
            this.components.error("End date must be later than start date");
            return;
        }
        const sqlite = new Database();
        sqlite.init(this.app.getCorePath("data"));
        const range = sqlite.getRangeBounds(start, end, network);
        this.components.log(`Range contains ${range.forgedCount} blocks and bounds are:
(date)     : [${startDate}, ${endDate})
(unixstamp): [${start}, ${end})
(height)   : [${range.firstForged}, ${range.lastForged}]\n`)

        this.components.log("voter commitment during the range is:")
        const voterCommitment = sqlite.getVoterCommitment(start, end, network);
        voterCommitment.forEach(item => console.log(item));
        console.log();

        this.components.log(`Committed addresses during the range, and respective valid voting balances at the beginning of the range (height ${range.firstForged}) are:`);        
        // Filter for only committed voters
        const addresses = voterCommitment.filter(al => al.continuousVotes === al.blockCount).map(al => al.address);
        // List committed voter addresses and valid voting balances at first block of the range
        sqlite.getVoterAllocationAtHeight(range.firstForged)
              .filter(item => addresses.includes(item.address) && !item.validVote.isZero())
              .sort((n1,n2) => n1.address >= n2.address ? 1:-1 ) // not care about equal strings as they are sorted already:
              .forEach(item => console.log(item.address, item.validVote.toFixed()));
}
}
