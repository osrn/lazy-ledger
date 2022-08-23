import { Container, Contracts, Providers } from "@solar-network/kernel";
import { ConfigHelper, configHelperSymbol } from "./config_helper";
import { Database, databaseSymbol } from "./database";
import { Processor, processorSymbol } from "./processor";
import { Teller, tellerSymbol } from "./teller";
import { TxRepository, txRepositorySymbol } from "./tx_repository";

export class ServiceProvider extends Providers.ServiceProvider {
    @Container.inject(Container.Identifiers.LogService)
    private readonly logger!: Contracts.Kernel.Logger;

    // Get unique primitives
    // private configHelperSymbol = Symbol.for("LazyLedger<ConfigHelper>");
    // private databaseSymbol = Symbol.for("LazyLedger<Database>");
    // private processorSymbol = Symbol.for("LazyLedger<Processor>");
    // private tellerSymbol = Symbol.for("LazyLedger<Teller>");

    public async register(): Promise<void> {
        //this.app.bind<Controller>(this.controllerSymbol).to(Controller).inSingletonScope();
        this.app.bind<ConfigHelper>(configHelperSymbol).to(ConfigHelper).inSingletonScope();
        this.app.bind<TxRepository>(txRepositorySymbol).to(TxRepository).inSingletonScope();;
        this.app.bind<Database>(databaseSymbol).to(Database).inSingletonScope();
        this.app.bind<Processor>(processorSymbol).to(Processor).inSingletonScope();
        this.app.bind<Teller>(tellerSymbol).to(Teller).inSingletonScope();
        this.logger.info("@osrn/Lazy-Ledger (LL) Reward Sharing Plugin registered");
    }

    public async bootWhen(): Promise<boolean> {
        return !!this.config().get("enabled");
    }

    public async boot(): Promise<void> {
        //this.app.get<Controller>(this.controllerSymbol).boot();
        if (await this.app.get<ConfigHelper>(configHelperSymbol).boot()) {
            this.app.get<Database>(databaseSymbol).boot();
            this.app.get<Processor>(processorSymbol).boot();
            this.app.get<Teller>(tellerSymbol).boot();
            this.logger.info("(LL) Plugin boot complete");
        }
        else
            this.logger.error("(LL) Errors in plugin boot sequence. Not starting.");
    }
}
