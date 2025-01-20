import { TelegramClient, Api, errors } from "telegram";
import * as fs from 'fs/promises';
import { UserDataDtoCrud } from "./dbservice";
import { generateEmojis, getCurrentHourIST, getRandomEmoji, IChannel, ppplbot, selectRandomElements, sendToLogs, sleep } from "./utils";
import { updateFailedCount, updateSuccessCount } from "./express";
import { parseError } from "./parseError";
import { SendMessageParams } from "telegram/client/messages";
import { pickOneMsg } from "./messages";
import { fetchWithTimeout } from "./fetchWithTimeout";
import TelegramManager from "./TelegramManager";
import path from "path";

interface MessageQueueItem {
    mobile: string;
    channelId: string;
    messageId: number;
    timestamp: number;
    messageIndex: string;
}

interface MobileStats {
    messagesSent: number;
    failedMessages: number;
    sleepTime: number;
    releaseTime: number;
    lastMessageTime: number;
    daysLeft: number;
    failCount: number;
}

export class Promotion {
    private mobileStats: Map<string, MobileStats> = new Map<string, MobileStats>();
    private nextMobileIndex = 0; // Index for round-robin mobile selection
    private channels: string[] = [];
    private minDelay: number = 170000;
    private maxDelay: number = 200000;
    private messageQueue: MessageQueueItem[] = [];
    private messageCheckDelay: number = 20000;
    private lastMessageTime: number = Date.now() - 20 * 60 * 1000;
    private promoteMsgs = {};
    private mobiles: string[] = [];
    private channelIndex = 0; // Add channelIndex as an instance private member
    private failureReason = 'UNKNOWN';
    private startPromoteCount: number = 0;
    private promotionResults: Map<string, Map<string, { success: boolean, errorMessage?: string }>> = new Map(); // New map to store promotion results

    private getClient: (clientId: string) => TelegramManager | undefined;
    static instance: Promotion;
    private isPromoting: boolean = false;

    private constructor(mobiles: string[], getClient: (clientId: string) => TelegramManager | undefined) {
        this.getClient = getClient;
        this.mobiles = mobiles;
        console.log("Promotion Instance created");
        setInterval(() => this.checkQueuedMessages(), this.messageCheckDelay);
        const db = UserDataDtoCrud.getInstance();
        db.getPromoteMsgs().then((data) => {
            this.promoteMsgs = data;
        });
        for (const mobile of mobiles) {
            this.mobileStats.set(mobile, {
                messagesSent: 0,
                failedMessages: 0,
                sleepTime: 0,
                releaseTime: 0,
                lastMessageTime: Date.now() - 13 * 60 * 1000,
                daysLeft: -1,
                failCount: 0
            });
        }
    }

    public setMobiles(mobiles: string[]) {
        console.log("Setting Mobiles in Promotion instance", mobiles.length);
        const validMobiles = mobiles.filter(mobile => this.getClient(mobile));
        this.mobiles = validMobiles;

        // const mobileSet = new Set(mobiles);

        // for (const mobile of this.mobileStats.keys()) {
        //     if (!mobileSet.has(mobile)) {
        //         this.mobileStats.delete(mobile);
        //         console.log(`Deleted mobile ${mobile} from mobileStats`);
        //     }
        // }

        // for (const mobile of this.promotionResults.keys()) {
        //     if (!mobileSet.has(mobile)) {
        //         this.promotionResults.delete(mobile);
        //         console.log(`Deleted mobile ${mobile} from promotion Results`);
        //     }
        // }

        for (const mobile of mobiles) {
            if (!this.mobileStats.has(mobile)) {
                this.mobileStats.set(mobile, {
                    messagesSent: 0,
                    failedMessages: 0,
                    sleepTime: 0,
                    releaseTime: 0,
                    lastMessageTime: Date.now() - 13 * 60 * 1000,
                    daysLeft: -1,
                    failCount: 0
                });
            }
        }
    }

    public refreshStats(mobiles: string[]) {
        console.log("Refreshing Stats for Promotion instance", mobiles);
        const mobileSet = new Set(mobiles);

        for (const mobile of this.mobileStats.keys()) {
            if (!mobileSet.has(mobile)) {
                this.mobileStats.delete(mobile);
                console.log(`Deleted mobile ${mobile} from mobileStats`);
            }
        }

        for (const mobile of this.promotionResults.keys()) {
            if (!mobileSet.has(mobile)) {
                this.promotionResults.delete(mobile);
                console.log(`Deleted mobile ${mobile} from promotion Results`);
            }
        }
    }


