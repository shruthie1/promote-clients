import { Api, TelegramClient } from "telegram";
import { getEntity } from "telegram/client/users";
import { NewMessageEvent } from "telegram/events";
import { sleep } from "./utils";
import { parseError } from "./parseError";
import { ReactQueue } from "./ReactQueue";
import { contains, IChannel, selectRandomElements } from "./utils";
import { getAllReactions, setReactions } from "./reaction.utils";
import TelegramManager from "./TelegramManager";
import { UserDataDtoCrud } from "./dbservice";
import { restartClient } from "./express";

const notifbot = `https://api.telegram.org/bot5856546982:AAEW5QCbfb7nFAcmsTyVjHXyV86TVVLcL_g/sendMessage?chat_id=${process.env.notifChannel}`;

export class Reactions {
    private flag = true;
    private flag2 = true;
    private floodControl = new Map<string, { triggeredTime: number; releaseTime: number; count: number }>();
    private waitReactTime = Date.now();
    public lastReactedtime = Date.now() - 180000;
    private reactionDelays: number[] = [];
    private reactionsRestarted = Date.now();
    public averageReactionDelay = 0;
    private minWaitTime = 1500;
    private maxWaitTime = 21000;
    private reactSleepTime = 5000;
    private floodTriggeredTime = 0;
    private floodCount = 0;
    private targetReactionDelay = 6000;
    private reactQueue: ReactQueue;
    private nextMobileIndex = 0;
    private currentMobile: string;
    private mobiles: string[] = [];
    private successCount = 0;
    private debounceTimeout: NodeJS.Timeout | null = null;

    private getClient: (clientId: string) => TelegramManager | undefined;

    constructor(mobiles: string[], getClient: (clientId: string) => TelegramManager | undefined) {
        this.reactQueue = ReactQueue.getInstance();
        this.mobiles = mobiles;
        this.getClient = getClient;
        this.currentMobile = mobiles[0];
        console.log("Reaction Instance created");
    }

    public async setMobiles(mobiles: string[]) {
        console.log("Setting Mobiles in Reaction Instance", mobiles.length);
        this.mobiles = mobiles;
        const db = UserDataDtoCrud.getInstance();
        const result = await db.increaseReactCount(process.env.clientId, this.successCount);
        console.log("Updated React Success Count", this.successCount);
        this.successCount = 0;
        for (const mobile of mobiles) {
            if (!this.floodControl.has(mobile)) {
                this.floodControl.set(mobile, { count: 0, releaseTime: 0, triggeredTime: 0 });
            }
        }
    }

    private standardEmoticons = ['👍', '❤', '🔥', '👏', '🥰', '😁'];
    private emoticons = [
        '❤', '🔥', '👏', '🥰', '😁', '🤔',
        '🤯', '😱', '🤬', '😢', '🎉', '🤩',
        '🤮', '💩', '🙏', '👌', '🕊', '🤡',
        '🥱', '🥴', '😍', '🐳', '❤‍🔥', '💯',
        '🤣', '💔', '🏆', '😭', '😴', '👍',
        '🌚', '⚡', '🍌', '😐', '💋', '👻',
        '👀', '🙈', '🤝', '🤗', '🆒',
        '🗿', '🙉', '🙊', '🤷', '👎'
    ];
    private standardReactions = this.standardEmoticons.map(emoticon => new Api.ReactionEmoji({ emoticon }));
    private defaultReactions = this.emoticons.map(emoticon => new Api.ReactionEmoji({ emoticon }));

    private reactRestrictedIds = [
        '1798767939', process.env.updatesChannel, process.env.notifChannel,
        "1703065531", "1972065816", "1949920904", "2184447313", "2189566730",
        "1870673087", "1261993766", "1202668523", "1738391281", "1906584870",
        "1399025405", "1868271399", "1843478697", "2113315849", "1937606045",
        "1782145954", "1623008940", "1738135934", "1798503017", "1889233160",
        "1472089976", "1156516733", "1514843822", "2029851294", "2097005513",
        "1897072643", "1903237199", "1807801643", "1956951800", "1970106364",
        "2028322484", "2135964892", "2045602167", "1486096882", "1336087349",
        "1878652859", "1711250382", "1959564784", "1345564184", "1663368151",
        "1476492615", "1524427911", "1400204596", "1812110874", "1654557420",
        "1765654210", "1860635416", "1675260943", "1730253703", "2030437007",
        "1213518210", "1235057378", "1586912179", "1672828024", "2069091557",
        "1860671752", "2125364202", "1959951200", "1607289097", "1929774605",
        "1780733848", "1685018515", "2057393918", "1887746719", "1916123414",
        "1970767061", "2057158588"
    ];

