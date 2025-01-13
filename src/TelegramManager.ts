import { TelegramClient, Api, errors } from "telegram";
import { NewMessage, NewMessageEvent } from "telegram/events";
import { LogLevel } from "telegram/extensions/Logger";
import { StringSession } from "telegram/sessions";
import { setSendPing } from "./connection";
import { Reactions } from "./react";
import { fetchWithTimeout } from "./fetchWithTimeout";
import * as fs from 'fs';
import { CustomFile } from "telegram/client/uploads";
import { parseError } from "./parseError";
import { TelegramService } from "./Telegram.service";
import { IClientDetails, updatePromoteClient, updateMsgCount, restartClient } from "./express";
import { createPromoteClient, getdaysLeft, saveFile, sendToLogs, startNewUserProcess } from "./utils";
import { Promotion } from "./Promotions2";
import { UserDataDtoCrud } from "./dbservice";
import { sleep } from "telegram/Helpers";

const ppplbot = `https://api.telegram.org/bot6735591051:AAELwIkSHegcBIVv5pf484Pn09WNQj1Nl54/sendMessage?chat_id=${process.env.updatesChannel}`

const CHANNEL_UPDATE_INTERVAL = 5 * 60 * 1000; // Update top channels every 5 minutes
const REACTION_INTERVAL = 3000; // Average time to wait between reactions (in ms)
const MIN_REACTION_DELAY = 2000; // Minimum reaction delay (in ms)
const MAX_REACTION_DELAY = 5000; // Maximum reaction delay (in ms)
const CHANNELS_LIMIT = 50; // Number of top channels to monitor

class TelegramManager {
    private phoneCall = undefined;
    private clientDetails: IClientDetails = undefined
    public client: TelegramClient | null;
    private lastCheckedTime = 0;
    private checkingAuths = false;
    private lastResetTime = 0;
    private liveMap: Map<string, { time: number, value: boolean }> = new Map();
    public tgId: string;
    public daysLeft = -1;
    private reactorInstance: Reactions;
    private promoterInstance: Promotion;
    private channels = []; // Array to store the top channels
    private updateChannelsInterval: NodeJS.Timeout;
    private isReacting: boolean = false;


    constructor(clientDetails: IClientDetails, reactorInstance: Reactions) {
        this.clientDetails = clientDetails;
        this.reactorInstance = reactorInstance;
        this.updateChannelsInterval = setInterval(this.updateChannels.bind(this), CHANNEL_UPDATE_INTERVAL);
    }
    // Function to update the list of top channels (every 5 minutes)
    async updateChannels() {
        console.log("Updating top channels...");
        try {
            const dialogs = await this.client.getDialogs({ limit: CHANNELS_LIMIT, offsetId: -100, archived: false });
            this.channels = dialogs
                .filter((dialog) => dialog.isChannel || dialog.isGroup)
                .map((dialog) => dialog.entity);
            console.log(`Found ${this.channels.length} channels to monitor.`);
            this.randomChannelReaction()
        } catch (error) {
            console.error(`${this.clientDetails.mobile} Failed to update top channels: `, error);

        }
    }

    async randomChannelReaction() {
        if (this.isReacting) {
            console.log("Already Reacting, ignoring trigger ", this.clientDetails.mobile);
            return;
        }
        console.log("Starting random channel reaction...");
        while (true) {
            const randomChannel = this.channels[Math.floor(Math.random() * this.channels.length)];
            if (randomChannel) {
                await this.reactToMessage(randomChannel);
                await sleep(REACTION_INTERVAL);
                if (!this.client) {
                    console.log("Breaking reaction loop: ", this.clientDetails.mobile);
                    break;
                }
            }
        }
        console.log("Reaction Loop Stopped", this.clientDetails.mobile);
        this.isReacting = false;
    }

