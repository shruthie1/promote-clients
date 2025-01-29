import { TelegramClient, Api, errors } from "telegram";
import { UserDataDtoCrud } from "./dbservice";
import { defaultMessages, defaultReactions, generateEmojis, getCurrentHourIST, getRandomBoolean, getRandomEmoji, IChannel, ppplbot, selectRandomElements, sendToLogs, sleep, startNewUserProcess } from "./utils";
import { IClientDetails, updateFailedCount, updateSuccessCount } from "./express";
import { parseError } from "./parseError";
import { SendMessageParams } from "telegram/client/messages";
import { pickOneMsg } from "./messages";
import { fetchWithTimeout } from "./fetchWithTimeout";
import path from "path";
import * as fs from 'fs/promises';
import { PromoteQueue } from "./PromoteQueue";

interface MessageQueueItem {
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
    lastCheckedTime: number;
}

export class Promotion {
    private promotionResults: Map<string, { success: boolean, count: number, errorMessage?: string }> = new Map();
    private clientDetails: IClientDetails;
    public client: TelegramClient | null;
    private daysLeft: number = -1;
    private sleepTime: number = 0;
    public messagesSent: number = 0;
    public failedMessages: number = 0;
    public releaseTime: number = 0;
    public failCount: number = 0;
    public lastMessageTime: number = Date.now() - 16 * 60 * 1000;
    private lastCheckedTime: number = 0;
    private channels: string[] = [];
    private messageQueue: MessageQueueItem[] = [];
    private messageCheckDelay: number = 10000;
    private promoteMsgs: Record<string, any> = {};
    private channelIndex: any;
    private failureReason: any;
    private isPromoting: boolean = false;

    constructor(client: TelegramClient, clientDetails: IClientDetails) {
        this.clientDetails = clientDetails;
        this.client = client;
        console.log(clientDetails.mobile, ": Promotion Instance created")
        setInterval(() => this.checkQueuedMessages(), this.messageCheckDelay);
        const db = UserDataDtoCrud.getInstance();
        db.getPromoteMsgs().then((data) => {
            this.promoteMsgs = data;
        })
        this.importResultsFromJson();
        this.startPromotion();
    }
    setDaysLeft(daysLeft: number) {
        this.daysLeft = daysLeft
    }

    resetMobileStats() {
        this.setMobileStats(
            {
                messagesSent: 0,
                failedMessages: 0,
                sleepTime: 0,
                releaseTime: 0,
                lastMessageTime: Date.now() - 16 * 60 * 1000,
                daysLeft: -1,
                failCount: 0,
                lastCheckedTime: 0,
            }
        )
    }

