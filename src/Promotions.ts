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
    mobile: string;
    channelId: string;
    messageId: number;
    timestamp: number;
    messageIndex: string;
}

export class Promotion {
    private limitControl: Map<string, { daysLeft: number; lastMessageTime: number }> = new Map<string, { daysLeft: number, lastMessageTime: number }>();
    private nextMobileIndex = 0; // Index for round-robin mobile selection
    private sleepTime = 0;
    private channels: string[];
    private minDelay: number = 185000;
    private maxDelay: number = 240000;
    private messageQueue: MessageQueueItem[] = []
    private messageCheckDelay: number = 20000;
    private promoteMsgs = {};
    private mobiles: string[] = [];

    private getClient: (clientId: string) => TelegramManager | undefined;
    static instance: Promotion;
    private isPromoting: boolean = false;

    private constructor(mobiles: string[], getClient: (clientId: string) => TelegramManager | undefined) {
        this.mobiles = mobiles;
        this.getClient = getClient;
        console.log("Promotion Instance created");
        setInterval(() => this.checkQueuedMessages(), this.messageCheckDelay);
        const db = UserDataDtoCrud.getInstance();
        db.getPromoteMsgs().then((data) => {
            this.promoteMsgs = data;
        });
        for (const mobile of mobiles) {
            this.limitControl.set(mobile, { daysLeft: -1, lastMessageTime: Date.now() - 5 * 60 * 1000 });
        }
    }

