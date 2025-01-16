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
import { getMapKeys, restartClient } from "./express";

const notifbot = `https://api.telegram.org/bot5856546982:AAEW5QCbfb7nFAcmsTyVjHXyV86TVVLcL_g/sendMessage?chat_id=${process.env.notifChannel}`;
interface ReactionStats {
    successCount: number;
    failedCount: number;
    sleepTime: number;
    releaseTime: number;
    lastReactedTime: number;
    triggeredTime: number;
    floodCount: number;
}
export class Reactions {
    private flag = true;
    private flag2 = true;
    private waitReactTime = Date.now();
    public lastReactedtime = Date.now() - 180000;
    private reactionDelays: number[] = [];
    private reactionsRestarted = Date.now();
    public averageReactionDelay = 0;
    private minWaitTime = 1500;
    private maxWaitTime = 21000;
    private reactSleepTime = 5000;
    private targetReactionDelay = 6000;
    private reactQueue: ReactQueue;
    private nextMobileIndex = 0;
    private mobiles: string[] = [];
    private successCount = 0;
    private reactStats: Map<string, ReactionStats> = new Map<string, ReactionStats>();

    private getClient: (clientId: string) => TelegramManager | undefined;

    constructor(mobiles: string[], getClient: (clientId: string) => TelegramManager | undefined) {
        this.reactQueue = ReactQueue.getInstance();
        this.mobiles = mobiles;
        this.getClient = getClient;
        for (const mobile of mobiles) {
            this.reactStats.set(mobile, {
                sleepTime: 0,
                releaseTime: 0,
                successCount: 0,
                failedCount: 0,
                lastReactedTime: 0,
                triggeredTime: 0,
                floodCount: 0
            });
        }
        console.log("Reaction Instance created : ", mobiles, mobiles?.length);
    }