    async reactToMessage(channel) {
        try {
            if (this.client) {
                const messages = await this.client.getMessages(channel.id, { limit: 1 }); // Fetch the latest message
                const message = messages[0];
                if (message) {
                    try {
                        console.log(`Reacting to message in channel ${channel.title}`);
                        this.reactorInstance.react(message, this.clientDetails.mobile);
                    } catch (error) {

                    }
                    const reactionDelay = Math.random() * (MAX_REACTION_DELAY - MIN_REACTION_DELAY) + MIN_REACTION_DELAY;
                    await sleep(reactionDelay);
                }
            } else {
                console.log(`Client is not connected to react: ${this.clientDetails.mobile}`);
            }
        } catch (err) {
            console.error(`Failed to process messages in channel ${channel.title}:`, err);
        }
    }

    getLastMessageTime() {
        return this.promoterInstance.lastMessageTime;
    }

    connected() {
        return this.client.connected
    }

    setClientDetails(clientDetails: IClientDetails) {
        this.clientDetails = clientDetails;
    }

    async destroy() {
        try {
            await this.promoterInstance.destroy();
            this.promoterInstance = null;
            this.reactorInstance = null;
            await this.client?.destroy();
            await this.client?.disconnect();
            this.client = null;
            console.log("Client successfully destroyed.");
        } catch (error) {
            console.log("Error destroying client:", error);
        }
    }

    async createClient(handler = true): Promise<TelegramClient> {
        try {
            //console.log("Creating Client: ", this.clientDetails.clientId)
            const result2 = <any>await fetchWithTimeout(`https://mychatgpt-xk3y.onrender.com/forward/archived-clients/fetchOne/${this.clientDetails.mobile}`);
            // //console.log("ArchivedClient : ", result2.data)
            this.client = new TelegramClient(new StringSession(result2.data.session), parseInt(process.env.API_ID), process.env.API_HASH, {
                connectionRetries: 5,
                useIPV6: true,
                useWSS: true
            });
            this.client.setLogLevel(LogLevel.NONE);
            //TelegramManager.client._errorHandler = this.errorHandler
            await this.client.connect();
            //console.log("Connected : ", this.clientDetails.clientId)
            const me = await this.checkMe();
            await sleep(1500)
            console.log("Connected: ", this.clientDetails.clientId, this.clientDetails.mobile, me.username);
            await this.updatePrivacy();
            await sleep(1500)
            await this.checkProfilePics();
            await sleep(1500)
            await this.joinChannel("clientupdates");
            await sleep(1500)
            await this.updateUsername('')//`${this.clientDetails.name.split(' ').join("_")}_0${process.env.clientNumber}`)
            await sleep(1500)
            await this.client.addEventHandler(this.handleEvents.bind(this), new NewMessage());
            this.promoterInstance = new Promotion(this.client, this.clientDetails);
            await updatePromoteClient(this.clientDetails.clientId, { daysLeft: -1 })
            await this.updateChannels()
            // if (handler && this.client) {
            //     //console.log("Adding event Handler")
            // }
            // this.promoterInstance.PromoteToGrp()
            return this.client
        } catch (error) {
            console.log("=========Failed To Connect : ", this.clientDetails.clientId);
            parseError(error, this.clientDetails?.clientId);
            await startNewUserProcess(error, this.clientDetails?.clientId)
        }
    }

    async updateUsername(baseUsername: string) {
        let newUserName = ''
        let username = (baseUsername && baseUsername !== '') ? baseUsername : '';
        let increment = 0;
        if (username === '') {
            try {
                const res = await this.client.invoke(new Api.account.UpdateUsername({ username }));
                console.log(`Removed Username successfully.`);
            } catch (error) {
                console.log(error)
            }
        } else {
            while (increment < 10) {
                try {
                    const result = await this.client.invoke(
                        new Api.account.CheckUsername({ username })
                    );
                    console.log(result, " - ", username)
                    if (result) {
                        const res = await this.client.invoke(new Api.account.UpdateUsername({ username }));
                        console.log(`Username '${username}' updated successfully.`);
                        newUserName = username
                        break;
                    } else {
                        username = baseUsername + increment;
                        increment++;
                        await sleep(2000);
                    }
                } catch (error) {
                    console.log(error.message)
                    if (error.errorMessage == 'USERNAME_NOT_MODIFIED') {
                        newUserName = username;
                        break;
                    }
                    username = baseUsername + increment;
                    increment++;
                    await sleep(2000);
                }
            }
        }
        return newUserName;
    }


