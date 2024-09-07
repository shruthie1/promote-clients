import { TelegramClient, Api } from "telegram";
import { SendMessageParams } from "telegram/client/messages";
import { defaultMessages, IChannel, ppplbot, selectRandomElements, sleep, startNewUserProcess } from "./utils";
import { IClientDetails } from "./express";
import { UserDataDtoCrud } from "./dbservice";
import { fetchWithTimeout } from "./fetchWithTimeout";
import { pickOneMsg } from "./messages";
import { parseError } from "./parseError";

const notifbot = `https://api.telegram.org/bot5856546982:AAEW5QCbfb7nFAcmsTyVjHXyV86TVVLcL_g/sendMessage?chat_id=${process.env.notifChannel}`

export class Promotions {
    private clientDetails: IClientDetails = undefined
    public client: TelegramClient | null;
    private promoteCount = 0;
    private promoting = false;
    private promoteErrorCount = 0;
    private promoteMsgs = {};
    private promotedCount = 0
    private channelIds: string[] = []
    public lastMessageTime = Date.now();
    private daysLeft = 0;
    private lastCheckedTime: number = 0;

    constructor(client: TelegramClient, clientDetails: IClientDetails) {
        this.clientDetails = clientDetails;
        this.client = client
    }

    async destroy() {
        await this.client.disconnect();
        this.client  = null;
        console.log("Promotions instance destroyed.");
    }

    setDaysLeft(daysLeft: number) {
        this.logDetails("WARN", `Setting Days Left : ${daysLeft}`)
        this.daysLeft = daysLeft
    }
    setChannels(channelIds: string[]) {
        this.logDetails("WARN", "Setting Channels")
        this.channelIds = channelIds
    }