    resetPromotionResults() {
        this.promotionResults = new Map();
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

    async fetchDialogs() {
        const totalBatches = 1; // Fetch three batches
        const batchSize = 500;
        const channelDataSet = new Set<string>(); // Use Set to avoid duplicates
        const channelDetails: { channelId: string; participantsCount: number }[] = [];
        console.log(`Fetching dialogs from clients...`);
        try {
            for (let batch = 0; batch < totalBatches; batch++) {
                const dialogs = await this.client.getDialogs({ limit: batchSize });

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
            const topChannels = channelDetails.slice(0, 250);
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


    async checkMessageExist(messageItem: MessageQueueItem) {
        try {
            const result = await this.client.getMessages(messageItem.channelId, { ids: messageItem.messageId });
            if (result.length > 0) {
                this.handleExistingMessage(messageItem.channelId, messageItem.messageIndex)
            } else {
                this.handleDeletedMessage(messageItem.channelId, messageItem.messageIndex)
            }
        } catch (error) {
            console.error(`Error checking message ${messageItem.messageId} in ${messageItem.channelId}: ${error.message}`);
        }
    }

    async sendMessageToChannel(mobile: string, channelInfo: IChannel, message: SendMessageParams) {
        try {
            if (this.sleepTime < Date.now()) {
                //console.log(`${mobile} Sending Message: to ${channelInfo.channelId} || @${channelInfo.username}`);
                const result = await this.client.sendMessage(channelInfo.username ? `@${channelInfo.username}` : channelInfo.channelId, message);
                if (result) {
                    await sendToLogs({ message: `${mobile}:\n@${channelInfo.username} ✅\nfailCount:  ${this.failCount}\nLastMsg:  ${((Date.now() - this.lastMessageTime) / 60000).toFixed(2)}mins\nDaysLeft:  ${this.daysLeft}\nChannelIndex: ${this.channelIndex}` });
                    this.lastMessageTime = Date.now();
                    await updateSuccessCount(process.env.clientId)
                    PromoteQueue.getInstance().push(channelInfo.channelId)
                    const stats = this.promotionResults.get(channelInfo.channelId) || { success: true, count: 0 };
                    this.promotionResults.set(channelInfo.channelId, { success: true, count: (stats.count ? stats.count : 0) + 1 });
                    return result;
                } else {
                    console.error(`Client ${mobile}: Failed to send message to ${channelInfo.channelId} || @${channelInfo.username}`);
                    return undefined;
                }
            } else {
                await sendToLogs({ message: `${mobile}:\n@${channelInfo.username} ❌\nFailCount:  ${this.failCount}\nLastMsg:  ${((Date.now() - this.lastMessageTime) / 60000).toFixed(2)}mins\nSleeping:  ${(this.sleepTime - Date.now()) / 60000}mins\nDaysLeft:  ${this.daysLeft}\nReason: ${this.failureReason}\nchannelIndex: ${this.channelIndex}` });
                console.log(`Client ${mobile}: Sleeping for ${this.sleepTime / 1000} seconds due to rate limit.`);
                return undefined;
            }

        } catch (error) {
            const stats = this.promotionResults.get(channelInfo.channelId) || { success: true, count: 0 };
            await updateFailedCount(process.env.clientId);
            this.promotionResults.set(channelInfo.channelId, { count: stats.count, success: false, errorMessage: error.errorMessage || "UNKNOWN" });
            this.failureReason = error.errorMessage;
            if (error.errorMessage !== 'USER_BANNED_IN_CHANNEL') {
                console.log(mobile, `Some Error Occured, ${error.errorMessage}`);
                if (!error.errorMessage) {
                    parseError(error, "Error sending message to channel", true);
                }
            }
            if (error instanceof errors.FloodWaitError) {
                console.log(error);
                console.warn(`Client ${mobile}: Rate limited. Sleeping for ${error.seconds} seconds.`);
                this.sleepTime = Date.now() + (error.seconds * 1000)
                return undefined;
            } else {
                console.error(`Client ${mobile}: Error sending message to ${channelInfo.username}: ${error.errorMessage}`);
                if (error.errorMessage === "CHANNEL_PRIVATE") {
                    return await this.handlePrivateChannel(this.client, channelInfo, message, error);
                } else {
                    return await this.handleOtherErrors(mobile, channelInfo, message, error);
                }
            }
        }
    }

    public async startPromotion() {
        console.log("promotion triggered...............");
        // this.startPromoteCount++;
        // if (this.startPromoteCount > 10 && this.lastMessageTime < Date.now() - 25 * 60 * 1000) {
        //     await fetchWithTimeout(`${ppplbot()}&text=@${(process.env.clientId).toUpperCase()}: Promotion HARD STOPPED.`);
        //     this.isPromoting = false;
        //     this.startPromoteCount = 0;
        //     this.lastMessageTime = Date.now();
        //     if (this.lastMessageTime < Date.now() - 30 * 60 * 1000) {
        //         await fetchWithTimeout(`${ppplbot()}&text=@${(process.env.clientId).toUpperCase()}: EXITTING as PROMOTION STOPPED.`);
        //         process.exit(0);
        //     }
        // }

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
        const randomIndex = selectRandomElements(channelInfo.availableMsgs, 1)[0] || '0';
        let endMsg = this.promoteMsgs[randomIndex] || this.promoteMsgs['0'];

        if (channelInfo.wordRestriction === 0) {
            const greetings = ['Hellloooo', 'Hiiiiii', 'Oyyyyyy', 'Oiiiii', 'Haaiiii', 'Hlloooo', 'Hiiii', 'Hyyyyy', 'Oyyyyye', 'Oyeeee', 'Heyyy'];
            const emojis = generateEmojis();
            const randomEmoji = getRandomEmoji();
            const hour = getCurrentHourIST();
            const isMorning = (hour > 9 && hour < 22);
            const offset = Math.floor(Math.random() * 3);
            const msgFlag = getRandomBoolean();
            if (msgFlag) {
                endMsg = pickOneMsg(['**U bussy👀?**', '**Trry Once!!😊💦**', '**Waiiting fr ur mssg.....Dr!!💦**', '**U Onliine?👀**', "**I'm Avilble!!😊**", '**U Intrstd??👀💦**', '**U Awakke?👀💦**', '**U therre???💦💦**']);
            }
            const addon = (offset !== 1) ? `${(offset === 2) ? `**\n\n\n             TODAAY's OFFFER:\n-------------------------------------------\n𝗩𝗲𝗱𝗶𝗼 𝗖𝗮𝗹𝗹 𝗗𝗲𝗺𝗼 𝗔𝘃𝗶𝗹𝗯𝗹𝗲${randomEmoji}${randomEmoji}\n𝗩𝗲𝗱𝗶𝗼 𝗖𝗮𝗹𝗹 𝗗𝗲𝗺𝗼 𝗔𝘃𝗶𝗹𝗯𝗹𝗲${randomEmoji}${randomEmoji}\n-------------------------------------------**` : `**\n\nI'm Freee Now!!${generateEmojis()}\nJUST Trry Once!!😚😚`}**` : endMsg;
            const msg = `**${pickOneMsg(greetings)}_._._._._._._!!**${emojis}\n\n\n\n${addon}`;
            // console.log(`Selected Msg for ${channelInfo.channelId}, ${channelInfo.title} | ChannelIdex:${this.channelIndex} | MsgIndex: ${randomIndex}`);
            sentMessage = await this.sendMessageToChannel(mobile, channelInfo, { message: `${msg}` });
        } else {
            // console.log(`Selected Msg for ${channelInfo.channelId}, ${channelInfo.title} | ChannelIdex:${this.channelIndex} | MsgIndex: ${randomIndex}`);
            // if (!randomAvailableMsg) {
            //     sendToLogs({ message: `Random Msg Does not EXIST:  ${channelInfo.channelId}, ${channelInfo.title}: index: ${randomIndex}| msg: ${this.promoteMsgs[randomIndex]}` });
            //     randomAvailableMsg = "**Hiiiiiiiiiii\nHiiiiiiiiiiiiiiiiiiii\nHiii\nHiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii\nHiiiiiii**"
            // }
            sentMessage = await this.sendMessageToChannel(mobile, channelInfo, { message: endMsg });
        }
        return sentMessage;
    }

    private async handleSuccessfulMessage(mobile: string, channelId: string, sentMessage: Api.Message) {
        this.messagesSent += 1;
        this.failCount = 0;
        this.messageQueue.push({
            channelId,
            messageId: sentMessage.id,
            timestamp: Date.now(),
            messageIndex: '0',
        });
        console.log(`Client ${mobile}: Message SENT to ${channelId} || channelIndex: ${this.channelIndex}`);
        // const randomBatchDelay = Math.floor(Math.random() * (this.maxDelay - this.minDelay + 1)) + this.minDelay;
        // console.log(`Sleeping for ${(randomBatchDelay / 60000).toFixed(2)} minutes`);
        // await sleep(randomBatchDelay);
    }

    public async promoteInBatchesV2() {
        this.channels = await this.fetchDialogs();
        this.channelIndex = 0;

        if (this.channels.length === 0) {
            console.error("No channels available for promotion.");
            return;
        }
        while (true) {
            // if (this.startPromoteCount > 5 && this.lastMessageTime < Date.now() - 25 * 60 * 1000) {
            //     await fetchWithTimeout(`${ppplbot()}&text=@${(process.env.clientId).toUpperCase()}: Promotion SOFT STOPPED.`);
            //     this.startPromoteCount = 0;
            //     return;
            // }

            if ((this.daysLeft <= 0 && this.channelIndex >= 110) || (this.daysLeft > 0 && this.channelIndex >= 230)) {
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

            if (channelInfo.banned || PromoteQueue.getInstance().contains(channelId) || this.isChannelNotSuitable(channelInfo)) {
                console.log(`Channel ${channelId} is banned or unsuitable. Skipping...`);
                this.channelIndex++;
                continue;
            }

            let messageSent = false;

            for (const mobile of healthyMobiles) {
                try {
                    const previousResult = this.promotionResults.get(channelId);
                    if (previousResult && previousResult.success == false) {
                        console.log(`Skipping promotion for mobile ${mobile} and channel ${channelId} based on previous result.`);
                        continue;
                    }

                    if (!messageSent) {
                        const sentMessage = await this.sendPromotionalMessage(mobile, channelInfo);
                        if (sentMessage) {
                            this.handleSuccessfulMessage(mobile, channelId, sentMessage);
                            messageSent = true;
                            break;
                        } else {
                            this.failCount += 1;
                            this.failedMessages += 1;
                            if (this.failCount > 6 || (this.lastMessageTime < Date.now() - 15 * 60 * 1000 && this.failCount > 0)) {
                                await sendToLogs({ message: `${mobile}:\n@${channelInfo.username} ❌\nFailCount:  ${this.failCount}\nLastMsg:  ${((Date.now() - this.lastMessageTime) / 60000).toFixed(2)}mins\nSleeping:  ${(this.sleepTime - Date.now()) / 60000}mins\nDaysLeft:  ${this.daysLeft}\nReason: ${this.failureReason}\nchannelIndex: ${this.channelIndex}` });
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

    // private updateMobileStats(mobile: string, channelId: string) {
    //     const stats = this.mobileStats.get(mobile) || { messagesSent: 0, failedMessages: 0, sleepTime: 0, releaseTime: 0, lastMessageTime: Date.now(), daysLeft: 0, failCount: 0 };

    //     this.failedMessages += 1;
    //     this.failCount += 1;
    //     this.mobileStats.set(mobile, stats);

    //     if (this.failCount > 6) {
    //         sendToLogs({
    //             message: `${mobile}:
    // @${channelId} ❌
    // FailCount: ${this.failCount}
    // LastMsg: ${(Date.now() - this.lastMessageTime) / 60000} mins
    // Sleeping: ${(this.sleepTime - Date.now()) / 60000} mins
    // DaysLeft: ${this.daysLeft}
    // Reason: ${this.failureReason}
    // channelIndex: ${this.channelIndex}`
    //         });
    //     }
    // }


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
            await this.checktghealth();
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
            const channelInfo = await db.getActiveChannel({ channelId });
            if (channelInfo.availableMsgs.length < 1) {
                console.log(`Setting channel ${channelId} as banned because messageIndex is '0'`);
                await db.updateActiveChannel({ channelId }, { banned: true });
                console.log(`Channel ${channelId} is now banned.`);
                await sendToLogs({ message: `Channel ${channelId} is now banned.` });
            }
        } else {
            const result = await db.removeFromAvailableMsgs({ channelId }, messageIndex);
            console.log(`Removed message ${messageIndex} from channel ${channelId}`);
            await sendToLogs({ message: `Removed message ${messageIndex} from channel ${channelId}` });
        }
    }

    async handleExistingMessage(channelId: string, messageIndex: string) {
        const db = UserDataDtoCrud.getInstance();
        console.log(`Message Existing for channelId: ${channelId}, messageIndex: ${messageIndex}`);
        if (messageIndex) {
            const result = await db.updateActiveChannel({ channelId }, { lastMessageTime: Date.now() });
        } else {
            console.log(`No message index provided for channel ${channelId}`);
        }
    }

    async getChannelInfo(channelId: string) {
        const db = UserDataDtoCrud.getInstance();
        let channelInfo = await db.getActiveChannel({ channelId: channelId });
        if (!channelInfo) {
            await sendToLogs({ message: `Channel ${channelId} not found in DB. Fetching from Telegram...` });
            channelInfo = await this.getIChannelFromTg(channelId);
            await db.updateActiveChannel({ channelId: channelId }, channelInfo);
        }
        return channelInfo
    }
    async getIChannelFromTg(channelId: string) {

        const channelEnt = channelId.startsWith('-') ? channelId : `-100${channelId}`
        const { id, defaultBannedRights, title, broadcast, username, participantsCount, restricted } = <Api.Channel>await this.client.getEntity(channelEnt)
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
            availableMsgs: defaultMessages,
            dMRestriction: 0,
            banned: false,
            reactions: defaultReactions,
            reactRestricted: false,
            wordRestriction: 0
        }
        return channel;
    }

    public getMobileStats(): MobileStats {
        return {
            messagesSent: this.messagesSent,
            failedMessages: this.failedMessages,
            sleepTime: this.sleepTime,
            releaseTime: this.releaseTime,
            lastMessageTime: this.lastMessageTime,
            daysLeft: this.daysLeft,
            failCount: this.failCount,
            lastCheckedTime: this.lastCheckedTime
        };
    }

    //logic to set the mobileStats
    public setMobileStats(mobileStats: MobileStats) {
        this.messagesSent = mobileStats.messagesSent;
        this.failedMessages = mobileStats.failedMessages;
        this.sleepTime = mobileStats.sleepTime;
        this.releaseTime = mobileStats.releaseTime;
        this.lastMessageTime = mobileStats.lastMessageTime;
        this.daysLeft = mobileStats.daysLeft;
        this.failCount = mobileStats.failCount;
        this.lastCheckedTime = mobileStats.lastCheckedTime;
    }

    public getPromotionResults(): Record<string, { success: boolean, errorMessage?: string }> {
        const result: Record<string, { success: boolean, errorMessage?: string }> = {};
        for (const [key, value] of this.promotionResults) {
            result[key] = value;
        }
        return result;
    }

    //logic to set the promotionResults
    public setPromotionResults(promotionResults: Record<string, { success: boolean, errorMessage?: string, count: number }>) {
        this.promotionResults = new Map(Object.entries(promotionResults));
    }

    public async saveResultsToJson(): Promise<void> {
        try {
            const dir = path.dirname(`./mobileStats-${this.clientDetails.mobile}.json`);
            await fs.mkdir(dir, { recursive: true });
            const data = {
                mobileStats: this.getMobileStats(),
                promotionResults: this.getPromotionResults(),
            };
            await fs.writeFile(`./mobileStats-${this.clientDetails.mobile}.json`, JSON.stringify(data, null, 2), 'utf-8');
            console.log(`Results saved to mobileStats-${this.clientDetails.mobile}.json`);
        } catch (error) {
            console.error(`Failed to save results to ./mobileStats.json:`, error.message);
        }
    }

    // Method to import results from a JSON file
    public async importResultsFromJson(): Promise<void> {
        try {
            const rawData = await fs.readFile(`./mobileStats-${this.clientDetails.mobile}.json`, 'utf-8');
            const data = JSON.parse(rawData);

            if (!data.mobileStats || !data.promotionResults) {
                console.error("Invalid JSON format: Required keys are missing.");
            }
            this.setMobileStats(data.mobileStats);
            this.setPromotionResults(data.promotionResults);
            console.log(`Results imported from ./mobileStats-${this.clientDetails.mobile}.json`);
        } catch (error) {
            if (error.code === 'ENOENT') {
                console.error(`File not found: ./mobileStats-${this.clientDetails.mobile}.json`);
            } else if (error instanceof SyntaxError) {
                console.error(`Failed to parse JSON from ./mobileStats-${this.clientDetails.mobile}.json:`, error.message);
            } else {
                console.error(`Failed to import results from ./mobileStats-${this.clientDetails.mobile}.json:`, error.message);
            }
        }
    }

    private getHealthyMobiles() {
        if (this.daysLeft < 7 && ((this.lastMessageTime < Date.now() - 12 * 60 * 1000 && this.daysLeft < 1) || (this.lastMessageTime < Date.now() - 3 * 60 * 1000 && this.daysLeft > 0)) && this.sleepTime < Date.now()) {
            return [this.clientDetails.mobile]
        }
        else {
            return []
        }
    }

    async checktghealth(force: boolean = false) {
        if ((this.lastCheckedTime < (Date.now() - 120 * 60 * 1000)) || force) {//&& daysLeftForRelease() < 0) {
            this.lastCheckedTime = Date.now();
            try {
                if (this.client) {
                    await this.client.sendMessage('@spambot', { message: '/start' })
                } else {
                    //console.log("instanse not exist")
                }
            } catch (error) {
                parseError(error, `CheckHealth in Tg: ${this.clientDetails?.mobile}`)
                await startNewUserProcess(error, this.clientDetails.mobile)
                try {
                    await this.client.invoke(
                        new Api.contacts.Unblock({
                            id: '178220800'
                        })
                    );
                } catch (error) {
                    parseError(error, this.clientDetails?.mobile)
                    await startNewUserProcess(error, this.clientDetails.mobile)
                }
                await fetchWithTimeout(`${ppplbot()}&text=@${(process.env.clientId).toUpperCase()}-PROM: Failed To Check Health`);
            }
            return true;
        }
        return false
    }

}