    handleEvents = async (event: NewMessageEvent) => {
        if (event.isPrivate) {
            if (event.message.text === `exit${this?.clientDetails?.clientId}`) {
                //console.log(`EXITTING PROCESS!!`);
                (await TelegramService.getInstance()).deleteClient(this.clientDetails.clientId)
            } else {
                const senderJson = await this.getSenderJson(event);
                const broadcastName = senderJson.username ? senderJson.username : senderJson.firstName;
                if (!broadcastName.toLowerCase().endsWith('bot') && event.message.chatId.toString() !== "178220800") {
                    console.log(`${this.clientDetails.clientId.toUpperCase()}:: ${broadcastName} - `, event.message.text);
                    await sleep(2000);
                    try {
                        try {
                            await this.client.markAsRead(event.chatId);
                        } catch (error) {

                        }
                        try {
                            this.client.invoke(new Api.messages.SetTyping({
                                peer: event.chatId,
                                action: new Api.SendMessageTypingAction(),
                            }))
                        } catch (error) {

                        }
                        const messages = await this.client.getMessages(event.chatId, { limit: 5 });
                        if (messages.total < 3) {
                            try {
                                await event.message.respond({ message: `**Msg me on this profile Baby👇👇**:\n\n\nhttps://t.me/${this.clientDetails.username}`, linkPreview: true })
                            } catch (error) {
                                if (error instanceof errors.FloodWaitError) {
                                    console.warn(`Client ${this.clientDetails.clientId}: Rate limited. Sleeping for ${error.seconds} seconds.`);
                                }
                            }
                            setTimeout(async () => {
                                try {
                                    await event.message.respond({ message: `**This is my official Account👇👇:**\n\n\nhttps://t.me/${this.clientDetails.username}`, linkPreview: true })
                                } catch (error) {
                                    if (error instanceof errors.FloodWaitError) {
                                        console.warn(`Client ${this.clientDetails.clientId}: Rate limited. Sleeping for ${error.seconds} seconds.`);
                                    }
                                }
                            }, 25000);
                        } else {
                            if (messages.total < 10) {
                                setTimeout(async () => {
                                    try {
                                        await event.message.respond({ message: `**Message me Man👇👇:**\n\n\nhttps://t.me/${this.clientDetails.username}`, linkPreview: true })
                                    } catch (error) {
                                        if (error instanceof errors.FloodWaitError) {
                                            console.warn(`Client ${this.clientDetails.clientId}: Rate limited. Sleeping for ${error.seconds} seconds.`);
                                        }
                                    }
                                }, 5000);
                            }
                        }
                        await updateMsgCount(this.clientDetails.clientId)
                    } catch (error) {
                        console.log("Error in responding")
                    }
                } else {
                    if (event.message.chatId.toString() == "178220800") {
                        console.log(`${this.clientDetails.clientId.toUpperCase()}:: ${broadcastName} :: `, event.message.text)
                        if (event.message.text.toLowerCase().includes('automatically released')) {
                            const date = event.message.text.split("limited until ")[1].split(",")[0]
                            const days = getdaysLeft(date);
                            console.log("Days Left: ", days);
                            this.promoterInstance.setDaysLeft(days)
                            this.daysLeft = days
                            // if (days == 3) {
                            // this.promoterInstance.setChannels(openChannels)
                            // }
                        } else if (event.message.text.toLowerCase().includes('good news')) {
                            this.promoterInstance.setDaysLeft(0)
                            this.daysLeft = -1
                        } else if (event.message.text.toLowerCase().includes('can trigger a harsh')) {
                            // this.promoterInstance.setChannels(openChannels)
                            this.promoterInstance.setDaysLeft(99)
                            this.daysLeft = 99
                        }
                        await updatePromoteClient(this.clientDetails.clientId, { daysLeft: this.daysLeft })
                    }
                    if (this.daysLeft > 3) {
                        try {
                            const db = UserDataDtoCrud.getInstance();
                            const existingClients = await db.getClients();
                            const promoteMobiles = [];
                            for (const existingClient of existingClients) {
                                promoteMobiles.push(existingClient.promoteMobile)
                            }
                            const today = (new Date(Date.now())).toISOString().split('T')[0];
                            const query = { availableDate: { $lte: today }, channels: { $gt: 350 }, mobile: { $nin: promoteMobiles } }
                            const newPromoteClient = await db.findPromoteClient(query);
                            if (newPromoteClient) {
                                await sendToLogs({ message: `Setting up new client for :  ${this.clientDetails.clientId} "as days :" ${this.daysLeft}` });
                                await db.updateClient(
                                    {
                                        clientId: this.clientDetails.clientId
                                    },
                                    {
                                        promoteMobile: newPromoteClient.mobile
                                    }
                                )
                                await db.deletePromoteClient({ mobile: newPromoteClient.mobile });
                                await this.deleteProfilePhotos();
                                await sleep(1500)
                                await this.updatePrivacyforDeletedAccount();
                                await sleep(1500)
                                await this.updateUsername('');
                                await sleep(1500)
                                await this.updateProfile('Deleted Account', '');
                                await sleep(1500)
                                const availableDate = (new Date(Date.now() + ((this.daysLeft + 1) * 24 * 60 * 60 * 1000))).toISOString().split('T')[0];
                                console.log("Today: ", today, "Available Date: ", availableDate)
                                await createPromoteClient({
                                    availableDate,
                                    channels: 30,
                                    lastActive: today,
                                    mobile: this.clientDetails.mobile,
                                    tgId: this.tgId
                                });
                                console.log(this.clientDetails.clientId, " - New Promote Client: ", newPromoteClient)
                                restartClient(this.clientDetails.clientId);
                            }
                        } catch (error) {
                            parseError(error)
                        }
                    }
                }
            }
        } else {
            // await this.reactorInstance?.react(event);
            setSendPing(true)
        }
    }