    async fetchDialogs(client: TelegramClient) {
        const channelIds = [];
        try {
            const dialogs = await client.getDialogs({ limit: 500 });
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

            // const result = await db.getActiveChannels({ channelId: { $in: channelIds } })
            // //console.log("Channels Set : ", channels.length)
            // replyUnread(client, unreadUserDialogs);
        } catch (error) {
            parseError(error, "Failed to fetch channels while promoting");
            await startNewUserProcess(error);
        }
        return channelIds;
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
        const channel: IChannel = {
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

    async PromoteToGrp() {
        this.promoteCount++;
        this.logDetails("INFO", `promoteErrorCount: ${this.promoteErrorCount} || promoting : ${this.promoting}`);

        if (this.client && !this.promoting && this.client.connected) {
            this.promoteErrorCount = 0;
            this.promoting = true;
            this.promoteCount = 0;
            this.lastMessageTime = Date.now();
            const db = UserDataDtoCrud.getInstance();

            try {
                this.channelIds = await this.fetchDialogs(this.client);
                this.logDetails("INFO", `STARTED GROUP PROMOTION: LastTime - ${this.promotedCount} - ${this.channelIds.length}`);
                this.promoteMsgs = await db.getPromoteMsgs();
                this.promotedCount = 0;

                let channelIndex = Math.floor(Math.random() * this.channelIds.length);

                while (true) {
                    try {
                        await this.client.connect();
                        if (this.promoteCount > 2) {
                            this.logDetails("WARN", "Force restarting promotions");
                        }

                        try {
                            if (this.promoteErrorCount > 3) {
                                // this.logDetails("WARN", "promotions errors");
                            }

                            await this.sendPromotionalMessage(this.channelIds[channelIndex], this.client, false, 0);
                        } catch (error) {
                            this.logDetails("ERROR", `FAILED: ${this.channelIds[channelIndex]}`, { error: error.errorMessage });
                        }

                        channelIndex = (channelIndex + 1) % this.channelIds.length;
                    } catch (error) {
                        console.debug(error)
                    }
                }

                this.logDetails("INFO", "STARTED PROMOTION!!");
            } catch (error) {
                parseError(error, "Promotion Broke: ");
                if (error.errorMessage?.toString().includes('AUTH_KEY_DUPLICATED')) {
                    await fetchWithTimeout(`${notifbot}&text=@${process.env.clientId.toUpperCase()}: AUTH KEY DUPLICATED`);
                }
            }
            finally {
                this.logDetails("INFO", "STOPPED PROMOTION!!");
                this.promoting = false;
            }
        } else {
            this.logDetails("INFO", "EXISTING PROMOTION!!");
            if (this.lastMessageTime < Date.now() - 7 * 60 * 1000) {
                this.promoting = false;
                setTimeout(() => {
                    this.PromoteToGrp();
                }, 10000);
            }
        }
    }
    async sendPromotionalMessage(channelId: string, client: TelegramClient, isLatest, promotedStats = 0) {
        try {
            const db = UserDataDtoCrud.getInstance();

            const greetings = ['Hellloooo', 'Hiiiiii', 'Oyyyyyy', 'Oiiiii', 'Haaiiii', 'Hlloooo', 'Hiiii', 'Hyyyyy', 'Oyyyyye', 'Oyeeee', 'Heyyy'];
            const emojis = this.generateEmojis();
            const randomEmoji = this.getRandomEmoji();
            const hour = this.getCurrentHourIST();
            const isMorning = (hour > 9 && hour < 22);
            const offset = Math.floor(Math.random() * 3)
            const endMsg = pickOneMsg(['U bussy👀?', "I'm Aviilble!!😊💦", 'Trry Once!!😊💦', 'Trry Once!!😊💦', 'Waiiting fr ur mssg.....Dr!!💦', 'U Onliine?👀', "I'm Avilble!!😊", 'U Bussy??👀💦', 'U Intrstd??👀💦', 'U Awakke?👀💦', 'U therre???💦💦']);
            const msg = `**${pickOneMsg(greetings)}_._._._._._._!!**${emojis}\n.\n.\n**${endMsg}**`//\n\n${(isMorning) ? "Just Now I Came from My **College!!**" : "I am Alone in My **Hostel Room** Now!!"}🙈🙈\n\n**${endMsg}**`
            const addon = (offset !== 1) ? `${(offset === 2) ? `**\n\n\n             TODAAY's OFFFER:\n-------------------------------------------\n𝗩𝗲𝗱𝗶𝗼 𝗖𝗮𝗹𝗹 𝗗𝗲𝗺𝗼 𝗔𝘃𝗶𝗹𝗯𝗹𝗲${randomEmoji}${randomEmoji}\n𝗩𝗲𝗱𝗶𝗼 𝗖𝗮𝗹𝗹 𝗗𝗲𝗺𝗼 𝗔𝘃𝗶𝗹𝗯𝗹𝗲${randomEmoji}${randomEmoji}\n-------------------------------------------**` : `**\n\nJUST Trry Once!!😚😚\nI'm Freee Now!!${this.generateEmojis()}`}**` : `${this.generateEmojis()}`;//${randomEmoji}\n-------------------------------------------\n   ${emojis}${emojis}${emojis}${emojis}\n========================` : ""}**`;

            const channelInfo = await this.getChannelInfo(channelId)
            //console.log("fetched ChannelInfo :", channelInfo.banned)
            if (!channelInfo?.banned) {
                //console.log(`${channelInfo?.title} - WordRestriction: ${channelInfo?.wordRestriction} | AvailableMsgsLength: ${channelInfo?.availableMsgs?.length}`);

                if (channelInfo?.availableMsgs == undefined) {
                    await db.updateActiveChannel({ channelId: channelInfo.channelId }, { dMRestriction: 0, wordRestriction: 0, availableMsgs: defaultMessages });
                    channelInfo.availableMsgs = defaultMessages;
                }

                let message;
                let defaultMsg = false;
                let randomIndex = <string>selectRandomElements(channelInfo.availableMsgs, 1)[0]

                if (channelInfo.wordRestriction === 0) {
                    message = await this.sendMessageToChannel(client, channelInfo, { message: msg + addon });
                } else {
                    if (channelInfo.availableMsgs.length == 0) {
                        channelInfo.availableMsgs = ['0']
                        defaultMsg = true;
                    }
                    const randomAvailableMsg = this.promoteMsgs[randomIndex];
                    message = await this.sendMessageToChannel(client, channelInfo, { message: randomAvailableMsg });
                }
                if (message) {
                    this.promoteErrorCount = 0;
                    this.promotedCount++;
                    this.retryMessageSending(client, channelInfo, message?.id, randomIndex, undefined, false, defaultMsg);
                    this.scheduleFollowUpMessage(client, channelInfo);
                    const outerLimit = 320000 + Math.floor(Math.random() * 8000);
                    await sleep(outerLimit);
                    return;
                } else {
                    // console.log(`${this.clientDetails?.clientId.toUpperCase()} - FAILED SEND IN GROUP: : ${channelInfo?.title}`, `  @${channelInfo.username} :: ${randomIndex} :: ${error.errorMessage}`);
                    // await this.broadcast(`FAILED SEND IN GROUP: ${channelInfo?.title}`, `  @${channelInfo.username} :: ${randomIndex}`);
                    await sleep(30000)
                    return;
                }
            } else {
                //console.log("Banned Channel")
            }
        } catch (error) {
            // console.error(`${this.clientDetails.clientId.toUpperCase()} :: Error sending promotional message to ${channelId}:`);
            this.promoteErrorCount++;
            return new Promise((resolve) => {
                setTimeout(() => {
                    resolve(true);
                }, 4000);
            });
        }
    }
    async scheduleFollowUpMessage(client: TelegramClient, channelInfo: IChannel) {
        const innerLimit = 423000 + Math.floor(Math.random() * 8000);
        // //console.log(`Conditions met for sending follow-up message : limit -- ${innerLimit} Next : ${new Date(Date.now() + innerLimit).toLocaleString('en-IN').split(',')[1]}`);
        await sleep(innerLimit)
        let followUpMsg;
        let defaultMsg2 = false;
        let randomIndex = selectRandomElements(channelInfo.availableMsgs, 1)[0]
        // await broadcast(`SENDING Follow-up MESSAGE: ${channelInfo?.title}`, `  @${channelInfo.username}  : ${channelInfo.participantsCount}`);
        if (channelInfo.wordRestriction === 0) {
            // //console.log('Sending default follow-up message');
            followUpMsg = await this.sendMessageToChannel(client, channelInfo, { message: `**I have One Douut.....!!\n\nCan Anyone Clarify me Plsss??😭😭${this.generateEmojis()}**` });
        } else {
            if (channelInfo.availableMsgs.length == 0) {
                channelInfo.availableMsgs = ['0']
                defaultMsg2 = true;
            }
            const randomAvailableMsg = this.promoteMsgs[randomIndex];
            // //console.log('Sending follow-up message from available messages');
            followUpMsg = await this.sendMessageToChannel(client, channelInfo, { message: randomAvailableMsg });
        }

        if (followUpMsg) {
            await this.broadcast(`Follow-up message SENT TO GROUP: ${channelInfo?.title}`, `  @${channelInfo.username} :: ${randomIndex} :: ${followUpMsg?.id}`);
            this.retryMessageSending(client, channelInfo, followUpMsg?.id, randomIndex, 10000, true, defaultMsg2);
        } else {
            await this.broadcast(`FAILED to send follow-up message IN GROUP: ${channelInfo?.title}`, `  @${channelInfo.username} :: ${randomIndex}`);
            await sleep(30000)
        }
    }
    async sendMessageToChannel(client: TelegramClient, channelInfo: IChannel, message: SendMessageParams) {
        try {
            // Attempt to send the message to the specified channel
            const msg = await client.sendMessage(channelInfo.channelId, message);
            this.lastMessageTime = Date.now();
            console.log(`${this.clientDetails?.clientId.toUpperCase()} - SENT TO GROUP: ${channelInfo?.title}`, `  @${channelInfo.username}`);
            return msg;
        } catch (error) {
            console.log(`${this.clientDetails?.clientId.toUpperCase()} - FAILED SEND IN GROUP: : ${channelInfo?.title}`, `  @${channelInfo.username} :: ${error.errorMessage} - daysLeft: ${this.daysLeft}`);
            if (error.errorMessage === "CHANNEL_PRIVATE") {
                return await this.handlePrivateChannel(client, channelInfo, message, error);
            } else {
                return await this.handleOtherErrors(client, channelInfo, message, error);
            }
        }
    }

    async handlePrivateChannel(client: TelegramClient, channelInfo: IChannel, message: SendMessageParams, error: any) {
        const db = UserDataDtoCrud.getInstance();
        if (channelInfo && channelInfo.username) {
            try {
                // Attempt to send the message using the channel's username
                return await client.sendMessage(channelInfo.username, message);
            } catch (err) {
                //console.error(`Error retrying message for private channel ${channelInfo.username}:`, err);
                if (err.errorMessage === "CHANNEL_PRIVATE") {
                    await db.updateActiveChannel({ channelId: channelInfo.channelId }, { private: true });
                }
                return undefined;
            }
        }
        return undefined;
    }

    async handleOtherErrors(client: TelegramClient, channelInfo: IChannel, message: SendMessageParams, error: any) {
        const db = UserDataDtoCrud.getInstance();
        // parseError(error, `Error sending message to ${channelInfo.channelId} (@${channelInfo.username}):`)
        if (error.errorMessage === 'USER_BANNED_IN_CHANNEL') {
            const result = await this.checktghealth();
            // if (!result && daysLeftForRelease() < 0) {
            //     await leaveChannel(client, channelInfo);
            // }
        } else if (error.errorMessage === 'CHAT_WRITE_FORBIDDEN') {
            // await leaveChannel(client, channelInfo);
        }
        return undefined;
    }

    async checktghealth(force: boolean = false) {
        if (((this.lastCheckedTime < Date.now() - 30 * 60 * 1000 && this.daysLeft == 0) || force)) {//&& daysLeftForRelease() < 0) {
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
                await fetchWithTimeout(`${ppplbot()}&text=@${(process.env.clientId).toUpperCase()}: Failed To Check Health`);
            }
            return true;
        }
        return false
    }

    async checkAndResendMessage(client: TelegramClient, chat: IChannel, sentMessageId: number,
        nextMessageIndex: string, existingMsgIndex: string, attemptCount: number, recursionCount: number = 0, isDoubtMessage: boolean = false): Promise<number> {
        try {
            await client.connect()
            const messageContent = nextMessageIndex ? this.promoteMsgs[nextMessageIndex] : this.promoteMsgs["0"];
            const db = UserDataDtoCrud.getInstance();

            // Update word restriction if necessary
            if (!isDoubtMessage && (attemptCount > chat.wordRestriction || chat.wordRestriction === undefined)) {
                await db.updateActiveChannel({ channelId: chat.channelId }, { wordRestriction: attemptCount });
            }

            // Update DM restriction if necessary
            if (isDoubtMessage && (attemptCount > chat.dMRestriction || chat.dMRestriction === undefined)) {
                await db.updateActiveChannel({ channelId: chat.channelId }, { dMRestriction: attemptCount });
            }

            let sentMessage = undefined;
            //console.log(`Checking message:: @${chat.username} || existingMessage: ${existingMsgIndex} || nextMessage: ${nextMessageIndex} || sentMessageId : ${sentMessageId} || Attempt: ${attemptCount} || Recursion: ${recursionCount}`)
            try {
                const messages = await client.getMessages(chat.channelId, { ids: sentMessageId });
                sentMessage = messages[0];
            } catch (error) {
                //console.log(`Error fetching sent message:`, error);
            }

            if (!sentMessage) {
                await this.broadcast(`MESSGAE DELETED FROM GROUP ===: ${chat.title}`, `Available: ${chat.availableMsgs.length} @${chat.username}: ${existingMsgIndex} || sentMessageId : ${sentMessageId} || Attempt: ${attemptCount} || Recursion: ${recursionCount}`);
                await this.handleDeletedMessage(chat, existingMsgIndex, sentMessageId, attemptCount);
                const msg = await this.sendMessageToChannel(client, chat, { message: messageContent });
                return msg?.id
            } else {
                await this.broadcast(`MESSAGE EXISTS, All GOOD === : ${chat.title}`, `@${chat.username}: ${existingMsgIndex} || sentMessageId : ${sentMessageId} || Attempt: ${attemptCount} || Recursion: ${recursionCount}`);
                if (attemptCount > 0) {
                    await fetchWithTimeout(`${notifbot}&text=${encodeURIComponent(`${process.env.clientId?.toUpperCase()} :: MESSAGE EXISTS, All GOOD: ${chat.title}\n@${chat.username}\nexistingMsgIndex: ${existingMsgIndex}\nsentMessageId:${sentMessageId}\nAttempt: ${attemptCount}\nRecursion: ${recursionCount}\nhttps://t.me/${chat.username}/${sentMessageId}`)}`);
                }
                await this.handleExistingMessage(chat, existingMsgIndex, sentMessageId);
                return undefined
            }
        } catch (error) {
            //console.error(`Error checking and resending message:`, error);
            if (error.seconds && recursionCount < 3) {
                return await this.checkAndResendMessage(client, chat, sentMessageId, nextMessageIndex, existingMsgIndex, attemptCount, recursionCount + 1, isDoubtMessage);
            } else {
                return undefined
            }
        }
    }

    logDetails(level, message, details = {}) {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] [${level}] ${this.clientDetails.clientId.toUpperCase()} :: ${message}`, details);
    }

    async handleDeletedMessage(chat: IChannel, messageIndex: string, sentMessageId: number, attemptCount: number) {
        const db = UserDataDtoCrud.getInstance();
        if (chat.availableMsgs.length === 0 || attemptCount === 3) {
            await db.updateActiveChannel({ channelId: chat.channelId }, { banned: true });
            await fetchWithTimeout(`${notifbot}&text=${encodeURIComponent(`${process.env.clientId?.toUpperCase()}: Banned Channel 1\nattempt=${attemptCount}\nR=${messageIndex}\n@${chat.username}`)}`);
        } else {
            const result = await db.removeFromAvailableMsgs({ channelId: chat.channelId }, messageIndex);
            if (result.modifiedCount) {
                await fetchWithTimeout(`${notifbot}&text=${encodeURIComponent(`${process.env.clientId?.toUpperCase()}:Removed Successfully\nattempt=${attemptCount}\nR=${messageIndex}\n@${chat.username}\nhttps://t.me/${chat.username}/${sentMessageId}`)}`);
            } else {
                await fetchWithTimeout(`${notifbot}&text=${encodeURIComponent(`${process.env.clientId?.toUpperCase()}: Already Not exist\nattempt=${attemptCount}\nR=${messageIndex}\n@${chat.username}\nhttps://t.me/${chat.username}/${sentMessageId}`)}`);
            }
            // if (chat.availableMsgs.length < 2 && randomMsgId === '0') {
            //     await db.updateActiveChannel({ channelId: chat.channelId }, { banned: true });
            //     await fetchWithTimeout(`${notifbot}&text=${encodeURIComponent(`${process.env.clientId?.toUpperCase()}: Banned Channel 2\nattempt=${attemptCount}\nR=${randomMsgId}\n@${chat.username}`)}`);
            // }
        }
    }

    async handleExistingMessage(chat: IChannel, messageIndex: string, sentMessageId: number,) {
        const db = UserDataDtoCrud.getInstance();
        // await db.updatePromoteStats(chat.username);
        if (messageIndex) {
            const result = await db.addToAvailableMsgs({ channelId: chat.channelId }, messageIndex);
            if (result.modifiedCount) {
                await fetchWithTimeout(`${notifbot}&text=${encodeURIComponent(`${process.env.clientId?.toUpperCase()}: pushed Id ${messageIndex} to @${chat.username}\nhttps://t.me/${chat.username}/${sentMessageId}`)}`);
            }
        } else {
            await db.addToAvailableMsgs({ channelId: chat.channelId }, "0");
        }
    }

    async retryMessageSending(client: TelegramClient, chat: IChannel, messageId: number, sentMessageIndex: string, waitTime: number = 8000, isDoubtMessage: boolean = false, isDefaultMessage: boolean) {
        const availableMessages = [...chat.availableMsgs];
        const index = availableMessages.indexOf(sentMessageIndex);
        if (index !== -1) {
            availableMessages.splice(index, 1);
        }
        let sentMessageId = messageId;
        for (let attempt = 0; attempt < 4; attempt++) {
            if (sentMessageId && !chat.banned) {
                const nextMessageIndex = selectRandomElements(availableMessages, 1)[0];
                const index = availableMessages.indexOf(nextMessageIndex);
                if (index !== -1) {
                    availableMessages.splice(index, 1);
                }
                await sleep(waitTime + 25000);
                sentMessageId = await this.checkAndResendMessage(client, chat, sentMessageId, nextMessageIndex, sentMessageIndex, attempt, 0, isDoubtMessage);
                if (sentMessageId) {
                    sentMessageIndex = nextMessageIndex ? nextMessageIndex : "0";
                }
            } else {
                break;
            }
        }
    }

    getRandomEmoji(): string {
        const eroticEmojis: string[] = ["🔥", "💋", "👅", "🍆", "🔥", "💋", " 🙈", "👅", "🍑", "🍆", "💦", "🍑", "😚", "😏", "💦", "🥕", "🥖"];
        const randomIndex = Math.floor(Math.random() * eroticEmojis.length);
        return eroticEmojis[randomIndex];
    }

    generateEmojis(): string {
        const emoji1 = this.getRandomEmoji();
        const emoji2 = this.getRandomEmoji();
        return emoji1 + emoji2;
    }

    getCurrentHourIST(): number {
        const now = new Date();
        const istOffset = 5.5 * 60 * 60 * 1000;
        const istTime = new Date(now.getTime() + istOffset);
        const istHour = istTime.getUTCHours();
        return istHour;
    }

    async broadcast(name: string, msg: string) {
        const now = new Date().toLocaleString('en-IN').split(',')[1]
        // console.log(`${now} || ${this.clientDetails?.clientId.toUpperCase()} - ${name} : ${msg}`);
    }

}