    async checkQueuedMessages() {
        const now = Date.now();
        const readyMessages = [];
        for (const item of this.messageQueue) {
            if ((now - item.timestamp) >= this.messageCheckDelay) {
                readyMessages.push(item);
            }
        }
        for (const messageItem of readyMessages) {
            await this.checkMessageExist(messageItem);
        }
        this.messageQueue = this.messageQueue.filter(item => !readyMessages.includes(item));
    }

    public static getInstance(mobiles: string[], getClient: (clientId: string) => TelegramManager | undefined): Promotion {
        if (!Promotion.instance) {
            Promotion.instance = new Promotion(mobiles, getClient);
        }
        return Promotion.instance;
    }

    setDaysLeft(mobile: string, daysLeft: number) {
        console.log("Setting DaysLeft:", daysLeft)
        const stats = this.mobileStats.get(mobile);
        if (stats) {
            this.mobileStats.set(mobile, { ...stats, daysLeft: daysLeft })
        }
        if (daysLeft == -1) {
            this.clearPromtionsMap(mobile);
        }
    }

    getDaysLeft(mobile: string) {
        const data = this.mobileStats.get(mobile);
        return data.daysLeft;
    }

    getLastMessageTime(mobile: string) {
        const data = this.mobileStats.get(mobile);
        return data.lastMessageTime;
    }

    private getHealthyMobiles() {
        return this.mobiles.filter((mobile) => {
            let stats = this.mobileStats.get(mobile);
            if (!stats) {
                stats = {
                    messagesSent: 0,
                    failedMessages: 0,
                    sleepTime: 0,
                    releaseTime: 0,
                    lastMessageTime: Date.now() - 13 * 60 * 1000,
                    daysLeft: -1,
                    failCount: 0
                };
            }
            if (stats.failCount > 10) {
                stats.daysLeft = 0;
                stats.sleepTime = Date.now() + 10 * 60 * 1000;
                stats.failCount = 0
            };
            this.mobileStats.set(mobile, stats);
            return stats && stats.daysLeft < 7 && stats.lastMessageTime < Date.now() - 12 * 60 * 1000 && stats.sleepTime < Date.now();
        });
    }

    private selectNextMobile(currentMobile: string | null = null): string | null {
        const healthyMobiles = this.getHealthyMobiles();
        if (!healthyMobiles.length) {
            console.warn("No healthy mobiles available for Promotions");
            return null;
        }
        let selectedMobile = healthyMobiles[this.nextMobileIndex % healthyMobiles.length];
        if (currentMobile && healthyMobiles.length === 1 && selectedMobile === currentMobile) {
            console.log(`Only one healthy mobile available and it is the current mobile: ${currentMobile}`);
            return null;
        }
        if (currentMobile && healthyMobiles.length > 1 && selectedMobile === currentMobile) {
            this.nextMobileIndex = (this.nextMobileIndex + 1) % healthyMobiles.length;
            selectedMobile = healthyMobiles[this.nextMobileIndex % healthyMobiles.length];
        }
        this.nextMobileIndex = (this.nextMobileIndex + 1) % healthyMobiles.length;
        return selectedMobile;
    }


    async checkMessageExist(messageItem: MessageQueueItem) {
        try {
            const tgManager = this.getClient(messageItem.mobile)
            const result = await tgManager.client.getMessages(messageItem.channelId, { ids: messageItem.messageId });
            if (result.length > 0) {
                this.handleExistingMessage(messageItem.channelId, messageItem.messageIndex)
            } else {
                this.handleDeletedMessage(messageItem.channelId, messageItem.messageIndex)
            }
        } catch (error) {
            console.error(`Error checking message ${messageItem.messageId} in ${messageItem.channelId}: ${error.message}`);
        }
    }