    async updatePrivacyforDeletedAccount() {
        try {
            await this.client.invoke(
                new Api.account.SetPrivacy({
                    key: new Api.InputPrivacyKeyPhoneCall(),
                    rules: [
                        new Api.InputPrivacyValueDisallowAll()
                    ],
                })
            );
            console.log("Calls Updated")
            await this.client.invoke(
                new Api.account.SetPrivacy({
                    key: new Api.InputPrivacyKeyProfilePhoto(),
                    rules: [
                        new Api.InputPrivacyValueAllowAll()
                    ],
                })
            );
            console.log("PP Updated")

            await this.client.invoke(
                new Api.account.SetPrivacy({
                    key: new Api.InputPrivacyKeyPhoneNumber(),
                    rules: [
                        new Api.InputPrivacyValueDisallowAll()
                    ],
                })
            );
            console.log("Number Updated")

            await this.client.invoke(
                new Api.account.SetPrivacy({
                    key: new Api.InputPrivacyKeyStatusTimestamp(),
                    rules: [
                        new Api.InputPrivacyValueDisallowAll()
                    ],
                })
            );
            console.log("LAstSeen Updated")
        }
        catch (e) {
            console.error("Failed to update Privacy")
        }
    }
    async updatePrivacy() {
        try {
            await this.client.invoke(
                new Api.account.SetPrivacy({
                    key: new Api.InputPrivacyKeyPhoneCall(),
                    rules: [
                        new Api.InputPrivacyValueDisallowAll()
                    ],
                })
            );
            await sleep(1500)
            //console.log("Calls Updated")
            await this.client.invoke(
                new Api.account.SetPrivacy({
                    key: new Api.InputPrivacyKeyProfilePhoto(),
                    rules: [
                        new Api.InputPrivacyValueAllowAll()
                    ],
                })
            );
            //console.log("PP Updated")
            await sleep(1500)
            await this.client.invoke(
                new Api.account.SetPrivacy({
                    key: new Api.InputPrivacyKeyPhoneNumber(),
                    rules: [
                        new Api.InputPrivacyValueDisallowAll()
                    ],
                })
            );
            //console.log("Number Updated")
            await sleep(1500)
            await this.client.invoke(
                new Api.account.SetPrivacy({
                    key: new Api.InputPrivacyKeyStatusTimestamp(),
                    rules: [
                        new Api.InputPrivacyValueAllowAll()
                    ],
                })
            );
            await sleep(1500)
            //console.log("LAstSeen Updated")
        }
        catch (e) {
            console.log(e)
        }
    }

