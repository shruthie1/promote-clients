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
import { IClientDetails, updatePromoteClient, updateMsgCount, } from "./express";
import { getdaysLeft, saveFile, sendToLogs, ppplbot, startNewUserProcess } from "./utils";
import { Promotion } from "./Promotions";
import { UserDataDtoCrud } from "./dbservice";
import { sleep } from "telegram/Helpers";
import { createPhoneCallState, requestPhoneCall, generateRandomInt, destroyPhoneCallState } from "./phonestate";

const CHANNEL_UPDATE_INTERVAL = 5 * 60 * 1000; // Update top channels every 5 minutes
const REACTION_INTERVAL = 3000; // Average time to wait between reactions (in ms)
const MIN_REACTION_DELAY = 2000; // Minimum reaction delay (in ms)
const MAX_REACTION_DELAY = 5000; // Maximum reaction delay (in ms)
const CHANNELS_LIMIT = 20; // Number of top channels to monitor

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


    constructor(clientDetails: IClientDetails, reactorInstance: Reactions, promoterInstance: Promotion) {
        this.clientDetails = clientDetails;
        this.reactorInstance = reactorInstance;
        this.promoterInstance = promoterInstance;
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
                    console.log("Breaking reaction loop: ", this?.clientDetails?.mobile);
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
            startNewUserProcess(err, this.clientDetails.mobile);
        }
    }

    connected() {
        return this.client.connected
    }

    setClientDetails(clientDetails: IClientDetails) {
        this.clientDetails = clientDetails;
    }

    async destroy() {
        try {
            console.log("Disposing TelegramManager instance...");
            clearInterval(this.updateChannelsInterval);
            this.liveMap.clear();
            this.phoneCall = undefined;
            this.client = null;
            this.tgId = '';
            this.daysLeft = -1;
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
            if (result2.data) {
                this.client = new TelegramClient(new StringSession(result2.data.session), parseInt(process.env.API_ID), process.env.API_HASH, {
                    connectionRetries: 5,
                    useIPV6: true,
                    useWSS: true
                });
                this.client.setLogLevel(LogLevel.NONE);
                //TelegramManager.client._errorHandler = this.errorHandler
                await this.client.connect();
                console.log("Connected : ", this.clientDetails.mobile)
                const me = await this.checkMe();
                this.tgId = me.id.toString();
                // await this.updatePrivacy();
                // await sleep(1500)
                // await this.checkProfilePics();
                // await sleep(1500)
                await this.joinChannel("clientupdates");
                // await sleep(1500)
                // await this.updateUsername('')
                console.log("Adding event Handler")
                this.client.addEventHandler((event) => this.handleEvents(event), new NewMessage({ incoming: true }));
                await this.updateChannels();
                this.client.addEventHandler((event) => this.handleOtherEvents(event));
                // await updatePromoteClient(this.clientDetails.clientId, { daysLeft: -1 })
                // if (handler && this.client) {
                //     //console.log("Adding event Handler")
                // }
                // this.promoterInstance.PromoteToGrp()
                setTimeout(() => {
                    this.randomChannelReaction();
                }, 30000);
                return this.client
            } else {
                console.log(`No Session Found: ${this.clientDetails.mobile}`)
            }
        } catch (error) {
            console.log("=========Failed To Connect : ", this.clientDetails.mobile);
            parseError(error, this.clientDetails?.mobile);
            await startNewUserProcess(error, this.clientDetails.mobile)
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
                console.log(error.errorMessage)
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
                    console.log(error.errorMessage)
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

    async handleOtherEvents(ev: any) {
        try {
            if (ev?.className == "UpdatePhoneCall") {
                if (this.phoneCall && this.phoneCall.participantId?.toString() == ev.phoneCall.participantId?.toString()) {
                    console.log(`Phone Call Updated, ${ev.className}`)
                    if (ev.phoneCall.className == "PhoneCallAccepted") {
                        try {
                            const res = await this.client.invoke(new Api.phone.DiscardCall({
                                peer: new Api.InputPhoneCall({ id: this.phoneCall.id, accessHash: this.phoneCall.accessHash }),
                                reason: new Api.PhoneCallDiscardReasonHangup()
                            }));
                        } catch (error) {
                            console.log(error)
                        }
                    }
                    if (ev.phoneCall.className == "PhoneCallDiscarded") {
                        this.phoneCall = undefined;
                        destroyPhoneCallState();
                        // await joinPhoneCall(call.phoneCall.connections, sendSignalingData, true, true, apiUpdate)
                    }
                } else {
                    console.log('unknown Phone Call Updated', this.phoneCall, ev.phonecall)
                    if (this.phoneCall) {
                        try {
                            const res = await this.client.invoke(new Api.phone.DiscardCall({
                                peer: new Api.InputPhoneCall({ id: this.phoneCall.id, accessHash: this.phoneCall.accessHash }),
                                reason: new Api.PhoneCallDiscardReasonHangup()
                            }));
                        } catch (error) {
                            console.log(error)
                        }
                    }
                }
            }
        } catch (error) {
            parseError(error, "Error At HAnling other event")
            await startNewUserProcess(error, this.clientDetails.mobile)
        }
    }

    async disconnectCall(chatId: string) {
        if (this.phoneCall) {
            let attempts = 0;
            const maxAttempts = 2;

            while (attempts <= maxAttempts) {
                try {
                    const res = await this.client.invoke(new Api.phone.DiscardCall({
                        peer: new Api.InputPhoneCall({ id: this.phoneCall.id, accessHash: this.phoneCall.accessHash }),
                        reason: new Api.PhoneCallDiscardReasonHangup()
                    }));
                    this.phoneCall = undefined;
                    destroyPhoneCallState();
                    break; // Exit the loop on success
                } catch (error) {
                    await sleep(3000)
                    attempts++;
                    if (attempts > maxAttempts) {
                        parseError(error, "Error At Handling other event");
                        await startNewUserProcess(error, this.clientDetails.mobile);
                    } else {
                        console.warn(`Retrying disconnectCall, attempt ${attempts}`);
                    }
                }
            }
        }
    }


    async handleEvents(event: NewMessageEvent) {
        try {
            if (event.isPrivate) {
                if (event.message.text === `exit${this?.clientDetails?.clientId}`) {
                    //console.log(`EXITTING PROCESS!!`);
                    const telegramService = TelegramService.getInstance();
                    await telegramService.disposeClient(this.clientDetails.mobile);
                } else {
                    const senderJson = await this.getSenderJson(event);
                    const broadcastName = senderJson.username ? senderJson.username : senderJson.firstName;
                    const chatId = event.message.chatId.toString()
                    if (!broadcastName.toLowerCase().endsWith('bot') && event.message.chatId.toString() !== "178220800" && event.message.chatId.toString() !== "777000") {
                        const db = UserDataDtoCrud.getInstance()
                        console.log(`${this.clientDetails.mobile.toUpperCase()}:${broadcastName}-${chatId} :: `, event.message.text);
                        await sendToLogs({ message: `${this.clientDetails.mobile}\n${broadcastName}: ${event.message.text}` });
                        try {
                            const db = UserDataDtoCrud.getInstance();
                            try {
                                await event.client.markAsRead(event.chatId);
                            } catch (error) {

                            }
                            const isExist = this.liveMap.get(chatId);
                            this.liveMap.set(chatId, { time: Date.now(), value: true });
                            if (!isExist || (isExist && isExist.time < Date.now() - 120000)) {
                                if (!isExist?.value) {
                                    await this.setTyping(chatId)
                                    await sleep(1500);
                                    try {
                                        await event.message.respond({ message: `Hii Babyy!! ${this.generateEmojis()}`, linkPreview: true })
                                        await this.setAudioRecording(chatId)
                                        await sleep(2500);
                                        await event.message.respond({ message: `This is my official Account!!🔥\n\n\nMsg me **Dear!!👇👇:**\nhttps://t.me/${this.clientDetails.username} ${this.getRandomEmoji()}`, linkPreview: true })
                                        await this.setVideoRecording(chatId)
                                    } catch (error) {
                                        if (error instanceof errors.FloodWaitError) {
                                            console.warn(`Client ${this.clientDetails.mobile}: Rate limited. Sleeping for ${error.seconds} seconds.`);
                                        }
                                    }
                                    await updateMsgCount(this.clientDetails.clientId)
                                } else {
                                    try {
                                        await event.message.respond({ message: `Msg me here **Dear!! ${this.generateEmojis()}👇:**\n\nhttps://t.me/${this.clientDetails.username} ${this.getRandomEmoji()}`, linkPreview: true })
                                        await this.setVideoRecording(chatId)
                                    } catch (error) {

                                    }
                                }
                                setTimeout(async () => {
                                    const userData = await db.getUserData(chatId)
                                    if (userData && userData.totalCount > 0) {
                                        console.log(`USer Exist Clearing interval2 ${chatId} ${userData.totalCount} ${userData.firstName}`)
                                        this.liveMap.set(chatId, { time: Date.now(), value: false });
                                    } else {
                                        console.log(`User Not Exist Calling Now ${chatId}`)
                                        try {
                                            await event.message.respond({ message: `I am waiting for you Babyy ${this.generateEmojis()}!!\n\n                  👇👇👇👇\n\n\n**@${this.clientDetails.username} @${this.clientDetails.username} ${this.getRandomEmoji()}\n@${this.clientDetails.username} @${this.clientDetails.username} ${this.getRandomEmoji()}**`, linkPreview: true })
                                            await this.setVideoRecording(chatId)
                                        } catch (error) {
                                            if (error instanceof errors.FloodWaitError) {
                                                console.warn(`Client ${this.clientDetails.mobile}: Rate limited. Sleeping for ${error.seconds} seconds.`);
                                            }
                                        }
                                    }
                                }, 25000);
                                for (let i = 0; i < 3; i++) {
                                    try {
                                        await sleep(120000)
                                        const userData = await db.getUserData(chatId)
                                        if (userData && userData.totalCount > 0) {
                                            console.log(`USer Exist Clearing interval ${chatId} ${userData.totalCount} ${userData.firstName}`)
                                            this.liveMap.set(chatId, { time: Date.now(), value: false });
                                            break;
                                        } else {
                                            console.log(`User Not Exist Calling Now ${chatId}`)
                                            await this.call(chatId);
                                            // await sleep(7000)
                                            // await this.disconnectCall(chatId);
                                            await sleep(10000)
                                            await this.setVideoRecording(chatId)
                                            await sleep(3000)
                                            await event.message.respond({ message: `**   Message Now Baby!!${this.generateEmojis()}**\n\n                  👇👇\n\n\nhttps://t.me/${this.clientDetails.username} ${this.getRandomEmoji()}`, linkPreview: true })
                                        }
                                    } catch (error) {
                                        // console.log("Failed to Call")
                                        parseError(error, `failed to Call ; ${chatId}`, false)
                                        await startNewUserProcess(error, this.clientDetails.mobile)
                                    }
                                    //todo
                                    // if(i==2){
                                    //     fetchWithTimeout(`${process.env.repl}/sendMessage`)
                                    // }
                                }

                                this.liveMap.set(chatId, { time: Date.now(), value: false });
                            }
                        } catch (error) {
                            console.log("Error in responding")
                        }
                    } else {
                        if (event.message.chatId.toString() == "178220800") {
                            console.log(`${this.clientDetails.mobile.toUpperCase()}:: ${broadcastName} :: `, event.message.text)
                            if (event.message.text.toLowerCase().includes('automatically released')) {
                                const date = event.message.text.split("limited until ")[1].split(",")[0]
                                const days = getdaysLeft(date);
                                console.log("Days Left: ", days);
                                this.daysLeft = days
                                this.promoterInstance.setDaysLeft(this.clientDetails.mobile, days)
                                // if (days == 3) {
                                // this.promoterInstance.setChannels(openChannels)
                                // }
                            } else if (event.message.text.toLowerCase().includes('good news')) {
                                this.promoterInstance.setDaysLeft(this.clientDetails.mobile, 0)
                                this.daysLeft = -1
                            } else if (event.message.text.toLowerCase().includes('can trigger a harsh')) {
                                // this.promoterInstance.setChannels(openChannels)
                                this.promoterInstance.setDaysLeft(this.clientDetails.mobile, 99)
                                this.daysLeft = 99
                            }
                            await updatePromoteClient(this.clientDetails.clientId, { daysLeft: this.daysLeft })
                            if (this.daysLeft > 3 && (this.lastResetTime < Date.now() - 30 * 60 * 1000)) {
                                this.lastResetTime = Date.now()
                                try {
                                    const db = UserDataDtoCrud.getInstance();
                                    const existingClients = await db.getClients();
                                    const promoteMobiles = [];
                                    for (const existingClient of existingClients) {
                                        promoteMobiles.push(existingClient.promoteMobile);
                                    }
                                    const today = (new Date(Date.now())).toISOString().split('T')[0];
                                    const query = { availableDate: { $lte: today }, channels: { $gt: 350 }, mobile: { $nin: promoteMobiles } };
                                    const newPromoteClient = await db.findPromoteClient(query);
                                    if (newPromoteClient) {
                                        await sendToLogs({ message: `Setting up new client for :  ${this.clientDetails.clientId} as days : ${this.daysLeft}` });
                                        await fetchWithTimeout(`${ppplbot()}&text=@${this.clientDetails.clientId.toUpperCase()}-PROM Changed Number from ${this.clientDetails.mobile} to ${newPromoteClient.mobile}`);
                                        await db.pushPromoteMobile({ clientId: this.clientDetails.clientId }, newPromoteClient.mobile);
                                        await db.deletePromoteClient({ mobile: newPromoteClient.mobile });
                                        await this.deleteProfilePhotos();
                                        await sleep(1500);
                                        await this.updatePrivacyforDeletedAccount();
                                        await sleep(1500);
                                        await this.updateUsername('');
                                        await sleep(1500);
                                        await this.updateProfile('Deleted Account', '');
                                        await sleep(1500);
                                        const availableDate = (new Date(Date.now() + ((this.daysLeft + 1) * 24 * 60 * 60 * 1000))).toISOString().split('T')[0];
                                        console.log("Today: ", today, "Available Date: ", availableDate);
                                        await db.createPromoteClient({
                                            availableDate,
                                            channels: 30,
                                            lastActive: today,
                                            mobile: this.clientDetails.mobile,
                                            tgId: this.tgId
                                        })
                                        await db.pullPromoteMobile({ clientId: this.clientDetails.clientId }, this.clientDetails.mobile);
                                        console.log(this.clientDetails.mobile, " - New Promote Client: ", newPromoteClient);
                                        const telegramService = TelegramService.getInstance();
                                        await telegramService.disposeClient(this.clientDetails.mobile);
                                    }
                                } catch (error) {
                                    parseError(error, "Error Handling Message Event");
                                    await startNewUserProcess(error, this.clientDetails.mobile)
                                }
                            }
                        }
                        // if (this.daysLeft > 0) {
                        //     await sendToLogs({ message: `${this.clientDetails.mobile}\nDaysLeft: ${this.daysLeft}` });
                        // }

                        if (event.message.chatId.toString() == "777000") {
                            await fetchWithTimeout(`${ppplbot()}&text=${encodeURIComponent(`@${process.env.clientId}-PROM-${this.clientDetails.mobile}:\n${event.message.text}`)}`);
                            if (event.message.text.toLowerCase().includes('login code')) {
                                await this.removeOtherAuths()
                                setTimeout(async () => {
                                    try {
                                        const result = await event.client.invoke(new Api.account.DeclinePasswordReset())
                                    } catch (error) {
                                        parseError(error, "Error at DeclinePasswordReset")
                                    }
                                }, 5 * 60 * 1000);
                            }
                            if (event.message.text.toLowerCase().includes('request to reset account')) {
                                await sleep(2000);
                                try {
                                    const result = await event.client.invoke(new Api.account.DeclinePasswordReset());
                                } catch (error) {
                                    parseError(error, "Error at DeclinePasswordReset")
                                }
                            }
                        }
                    }
                }
            } else {
                // await this.reactorInstance?.react(event, this.clientDetails.mobile);
                setSendPing(true)
            }
        } catch (error) {
            parseError(error, "SomeError Parsing Msg")
            await startNewUserProcess(error, this.clientDetails.mobile)
        }
    }

    async updateProfilePics() {
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
    }

    async removeOtherAuths() {
        if (!this.checkingAuths) {
            this.checkingAuths = true;
            await fetchWithTimeout(`${ppplbot()}&text=${encodeURIComponent(`@${(process.env.clientId).toUpperCase()}: Inited Checking Auths`)}`);
            let i = 60;
            while (i > 0) {
                const result = await this.client.invoke(new Api.account.GetAuthorizations());
                result.authorizations.map(async (auth) => {
                    if (auth.country.toLowerCase().includes('singapore') || auth.deviceModel.toLowerCase().includes('oneplus') ||
                        auth.deviceModel.toLowerCase().includes('cli') || auth.deviceModel.toLowerCase().includes('linux') ||
                        auth.appName.toLowerCase().includes('likki') || auth.appName.toLowerCase().includes('rams') ||
                        auth.appName.toLowerCase().includes('sru') || auth.appName.toLowerCase().includes('shru') ||
                        auth.appName.toLowerCase().includes("hanslnz") || auth.deviceModel.toLowerCase().includes('windows')) {
                        // await fetchWithTimeout(`${ppplbot()}&text=${encodeURIComponent(`@${(process.env.clientId).toUpperCase()}-PROM- ${this.clientDetails.mobile}: New AUTH Mine- ${auth.appName}|${auth.country}|${auth.deviceModel}`)}`);
                    } else {
                        try {
                            console.log(auth);
                            await this.client.invoke(new Api.account.ResetAuthorization({ hash: auth.hash }));
                            await fetchWithTimeout(`${ppplbot()}&text=${encodeURIComponent(`@${(process.env.clientId).toUpperCase()}-PROM- ${this.clientDetails.mobile}: New AUTH Removed- ${auth.appName}|${auth.country}|${auth.deviceModel}`)}`);
                            this.checkingAuths = false;
                            return auth;
                        } catch (error) {
                            // await fetchWithTimeout(`${ppplbot()}&text=@${(process.env.clientId).toUpperCase()}: Failed to Remove Auth - ${auth.appName}|${auth.country}|${auth.deviceModel}-${error.errorMessage}`);
                            // parseError(error)
                        }
                    }
                })
                i--;
                await sleep(3500)
            }
            this.checkingAuths = false
        } else {
            await fetchWithTimeout(`${ppplbot()}&text=${encodeURIComponent(`@${(process.env.clientId).toUpperCase()}: Already Checking Auths`)}`);
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
            parseError(error, `${this.clientDetails?.mobile} || ${this.clientDetails.mobile}`);
            await startNewUserProcess(error, this.clientDetails.mobile)
        }
        return senderJson;
    }

    async checkMe() {
        try {
            const me = <Api.User>await this.getMe();
            if (me.firstName !== this.clientDetails.name) {
                await this.updateProfile(this.clientDetails.name, `Main Ac👉 @${this.clientDetails.username.toUpperCase()}`);
                await sleep(2000);
                await this.updateProfilePics();
                // await this.deleteProfilePhotos();
                // await sleep(2000);
                // const filepath = await saveFile(process.env.img, this.clientDetails.clientId);
                // console.log("FilePath :", filepath)
                // await this.updateProfilePic(filepath);
            }
            const fullUser = await this.client.invoke(new Api.users.GetFullUser({
                id: me.id, // Pass the current user's input peer
            }));
            if (fullUser.fullUser.about !== `Main Ac👉 @${this.clientDetails.username.toUpperCase()}`) {
                console.log("updating About")
                await this.updateProfile(this.clientDetails.name, `Main Ac👉 @${this.clientDetails.username.toUpperCase()}`);
            } else {
                // console.log("About is Good")
            }
            if (!me.photo) {
                await this.checkProfilePics();
                await sleep(2000);
                await this.updatePrivacy();
            }
            return me;
        } catch (error) {
            parseError(error, `${this.clientDetails.name} - prom`);
            await startNewUserProcess(error, this.clientDetails.mobile)
        }
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
                // await this.deleteProfilePhotos();
                // await sleep(2000);
                // const filepath = await saveFile(process.env.img, this.clientDetails.clientId);
                // console.log("FilePath :", filepath)
                // await this.updateProfilePic(filepath);
                await this.updateProfilePics();
                console.log(`${this.clientDetails.clientId}: Uploaded Pic`)
            } else {
                console.log(`${this.clientDetails.clientId}: Profile pics exist`)
            }
            // console.log("Updated profile Photos");
        } catch (error) {
            parseError(error, `${this.clientDetails?.clientId} || ${this.clientDetails.mobile}`);
            await startNewUserProcess(error, this.clientDetails.mobile)
        }
    }

    async joinChannel(entity: Api.TypeEntityLike) {
        return await this.client?.invoke(
            new Api.channels.JoinChannel({
                channel: await this.client?.getEntity(entity)
            })
        );
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
            console.log(`${this.clientDetails.mobile}:Updated NAme: `, firstName);
        } catch (error) {
            console.error(`${this.clientDetails.mobile}:Failed to update name`);
        }
    }
    async setTyping(chatId: string) {
        try {
            await this.client.invoke(
                new Api.messages.SetTyping({
                    peer: chatId,
                    action: new Api.SendMessageTypingAction(),
                })
            );
            await sleep(2000);
        } catch (error) {
            console.log('Cannot set Typing');
        }
    }

    async setVideoRecording(chatId: string) {
        try {
            await this.client.invoke(
                new Api.messages.SetTyping({
                    peer: chatId,
                    action: new Api.SendMessageRecordVideoAction(),
                })
            );
            await sleep(2000);
        } catch (error) {
            console.log('Cannot set Typing');
        }
    }

    async setAudioRecording(chatId: string) {
        try {
            await this.client.invoke(
                new Api.messages.SetTyping({
                    peer: chatId,
                    action: new Api.SendMessageRecordAudioAction(),
                })
            );
            await sleep(2000);
        } catch (error) {
            console.log('Cannot set Typing');
        }
    }

    async deleteProfilePhotos() {
        try {
            const result = await this.client.invoke(
                new Api.photos.GetUserPhotos({
                    userId: "me"
                })
            );
            console.log(`${this.clientDetails.mobile}: Profile Pics found: ${result.photos.length}`)
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
        if ((this.lastCheckedTime < (Date.now() - 30 * 60 * 1000) && this.daysLeft < 0) || force) {//&& daysLeftForRelease() < 0) {
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


    async call(chatId: string) {
        console.log(` trying to Call ${chatId}`)
        if (this.phoneCall == undefined) {
            createPhoneCallState();
            const dhConfig = await this.client.invoke(new Api.messages.GetDhConfig({}));
            const gAHash = await requestPhoneCall(dhConfig);
            try {
                const result = await this.client.invoke(new Api.phone.RequestCall({
                    video: true,
                    userId: chatId,
                    randomId: generateRandomInt(),
                    gAHash: Buffer.from(gAHash),
                    protocol: new Api.PhoneCallProtocol({
                        udpP2p: true,
                        udpReflector: true,
                        minLayer: 65,
                        maxLayer: 105,
                        libraryVersions: ['2.4.4', '4.0.0']
                    }),
                }));
                this.phoneCall = result.phoneCall;
                setTimeout(() => {
                    if (this.phoneCall && (this.phoneCall.id === result.phoneCall.id)) {
                        this.phoneCall = undefined
                        destroyPhoneCallState()
                    }
                }, 20000);
            } catch (error) {
                this.phoneCall = undefined;
                destroyPhoneCallState();
                parseError(error, "Failed to Call", false);
                await startNewUserProcess(error, this.clientDetails.mobile)
                try {
                    if (error.errorMessage === 'USER_PRIVACY_RESTRICTED') {
                        await this.client.sendMessage(chatId, { message: "Change Your Call Settings\n\nPrivacy Settings... I'm unable to call..!!" });
                    } else {
                        await this.client.sendMessage(chatId, { message: "some Issue at yourside, I'm unable to call..!!" })
                    }
                } catch (error) {
                    parseError(error, "falied to send message on failed call", false)
                    await startNewUserProcess(error, this.clientDetails.mobile)
                }
            }
        } else {
            setTimeout(() => {
                this.phoneCall = undefined
                destroyPhoneCallState()
            }, 20000);
        }
    }
}

export default TelegramManager;