    async fetchDialogs() {
        const totalBatches = 1; // Fetch three batches
        const batchSize = 350;
        const channelDataSet = new Set<string>(); // Use Set to avoid duplicates
        const channelDetails: { channelId: string; participantsCount: number }[] = [];
        console.log(`Fetching dialogs from clients...`);
        try {
            for (let batch = 0; batch < totalBatches; batch++) {
                const mobile = selectRandomElements(this.mobiles, 1)[0];
                console.log(`Fetching dialogs for mobile: ${mobile}`);
                const tgManager = this.getClient(mobile);
                const client = tgManager?.client;

                if (!client) {
                    console.warn(`Client not available for mobile: ${mobile}`);
                    continue;
                }

                await client.connect();
                const dialogs = await client.getDialogs({ limit: batchSize });

                if (!dialogs || dialogs.length === 0) {
                    console.warn("No dialogs retrieved from the client.");
                    break;
                }

                for (const dialog of dialogs) {
                    if (dialog.isChannel || dialog.isGroup) {
                        const chatEntity = dialog.entity as Api.Channel;

                        if (
                            !chatEntity.broadcast && // Exclude broadcast channels
                            chatEntity.participantsCount > 500 && // Minimum participants
                            !chatEntity.defaultBannedRights?.sendMessages && // Allow messaging
                            !chatEntity.restricted && // Exclude restricted channels
                            chatEntity.id
                        ) {
                            const channelId = chatEntity.id.toString().replace(/^-100/, "");
                            if (!channelDataSet.has(channelId)) {
                                // Add to Set to prevent duplicates
                                channelDataSet.add(channelId);
                                channelDetails.push({
                                    channelId,
                                    participantsCount: chatEntity.participantsCount,
                                });
                            }
                        }
                    }
                }
            }

            // Sort channels by participantsCount
            // channelDetails.sort((a, b) => b.participantsCount - a.participantsCount);
            console.log(`Sorted channels by participants count: ${channelDetails.length}`);

            // Fisher-Yates Shuffle on top 250
            const topChannels = channelDetails.slice(0, 200);
            // for (let i = topChannels.length - 1; i > 0; i--) {
            //     const j = Math.floor(Math.random() * (i + 1));
            //     [topChannels[i], topChannels[j]] = [topChannels[j], topChannels[i]];
            // }
            // console.log(`Shuffled top channels`);

            // Return only the shuffled channel IDs
            return topChannels.map(channel => channel.channelId);

        } catch (error) {
            parseError(error, `Error occurred while fetching dialogs`, true);
            return [];
        }
    }

    async sendMessageToChannel(mobile: string, channelInfo: IChannel, message: SendMessageParams) {
        const tgManager = this.getClient(mobile);
        try {
            if (tgManager?.client) {
                const stats = this.mobileStats.get(mobile);
                if (stats.sleepTime < Date.now()) {
                    // console.log(`${mobile} Sending Message: to ${channelInfo.channelId} || @${channelInfo.username}`);
                    const result = await tgManager.client.sendMessage(channelInfo.username ? `@${channelInfo.username}` : channelInfo.channelId, message);
                    if (result) {
                        await sendToLogs({ message: `${mobile}:\n@${channelInfo.username} ✅\nfailCount:  ${stats.failCount}\nLastMsg:  ${((Date.now() - stats.lastMessageTime) / 60000).toFixed(2)}mins\nDaysLeft:  ${stats.daysLeft}\nChannelIndex: ${this.channelIndex}` });
                        this.mobileStats.set(mobile, { ...stats, lastMessageTime: Date.now() });
                        this.lastMessageTime = Date.now();
                        await updateSuccessCount(process.env.clientId);
                        if (!this.promotionResults.has(mobile)) {
                            this.promotionResults.set(mobile, new Map());
                        }
                        this.promotionResults.get(mobile)!.set(channelInfo.channelId, { success: true });
                        return result;
                    } else {
                        console.error(`Client ${mobile}: Failed to send message to ${channelInfo.channelId} || @${channelInfo.username}`);
                        return undefined;
                    }
                } else {
                    await sendToLogs({ message: `${mobile}:\n@${channelInfo.username} ❌\nFailCount:  ${stats.failCount}\nLastMsg:  ${((Date.now() - stats.lastMessageTime) / 60000).toFixed(2)}mins\nSleeping:  ${(stats.sleepTime - Date.now()) / 60000}mins\nDaysLeft:  ${stats.daysLeft}\nReason: ${this.failureReason}\nchannelIndex: ${this.channelIndex}` });
                    console.log(`Client ${mobile}: Sleeping for ${stats.sleepTime / 1000} seconds due to rate limit.`);
                    return undefined;
                }
            } else {
                console.log("client Destroyed while promotions", mobile);
                await fetchWithTimeout(`${ppplbot()}&text=@${(process.env.clientId).toUpperCase()}: ${mobile}: Client Does not exist.`);
                return undefined;
            }
        } catch (error) {
            await updateFailedCount(process.env.clientId);
            if (!this.promotionResults.has(mobile)) {
                this.promotionResults.set(mobile, new Map());
            }
            this.promotionResults.get(mobile)!.set(channelInfo.channelId, { success: false, errorMessage: error.errorMessage || "UNKNOWN" });
            this.failureReason = error.errorMessage;
            if (error.errorMessage !== 'USER_BANNED_IN_CHANNEL') {
                console.log(mobile, `Some Error Occured, ${error.errorMessage}`);
            }
            if (error instanceof errors.FloodWaitError) {
                console.log(error);
                console.warn(`Client ${mobile}: Rate limited. Sleeping for ${error.seconds} seconds.`);
                const stats = this.mobileStats.get(mobile);
                this.mobileStats.set(mobile, { ...stats, sleepTime: Date.now() + (error.seconds * 1000) });
                return undefined;
            } else {
                console.error(`Client ${mobile}: Error sending message to ${channelInfo.username}: ${error.errorMessage}`);
                if (error.errorMessage === "CHANNEL_PRIVATE") {
                    return await this.handlePrivateChannel(tgManager.client, channelInfo, message, error);
                } else {
                    return await this.handleOtherErrors(mobile, channelInfo, message, error);
                }
            }
        }
    }