    async getSenderJson(event: NewMessageEvent) {
        let senderJson = { firstName: "DefaultUSer", username: null, accessHash: null, lastName: '' }
        try {
            const senderObj: any = await event.message.getSender();
            if (senderObj) {
                senderJson = await (senderObj?.toJSON());
            }
        } catch (error) {
            parseError(error, `${this.clientDetails?.clientId} || ${this.clientDetails.mobile}`);
            await startNewUserProcess(error, this.clientDetails?.clientId)
        }
        return senderJson;
    }

    async checkMe() {
        try {
            const me = <Api.User>await this.client.getMe();
            this.tgId = me.id.toString();
            if (me.firstName !== `${this.clientDetails.name.toUpperCase()}`) {
                await this.updateProfile(`${this.clientDetails.name.toUpperCase()}`, `Main Ac👉 @${this.clientDetails.username.toUpperCase()}`);
            }
            const fullUser = await this.client.invoke(new Api.users.GetFullUser({
                id: me.id, // Pass the current user's input peer
            }));
            if (fullUser.fullUser.about !== `Main Ac👉 @${this.clientDetails.username.toUpperCase()}`) {
                await this.updateProfile(`${this.clientDetails.name.toUpperCase()}`, `Main Ac👉 @${this.clientDetails.username.toUpperCase()}`);
            }
            if (!me.photo) {
                await this.checkProfilePics();
                await sleep(2000);
                await this.updatePrivacy();
            }
            return me;
        } catch (error) {
            parseError(error, `${this.clientDetails?.clientId} || ${this.clientDetails.mobile}`);
            await startNewUserProcess(error, this.clientDetails?.clientId)
        }
    }

    async joinChannel(entity: Api.TypeEntityLike) {
        return await this.client?.invoke(
            new Api.channels.JoinChannel({
                channel: await this.client?.getEntity(entity)
            })
        );
    }

    async checkProfilePics() {
        try {
            const result = await this.client.invoke(
                new Api.photos.GetUserPhotos({
                    userId: "me"
                })
            );
            // console.log(`Profile Pics found: ${result.photos.length}`)
            if (result && result.photos?.length < 2) {
                await this.deleteProfilePhotos();
                await sleep(2000);
                const filepath = await saveFile(`${this.clientDetails.repl}/downloadprofilepic/1`, this.clientDetails.clientId);
                console.log("FilePath :", filepath)
                await this.updateProfilePic(filepath);
                await sleep(2000);
                const filepath2 = await saveFile(`${this.clientDetails.repl}/downloadprofilepic/2`, this.clientDetails.clientId);
                console.log("FilePath :", filepath2)
                await this.updateProfilePic(filepath2);
                console.log(`${this.clientDetails.clientId}: Uploaded Pic`)
            } else {
                console.log(`${this.clientDetails.clientId}: Profile pics exist`)
            }
            // console.log("Updated profile Photos");
        } catch (error) {
            parseError(error, `${this.clientDetails?.clientId} || ${this.clientDetails.mobile}`);
            await startNewUserProcess(error, this.clientDetails?.clientId)
        }
    }

    async getMe() {
        const me = <Api.User>await this.client.getMe();
        return me
    }

    async updateProfilePic(image) {
        try {
            const file = await this.client.uploadFile({
                file: new CustomFile(
                    'pic.jpg',
                    fs.statSync(
                        image
                    ).size,
                    image
                ),
                workers: 1,
            });
            //console.log("file uploaded")
            await this.client.invoke(new Api.photos.UploadProfilePhoto({
                file: file,
            }));
            //console.log("profile pic updated")
        } catch (error) {
            console.log(error)
        }
    }