    public async setMobiles(mobiles: string[]) {
        console.log("Setting Mobiles in Reaction Instance", mobiles.length);
        this.mobiles = mobiles;
        const db = UserDataDtoCrud.getInstance();
        const result = await db.increaseReactCount(process.env.clientId, this.successCount);
        this.successCount = 0;
        const mobileSet = new Set(mobiles);
        for (const mobile of this.reactStats.keys()) {
            if (!mobileSet.has(mobile)) {
                this.reactStats.delete(mobile);
                console.log(`Deleted mobile ${mobile} from mobileStats`);
            }
        }

        for (const mobile of mobiles) {
            if (!this.reactStats.has(mobile)) {
                this.reactStats.set(mobile, {
                    sleepTime: 0,
                    releaseTime: 0,
                    successCount: 0,
                    failedCount: 0,
                    lastReactedTime: 0,
                    triggeredTime: 0,
                    floodCount: 0
                });
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

    async react(message: Api.Message, targetMobile: string): Promise<void> {
        const stats = this.reactStats.get(targetMobile);
        if (!this.flag || stats.releaseTime > Date.now() || stats.lastReactedTime > Date.now() - 15000) {
            return;
        }
        try {
            const chatId = message.chatId.toString();
            if (this.shouldReact(chatId)) {
                this.flag = false;
                const availableReactions = getAllReactions(chatId);
                if (availableReactions && availableReactions.length > 1) {
                    const reaction = this.selectReaction(availableReactions);
                    await this.processReaction(message, reaction, targetMobile);
                } else {
                    this.processReaction(message, selectRandomElements(this.standardReactions, 1), targetMobile);
                    await this.handleReactionsCache(targetMobile, chatId);
                }
                this.flag = true;
            } else {
                await this.handleReactionRestart(message, chatId);
            }
        } catch (error) {
            this.handleError(error);
        }
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

    private async handleReactionsCache(mobile: string, chatId: string): Promise<void> {
        if (this.flag2) {
            this.flag2 = false;
            try {
                const availableReactions = await this.getReactions(chatId, this.getClient(mobile)?.client);
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
        const isRestricted = contains(chatId, this.reactRestrictedIds);
        const isInQueue = this.reactQueue.contains(chatId);
        const hasMobiles = this.mobiles?.length > 0;
        if (!hasMobiles) {
            this.setMobiles(getMapKeys());
        }
        return !isRestricted && !isInQueue && this.mobiles?.length > 0;
    }

    private async processReaction(message: Api.Message, reaction: Api.ReactionEmoji[], mobile: string): Promise<void> {
        const tgManager = this.getClient(mobile);
        if (tgManager?.client) {
            await this.executeReaction(message, tgManager.client, reaction, mobile);
        } else {
            console.log(`Client is undefined: ${mobile}`);
        }
    }

    private async executeReaction(message: Api.Message, client: TelegramClient, reaction: Api.ReactionEmoji[], mobile: string): Promise<void> {
        const chatId = message.chatId.toString();
        try {
            await this.sendReaction(client, message, reaction);
            console.log(`${mobile} Reacted Successfully, Average Reaction Delay:`, this.averageReactionDelay, "ms", reaction[0].emoticon, this.reactSleepTime, new Date().toISOString().split('T')[1].split('.')[0]);
            await this.updateReactionStats(mobile);
        } catch (error) {
            await this.handleReactionError(error, reaction, chatId, mobile);
        } finally {
            const stats = this.reactStats.get(mobile);
            if (this.averageReactionDelay < this.targetReactionDelay) {
                this.reactSleepTime = Math.min(this.reactSleepTime + 200, this.maxWaitTime);
            } else if (Date.now() > stats.triggeredTime + 600000 && stats.floodCount < 3) {
                this.reactSleepTime = Math.max(this.reactSleepTime - 50, this.minWaitTime);
            }
            this.waitReactTime = Date.now() + this.reactSleepTime;
        }
    }

    private selectReaction(availableReactions: Api.ReactionEmoji[]): Api.ReactionEmoji[] {
        const reactionIndex = Math.floor(Math.random() * availableReactions.length);
        return [availableReactions[reactionIndex]];
    }

    private async sendReaction(client: TelegramClient, message: Api.Message, reaction: Api.ReactionEmoji[]): Promise<void> {
        const MsgClass = new Api.messages.SendReaction({
            peer: message.chat,
            msgId: message.id,
            reaction,
        });

        await client.invoke(MsgClass);
    }

    private async updateReactionStats(mobile: string): Promise<void> {
        const stats = this.reactStats.get(mobile);
        this.reactStats.set(mobile, {
            ...stats,
            lastReactedTime: Date.now(),
            successCount: stats.successCount + 1,
        });
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
        const stats = this.reactStats.get(mobile);
        this.reactStats.set(mobile, {
            ...stats,
            lastReactedTime: Date.now(),
            failedCount: stats.failedCount + 1,
        });
        if (error.seconds) {
            await this.handleFloodError(error, mobile);
        } else if (error.errorMessage === "REACTION_INVALID") {
            let availableReactions = [...getAllReactions(chatId)];
            availableReactions = [...availableReactions.splice(availableReactions.indexOf(reaction[0]), 1)];
            console.log(`${mobile} Removed Reaction : ${error.errorMessage}: ${chatId} ${reaction[0].emoticon}`, new Date().toISOString().split('T')[1].split('.')[0]);
            setReactions(chatId, availableReactions);
        } else {
            console.log(error, reaction[0].emoticon);
            console.log(`${mobile} Reaction failed: ${error.errorMessage}`, new Date().toISOString().split('T')[1].split('.')[0]);
        }

    }

    private async handleFloodError(error: any, mobile: string): Promise<void> {
        console.log(`Handling flood error for mobile: ${mobile} for ${error.seconds} seconds`);
        const stats = this.reactStats.get(mobile);
        const releaseTime = Date.now() + error.seconds * 1000;
        this.reactStats.set(mobile, {
            ...stats,
            triggeredTime: Date.now(),
            releaseTime,
            floodCount: stats.floodCount + 1,
        });
        this.reactSleepTime = 5000;
        this.targetReactionDelay += 500;
        this.minWaitTime += 500;
    }

    private async handleReactionRestart(message: Api.Message, chatId: string): Promise<void> {
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
            const stats = this.reactStats.get(mobile);
            return stats.releaseTime < Date.now();
        });
    }

    private selectNextMobile(): string | null {
        const healthyMobiles = this.getHealthyMobiles();
        if (!healthyMobiles.length) {
            console.warn("No healthy mobiles available for Reactions, but mobiles: ", this.mobiles);
            return null;
        }
        const selectedMobile = healthyMobiles[this.nextMobileIndex % healthyMobiles.length];
        this.nextMobileIndex = (this.nextMobileIndex + 1) % healthyMobiles.length;
        return selectedMobile;
    }
}
