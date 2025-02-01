import { getClientDetails, getMapKeys, getMapValues, IClientDetails } from "./express";
import { parseError } from "./parseError";
import { Reactions } from "./react";
import { loadReactionsFromFile } from "./reaction.utils";
import TelegramManager from "./TelegramManager";
export class TelegramService {
    private static clientsMap: Map<string, TelegramManager> = new Map();
    private static instance: TelegramService;
    private reactorInstance: Reactions;

    private constructor() {}

    public static getInstance(): TelegramService {
        if (!TelegramService.instance) {
            TelegramService.instance = new TelegramService();
        }
        return TelegramService.instance;
    }

    async updateProfilePics() {
        for (const [mobile, tgManager] of TelegramService.clientsMap.entries()) {
            await tgManager.updateProfilePics();
        }
    }

    getLastMessageTime(mobile: string) {
        const tgManager = this.getClient(mobile);
        return tgManager?.promoterInstance.lastMessageTime;
    }

    getDaysLeft(mobile: string) {
        const tgManager = this.getClient(mobile);
        return tgManager?.daysLeft;
    }

    startPromotion(mobile: string) {
        const tgManager = this.getClient(mobile);
        return tgManager?.promoterInstance.startPromotion();
    }

    getPromotionResults() {
        const result = {};
        for (const mobile of this.getMobiles()) {
            const tgManager = this.getClient(mobile);
            result[mobile] = tgManager?.promoterInstance?.getPromotionResults();
        }
        return result;
    }

    getMobileStats() {
        const result = {};
        for (const mobile of this.getMobiles()) {
            const tgManager = this.getClient(mobile);
            result[mobile] = tgManager?.promoterInstance?.getMobileStats();
            delete result[mobile]["lastCheckedTime"];
            delete result[mobile]["sleepTime"];
            delete result[mobile]["releaseTime"];
            delete result[mobile]["lastMessageTime"];
        }
        return result;
    }

    resetPromotionResults() {
        const result = {};
        for (const mobile of this.getMobiles()) {
            const tgManager = this.getClient(mobile);
            result[mobile] = tgManager?.promoterInstance?.resetPromotionResults();
        }
        return result;
    }

    resetMobileStats() {
        const result = {};
        for (const mobile of this.getMobiles()) {
            const tgManager = this.getClient(mobile);
            result[mobile] = tgManager?.promoterInstance?.resetMobileStats();
        }
        return result;
    }

    saveMobileStats() {
        const result = {};
        for (const mobile of this.getMobiles()) {
            const tgManager = this.getClient(mobile);
            result[mobile] = tgManager?.promoterInstance?.saveResultsToJson();
        }
        return result;
    }

    importMobileStats() {
        const result = {};
        for (const mobile of this.getMobiles()) {
            const tgManager = this.getClient(mobile);
            result[mobile] = tgManager?.promoterInstance?.saveResultsToJson();
        }
        return result;
    }

    async setMobiles(mobiles: string[]) {
        await this.reactorInstance.setMobiles(mobiles)
    }
    public async connectClients() {
        console.log("Connecting....!!");
        const mobiles = getMapKeys();
        console.log("Total clients:", mobiles.length);
        this.reactorInstance = new Reactions(mobiles, this.getClient.bind(this))
        await loadReactionsFromFile();
        for (const mobile of mobiles) {
            const clientDetails = getClientDetails(mobile)
            await this.createClient(clientDetails, false, true);
        }
        console.log("Connected....!!");
    }

    public getAverageReactionDelay() {
        return this.reactorInstance.averageReactionDelay
    }

    public getLastReactedTime() {
        return this.reactorInstance.lastReactedtime
    }

    public getTgManagers() {
        return Array.from(TelegramService.clientsMap.values())
    }

    public getMobiles() {
        return Array.from(TelegramService.clientsMap.keys())
    }

    public getClient(mobile: string) {
        // console.log("Getting Client :", mobile)
        const tgManager = TelegramService.clientsMap.get(mobile);
        try {
            if (tgManager) {
                return tgManager
            } else {
                console.log(`tg manager is undefined: ${mobile}`)
                return undefined;
            }
        } catch (error) {
            console.log(error);
            process.exit(1);
        }
    }

