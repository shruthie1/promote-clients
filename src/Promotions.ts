import { TelegramClient, Api, errors } from "telegram";
import { UserDataDtoCrud } from "./dbservice";
import { generateEmojis, getCurrentHourIST, getRandomEmoji, IChannel, ppplbot, selectRandomElements, sendToLogs, sleep } from "./utils";
import { updateFailedCount, updateSuccessCount } from "./express";
import { parseError } from "./parseError";
import { SendMessageParams } from "telegram/client/messages";
import { pickOneMsg } from "./messages";
import { fetchWithTimeout } from "./fetchWithTimeout";
import TelegramManager from "./TelegramManager";

interface MessageQueueItem {
    channelId: string;
    messageId: number;
    timestamp: number;
    messageIndex: string;
}

export class Promotion {
    private lastMessageTime: number = 0;
    private daysLeft: number = -1
    private sleepTime = 0;
    private channels: string[];
    private minDelay: number = 170000;
    private maxDelay: number = 200000;
    private messageQueue: MessageQueueItem[] = []
    private messageCheckDelay: number = 20000;
    private promoteMsgs = {};
    private tgManager: TelegramManager;
    private failCount: number = 0;
    private channelIndex = 0; // Add channelIndex as an instance private member
    private failureReason = 'UNKNOWN';
    private isPromoting: boolean = false;
    private mobile: string;