    public async startPromotion() {
        console.log("promotion triggered...............");
        this.startPromoteCount++;
        if (this.startPromoteCount > 10 && this.lastMessageTime < Date.now() - 25 * 60 * 1000) {
            await fetchWithTimeout(`${ppplbot()}&text=@${(process.env.clientId).toUpperCase()}: Promotion HARD STOPPED.`);
            this.isPromoting = false;
            this.startPromoteCount = 0;
            this.lastMessageTime = Date.now();
            if (this.lastMessageTime < Date.now() - 30 * 60 * 1000) {
                await fetchWithTimeout(`${ppplbot()}&text=@${(process.env.clientId).toUpperCase()}: EXITTING as PROMOTION STOPPED.`);
                process.exit(0);
            }
        }

        if (this.isPromoting || this.lastMessageTime > Date.now() - 15 * 60 * 1000) {
            console.log("Already Promoting, Skipping...");
            return;
        }
        console.log(`Starting Promotion...............`);

        this.isPromoting = true;
        try {
            while (true) {
                console.log("Starting promoteInBatches...");
                await this.promoteInBatchesV2();
                console.log("promoteInBatches completed. Retrying in 10 seconds.");
                await sleep(10000); // Retry mechanism after small delay
            }
        } catch (error) {
            const errorDetails = parseError(error, "Error in promoteInBatches loop:", true);
            await sendToLogs({ message: errorDetails.message });
        } finally {
            this.isPromoting = false;
            console.log("Promotion stopped unexpectedly.");
        }
    }

    private isChannelNotSuitable(channelInfo: IChannel): boolean {
        const notPattern = new RegExp('online|realestat|propert|board|design|realt|class|PROFIT|wholesale|retail|topper|exam|motivat|medico|shop|follower|insta|traini|cms|cma|subject|currency|color|amity|game|gamin|like|earn|popcorn|TANISHUV|bitcoin|crypto|mall|work|folio|health|civil|win|casino|shop|promot|english|invest|fix|money|book|anim|angime|support|cinema|bet|predic|study|youtube|sub|open|trad|cric|quot|exch|movie|search|boost|dx|film|offer|ott|deal|quiz|academ|insti|talkies|screen|series|webser', "i");
        if (channelInfo.title?.match(notPattern) || channelInfo.username?.match(notPattern)) {
            console.log(`Channel ${channelInfo.channelId} is not suitable for promotion. Skipping...`);
            return true;
        }
        return false;
    }

    private isChannelScoreHigh(channelScore: { participantOffset: number, activeUsers: number }): boolean {
        const score = channelScore.participantOffset + channelScore.activeUsers;
        if (score > 90) {
            console.log(`Channel has high/low score of ${score}. Skipping...`);
            return true;
        }
        return false;
    }

