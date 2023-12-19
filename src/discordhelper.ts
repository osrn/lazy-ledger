import { Container, Contracts } from "@solar-network/kernel";
import { userMention, WebhookClient } from "discord.js";
import { ConfigHelper, configHelperSymbol } from "./confighelper";
import { IConfig } from "./interfaces";
import { emoji } from "node-emoji";
import { inspect } from "util";

export const discordHelperSymbol = Symbol.for("LazyLedger<DiscordHelper>");
const pretty = (obj: any, depth: number | null = 2) => inspect(obj, { colors: true, depth: depth });

@Container.injectable()
export class DiscordHelper {
    @Container.inject(Container.Identifiers.Application)
    private readonly app!: Contracts.Kernel.Application;

    @Container.inject(Container.Identifiers.LogService)
    private readonly logger!: Contracts.Kernel.Logger;

    private static Discord: WebhookClient;
    private botname = "Bot";
    private config!: IConfig;

    public async sendmsg(message: string, alert: boolean = false): Promise<void> {
        if (alert && this.config.discord?.mention) {
            message = `${message} ${userMention(this.config.discord.mention!)}`;
        }
        try {
            if (DiscordHelper.Discord)
                await DiscordHelper.Discord.send({ content: message, username: this.botname})
        }
        catch (e) {
            this.logger.error(`(LL) Exception at discord send()\n${pretty(e)}\n${pretty(e.stack)}`);
        }
    }

    public async boot(): Promise<boolean> {
        // discord.js Webhook.send() has a behaviour to resolve twice.
        // This becomes an issue in Solar Core; snapshots package utilizes a listener for the - now deprecated -
        // multipleResolves event; which clutters the logs with warnings whenever a plugin sends message
        // to a discord channel. Solution is to remove that deprecated process.multipleResolves listener.
        process.removeAllListeners('multipleResolves');

        this.config = this.app.get<ConfigHelper>(configHelperSymbol).getConfig();

        if (!DiscordHelper.Discord && this.config.discord?.webhookId && this.config.discord?.webhookToken) {
            this.botname = this.config.discord?.botname;
            try {
                DiscordHelper.Discord = new WebhookClient({ id: this.config.discord.webhookId, token: this.config.discord.webhookToken });
                this.logger.info(`(LL) DiscordHelper: boot complete ${emoji.white_check_mark}`);
            }
            catch (e) {
            }
        }

        return true; // Discord is optional feature for plugin. always return true
    }
}