    public setMobiles(mobiles: string[]) {
        console.log("Setting Mobiles in Promotion instance", mobiles.length);
        this.mobiles = mobiles;
        for (const mobile of mobiles) {
            if (!this.limitControl.has(mobile)) {
                this.limitControl.set(mobile, { daysLeft: -1, lastMessageTime: Date.now() - 5 * 60 * 1000 });
            }
        }
    }
    public static getInstance(mobiles: string[], getClient: (clientId: string) => TelegramManager | undefined): Promotion {
        if (!Promotion.instance) {
            Promotion.instance = new Promotion(mobiles, getClient);
        }
        return Promotion.instance;
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

    setDaysLeft(mobile: string, daysLeft: number) {
        console.log("Setting DaysLeft:", daysLeft)
        const data = this.limitControl.get(mobile)
        this.limitControl.set(mobile, { ...data, daysLeft: daysLeft })
    }

    getDaysLeft(mobile: string) {
        const data = this.limitControl.get(mobile);
        return data.daysLeft;
    }

    getLastMessageTime(mobile: string) {
        const data = this.limitControl.get(mobile);
        return data.lastMessageTime;
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
        const totalBatches = 3; // Fetch three batches
        const batchSize = 150;
        const channelDataSet = new Set<string>(); // Use Set to avoid duplicates
        const channelDetails: { channelId: string; participantsCount: number }[] = [];
        console.log(`Fetching dialogs from clients...`);
        try {
            for (let batch = 0; batch < totalBatches; batch++) {
                const mobile = this.selectNextMobile(); // Rotate mobile   
                console.log(`Fetching dialogs for mobile: ${mobile}`);
                const tgManager = this.getClient(mobile);
                const client = tgManager?.client;

                if (!client) {
                    console.warn(`Client not available for mobile: ${mobile}`);
                    continue;
                }

                await client.connect();

                let offsetId = 0; // Reset offset for each mobile in this example
                const dialogs = await client.getDialogs({ limit: batchSize, offsetId });

                if (!dialogs || dialogs.length === 0) {
                    console.warn("No dialogs retrieved from the client.");
                    break;
                }

                for (const dialog of dialogs) {
                    if (dialog.isChannel || dialog.isGroup) {
                        const chatEntity = dialog.entity as Api.Channel;

                        // Extract channel information
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
            channelDetails.sort((a, b) => b.participantsCount - a.participantsCount);
            console.log(`Sorted channels by participants count: ${channelDetails.length}`);

            // Fisher-Yates Shuffle on top 250
            const topChannels = channelDetails.slice(0, 250);
            for (let i = topChannels.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [topChannels[i], topChannels[j]] = [topChannels[j], topChannels[i]];
            }
            console.log(`Shuffled top channels`);

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
                await tgManager.client.invoke(
                    new Api.messages.SetTyping({
                        peer: channelInfo.username,
                        action: new Api.SendMessageTypingAction(),
                    })
                );
                await sleep(2000);
                if (this.sleepTime < Date.now()) {
                    console.log(`Sending Message: ${message.message}`);
                    const result = await tgManager.client.sendMessage(channelInfo.username ? `@${channelInfo.username}` : channelInfo.channelId, message);
                    if (result) {
                        const data = this.limitControl.get(mobile);
                        await sendToLogs({ message: `${mobile}:\n@${channelInfo.username} ✅\nLastMsg:  ${((Date.now() - data.lastMessageTime) / 60000).toFixed(2)}mins\nDaysLeft:  ${data.daysLeft}` });
                        this.limitControl.set(mobile, { ...data, lastMessageTime: Date.now() });
                        await updateSuccessCount(process.env.clientId);
                        return result;
                    } else {
                        console.error(`Client ${mobile}: Failed to send message to ${channelInfo.channelId} || @${channelInfo.username}`);
                        return undefined;
                    }
                } else {
                    console.log(`Client ${mobile}: Sleeping for ${this.sleepTime / 1000} seconds due to rate limit.`);
                    return undefined;
                }
            } else {
                console.log("client Destroyed while promotions", mobile);
                await fetchWithTimeout(`${ppplbot()}&text=@${(process.env.clientId).toUpperCase()}: ${mobile}: Client Destroyed.`);
                return undefined;
            }
        } catch (error) {
            await updateFailedCount(process.env.clientId);
            if (error.errorMessage !== 'USER_BANNED_IN_CHANNEL') {
                console.log(mobile, `Some Error Occured, ${error.errorMessage}`);
            }
            if (error instanceof errors.FloodWaitError) {
                console.log(error);
                console.warn(`Client ${mobile}: Rate limited. Sleeping for ${error.seconds} seconds.`);
                this.sleepTime = Date.now() + (error.seconds * 1000); // Set the sleep time for the specific client
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
        let channelIndex = 0;
        let mobile = this.selectNextMobile();
        let failCount = 0;

        if (mobile && this.mobiles.length > 0) {
            if (this.channels.length > 0) {
                while (true) {
                    if (mobile) {
                        try {

                            if (channelIndex > 100) {
                                console.log("Refreshing channel list after reaching index 190...");
                                this.channels = await this.fetchDialogs();
                                channelIndex = 0;
                                continue;
                            }
                            let randomIndex = '0'

                            const channelId = this.channels[channelIndex];
                            const channelInfo = await this.getChannelInfo(channelId);

                            if (!channelInfo) {
                                console.error(`Channel info for ID ${channelId} not found.`);
                                channelIndex++;
                                continue;
                            }
                            const notPattern = new RegExp('online|board|class|PROFIT|wholesale|retail|topper|exam|motivat|medico|shop|follower|insta|traini|cms|cma|subject|currency|color|amity|game|gamin|like|earn|popcorn|TANISHUV|bitcoin|crypto|mall|work|folio|health|civil|win|casino|shop|promot|english|invest|fix|money|book|anim|angime|support|cinema|bet|predic|study|youtube|sub|open|trad|cric|quot|exch|movie|search|film|offer|ott|deal|quiz|boost|dx|academ|insti|talkies|screen|series|webser', "i")
                            //make sure to add the channel title or username is not in the notPattern
                            if (channelInfo.title?.match(notPattern) || channelInfo.username?.match(notPattern)) {
                                console.log(`Channel ${channelId} is not suitable for promotion. Skipping...`);
                                channelIndex++;
                                continue;
                            }
                            if (!channelInfo.banned) {

                                let sentMessage: Api.Message;
                                if (channelInfo.wordRestriction === 0) {
                                    // console.log(`Preparing unrestricted promotional message for channel: ${channelInfo.username}`);
                                    const greetings = ['Hellloooo', 'Hiiiiii', 'Oyyyyyy', 'Oiiiii', 'Haaiiii', 'Hlloooo', 'Hiiii', 'Hyyyyy', 'Oyyyyye', 'Oyeeee', 'Heyyy'];
                                    const emojis = generateEmojis();
                                    const randomEmoji = getRandomEmoji();
                                    const hour = getCurrentHourIST();
                                    const isMorning = (hour > 9 && hour < 22);
                                    const offset = Math.floor(Math.random() * 3);
                                    const endMsg = pickOneMsg(['U bussy👀?', "I'm Aviilble!!😊💦", 'Trry Once!!😊💦', 'Trry Once!!😊💦', 'Waiiting fr ur mssg.....Dr!!💦', 'U Onliine?👀', "I'm Avilble!!😊", 'U Bussy??👀💦', 'U Intrstd??👀💦', 'U Awakke?👀💦', 'U therre???💦💦']);
                                    const msg = `**${pickOneMsg(greetings)}_._._._._._._!!**${emojis}\n.\n.\n**${endMsg}**`;
                                    const addon = (offset !== 1) ? `${(offset === 2) ? `**\n\n\n             TODAAY's OFFFER:\n-------------------------------------------\n𝗩𝗲𝗱𝗶𝗼 𝗖𝗮𝗹𝗹 𝗗𝗲𝗺𝗼 𝗔𝘃𝗶𝗹𝗯𝗹𝗲${randomEmoji}${randomEmoji}\n𝗩𝗲𝗱𝗶𝗼 𝗖𝗮𝗹𝗹 𝗗𝗲𝗺𝗼 𝗔𝘃𝗶𝗹𝗯𝗹𝗲${randomEmoji}${randomEmoji}\n-------------------------------------------**` : `**\n\nJUST Trry Once!!😚😚\nI'm Freee Now!!${generateEmojis()}`}**` : `${generateEmojis()}`;

                                    // console.log(`Sending message: ${msg}\nAddon: ${addon}`);
                                    sentMessage = await this.sendMessageToChannel(mobile, channelInfo, { message: `${msg}\n${addon}` });
                                } else {
                                    // console.log(`Channel has word restriction. Selecting random available message.`);
                                    randomIndex = selectRandomElements(channelInfo.availableMsgs, 1)[0] || '0';
                                    console.log(`Selected Msg for ${channelId}, ${channelInfo.title} | ChannelIdex:${channelIndex} | MsgIndex: ${randomIndex}`);
                                    let randomAvailableMsg = this.promoteMsgs[randomIndex];
                                    if (!randomAvailableMsg) {
                                        console.log(`Random Msg Does not EXIST:  ${channelId}, ${channelInfo.title}: index: ${randomIndex}| msg: ${this.promoteMsgs[randomIndex]}`);
                                        randomAvailableMsg = "**Hiiiiii**"
                                    }
                                    sentMessage = await this.sendMessageToChannel(mobile, channelInfo, { message: randomAvailableMsg });
                                }

                                if (sentMessage) {
                                    failCount = 0;
                                    this.messageQueue.push({
                                        mobile,
                                        channelId,
                                        messageId: sentMessage.id,
                                        timestamp: Date.now(),
                                        messageIndex: randomIndex,
                                    });
                                    console.log(`Client ${mobile}: Message SENT to ${channelInfo.channelId} || @${channelInfo.username}`);
                                    const randomBatchDelay = Math.floor(Math.random() * (this.maxDelay - this.minDelay + 1)) + this.minDelay;
                                    console.log(`Sleeping for ${(randomBatchDelay / 60000).toFixed(2)} minutes`);
                                    await sleep(randomBatchDelay);
                                    mobile = this.selectNextMobile();
                                } else {
                                    console.warn(`Message sending failed for channel: ${channelInfo.username || channelId}`);
                                    const floodData = this.limitControl.get(mobile)
                                    if (failCount < 3 && floodData.daysLeft >= 0) {
                                        console.log(`Retrying after a short delay. Fail count: ${failCount}`);
                                        const randomDelay = Math.floor(Math.random() * (30000 - 10000)) + 10000;
                                        await sendToLogs({ message: `${mobile}:\n@${channelInfo.username} ❌\nFailCount:  ${failCount}\nLastMsg:  ${((Date.now() - floodData.lastMessageTime) / 60000).toFixed(2)}mins\nSleeping:  ${(randomDelay / 60000).toFixed(2)} Mins\nDaysLeft:  ${floodData.daysLeft}` });
                                        failCount++;
                                        await sleep(randomDelay);
                                    } else {
                                        console.log(`Switching mobile after ${failCount} consecutive failures.`);
                                        const randomDelay = Math.floor(Math.random() * (this.maxDelay - this.minDelay + 1)) + this.minDelay;
                                        console.log(`Sleeping for ${(randomDelay / 60000).toFixed(2)} Mins`);
                                        await sendToLogs({ message: `${mobile}:\n@${channelInfo.username} ❌\nFailCount:  ${failCount}\nLastMsg:  ${((Date.now() - floodData.lastMessageTime) / 60000).toFixed(2)}mins\nSleeping:  ${(randomDelay / 60000).toFixed(2)} Mins\nDaysLeft:  ${floodData.daysLeft}` });
                                        failCount = 0;
                                        mobile = this.selectNextMobile();
                                        await sleep(randomDelay);
                                    }
                                }
                            } else {
                                console.warn(`Channel is banned: ${channelInfo.username || channelId}`);
                            }

                            channelIndex++;
                        } catch (error) {
                            console.error(`Error in promoteInBatches for mobile ${mobile}:`, error);
                            await sleep(30000);
                        }
                    } else {
                        console.warn(`No mobile available. Retrying after delay.`);
                        await sleep(30000);
                    }
                }
            } else {
                console.error(`No channels available for promotion.`);
            }

            console.log("Sending failure alert...");
            await fetchWithTimeout(`${ppplbot()}&text=@${(process.env.clientId).toUpperCase()}: Issue with Promotions`);
            setTimeout(() => {
                console.log("Issue with Promotions. Restarting client...");
                // restartClient(mobile);
            }, 300000);
        } else {
            console.log("Mobile not availables for Starting Promotion");
        }
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
            await this.getClient(mobile).checktghealth();
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

    private getHealthyMobiles() {
        return this.mobiles.filter((mobile) => {
            const floodData = this.limitControl.get(mobile)
            return floodData.daysLeft < 7 && floodData.lastMessageTime < Date.now() - 3 * 60 * 1000 //Change it
        });
    }

    private selectNextMobile(): string | null {
        const healthyMobiles = this.getHealthyMobiles();
        if (!healthyMobiles.length) {
            console.warn("No healthy mobiles available for Promotions");
            return null;
        }
        const selectedMobile = healthyMobiles[this.nextMobileIndex % healthyMobiles.length];
        this.nextMobileIndex = (this.nextMobileIndex + 1) % healthyMobiles.length;
        return selectedMobile;
    }
}

