import { getClientDetails, getMapKeys, getMapValues, IClientDetails } from "./express";
import { parseError } from "./parseError";
import { Promotion } from "./Promotions";
import { Reactions } from "./react";
import TelegramManager from "./TelegramManager";
export class TelegramService {
    private static clientsMap: Map<string, TelegramManager> = new Map();
    private static instance: TelegramService;
    private reactorInstance: Reactions;
    private promoterInstance: Promotion;

    private constructor() {}

    public static getInstance(): TelegramService {
        if (!TelegramService.instance) {
            TelegramService.instance = new TelegramService();
        }
        return TelegramService.instance;
    }

    getLastMessageTime(mobile: string) {
        return this.promoterInstance?.getLastMessageTime(mobile);
    }

    getDaysLeft(mobile: string) {
        return this.promoterInstance?.getDaysLeft(mobile);
    }

    setMobiles(mobiles: string[]) {
        this.promoterInstance.setMobiles(mobiles)
        this.reactorInstance.setMobiles(mobiles)
    }
    public async connectClients() {
        console.log("Connecting....!!");
        const mobiles = getMapKeys();
        console.log("Total clients:", mobiles.length);
        this.reactorInstance = new Reactions(mobiles, this.getClient.bind(this))
        this.promoterInstance = Promotion.getInstance(mobiles, this.getClient.bind(this));
        for (const mobile of mobiles) {
            const clientDetails = getClientDetails(mobile)
            await this.createClient(clientDetails, false, true);
        }
        this.promoterInstance.startPromotion()
        console.log("Connected....!!");
    }

    public startPromotion() {
        return this.promoterInstance.startPromotion()
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
                this.promoterInstance = null;
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
            const telegramManager = new TelegramManager(clientDetails, this.reactorInstance, this.promoterInstance);
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
                    console.log("Client Expired")
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