    private async sendPromotionalMessage(mobile: string, channelInfo: IChannel): Promise<Api.Message | undefined> {
        let sentMessage: Api.Message | undefined;
        if (false && channelInfo.wordRestriction === 0) {
            const greetings = ['Hellloooo', 'Hiiiiii', 'Oyyyyyy', 'Oiiiii', 'Haaiiii', 'Hlloooo', 'Hiiii', 'Hyyyyy', 'Oyyyyye', 'Oyeeee', 'Heyyy'];
            const emojis = generateEmojis();
            const randomEmoji = getRandomEmoji();
            const hour = getCurrentHourIST();
            const isMorning = (hour > 9 && hour < 22);
            const offset = Math.floor(Math.random() * 3);
            const endMsg = pickOneMsg(['U bussy👀?', "I'm Aviilble!!😊💦", 'Trry Once!!😊💦', 'Trry Once!!😊💦', 'Waiiting fr ur mssg.....Dr!!💦', 'U Onliine?👀', "I'm Avilble!!😊", 'U Bussy??👀💦', 'U Intrstd??👀💦', 'U Awakke?👀💦', 'U therre???💦💦']);
            const msg = `**${pickOneMsg(greetings)}_._._._._._._!!**${emojis}\n.\n.\n**${endMsg}**`;
            const addon = (offset !== 1) ? `${(offset === 2) ? `**\n\n\n             TODAAY's OFFFER:\n-------------------------------------------\n𝗩𝗲𝗱𝗶𝗼 𝗖𝗮𝗹𝗹 𝗗𝗲𝗺𝗼 𝗔𝘃𝗶𝗹𝗯𝗹𝗲${randomEmoji}${randomEmoji}\n𝗩𝗲𝗱𝗶𝗼 𝗖𝗮𝗹𝗹 𝗗𝗲𝗺𝗼 𝗔𝘃𝗶𝗹𝗯𝗹𝗲${randomEmoji}${randomEmoji}\n-------------------------------------------**` : `**\n\nJUST Trry Once!!😚😚\nI'm Freee Now!!${generateEmojis()}`}**` : `${generateEmojis()}`;

            sentMessage = await this.sendMessageToChannel(mobile, channelInfo, { message: `${msg}\n${addon}` });
        } else {
            // console.log(`Channel has word restriction. Selecting random available message.`);
            const randomIndex = selectRandomElements(channelInfo.availableMsgs, 1)[0] || '0';
            // console.log(`Selected Msg for ${channelInfo.channelId}, ${channelInfo.title} | ChannelIdex:${this.channelIndex} | MsgIndex: ${randomIndex}`);
            let randomAvailableMsg = this.promoteMsgs[randomIndex];
            if (!randomAvailableMsg) {
                console.log(`Random Msg Does not EXIST:  ${channelInfo.channelId}, ${channelInfo.title}: index: ${randomIndex}| msg: ${this.promoteMsgs[randomIndex]}`);
                randomAvailableMsg = "**Hiiiiiiiiiii\nHiiiiiiiiiiiiiiiiiiii\nHiii\nHiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii\nHiiiiiii**"
            }
            sentMessage = await this.sendMessageToChannel(mobile, channelInfo, { message: randomAvailableMsg });
        }
        return sentMessage;
    }

    private async handleSuccessfulMessage(mobile: string, channelId: string, sentMessage: Api.Message) {
        const stats = this.mobileStats.get(mobile);
        this.mobileStats.set(mobile, { ...stats, messagesSent: stats.messagesSent + 1, failCount: 0 });
        this.messageQueue.push({
            mobile,
            channelId,
            messageId: sentMessage.id,
            timestamp: Date.now(),
            messageIndex: 'id',
        });
        console.log(`Client ${mobile}: Message SENT to ${channelId} || channelIndex: ${this.channelIndex}`);
        // const randomBatchDelay = Math.floor(Math.random() * (this.maxDelay - this.minDelay + 1)) + this.minDelay;
        // console.log(`Sleeping for ${(randomBatchDelay / 60000).toFixed(2)} minutes`);
        // await sleep(randomBatchDelay);
    }

