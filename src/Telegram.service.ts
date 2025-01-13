import { getMapValues, IClientDetails } from "./express";
import { parseError } from "./parseError";
import { Reactions } from "./react";
import TelegramManager from "./TelegramManager";
export class TelegramService {
    private static clientsMap: Map<string, TelegramManager> = new Map();
    private static instance: TelegramService;
    private reactorInstance: Reactions
    private mobiles: string[] = [];

    private constructor() {}

    public static getInstance(): TelegramService {
        if (!TelegramService.instance) {
            TelegramService.instance = new TelegramService();
        }
        return TelegramService.instance;
    }

    setMobiles(mobiles: string[]) {
        this.mobiles = mobiles;
    }
    
    public async connectClients() {
        console.log("Connecting....!!");
        const clients = getMapValues();
        console.log("Total clients:", clients.length);
        this.reactorInstance = new Reactions(this.mobiles, this.getClient.bind(this));
        for (const client of clients) {
            await this.createClient(client, false, true);
        }
        console.log("Connected....!!");
    }


    public getMapValues() {
        return Array.from(TelegramService.clientsMap.values())
    }

    public getMapKeys() {
        return Array.from(TelegramService.clientsMap.keys())
    }

    public async getClient(mobile: string) {
        console.log("Getting Client :", mobile)
        const tgManager = TelegramService.clientsMap.get(mobile);
        try {
            if (tgManager && tgManager.connected()) {
                await tgManager.client.connect();
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
                await tgManager.client?.disconnect();
                TelegramService.clientsMap.delete(mobile);
                console.log(`Client disconnected: ${mobile}`);
            } catch (error) {
                console.log(parseError(error));
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
                await client.getMe();
                if (client) {
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
            return await this.getClient(clientDetails.mobile)
        }
    }
}