    public constructor(tgManager: TelegramManager) {
        console.log("Promotion Instance created");
        this.tgManager = tgManager;
        this.mobile = tgManager.clientDetails.mobile;
        setInterval(() => this.checkQueuedMessages(), this.messageCheckDelay);
        const db = UserDataDtoCrud.getInstance();
        db.getPromoteMsgs().then((data) => {
            this.promoteMsgs = data;
        });
        this.tgManager.on('setDaysLeft', this.setDaysLeft.bind(this));
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

    setDaysLeft(data: { daysLeft: number }) {
        console.log("Setting DaysLeft:", data.daysLeft)
        this.daysLeft = data.daysLeft;
    }

    getDaysLeft() {
        return this.daysLeft;
    }

    getLastMessageTime() {
        return this.lastMessageTime;
    }

    async checkMessageExist(messageItem: MessageQueueItem) {
        try {
            const result = await this.tgManager.client.getMessages(messageItem.channelId, { ids: messageItem.messageId });
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
        const batchSize = 500;
        const channelDataSet = new Set<string>(); // Use Set to avoid duplicates
        const channelDetails: { channelId: string; participantsCount: number }[] = [];
        console.log(`Fetching dialogs from clients...`);
        try {
            for (let batch = 0; batch < totalBatches; batch++) {
                console.log(`Fetching dialogs for mobile: ${this.mobile}`);
                const client = this.tgManager?.client;

                if (!client) {
                    console.warn(`Client not available for mobile: ${this.mobile}`);
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

            // // Fisher-Yates Shuffle on top 250
            // const topChannels = channelDetails.slice(0, 250);
            // for (let i = topChannels.length - 1; i > 0; i--) {
            //     const j = Math.floor(Math.random() * (i + 1));
            //     [topChannels[i], topChannels[j]] = [topChannels[j], topChannels[i]];
            // }
            // console.log(`Shuffled top channels`);

            // Return only the shuffled channel IDs
            return channelDetails.map(channel => channel.channelId);

        } catch (error) {
            parseError(error, `Error occurred while fetching dialogs`, true);
            return [];
        }
    }

    async sendMessageToChannel(channelInfo: IChannel, message: SendMessageParams) {
        try {
            if (this.tgManager?.client) {
                await this.tgManager.client.invoke(
                    new Api.messages.SetTyping({
                        peer: channelInfo.username,
                        action: new Api.SendMessageTypingAction(),
                    })
                );
                await sleep(2000);
                if (this.sleepTime < Date.now()) {
                    console.log(`Sending Message: ${message.message}`);
                    const result = await this.tgManager.client.sendMessage(channelInfo.username ? `@${channelInfo.username}` : channelInfo.channelId, message);
                    if (result) {
                        await sendToLogs({ message: `${this.mobile}:\n@${channelInfo.username} ✅\nfailCount:  ${this.failCount}\nLastMsg:  ${((Date.now() - this.lastMessageTime) / 60000).toFixed(2)}mins\nDaysLeft:  ${this.daysLeft}\nChannelIndex: ${this.channelIndex}` });
                        this.lastMessageTime = Date.now()
                        await updateSuccessCount(process.env.clientId);
                        return result;
                    } else {
                        console.error(`Client ${this.mobile}: Failed to send message to ${channelInfo.channelId} || @${channelInfo.username}`);
                        return undefined;
                    }
                } else {
                    console.log(`Client ${this.mobile}: Sleeping for ${this.sleepTime / 1000} seconds due to rate limit.`);
                    return undefined;
                }
            } else {
                console.log("client Destroyed while promotions", this.mobile);
                await fetchWithTimeout(`${ppplbot()}&text=@${(process.env.clientId).toUpperCase()}: ${this.mobile}: Client Destroyed.`);
                return undefined;
            }
        } catch (error) {
            await updateFailedCount(process.env.clientId);
            this.failureReason = error.errorMessage;
            if (error.errorMessage !== 'USER_BANNED_IN_CHANNEL') {
                console.log(this.mobile, `Some Error Occured, ${error.errorMessage}`);
            }
            if (error instanceof errors.FloodWaitError) {
                console.log(error);
                console.warn(`Client ${this.mobile}: Rate limited. Sleeping for ${error.seconds} seconds.`);
                this.sleepTime = Date.now() + (error.seconds * 1000); // Set the sleep time for the specific client
                return undefined;
            } else {
                console.error(`Client ${this.mobile}: Error sending message to ${channelInfo.username}: ${error.errorMessage}`);
                if (error.errorMessage === "CHANNEL_PRIVATE") {
                    return await this.handlePrivateChannel(this.tgManager.client, channelInfo, message, error);
                } else {
                    return await this.handleOtherErrors(this.mobile, channelInfo, message, error);
                }
            }
        }
    }

    public async startPromotion() {
        if (this.isPromoting) {
            return;
        }
        this.isPromoting = true;
        try {
            while (true) {
                console.log("Starting promoteInBatches...");
                await this.promoteInBatches();
                console.log("promoteInBatches completed. Retrying in 10 seconds.");
                await sleep(10000); // Retry mechanism after small delay
            }
        } catch (error) {
            console.error("Error in promoteInBatches loop:", error);
        } finally {
            this.isPromoting = false;
            console.log("Promotion stopped unexpectedly.");
        }
    }

    public async promoteInBatches() {
        this.channels = await this.fetchDialogs();
        this.channelIndex = 0; // Initialize channelIndex
        if (this.channels.length > 0) {
            while (this.channelIndex < this.channels.length) {
                try {
                    if (this.channelIndex > 100) {
                        await this.refreshChannelList();
                        continue;
                    }

                    const channelId = this.channels[this.channelIndex];
                    const channelInfo = await this.getChannelInfo(channelId);

                    if (!channelInfo || channelInfo.banned || this.isChannelNotSuitable(channelInfo)) {
                        this.channelIndex++;
                        continue;
                    }

                    const client = this.tgManager?.client;
                    if (!client) {
                        console.error(`Client is undefined for mobile ${this.mobile}. Stopping promotion.`);
                        break;
                    }

                    const channelScore = await this.calculateChannelScore(client, channelInfo);
                    if (this.isLowScore(channelScore)) {
                        this.channelIndex++;
                        continue;
                    }

                    const sentMessage = await this.sendPromotionMessage(channelInfo);
                    if (sentMessage) {
                        await this.handleSuccessfulMessage(channelId, sentMessage);
                    } else {
                        await this.handleFailedMessage(channelInfo, channelScore);
                    }
                    this.channelIndex++;
                } catch (error) {
                    console.error(`Error in promoteInBatches for mobile ${this.mobile}:`, error);
                    await sleep(30000);
                }
            }
        } else {
            console.error(`No channels available for promotion.`);
        }

        await this.sendFailureAlert();
    }

    private async refreshChannelList() {
        console.log("Refreshing channel list after reaching index 100...");
        this.channels = await this.fetchDialogs();
        this.channelIndex = 0;
    }

    private isChannelNotSuitable(channelInfo: IChannel): boolean {
        const notPattern = new RegExp('online|board|class|PROFIT|wholesale|retail|topper|exam|motivat|medico|shop|follower|insta|traini|cms|cma|subject|currency|color|amity|game|gamin|like|earn|popcorn|TANISHUV|bitcoin|crypto|mall|work|folio|health|civil|win|casino|shop|promot|english|invest|fix|money|book|anim|angime|support|cinema|bet|predic|study|youtube|sub|open|trad|cric|quot|exch|movie|search|film|offer|ott|deal|quiz|boost|dx|academ|insti|talkies|screen|series|webser', "i");
        if (channelInfo.title?.match(notPattern) || channelInfo.username?.match(notPattern)) {
            console.log(`Channel ${channelInfo.channelId} is not suitable for promotion. Skipping...`);
            return true;
        }
        return false;
    }

    private isLowScore(channelScore: { participantOffset: number, activeUsers: number, recentMessages: number }): boolean {
        const score = channelScore.participantOffset + channelScore.activeUsers;
        if (score < 25) {
            console.log(`Channel has low score of ${score}. Skipping...`);
            return true;
        }
        return false;
    }

    private async sendPromotionMessage(channelInfo: IChannel): Promise<Api.Message | undefined> {
        let sentMessage: Api.Message | undefined;
        if (channelInfo.wordRestriction === 0) {
            sentMessage = await this.sendUnrestrictedMessage(channelInfo);
        } else {
            sentMessage = await this.sendRestrictedMessage(channelInfo);
        }
        return sentMessage;
    }

    private async sendUnrestrictedMessage(channelInfo: IChannel): Promise<Api.Message | undefined> {
        const greetings = ['Hellloooo', 'Hiiiiii', 'Oyyyyyy', 'Oiiiii', 'Haaiiii', 'Hlloooo', 'Hiiii', 'Hyyyyy', 'Oyyyyye', 'Oyeeee', 'Heyyy'];
        const emojis = generateEmojis();
        const randomEmoji = getRandomEmoji();
        const hour = getCurrentHourIST();
        const offset = Math.floor(Math.random() * 3);
        const endMsg = pickOneMsg(['U bussy👀?', "I'm Aviilble!!😊💦", 'Trry Once!!😊💦', 'Trry Once!!😊💦', 'Waiiting fr ur mssg.....Dr!!💦', 'U Onliine?👀', "I'm Avilble!!😊", 'U Bussy??👀💦', 'U Intrstd??👀💦', 'U Awakke?👀💦', 'U therre???💦💦']);
        const msg = `**${pickOneMsg(greetings)}_._._._._._._!!**${emojis}\n.\n.\n**${endMsg}**`;
        const addon = (offset !== 1) ? `${(offset === 2) ? `**\n\n\n             TODAAY's OFFFER:\n-------------------------------------------\n𝗩𝗲𝗱𝗶𝗼 𝗖𝗮𝗹𝗹 𝗗𝗲𝗺𝗼 𝗔𝘃𝗶𝗹𝗯𝗹𝗲${randomEmoji}${randomEmoji}\n𝗩𝗲𝗱𝗶𝗼 𝗖𝗮𝗹𝗹 𝗗𝗲𝗺𝗼 𝗔𝘃𝗶𝗹𝗯𝗹𝗲${randomEmoji}${randomEmoji}\n-------------------------------------------**` : `**\n\nJUST Trry Once!!😚😚\nI'm Freee Now!!${generateEmojis()}`}**` : `${generateEmojis()}`;

        return await this.sendMessageToChannel(channelInfo, { message: `${msg}\n${addon}` });
    }

    private async sendRestrictedMessage(channelInfo: IChannel): Promise<Api.Message | undefined> {
        const randomIndex = selectRandomElements(channelInfo.availableMsgs, 1)[0] || '0';
        console.log(`Selected Msg for ${channelInfo.channelId}, ${channelInfo.title} | ChannelIndex:${this.channelIndex} | MsgIndex: ${randomIndex}`);
        let randomAvailableMsg = this.promoteMsgs[randomIndex];
        if (!randomAvailableMsg) {
            console.log(`Random Msg Does not EXIST:  ${channelInfo.channelId}, ${channelInfo.title}: index: ${randomIndex}| msg: ${this.promoteMsgs[randomIndex]}`);
            randomAvailableMsg = "**Hiiiiii**";
        }
        return await this.sendMessageToChannel(channelInfo, { message: randomAvailableMsg });
    }

    private async handleSuccessfulMessage(channelId: string, sentMessage: Api.Message) {
        if (this.failCount > 0) {
            this.channels.splice(this.channelIndex, 1);
            this.failCount = 0;
        }
        if (this.daysLeft == 0) {
            this.daysLeft = -1;
        }
        this.messageQueue.push({
            channelId,
            messageId: sentMessage.id,
            timestamp: Date.now(),
            messageIndex: 'id',
        });
        console.log(`Client ${this.mobile}: Message SENT to ${channelId} || channelIndex: ${this.channelIndex}`);
        const randomBatchDelay = Math.floor(Math.random() * (this.maxDelay - this.minDelay + 1)) + this.minDelay;
        console.log(`Sleeping for ${(randomBatchDelay / 60000).toFixed(2)} minutes`);
        await sleep(randomBatchDelay);
    }

    private async handleFailedMessage(channelInfo: IChannel, channelScore: { participantOffset: number, activeUsers: number, recentMessages: number }) {
        console.warn(`Message sending failed for channel: ${channelInfo.username || channelInfo.channelId}`);
        if (this.failCount < 5 && this.daysLeft > -1) {
            console.log(`Retrying after a short delay. Fail count: ${this.failCount}`);
            const randomDelay = Math.floor(Math.random() * (5000 - 3000)) + 3000;
            this.failCount++;
            await sleep(randomDelay);
        } else {
            console.log(`Long sleeping after ${this.failCount} consecutive failures.`);
            const randomDelay = Math.floor(Math.random() * (this.maxDelay - this.minDelay + 1)) + this.minDelay;
            console.log(`Sleeping for ${(randomDelay / 60000).toFixed(2)} Mins`);
            await sendToLogs({ message: `${this.mobile}:\n@${channelInfo.username} ❌\nFailCount:  ${this.failCount}\nLastMsg:  ${((Date.now() - this.lastMessageTime) / 60000).toFixed(2)}mins\nSleeping:  ${(randomDelay / 60000).toFixed(2)} Mins\nDaysLeft:  ${this.daysLeft}\nReason: ${this.failureReason}\nchannelIndex: ${this.channelIndex}\nchannelScore: ${channelScore}` });
            this.failCount = 0;
            await sleep(randomDelay);
        }
    }

    private async sendFailureAlert() {
        console.log("Sending failure alert...");
        await fetchWithTimeout(`${ppplbot()}&text=@${(process.env.clientId).toUpperCase()}: Issue with Promotions`);
        setTimeout(() => {
            console.log("Issue with Promotions. Restarting client...");
            this.startPromotion();
        }, 300000);
    }
    async handlePrivateChannel(client: TelegramClient, channelInfo: IChannel, message: SendMessageParams, error: any) {
        const db = UserDataDtoCrud.getInstance();
        if (channelInfo && channelInfo.username) {
            try {
                return await client.sendMessage(channelInfo.username, message);
            } catch (err) {
                console.error(`Error retrying message for private channel ${channelInfo.username}:`, err);
                if (err.errorMessage === "CHANNEL_PRIVATE") {
                    await db.updateActiveChannel({ channelId: channelInfo.channelId }, { private: true });
                }
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
            await this.tgManager.checktghealth();
            // if (!result && daysLeftForRelease() < 0) {
            //     await leaveChannel(client, channelInfo);
            // }
        } else if (error.errorMessage === 'CHAT_WRITE_FORBIDDEN') {
            console.log(`${mobile}: ${error.errorMessage}`)
            // await leaveChannel(this.client, channelInfo);
        } else {
            const errorDetails = parseError(error, `${mobile}`, false)
        }
        return undefined;
    }

    async calculateChannelScore(client: TelegramClient, channelInfo: IChannel, forceUsername: boolean = false): Promise<{ participantOffset: number, activeUsers: number, recentMessages: number }> {
        try {
            const entity = forceUsername && channelInfo.username ? channelInfo.username : channelInfo.channelId
            const messages = await client.getMessages(entity, { limit: 100, });
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


            console.log(`Channel ${channelInfo.username} dynamicThreshold: ${participantOffset},participantsCount: ${channelInfo.participantsCount}`);
            return { participantOffset, activeUsers: activeUsers.size, recentMessages: recentMessages.length };
        } catch (err) {
            const errorDetails = parseError(err, `Failed to score ${channelInfo.username}`, false);
            if (errorDetails.message.includes('Could not find the input entity')) {
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
        const channelEnt = channelId.startsWith('-') ? channelId : `-100${channelId}`
        const { id, defaultBannedRights, title, broadcast, username, participantsCount, restricted } = <Api.Channel>await this.tgManager.client.getEntity(channelEnt)
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
}

