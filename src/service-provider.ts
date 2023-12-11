import { Container, Contracts, Providers } from "@solar-network/kernel";
import { name, description, version } from "./package-details.json";
import { ConfigHelper, configHelperSymbol } from "./confighelper";
import { Database, databaseSymbol } from "./database";
import { DiscordHelper, discordHelperSymbol } from "./discordhelper";
import { Processor, processorSymbol } from "./processor";
import { Teller, tellerSymbol } from "./teller";
import { TxRepository, txRepositorySymbol } from "./tx_repository";

export class ServiceProvider extends Providers.ServiceProvider {
    @Container.inject(Container.Identifiers.LogService)
    private readonly logger!: Contracts.Kernel.Logger;

    public async register(): Promise<void> {
        this.app.bind<ConfigHelper>(configHelperSymbol).to(ConfigHelper).inSingletonScope();
        this.app.bind<DiscordHelper>(discordHelperSymbol).to(DiscordHelper).inSingletonScope();
        this.app.bind<TxRepository>(txRepositorySymbol).to(TxRepository).inSingletonScope();;
        this.app.bind<Database>(databaseSymbol).to(Database).inSingletonScope();
        this.app.bind<Processor>(processorSymbol).to(Processor).inSingletonScope();
        this.app.bind<Teller>(tellerSymbol).to(Teller).inSingletonScope();
        this.logger.info(`${name} ${description} v${version} registered`);
    }

    public async bootWhen(): Promise<boolean> {
        return !!this.config().get("enabled");
    }

    public async boot(): Promise<void> {
        if (await this.app.get<ConfigHelper>(configHelperSymbol).boot()) {
            await this.app.get<DiscordHelper>(discordHelperSymbol).boot();
            await this.app.get<Database>(databaseSymbol).boot();
            await this.app.get<Processor>(processorSymbol).boot();
            await this.app.get<Teller>(tellerSymbol).boot();
            this.logger.info("(LL) Plugin boot complete");
        }
        else
            this.logger.emergency("(LL) Errors in plugin boot sequence. Not starting.");
    }
}