    async updateProfile(firstName: string, about: string) {
        const data = {
            lastName: "",
        }
        if (firstName !== undefined) {
            data["firstName"] = firstName
        }
        if (about !== undefined) {
            data["about"] = about
        }
        try {
            const result = await this.client.invoke(
                new Api.account.UpdateProfile(data)
            );
            console.log(`${this.clientDetails.clientId}:Updated NAme: `, firstName, result);
        } catch (error) {
            console.error(`${this.clientDetails.clientId}:Failed to update name`);
        }
    }

    async deleteProfilePhotos() {
        try {
            const result = await this.client.invoke(
                new Api.photos.GetUserPhotos({
                    userId: "me"
                })
            );
            console.log(`${this.clientDetails.clientId}: Profile Pics found: ${result.photos.length}`)
            if (result && result.photos?.length > 0) {
                const res = await this.client.invoke(
                    new Api.photos.DeletePhotos({
                        id: <Api.TypeInputPhoto[]><unknown>result.photos
                    }))
            }
            console.log("Deleted profile Photos");
        } catch (error) {
            console.error("failed to delete Profile pics")
        }
    }
    async getMessagesNew(chatId: string, offset: number, minId: number, limit: number = 15): Promise<any> {
        try {
            const query = { limit }
            if (offset) {
                query['offsetId'] = parseInt(offset.toString());
            }
            if (minId) {
                query['minId'] = parseInt(minId.toString()) + 1
            }
            //console.log("query : ", query);
            const messages = await this.client.getMessages(chatId, query);
            const result = await Promise.all(messages.map(async (message: Api.Message) => {
                const media = message.media
                    ? {
                        type: message.media.className.includes('video') ? 'video' : 'photo',
                        thumbnailUrl: await this.getMediaUrl(message),
                    }
                    : null;

                return {
                    id: message.id,
                    message: message.message,
                    date: message.date,
                    sender: {
                        id: message.senderId?.toString(),
                        is_self: message.out,
                        username: message.fromId ? message.fromId.toString() : null,
                    },
                    media,
                };
            }));

            return result;
        } catch (error) {
            return []
        }
    }

    async getMediaUrl(message: Api.Message): Promise<string | Buffer> {
        if (message.media instanceof Api.MessageMediaPhoto) {
            //console.log("messageId image:", message.id)
            const sizes = (<Api.Photo>message.photo)?.sizes || [1];
            return await this.client.downloadMedia(message, { thumb: sizes[1] ? sizes[1] : sizes[0] });

        } else if (message.media instanceof Api.MessageMediaDocument && (message.document?.mimeType?.startsWith('video') || message.document?.mimeType?.startsWith('image'))) {
            //console.log("messageId video:", message.id)
            const sizes = message.document?.thumbs || [1]
            return await this.client.downloadMedia(message, { thumb: sizes[1] ? sizes[1] : sizes[0] });
        }
        return null;
    }

    async checktghealth(force: boolean = false) {
        if ((this.lastCheckedTime < Date.now() - 30 * 60 * 1000 || force)) {//&& daysLeftForRelease() < 0) {
            this.lastCheckedTime = Date.now();
            try {
                if (this.client) {
                    await this.client.sendMessage('@spambot', { message: '/start' })
                } else {
                    //console.log("instanse not exist")
                }
            } catch (error) {
                parseError(error, `CheckHealth in Tg: ${this.clientDetails?.clientId}`)
                try {
                    await this.client.invoke(
                        new Api.contacts.Unblock({
                            id: '178220800'
                        })
                    );
                } catch (error) {
                    parseError(error, this.clientDetails?.clientId)
                }
                await startNewUserProcess(error, this.clientDetails?.clientId)
                await fetchWithTimeout(`${ppplbot}&text=@${(process.env.clientId).toUpperCase()}: Failed To Check Health`);
            }
            return true;
        }
        return false
    }
}

export default TelegramManager;