    public async promoteInBatchesV2() {
        this.channels = await this.fetchDialogs();
        this.channelIndex = 0;

        if (this.mobiles.length === 0) {
            console.log("No mobiles available for promotion.");
            return;
        }

        if (this.channels.length === 0) {
            console.error("No channels available for promotion.");
            return;
        }
        while (true) {
            if (this.startPromoteCount > 5 && this.lastMessageTime < Date.now() - 25 * 60 * 1000) {
                await fetchWithTimeout(`${ppplbot()}&text=@${(process.env.clientId).toUpperCase()}: Promotion SOFT STOPPED.`);
                this.startPromoteCount = 0;
                return;
            }

            if (this.channelIndex >= 190) {
                console.log("Refreshing channel list...");
                this.channels = await this.fetchDialogs();
                this.channelIndex = 0;
            }
            const healthyMobiles = await this.waitForHealthyMobilesEventDriven();
            if (!healthyMobiles || healthyMobiles.length === 0) {
                console.error(`No Healthy mobiles found.`);
                await sleep(30000)
                continue;
            }
            const channelId = this.channels[this.channelIndex];
            const channelInfo = await this.getChannelInfo(channelId);

            if (!channelInfo) {
                console.error(`Channel info for ID ${channelId} not found.`);
                this.channelIndex++;
                continue;
            }

            if (channelInfo.banned || this.isChannelNotSuitable(channelInfo) || !channelInfo.username || channelInfo.username === 'undefined' || channelInfo.username === 'null') {
                console.log(`Channel ${channelId} is banned or unsuitable. Skipping...`);
                this.channelIndex++;
                continue;
            }

            let messageSent = false;

            for (const mobile of healthyMobiles) {
                try {
                    if (this.promotionResults.has(mobile) && this.promotionResults.get(mobile)!.has(channelId)) {
                        const previousResult = this.promotionResults.get(mobile)!.get(channelId);
                        if (previousResult && previousResult.success == false) {
                            console.log(`Skipping promotion for mobile ${mobile} and channel ${channelId} based on previous result.`);
                            continue;
                        }
                    }

                    if (!messageSent) {
                        const sentMessage = await this.sendPromotionalMessage(mobile, channelInfo);
                        if (sentMessage) {
                            this.handleSuccessfulMessage(mobile, channelId, sentMessage);
                            messageSent = true;
                            break;
                        } else {
                            const stats = this.mobileStats.get(mobile) || { messagesSent: 0, failedMessages: 0, sleepTime: 0, releaseTime: 0, lastMessageTime: Date.now(), daysLeft: 0, failCount: 0 };
                            this.mobileStats.set(mobile, { ...stats, failedMessages: stats.failedMessages + 1, failCount: stats.failCount + 1 });
                            if (stats.failCount > 6 || (stats.lastMessageTime < Date.now() - 15 * 60 * 1000 && stats.failCount > 0)) {
                                await sendToLogs({ message: `${mobile}:\n@${channelInfo.username} ❌\nFailCount:  ${stats.failCount}\nLastMsg:  ${((Date.now() - stats.lastMessageTime) / 60000).toFixed(2)}mins\nSleeping:  ${(stats.sleepTime - Date.now()) / 60000}mins\nDaysLeft:  ${stats.daysLeft}\nReason: ${this.failureReason}\nchannelIndex: ${this.channelIndex}` });
                            }
                        }
                    }
                } catch (error) {
                    console.error(`Error for mobile ${mobile} on channel ${channelId}:`, error);
                }
            }

            await sleep(3000); // Avoid too frequent requests
            this.channelIndex++;
        }
    }
    private waitForHealthyMobilesEventDriven(retryInterval = 30000): Promise<string[]> {
        return new Promise((resolve) => {
            const checkMobiles = async () => {
                const healthyMobiles = this.getHealthyMobiles();
                if (healthyMobiles.length > 0) {
                    console.log(`Healthy mobiles: `, healthyMobiles);
                    resolve(healthyMobiles);
                } else {
                    console.warn(`No healthy mobiles available. Retrying in ${retryInterval / 1000} seconds...`);
                    setTimeout(checkMobiles, retryInterval); // Schedule the next check without blocking
                }
            };

            checkMobiles();
        });
    }

    private updateMobileStats(mobile: string, channelId: string) {
        const stats = this.mobileStats.get(mobile) || { messagesSent: 0, failedMessages: 0, sleepTime: 0, releaseTime: 0, lastMessageTime: Date.now(), daysLeft: 0, failCount: 0 };

        stats.failedMessages += 1;
        stats.failCount += 1;
        this.mobileStats.set(mobile, stats);

        if (stats.failCount > 6) {
            sendToLogs({
                message: `${mobile}:
    @${channelId} ❌
    FailCount: ${stats.failCount}
    LastMsg: ${(Date.now() - stats.lastMessageTime) / 60000} mins
    Sleeping: ${(stats.sleepTime - Date.now()) / 60000} mins
    DaysLeft: ${stats.daysLeft}
    Reason: ${this.failureReason}
    channelIndex: ${this.channelIndex}`
            });
        }
    }


