import { TelegramClient, Api, errors } from "telegram";
import { UserDataDtoCrud } from "./dbservice";
import { generateEmojis, getCurrentHourIST, getRandomEmoji, IChannel, ppplbot, selectRandomElements, sendToLogs, sleep } from "./utils";
import { IClientDetails, restartClient, updateFailedCount, updateSuccessCount } from "./express";
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
    private limitControl = new Map<string, { triggeredTime: number; daysLeft: number, lastMessageTime: number }>();
    private nextMobileIndex = 0; // Index for round-robin mobile selection
    private sleepTime = 0;
    private channels: string[];
    private minDelay: number = 100000;
    private maxDelay: number = 150000;
    private messageQueue: MessageQueueItem[] = []
    private messageCheckDelay: number = 20000;
    private promoteMsgs = {};
    private mobiles: string[] = [];

    private getClient: (clientId: string) => TelegramManager | undefined;

    constructor(mobiles: string[], getClient: (clientId: string) => TelegramManager | undefined) {
        this.mobiles = mobiles
        this.getClient = getClient;
        console.log("Promotion Instance created")
        setInterval(() => this.checkQueuedMessages(), this.messageCheckDelay);
        const db = UserDataDtoCrud.getInstance();
        db.getPromoteMsgs().then((data) => {
            this.promoteMsgs = data;
            this.promoteInBatches()
        })
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
        const data = this.limitControl.get(mobile) || { triggeredTime: 0, daysLeft: -1, lastMessageTime: Date.now() };
        this.limitControl.set(mobile, { ...data, triggeredTime: Date.now(), daysLeft: daysLeft })
    }

    getDaysLeft(mobile: string) {
        const data = this.limitControl.get(mobile) || { triggeredTime: 0, daysLeft: -1, lastMessageTime: Date.now() };
        return data.daysLeft;
    }

    getLastMessageTime(mobile: string) {
        const data = this.limitControl.get(mobile) || { triggeredTime: 0, daysLeft: -1, lastMessageTime: Date.now() };
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
        const channelIds = [];
        const mobile = this.selectNextMobile();
        const tgManager = this.getClient(mobile);
        const client = tgManager?.client
        try {
            await client?.connect()
            const dialogs = await client.getDialogs({ limit: 500 });
            const channelData = [];

            for (const dialog of dialogs) {
                if (dialog.isChannel || dialog.isGroup) {
                    const chatEntity = <Api.Channel>dialog.entity.toJSON();
                    const { id, defaultBannedRights, title, broadcast, username, participantsCount, restricted } = chatEntity;
                    if (!broadcast && !defaultBannedRights?.sendMessages && !restricted && id && participantsCount > 500) {
                        const channelId = id.toString().replace(/^-100/, "");
                        channelData.push({ channelId, participantsCount });
                    }
                }
            }

            // Sort by participantsCount in descending order
            channelData.sort((a, b) => b.participantsCount - a.participantsCount);

            // Get top 250 channels
            const top250Channels = channelData.slice(0, 250);

            // Fisher-Yates Shuffle
            for (let i = top250Channels.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [top250Channels[i], top250Channels[j]] = [top250Channels[j], top250Channels[i]];
            }

            // Collect shuffled channel IDs
            for (const channel of top250Channels) {
                channelIds.push(channel.channelId);
            }

            // Proceed with unread dialogs and other actions
        } catch (error) {
            parseError(error, `${mobile}- Failed to fetch channels while promoting`, true);
        }
        return channelIds;
    }

    async sendMessageToChannel(mobile: string, channelInfo: IChannel, message: SendMessageParams) {
        const tgManager = this.getClient(mobile)
        try {
            if (tgManager?.client) {
                if (this.sleepTime < Date.now()) {
                    const result = await tgManager.client.sendMessage(channelInfo.username ? `@${channelInfo.username}` : channelInfo.channelId, message);
                    console.log(`Client ${mobile}: Message sent to ${channelInfo.channelId} || @${channelInfo.username}`);
                    await sendToLogs({ message: `${mobile}:---✅\n@${channelInfo.username}` })
                    const data = this.limitControl.get(mobile) || { triggeredTime: 0, daysLeft: -1, lastMessageTime: Date.now() };
                    this.limitControl.set(mobile, { ...data, lastMessageTime: Date.now() })
                    await updateSuccessCount(mobile);
                    return result
                } else {
                    console.log(`Client ${mobile}: Sleeping for ${this.sleepTime / 1000} seconds due to rate limit.`);
                    return undefined
                }
            } else {
                console.log("client Destroyed while promotions", mobile)
                await fetchWithTimeout(`${ppplbot()}&text=@${(process.env.clientId).toUpperCase()}: ${mobile}: Client Destroyed.`);
            }
        } catch (error) {
            await sendToLogs({ message: `${mobile.toUpperCase()}:---❌\n@${channelInfo.username}` })
            await updateFailedCount(mobile);
            if (error.errorMessage !== 'USER_BANNED_IN_CHANNEL') {
                console.log(mobile, `Some Error Occured, ${error.errorMessage}`)
            }
            if (error instanceof errors.FloodWaitError) {
                console.log(error)
                console.warn(`Client ${mobile}: Rate limited. Sleeping for ${error.seconds} seconds.`);
                this.sleepTime = Date.now() + (error.seconds * 1000); // Set the sleep time for the specific client
                return undefined
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


    public async promoteInBatches() {
        this.channels = await this.fetchDialogs();
        let channelIndex = 0;
        let mobile = this.selectNextMobile();
        let failCount = 0;
        if (this.channels.length > 0) {
            while (true) {
                if (mobile) {
                    try {
                        if (channelIndex > 190) {
                            channelIndex = 0; // Restart index for a fresh batch
                            continue;
                        }

                        let randomIndex = '_id'
                        const channelId = this.channels[channelIndex]
                        const channelInfo = await this.getChannelInfo(channelId);
                        if (!channelInfo?.banned) {
                            let sentMessage: Api.Message | undefined;
                            if (channelInfo.wordRestriction === 0) {
                                const greetings = ['Hellloooo', 'Hiiiiii', 'Oyyyyyy', 'Oiiiii', 'Haaiiii', 'Hlloooo', 'Hiiii', 'Hyyyyy', 'Oyyyyye', 'Oyeeee', 'Heyyy'];
                                const emojis = generateEmojis();
                                const randomEmoji = getRandomEmoji();
                                const hour = getCurrentHourIST();
                                const isMorning = (hour > 9 && hour < 22);
                                const offset = Math.floor(Math.random() * 3)
                                const endMsg = pickOneMsg(['U bussy👀?', "I'm Aviilble!!😊💦", 'Trry Once!!😊💦', 'Trry Once!!😊💦', 'Waiiting fr ur mssg.....Dr!!💦', 'U Onliine?👀', "I'm Avilble!!😊", 'U Bussy??👀💦', 'U Intrstd??👀💦', 'U Awakke?👀💦', 'U therre???💦💦']);
                                const msg = `**${pickOneMsg(greetings)}_._._._._._._!!**${emojis}\n.\n.\n**${endMsg}**`//\n\n${(isMorning) ? "Just Now I Came from My **College!!**" : "I am Alone in My **Hostel Room** Now!!"}🙈🙈\n\n**${endMsg}**`
                                const addon = (offset !== 1) ? `${(offset === 2) ? `**\n\n\n             TODAAY's OFFFER:\n-------------------------------------------\n𝗩𝗲𝗱𝗶𝗼 𝗖𝗮𝗹𝗹 𝗗𝗲𝗺𝗼 𝗔𝘃𝗶𝗹𝗯𝗹𝗲${randomEmoji}${randomEmoji}\n𝗩𝗲𝗱𝗶𝗼 𝗖𝗮𝗹𝗹 𝗗𝗲𝗺𝗼 𝗔𝘃𝗶𝗹𝗯𝗹𝗲${randomEmoji}${randomEmoji}\n-------------------------------------------**` : `**\n\nJUST Trry Once!!😚😚\nI'm Freee Now!!${generateEmojis()}`}**` : `${generateEmojis()}`;//${randomEmoji}\n-------------------------------------------\n   ${emojis}${emojis}${emojis}${emojis}\n========================` : ""}**`;
                                sentMessage = await this.sendMessageToChannel(mobile, channelInfo, {
                                    message: `${msg}\n${addon}`,
                                });
                            } else {
                                // Select a random available promotional message
                                randomIndex = selectRandomElements(channelInfo.availableMsgs, 1)[0] || '0';
                                const randomAvailableMsg = this.promoteMsgs[randomIndex] || "Hiii";
                                sentMessage = await this.sendMessageToChannel(mobile, channelInfo, { message: randomAvailableMsg });
                            }
                            if (sentMessage) {
                                this.messageQueue.push({
                                    mobile,
                                    channelId,
                                    messageId: sentMessage.id,
                                    timestamp: Date.now(),
                                    messageIndex: randomIndex,
                                });
                                mobile = this.selectNextMobile();
                                const randomBatchDelay = Math.floor(Math.random() * (this.maxDelay - this.minDelay + 1)) + this.minDelay;
                                console.log(`Sleeping for ${(randomBatchDelay / 60000).toFixed(2)} minutes`);
                                await sleep(randomBatchDelay);
                            } else {
                                if (failCount < 3) {
                                    failCount++
                                    await sleep(10000)
                                } else {
                                    failCount = 0;
                                    mobile = this.selectNextMobile();
                                }
                            }
                        } else {
                            console.log(`Banned Channel - @${channelInfo.username}`);
                            // this.channels = this.channels.filter(id => id !== channelId);
                        }
                        channelIndex++;
                    } catch (error) {
                        parseError(error, "Error in PromoteBatch")
                        await sleep(30000)
                    }
                } else {
                    await sleep(30000)
                }
            }
        }

        await fetchWithTimeout(`${ppplbot()}&text=@${(process.env.clientId).toUpperCase()}: Issue with Promotions`);
        setTimeout(() => {
            console.log("Issue with Promotions",);
            // restartClient(mobile);
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
            const result = await this.checktghealth(mobile);
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

    async checktghealth(mobile: string, force: boolean = false) {
        const floodData = this.limitControl.get(mobile) || { triggeredTime: 0, daysLeft: -1, lastMessageTime: Date.now() };
        if ((floodData.triggeredTime < Date.now() - 120 * 60 * 1000 || force)) {//&& daysLeftForRelease() < 0) {
            this.limitControl.set(mobile, { ...floodData, triggeredTime: Date.now(), daysLeft: floodData.daysLeft })
            const tgManager = this.getClient(mobile)
            try {
                if (tgManager.client) {
                    await tgManager.client.sendMessage('@spambot', { message: '/start' })
                } else {
                    //console.log("instanse not exist")
                }
            } catch (error) {
                parseError(error, `${mobile}, CheckHealth in Promote`)
                try {
                    await tgManager.client.invoke(
                        new Api.contacts.Unblock({
                            id: '178220800'
                        })
                    );
                } catch (error) {
                    parseError(error, 'Error Unblocking')
                }
                // await fetchWithTimeout(`${ppplbot()}&text=@${(process.env.clientId).toUpperCase()}: Failed To Check Health`);
            }
            return true;
        }
        return false
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
            const floodData = this.limitControl.get(mobile) || { triggeredTime: 0, daysLeft: -1 };
            return floodData.daysLeft < 0
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

