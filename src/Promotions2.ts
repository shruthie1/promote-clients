import { TelegramClient, Api, errors } from "telegram";
import { UserDataDtoCrud } from "./dbservice";
import { generateEmojis, getCurrentHourIST, getRandomEmoji, IChannel, ppplbot, selectRandomElements, sleep } from "./utils";
import { IClientDetails, restartClient } from "./express";
import { parseError } from "./parseError";
import { SendMessageParams } from "telegram/client/messages";
import { pickOneMsg } from "./messages";
import { fetchWithTimeout } from "./fetchWithTimeout";

interface MessageQueueItem {
    channelId: string;
    messageId: number;
    timestamp: number;
    messageIndex: string;
}

export class Promotion {
    private clientDetails: IClientDetails = undefined
    public client: TelegramClient | null;
    private daysLeft: number = -1;
    private sleepTime = 0;
    public lastMessageTime = Date.now() - 240000;
    private lastCheckedTime: number;
    private channels: string[];
    private minDelay: number = 90000;
    private maxDelay: number = 300000;
    private smallDelay: number = 2000;
    private maxSmallDelay: number = 4000;
    private messageQueue: MessageQueueItem[] = []
    private messageCheckDelay: number = 15000;
    private promoteMsgs = {};

    constructor(client: TelegramClient, clientDetails: IClientDetails) {
        this.clientDetails = clientDetails;
        this.client = client;
        console.log(clientDetails.clientId, ": Promotion Instance created")
        setInterval(() => this.checkQueuedMessages(), this.messageCheckDelay);
        const db = UserDataDtoCrud.getInstance();
        db.getPromoteMsgs().then((data) => {
            this.promoteMsgs = data;
            this.promoteInBatches()
        })
    }

    async checkQueuedMessages() {
        const now = Date.now();
        const readyMessages = this.messageQueue.filter(item => (now - item.timestamp) >= this.messageCheckDelay);
        for (const messageItem of readyMessages) {
            await this.checkMessageExist(messageItem)
            this.messageQueue = this.messageQueue.filter(item => item.messageId !== messageItem.messageId);
        }
    }

    setDaysLeft(daysLeft: number) {
        this.daysLeft = daysLeft
    }

    async destroy() {
        await this.client.disconnect();
        this.client = null;
        console.log("Promotions instance destroyed.");
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

    async fetchDialogs() {
        const channelIds = [];
        try {
            await this.client?.connect()
            const dialogs = await this.client.getDialogs({ limit: 500 });
            //console.log("Dialogs : ", dialogs.length)
            const unreadUserDialogs = [];
            for (const dialog of dialogs) {
                if (dialog.isUser && dialog.unreadCount > 0) {
                    unreadUserDialogs.push(dialog);
                } else if (dialog.isChannel || dialog.isGroup) {
                    const chatEntity = <Api.Channel>dialog.entity.toJSON();
                    const { id, defaultBannedRights, title, broadcast, username, participantsCount, restricted } = chatEntity;
                    if (!broadcast && !defaultBannedRights?.sendMessages && !restricted && id && participantsCount > 500) {
                        const channelId = id.toString().replace(/^-100/, "");
                        channelIds.push(channelId)
                    }
                }
            }
        } catch (error) {
            parseError(error, `${this.clientDetails.clientId}|${this.clientDetails.mobile} - Failed to fetch channels while promoting`, true);
            // await startNewUserProcess(error);
        }
        return channelIds;
    }

    async sendMessageToChannel(channelInfo: IChannel, message: SendMessageParams) {
        try {
            if (this.client) {
                if (this.sleepTime < Date.now()) {
                    const result = await this.client.sendMessage(channelInfo.channelId, message);
                    console.log(`Client ${this.clientDetails.clientId}: Message sent to ${channelInfo.channelId}`);
                    this.lastMessageTime = Date.now()
                    return result
                } else {
                    console.log(`Client ${this.clientDetails.clientId}: Sleeping for ${this.sleepTime / 1000} seconds due to rate limit.`);
                    return undefined
                }
            } else {
                console.log("client Destroyed while promotions", this.clientDetails.clientId)
                await fetchWithTimeout(`${ppplbot()}&text=@${(process.env.clientId).toUpperCase()}: ${this.clientDetails.clientId}: Client Destroyed.`);
                restartClient(this.clientDetails.clientId)
            }
        } catch (error) {
            if (error.errorMessage !== 'USER_BANNED_IN_CHANNEL') {
                console.log(this.clientDetails.clientId, `Some Error Occured, ${error.errorMessage}`)
            }
            if (error instanceof errors.FloodWaitError) {
                console.log(error)
                console.warn(`Client ${this.clientDetails.clientId}: Rate limited. Sleeping for ${error.seconds} seconds.`);
                this.sleepTime = Date.now() + (error.seconds * 1000); // Set the sleep time for the specific client
                return undefined
            } else {
                console.error(`Client ${this.clientDetails.clientId}: Error sending message to ${channelInfo.username}: ${error.errorMessage} | DaysLeft: ${this.daysLeft}`);
                if (error.errorMessage === "CHANNEL_PRIVATE") {
                    return await this.handlePrivateChannel(channelInfo, message, error);
                } else {
                    return await this.handleOtherErrors(channelInfo, message, error);
                }
            }
        }
    }


    public async promoteInBatches() {
        this.channels = await this.fetchDialogs();
        let channelIndex = 0;

        if (this.channels.length > 0) {
            while (true) {
                if (this.client) {
                    const channelsBatch = this.channels.slice(channelIndex, channelIndex + 5);

                    if (channelsBatch.length < 3) {
                        channelIndex = 0; // Restart index for a fresh batch
                        continue;
                    }

                    console.log(`${this.clientDetails.clientId} :: Started Batch: ${channelsBatch.length}-${channelsBatch}`);
                    let sentCount = 0;
                    for (const channelId of channelsBatch) {
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
                                sentMessage = await this.sendMessageToChannel(channelInfo, {
                                    message: `${msg}\n${addon}`,
                                });
                            } else {
                                // Select a random available promotional message
                                const randomIndex = selectRandomElements(channelInfo.availableMsgs, 1)[0] || '0';
                                const randomAvailableMsg = this.promoteMsgs[randomIndex];
                                sentMessage = await this.sendMessageToChannel(channelInfo, { message: randomAvailableMsg });

                                if (sentMessage) {
                                    this.messageQueue.push({
                                        channelId,
                                        messageId: sentMessage.id,
                                        timestamp: Date.now(),
                                        messageIndex: randomIndex,
                                    });
                                }
                            }

                            if (sentMessage) {
                                sentCount++;
                            }

                            const randomSmallDelay = Math.floor(Math.random() * (this.maxSmallDelay - this.smallDelay + 1)) + this.smallDelay;
                            await sleep(randomSmallDelay);
                        } else {
                            console.log("Banned Channel");
                            this.channels = this.channels.filter(id => id !== channelId);
                        }
                    }

                    console.log(`${this.clientDetails.clientId} Sent: ${sentCount}`);
                    channelIndex = (channelIndex + 5) % this.channels.length;

                    if (channelIndex !== 0) {
                        const randomBatchDelay = Math.floor(Math.random() * (this.maxDelay - this.minDelay + 1)) + this.minDelay;
                        console.log(`${this.clientDetails.clientId} :: Sleeping for ${(randomBatchDelay / 60000).toFixed(2)} minutes`);
                        await sleep(randomBatchDelay);
                    }
                } else {
                    break;
                }
            }
        }