    async react(event: NewMessageEvent, targetMobile: string): Promise<void> {
        if (targetMobile !== this.currentMobile || !this.flag || this.waitReactTime > Date.now()) {
            return;
        }

        if (this.debounceTimeout) {
            clearTimeout(this.debounceTimeout);
        }
        this.debounceTimeout = setTimeout(async () => {
            const chatId = event.message.chatId.toString();
            try {
                if (this.shouldReact(chatId)) {
                    const availableReactions = getAllReactions(chatId);
                    if (availableReactions && availableReactions.length > 1) {
                        const reaction = this.selectReaction(availableReactions);
                        await this.processReaction(event, reaction);
                    } else {
                        this.processReaction(event, selectRandomElements(this.standardReactions, 1));
                        await this.handleReactionsCache(event, chatId);
                    }
                } else {
                    await this.handleReactionRestart(event, chatId);
                }
            } catch (error) {
                this.handleError(error);
            }
        }, 300); // Adjust the debounce delay as needed
    }

    private async getReactions(chatId: string, client: TelegramClient) {
        const channel = undefined;
        if (channel && channel.reactRestricted) {
            this.reactRestrictedIds.push(chatId);
            return [];
        } else {
            const reactions = await this.fetchAvailableReactions(chatId, client);
            return reactions;
        }
    }

    private async getChannelFromTg(channelId: string, client: TelegramClient) {
        try {
            const channelEnt = channelId.startsWith('-') ? channelId : `-100${channelId}`;
            const { id, defaultBannedRights, megagroup, title, broadcast, username, participantsCount, restricted } = <Api.Channel>await getEntity(client, channelEnt);
            const channel: IChannel = {
                channelId: id.toString()?.replace(/^-100/, ""),
                title,
                participantsCount,
                username,
                restricted,
                broadcast,
                megagroup,
                private: false,
                forbidden: false,
                sendMessages: defaultBannedRights?.sendMessages,
                canSendMsgs: !broadcast && !defaultBannedRights?.sendMessages,
                availableMsgs: [],
                dMRestriction: 0,
                banned: false,
                reactions: [],
                reactRestricted: false,
                wordRestriction: 0
            };
            return channel;
        } catch (error) {
            console.log("Failed to fetch channel from tg");
            return undefined;
        }
    }

    private async handleReactionsCache(event: NewMessageEvent, chatId: string): Promise<void> {
        if (this.flag2) {
            this.flag2 = false;
            try {
                const availableReactions = await this.getReactions(chatId, event.client);
                await this.updateReactionsCache(chatId, availableReactions);
            } catch (error) {
                this.handleCacheError(error, chatId);
            } finally {
                this.flag2 = true;
                await sleep(3000);
            }
        }
    }

    private async fetchAvailableReactions(chatId: string, client: TelegramClient): Promise<Api.ReactionEmoji[]> {
        const result = await client.invoke(new Api.channels.GetFullChannel({ channel: chatId }));
        const reactionsJson: any = result?.fullChat?.availableReactions?.toJSON();
        return reactionsJson?.reactions || [];
    }

    private async updateReactionsCache(chatId: string, availableReactions: Api.ReactionEmoji[]): Promise<void> {
        if (availableReactions.length > 3 && availableReactions.length > this.defaultReactions.length) {
            this.defaultReactions = availableReactions;
        }

        if (availableReactions.length < 1 && this.defaultReactions.length > 1) {
            const availReactions = this.defaultReactions.map(emoticon => emoticon.emoticon);
            setReactions(chatId, this.defaultReactions);
        } else {
            setReactions(chatId, availableReactions);
        }
    }

    private handleCacheError(error: any, chatId: string): void {
        parseError(error, `:: Fetching Reactions`, false);

        if (this.defaultReactions.length > 1) {
            setReactions(chatId, this.defaultReactions);
        }
    }

    private shouldReact(chatId: string): boolean {
        return (
            !contains(chatId, this.reactRestrictedIds) &&
            !this.reactQueue.contains(chatId) &&
            this.mobiles?.length > 1
        );
    }

    private async processReaction(event: NewMessageEvent, reaction: Api.ReactionEmoji[]): Promise<void> {
        this.flag = false;
        const tgManager = this.getClient(this.currentMobile);
        if (tgManager?.client) {
            await this.executeReaction(event, tgManager.client, reaction);
            this.currentMobile = this.selectNextMobile();
        } else {
            this.flag = true;
            console.log(`Client is undefined: ${this.currentMobile}`);
            this.mobiles = this.mobiles.filter(mobile => mobile !== this.currentMobile);
            this.floodControl.delete(this.currentMobile);
            this.currentMobile = this.selectNextMobile();
            await restartClient(this.currentMobile);
        }
    }