    public hasClient(mobile: string) {
        return TelegramService.clientsMap.has(mobile);
    }

    async disposeClient(mobile: string) {
        try {
            let tgManager = await this.getClient(mobile);
            if (tgManager) {
                await tgManager.destroy();
                console.log(`Disconnected and disposed old client for ${mobile}.`)
            }
            return TelegramService.clientsMap.delete(mobile)
        } catch (disposeError) {
            parseError(disposeError, `Failed to dispose old client for ${mobile}:`)
        }
    }

    async deleteClient(mobile: string) {
        let tgManager = await this.getClient(mobile);
        if (tgManager) {
            await tgManager.destroy(); // Ensure this cleans up all resources
            console.log(`Client ${mobile} destroyed.`);
            tgManager = null;
        } else {
            console.log(`Client ${mobile} not found.`);
        }
        console.log("Disconnected : ", mobile)
        TelegramService.clientsMap.set(mobile, null);
        return TelegramService.clientsMap.delete(mobile);
    }

    async disconnectAll() {
        const data = TelegramService.clientsMap.entries();
        console.log("Disconnecting All Clients");
        for (const [clientId, tgManager] of data) {
            try {
                this.reactorInstance = null;
                await tgManager.client?.disconnect();
                TelegramService.clientsMap.delete(clientId);
                console.log(`Client disconnected: ${clientId}`);
            } catch (error) {
                console.log(parseError(error, "Failed to Disconnect"));
                console.log(`Failed to Disconnect : ${clientId}`);
            }
        }
        TelegramService.clientsMap.clear();
    }

    async createClient(clientDetails: IClientDetails, autoDisconnect = false, handler = true): Promise<TelegramManager> {
        const clientData = await this.getClient(clientDetails.mobile)
        if (!clientData || !clientData.client) {
            const telegramManager = new TelegramManager(clientDetails, this.reactorInstance);
            try {
                const client = await telegramManager.createClient(handler);
                TelegramService.clientsMap.set(clientDetails.mobile, telegramManager);
                if (client) {
                    await client.getMe();
                    if (autoDisconnect) {
                        setTimeout(async () => {
                            if (client.connected || await this.getClient(clientDetails.mobile)) {
                                console.log("SELF destroy client : ", clientDetails.mobile);
                                await telegramManager.client.disconnect();
                            } else {
                                console.log("Client Already Disconnected : ", clientDetails.mobile);
                            }
                            TelegramService.clientsMap.delete(clientDetails.mobile);
                        }, 180000)
                    } else {
                        // setInterval(async () => {
                        //     //console.log("destroying loop :", mobile)
                        //     //client._destroyed = true
                        //     // if (!client.connected) {
                        //     // await client.connect();
                        //     //}
                        // }, 20000);
                    }
                    return telegramManager;
                } else {
                    console.log(`Client Expired: ${clientDetails.mobile}`)
                    // throw new BadRequestException('Client Expired');
                }
            } catch (error) {
                console.log("Parsing Error");
                const errorDetails = parseError(error, clientDetails.mobile);
            }
        } else {
            console.log("Client Already exists: ", clientDetails.mobile)
            return this.getClient(clientDetails.mobile)
        }
    }

    public promotionsBannedMobiles(): string {
        const twentyMinutesAgo = Date.now() - 20 * 60 * 1000;
        const mobilesWithOldMessages: string[] = [];

        for (const mobile of this.getMobiles()) {
            const lastMessageTime = this.getLastMessageTime(mobile);
            if (lastMessageTime && lastMessageTime < twentyMinutesAgo) {
                const minutesAgo = Math.floor((Date.now() - lastMessageTime) / (60 * 1000));
                mobilesWithOldMessages.push(`${mobile} : ${minutesAgo} mins`);
            }
        }

        console.log("Mobiles with last message time greater than 20 minutes:");
        mobilesWithOldMessages.forEach(mobile => console.log(mobile));

        return mobilesWithOldMessages.join("\n");
    }
}