        await fetchWithTimeout(`${ppplbot()}&text=@${(process.env.clientId).toUpperCase()}: ${this.clientDetails.clientId}: Issue with Promotions`);
        setTimeout(() => {
            console.log("Issue with Promotions", this.clientDetails.clientId);
            restartClient(this.clientDetails.clientId);
        }, 300000);
    }

    async handlePrivateChannel(channelInfo: IChannel, message: SendMessageParams, error: any) {
        const db = UserDataDtoCrud.getInstance();
        if (channelInfo && channelInfo.username) {
            try {
                return await this.client.sendMessage(channelInfo.username, message);
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

    async handleOtherErrors(channelInfo: IChannel, message: SendMessageParams, error: any) {
        // const db = UserDataDtoCrud.getInstance();
        // parseError(error, `Error sending message to ${channelInfo.channelId} (@${channelInfo.username}):`, false)
        if (error.errorMessage === 'USER_BANNED_IN_CHANNEL') {
            const result = await this.checktghealth();
            // if (!result && daysLeftForRelease() < 0) {
            //     await leaveChannel(client, channelInfo);
            // }
        } else if (error.errorMessage === 'CHAT_WRITE_FORBIDDEN') {
            console.log(`${this.clientDetails.clientId}: ${error.errorMessage}`)
            // await leaveChannel(this.client, channelInfo);
        } else {
            const errorDetails = parseError(error, `${this.clientDetails.clientId}`, false)
        }
        return undefined;
    }

    async checktghealth(force: boolean = false) {
        if (((this.lastCheckedTime < Date.now() - 120 * 60 * 1000 && this.daysLeft == 0) || force)) {//&& daysLeftForRelease() < 0) {
            this.lastCheckedTime = Date.now();
            try {
                if (this.client) {
                    await this.client.sendMessage('@spambot', { message: '/start' })
                } else {
                    //console.log("instanse not exist")
                }
            } catch (error) {
                parseError(error, `${this.clientDetails.clientId}, CheckHealth in Promote`)
                try {
                    await this.client.invoke(
                        new Api.contacts.Unblock({
                            id: '178220800'
                        })
                    );
                } catch (error) {
                    parseError(error)
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
            await db.updateActiveChannel({ channelId }, { banned: true });
        } else {
            const result = await db.removeFromAvailableMsgs({ channelId }, messageIndex);
        }
    }

    async handleExistingMessage(channelId: string, messageIndex: string) {
        const db = UserDataDtoCrud.getInstance();
        if (messageIndex) {
            const result = await db.addToAvailableMsgs({ channelId }, messageIndex);
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

