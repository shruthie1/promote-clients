import { getClientDetails, getMapKeys, getMapValues, IClientDetails } from "./express";
import { parseError } from "./parseError";
import { Promotion } from "./Promotions";
import { Reactions } from "./react";
import TelegramManager from "./TelegramManager";
export class TelegramService {
    private static clientsMap: Map<string, TelegramManager> = new Map();
    private static promotersMap: Map<string, Promotion> = new Map();
    private static instance: TelegramService;
    private reactorInstance: Reactions;

    private constructor() {}

    public static getInstance(): TelegramService {
        if (!TelegramService.instance) {
            TelegramService.instance = new TelegramService();
        }
        return TelegramService.instance;
    }

    startPromotion(mobile: string) {
        const promoterInstance = TelegramService.promotersMap.get(mobile);
        return promoterInstance?.startPromotion();
    }

    getLastMessageTime(mobile: string) {
        const promoterInstance = TelegramService.promotersMap.get(mobile);
        return promoterInstance?.getLastMessageTime();
    }

    getDaysLeft(mobile: string) {
        const promoterInstance = TelegramService.promotersMap.get(mobile);
        return promoterInstance?.getDaysLeft();
    }

    async setMobiles(mobiles: string[]) {
        await this.reactorInstance.setMobiles(mobiles)
    }
    public async connectClients() {
        console.log("Connecting....!!");
        const mobiles = getMapKeys();
        console.log("Total clients:", mobiles.length);
        this.reactorInstance = new Reactions(mobiles, this.getClient.bind(this))
        for (const mobile of mobiles) {
            const clientDetails = getClientDetails(mobile)
            await this.createClient(clientDetails, false, true);
            setTimeout(() => {
                const promoterInstance = TelegramService.promotersMap.get(mobile);
                promoterInstance?.startPromotion();
            }, 60000);
        }
        console.log("Connected....!!");
    }

    public getAverageReactionDelay() {
        return this.reactorInstance.getAverageReactionDelay()
    }

    public getMapValues() {
        return Array.from(TelegramService.clientsMap.values())
    }

    public getMapKeys() {
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
                tgManager = null;
                let promotorInstance = TelegramService.promotersMap.get(mobile);
                promotorInstance = null
                TelegramService.promotersMap.delete(mobile);
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
        for (const [mobile, tgManager] of data) {
            try {
                this.reactorInstance = null;
                await tgManager.client?.disconnect();
                TelegramService.clientsMap.delete(mobile);
                TelegramService.promotersMap.delete(mobile);
                console.log(`Client disconnected: ${mobile}`);
            } catch (error) {
                console.log(parseError(error, "Failed to Disconnect"));
                console.log(`Failed to Disconnect : ${mobile}`);
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
                const promoterInstance = new Promotion(telegramManager);
                TelegramService.promotersMap.set(clientDetails.mobile, promoterInstance);
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
}