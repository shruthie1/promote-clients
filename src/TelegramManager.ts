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
import { IClientDetails } from "./express";
import { getdaysLeft, startNewUserProcess } from "./utils";

import { Promotion } from "./Promotions2";

const ppplbot = `https://api.telegram.org/bot6735591051:AAELwIkSHegcBIVv5pf484Pn09WNQj1Nl54/sendMessage?chat_id=${process.env.updatesChannel}`

class TelegramManager {
    private clientDetails: IClientDetails = undefined
    public client: TelegramClient | null;
    private lastCheckedTime = 0;
    private reactorInstance: Reactions;
    public promoterInstance: Promotion;

    constructor(clientDetails: IClientDetails) {
        this.clientDetails = clientDetails;
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
            this.client = null;
            console.log("Client successfully destroyed.");
        } catch (error) {
            console.log("Error destroying client:", error);
        }
    }

    async createClient(handler = true): Promise<TelegramClient> {
        try {
            //console.log("Creating Client: ", this.clientDetails.clientId)
            const result2 = <any>await fetchWithTimeout(`https://checker-production-c3c0.up.railway.app/forward/archived-clients/fetchOne/${this.clientDetails.mobile}`);
            // //console.log("ArchivedClient : ", result2.data)
            this.client = new TelegramClient(new StringSession(result2.data.session), parseInt(process.env.API_ID), process.env.API_HASH, {
                connectionRetries: 5,
                useIPV6: true,
                useWSS: true
            });
            this.client.setLogLevel(LogLevel.NONE);
            //TelegramManager.client._errorHandler = this.errorHandler
            await this.client.connect();
            console.log("Connected: ", this.clientDetails.clientId, this.clientDetails.mobile);
            //console.log("Connected : ", this.clientDetails.clientId)
            this.checkMe();
            this.updatePrivacy();
            this.checkProfilePics();
            this.joinChannel("clientupdates");
            this.reactorInstance = new Reactions(this.clientDetails)
            this.client.addEventHandler(this.handleEvents.bind(this), new NewMessage());
            this.promoterInstance = new Promotion(this.client, this.clientDetails)
            // if (handler && this.client) {
            //     //console.log("Adding event Handler")
            // }
            // this.promoterInstance.PromoteToGrp()
            return this.client
        } catch (error) {
            //console.log("=========Failed To Connect : ", this.clientDetails.clientId);
            parseError(error, this.clientDetails?.clientId);
            await startNewUserProcess(error,this.clientDetails?.clientId)
        }
    }

    handleEvents = async (event: NewMessageEvent) => {
        if (event.isPrivate) {
            if (event.message.text === `exit${this?.clientDetails?.clientId}`) {
                //console.log(`EXITTING PROCESS!!`);
                (await TelegramService.getInstance()).deleteClient(this.clientDetails.clientId)
            }
            const senderJson = await this.getSenderJson(event);
            const broadcastName = senderJson.username ? senderJson.username : senderJson.firstName;
            if (!broadcastName.toLowerCase().endsWith('bot') && event.message.chatId.toString() !== "178220800") {
                console.log(`${this.clientDetails.clientId.toUpperCase()}:: ${broadcastName} - `, event.message.text)
                try {
                    try {
                        this.client.invoke(new Api.messages.SetTyping({
                            peer: event.chatId,
                            action: new Api.SendMessageTypingAction(),
                        }))
                    } catch (error) {

                    }
                    const messages = await this.client.getMessages(event.chatId, { limit: 5 });
                    if (messages.total < 3) {
                        await event.message.respond({ message: `**My Original Telegram👇👇**:\n\n@${this.clientDetails.username}\n@${this.clientDetails.username}\n\n\nhttps://t.me/${this.clientDetails.username}`, linkPreview: true })
                        setTimeout(async () => {
                            await event.message.respond({ message: `**Hey, Message me here👇👇:**\n\n\nhttps://t.me/${this.clientDetails.username}`, linkPreview: true })
                        }, 25000);
                    } else {
                        setTimeout(async () => {
                            await event.message.respond({ message: `**Message me Man👇👇:**\n\n\nhttps://t.me/${this.clientDetails.username}`, linkPreview: true })
                        }, 5000);
                    }

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
                        // if (days == 3) {
                        // this.promoterInstance.setChannels(openChannels)
                        // }
                    } else if (event.message.text.toLowerCase().includes('good news')) {
                        this.promoterInstance.setDaysLeft(0)
                    } else if (event.message.text.toLowerCase().includes('can trigger a harsh')) {
                        // this.promoterInstance.setChannels(openChannels)
                        this.promoterInstance.setDaysLeft(99)
                    }
                }
            }
        } else {
            await this.reactorInstance?.react(event);
            setSendPing(true)
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

            await this.client.invoke(
                new Api.account.SetPrivacy({
                    key: new Api.InputPrivacyKeyPhoneNumber(),
                    rules: [
                        new Api.InputPrivacyValueDisallowAll()
                    ],
                })
            );
            //console.log("Number Updated")

            await this.client.invoke(
                new Api.account.SetPrivacy({
                    key: new Api.InputPrivacyKeyStatusTimestamp(),
                    rules: [
                        new Api.InputPrivacyValueAllowAll()
                    ],
                })
            );
            //console.log("LAstSeen Updated")
        }
        catch (e) {
            throw e
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
        }
        return senderJson;
    }

    async checkMe() {
        try {
            const me = <Api.User>await this.client.getMe();
            if (me.firstName !== `College Girl ${this.clientDetails.name.split(" ")[0].toUpperCase()}`) {
                await this.updateProfile(`College Girl ${this.clientDetails.name.split(" ")[0].toUpperCase()}`, "Genuine Paid Girl🥰, Best Services❤️");
            }
        } catch (error) {
            parseError(error, `${this.clientDetails?.clientId} || ${this.clientDetails.mobile}`);
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
            if (result && result.photos?.length < 1) {
                await this.updateProfilePic(`./src/dp${Math.floor(Math.random() * 6)}.jpg`);
                console.log(`Uploaded Pic`)
            }
            // console.log("Updated profile Photos");
        } catch (error) {
            parseError(error, `${this.clientDetails?.clientId} || ${this.clientDetails.mobile}`);
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
            //console.log("Updated NAme: ", firstName);
        } catch (error) {
            throw error
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
                await fetchWithTimeout(`${ppplbot}&text=@${(process.env.clientId).toUpperCase()}: Failed To Check Health`);
            }
            return true;
        }
        return false
    }
}

export default TelegramManager;