    async handlePrivateChannel(client: TelegramClient, channelInfo: IChannel, message: SendMessageParams, error: any) {
        const db = UserDataDtoCrud.getInstance();
        if (channelInfo && channelInfo.username) {
            try {
                return await client.sendMessage(channelInfo.username, message);
            } catch (err) {
                console.error(`Error retrying message for private channel ${channelInfo.username}:`, err);
                // if (err.errorMessage === "CHANNEL_PRIVATE") {
                //     await db.updateActiveChannel({ channelId: channelInfo.channelId }, { private: true });
                // }
                return undefined;
            }
        }
        return undefined;
    }

    async handleOtherErrors(mobile: string, channelInfo: IChannel, message: SendMessageParams, error: any) {
        // const db = UserDataDtoCrud.getInstance();
        // parseError(error, `Error sending message to ${channelInfo.channelId} (@${channelInfo.username}):`, false)
        if (error.errorMessage === 'USER_BANNED_IN_CHANNEL') {
            //trigger checktghealth method from  TelegramManager class
            await this.getClient(mobile).checktghealth();
            // if (!result && daysLeftForRelease() < 0) {
            //     await leaveChannel(client, channelInfo);
            // }
        } else if (error.errorMessage === 'CHAT_WRITE_FORBIDDEN') {
            console.error(`${mobile}: ${error.errorMessage}`)
            // await leaveChannel(this.client, channelInfo);
        } else {
            console.error(`${mobile}: ${error.errorMessage}`)
            // const errorDetails = parseError(error, `${mobile}`, false)
        }
        return undefined;
    }

    async calculateChannelScore(client: TelegramClient, channelInfo: IChannel, forceUsername: boolean = false): Promise<{ participantOffset: number, activeUsers: number, recentMessages: number }> {
        try {
            const entity = forceUsername && channelInfo.username ? channelInfo.username : channelInfo.channelId
            const messages = await client.getMessages(entity, { limit: 100 });
            const tenMins = 10 * 60 * 1000;
            const currentTime = Date.now();
            const recentMessages = messages.filter(
                (msg: Api.Message) => msg.senderId && currentTime - msg.date * 1000 < tenMins
            );
            const activeUsers = new Set(
                recentMessages
                    .filter((msg) => {
                        return (msg.senderId && !msg.viaBot && msg.senderId.toString() !== '609517172' && Date.now() - msg.date * 1000 < 3600000)
                    })
                    .map((msg: any) => msg.senderId),
            );

            const participantOffset = Math.floor(channelInfo.participantsCount / 2000)

            // console.log('Msgs Length:', messages.length)
            // console.log("ActiveUsers: ", activeUsers.size)
            // console.log("Engagement Score: ", engagementScore)
            // console.log("Base Score:", baseScore);
            // console.log("dYnamic threashold :", dynamicThreshold);


            // console.log(`Channel ${channelInfo.username} dynamicThreshold: ${participantOffset},participantsCount: ${channelInfo.participantsCount}`);
            return { participantOffset, activeUsers: activeUsers.size, recentMessages: recentMessages.length };
        } catch (err) {
            const errorDetails = parseError(err, `Failed to score ${channelInfo.username}`, false);
            if (errorDetails.message.includes('Could not find the input entity') && !forceUsername) {
                try {
                    console.error(`trying to join channel ${channelInfo.username}`);
                    await client.invoke(new Api.channels.JoinChannel({ channel: channelInfo.username ? `@${channelInfo.username}` : channelInfo.channelId }));
                    return await this.calculateChannelScore(client, channelInfo, true);
                } catch (error) {
                    console.error(`Failed to join channel ${channelInfo.username}:`, error.message);
                }
            }
            return { participantOffset: 0, activeUsers: 0, recentMessages: 0 };
        }
    }

    async handleDeletedMessage(channelId: string, messageIndex: string) {
        const db = UserDataDtoCrud.getInstance();
        if (messageIndex == '0') {
            console.log(`Setting channel ${channelId} as banned because messageIndex is '0'`);
            await db.updateActiveChannel({ channelId }, { banned: true });
            console.log(`Channel ${channelId} is now banned.`);
        } else {
            const result = await db.removeFromAvailableMsgs({ channelId }, messageIndex);
            console.log(`Removed message ${messageIndex} from channel ${channelId}`);
        }
    }

    async handleExistingMessage(channelId: string, messageIndex: string) {
        const db = UserDataDtoCrud.getInstance();
        console.log(`Message Existing for channelId: ${channelId}, messageIndex: ${messageIndex}`);
        if (messageIndex) {
            const result = await db.addToAvailableMsgs({ channelId }, messageIndex);
        } else {
            console.log(`No message index provided for channel ${channelId}`);
        }
    }