    private async executeReaction(event: NewMessageEvent, client: TelegramClient, reaction: Api.ReactionEmoji[]): Promise<void> {
        const chatId = event.chatId.toString();

        try {
            await this.sendReaction(client, event, reaction);
            console.log(`${this.currentMobile} Reacted Successfully, Average Reaction Delay:`, this.averageReactionDelay, "ms", reaction[0].emoticon, this.reactSleepTime, new Date().toISOString().split('T')[1].split('.')[0]);
            await this.updateReactionStats();
        } catch (error) {
            await this.handleReactionError(error, reaction, chatId, this.currentMobile);
        } finally {
            if (this.averageReactionDelay < this.targetReactionDelay) {
                this.reactSleepTime = Math.min(this.reactSleepTime + 200, this.maxWaitTime);
            } else if (Date.now() > this.floodTriggeredTime + 600000 && this.floodCount < 3) {
                this.reactSleepTime = Math.max(this.reactSleepTime - 50, this.minWaitTime);
            }
            this.waitReactTime = Date.now() + this.reactSleepTime;
            this.flag = true;
        }
    }

    private selectReaction(availableReactions: Api.ReactionEmoji[]): Api.ReactionEmoji[] {
        const reactionIndex = Math.floor(Math.random() * availableReactions.length);
        return [availableReactions[reactionIndex]];
    }

    private async sendReaction(client: TelegramClient, event: NewMessageEvent, reaction: Api.ReactionEmoji[]): Promise<void> {
        const MsgClass = new Api.messages.SendReaction({
            peer: event.message.chat,
            msgId: event.message.id,
            reaction,
        });

        await client.invoke(MsgClass);
    }

    private async updateReactionStats(): Promise<void> {
        const reactionDelay = Math.min(Date.now() - this.lastReactedtime, 25000);
        this.lastReactedtime = Date.now();
        this.reactionDelays.push(reactionDelay);
        this.successCount++;
        if (this.reactionDelays.length > 20) {
            this.reactionDelays.shift();
        }
        const totalDelay = this.reactionDelays.reduce((sum, delay) => sum + delay, 0);
        this.averageReactionDelay = Math.floor(totalDelay / this.reactionDelays.length);
    }

    private async handleReactionError(
        error: any,
        reaction: Api.ReactionEmoji[],
        chatId: string,
        mobile: string
    ): Promise<void> {
        if (error.seconds) {
            await this.handleFloodError(error, mobile);
        } else if (error.errorMessage === "REACTION_INVALID") {
            let availableReactions = [...getAllReactions(chatId)];
            availableReactions = [...availableReactions.splice(availableReactions.indexOf(reaction[0]), 1)];
            console.log(`${mobile} Removed Reaction : ${error.errorMessage}: ${chatId} ${reaction[0].emoticon}`, new Date().toISOString().split('T')[1].split('.')[0]);
            setReactions(chatId, availableReactions);
        } else {
            console.log(`${mobile} Reaction failed: ${error.errorMessage}`, new Date().toISOString().split('T')[1].split('.')[0]);
        }
    }

    private async handleFloodError(error: any, mobile: string): Promise<void> {
        console.log(`Handling flood error for mobile: ${mobile} for ${error.seconds} seconds`);
        const currentFlood = this.floodControl.get(mobile) || { triggeredTime: 0, releaseTime: 0, count: 0 };

        const releaseTime = Date.now() + error.seconds * 1000;

        this.floodControl.set(mobile, {
            triggeredTime: Date.now(),
            releaseTime,
            count: currentFlood.count + 1,
        });
        this.reactSleepTime = 5000;
        this.targetReactionDelay += 500;
        this.minWaitTime += 500;
        this.floodTriggeredTime = Date.now();
        this.floodCount++;
    }

    private async handleReactionRestart(event: NewMessageEvent, chatId: string): Promise<void> {
        if (this.lastReactedtime < Date.now() - 60000 && this.shouldRestart(chatId)) {
            console.log("Restarting reaction process...");
            this.resetReactionState();
        }
    }

    private shouldRestart(chatId: string): boolean {
        return (
            !this.flag ||
            this.reactQueue.contains(chatId) ||
            this.reactionsRestarted < Date.now() - 30000
        );
    }

    private resetReactionState(): void {
        this.flag = true;
        this.lastReactedtime = Date.now();
        this.waitReactTime = Date.now();
        this.reactQueue.clear();
        this.reactionsRestarted = Date.now();
    }

    private handleError(error: any): void {
        parseError(error, ":: Reaction Error", false);
        this.flag = true;
        this.flag2 = true;
    }

    private getHealthyMobiles() {
        return this.mobiles.filter((mobile) => {
            const floodData = this.floodControl.get(mobile) || { triggeredTime: 0, releaseTime: 0, count: 0 };
            return floodData.releaseTime < Date.now();
        });
    }

    private selectNextMobile(): string | null {
        const healthyMobiles = this.getHealthyMobiles();
        if (!healthyMobiles.length) {
            console.warn("No healthy mobiles available for Reactions");
            return null;
        }
        const selectedMobile = healthyMobiles[this.nextMobileIndex % healthyMobiles.length];
        this.nextMobileIndex = (this.nextMobileIndex + 1) % healthyMobiles.length;
        return selectedMobile;
    }
}