    async getChannelInfo(channelId: string) {
        const db = UserDataDtoCrud.getInstance();
        let channelInfo = await db.getActiveChannel({ channelId: channelId });
        if (!channelInfo) {
            channelInfo = await this.getIChannelFromTg(channelId);
            await db.updateActiveChannel({ channelId: channelId }, channelInfo);
        }
        return channelInfo
    }
    async getIChannelFromTg(channelId: string) {
        const mobile = this.selectNextMobile();
        const tgManager = this.getClient(mobile);
        const channelEnt = channelId.startsWith('-') ? channelId : `-100${channelId}`
        const { id, defaultBannedRights, title, broadcast, username, participantsCount, restricted } = <Api.Channel>await tgManager.client.getEntity(channelEnt)
        const channel = {
            channelId: id.toString()?.replace(/^-100/, ""),
            title,
            participantsCount,
            username,
            restricted,
            broadcast,
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
        }
        return channel;
    }

    public getMobileStats(): Record<string, MobileStats> {
        const result: Record<string, MobileStats> = {};
        this.mobileStats.forEach((value, key) => {
            result[key] = value;
        });
        return result;
    }

    // Method to return promotionResults as an object
    public getPromotionResults(): Record<string, Record<string, { success: boolean, errorMessage?: string }>> {
        const result: Record<string, Record<string, { success: boolean, errorMessage?: string }>> = {};
        this.promotionResults.forEach((innerMap, outerKey) => {
            result[outerKey] = {};
            innerMap.forEach((value, innerKey) => {
                result[outerKey][innerKey] = value;
            });
        });
        return result;
    }

    public async saveResultsToJson(): Promise<void> {
        try {
            const dir = path.dirname("./mobileStats.json");
            await fs.mkdir(dir, { recursive: true });
            const data = {
                mobileStats: this.getMobileStats(),
                promotionResults: this.getPromotionResults(),
            };
            await fs.writeFile("./mobileStats.json", JSON.stringify(data, null, 2), 'utf-8');
            console.log(`Results saved to mobileStats.json`);
        } catch (error) {
            console.error(`Failed to save results to ./mobileStats.json:`, error.message);
        }
    }

    // Method to import results from a JSON file
    public async importResultsFromJson(): Promise<void> {
        try {
            const rawData = await fs.readFile("./mobileStats.json", 'utf-8');
            const data = JSON.parse(rawData);

            if (!data.mobileStats || !data.promotionResults) {
                console.error("Invalid JSON format: Required keys are missing.");
            }

            // Reconstruct mobileStats
            this.mobileStats = new Map(
                Object.entries(data.mobileStats).map(([key, value]) => [key, value as MobileStats])
            );

            // Reconstruct promotionResults
            this.promotionResults = new Map(
                Object.entries(data.promotionResults).map(([outerKey, innerObj]) => [
                    outerKey,
                    new Map(
                        Object.entries(innerObj).map(([innerKey, value]) => [
                            innerKey,
                            value as { success: boolean; errorMessage?: string },
                        ])
                    ),
                ])
            );

            console.log(`Results imported from mobileStats.json`);
        } catch (error) {
            if (error.code === 'ENOENT') {
                console.error(`File not found: mobileStats.json`);
            } else if (error instanceof SyntaxError) {
                console.error(`Failed to parse JSON from mobileStats.json:`, error.message);
            } else {
                console.error(`Failed to import results from mobileStats.json:`, error.message);
            }
        }
    }

    public promotionsBannedMobiles(): string {
        const twentyMinutesAgo = Date.now() - 20 * 60 * 1000;
        const mobilesWithOldMessages: string[] = [];

        for (const mobile of this.mobiles) {
            const value = this.mobileStats.get(mobile);
            if (value.lastMessageTime && value.lastMessageTime < twentyMinutesAgo) {
                const minutesAgo = Math.floor((Date.now() - value.lastMessageTime) / (60 * 1000));
                mobilesWithOldMessages.push(`${mobile} : ${minutesAgo} mins`);
            }
        }

        console.log("Mobiles with last message time greater than 20 minutes:");
        mobilesWithOldMessages.forEach(mobile => console.log(mobile));

        return mobilesWithOldMessages.join("\n");
    }


    public clearPromtionsMap(mobile: string) {
        this.promotionResults.set(mobile, new Map);
    }
}
