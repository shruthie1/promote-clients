import { getMapValues, IClientDetails } from "./express";
import { parseError } from "./parseError";
import TelegramManager from "./TelegramManager";
export class TelegramService {
    private static clientsMap: Map<string, TelegramManager> = new Map();
    private static instance: TelegramService;

    private constructor() {}

    public static getInstance(): TelegramService {
        if (!TelegramService.instance) {
            TelegramService.instance = new TelegramService();
        }
        return TelegramService.instance;
    }

    public async connectClients() {
        console.log("Connecting....!!");
        const clients = getMapValues();
        console.log("Total clients:", clients.length);
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

    public async getClient(clientId: string) {
        console.log("Getting Client :", clientId)
        const tgManager = TelegramService.clientsMap.get(clientId);
        try {
            if (tgManager && tgManager.connected()) {
                await tgManager.client.connect();
                return tgManager
            } else {
                console.log(`tg manager is undefined: ${clientId}`)
                return undefined;
            }
        } catch (error) {
            console.log(error);
            process.exit(1);
        }
    }

    public hasClient(clientId: string) {
        return TelegramService.clientsMap.has(clientId);
    }

    async deleteClient(clientId: string) {
        let tgManager = await this.getClient(clientId);
        if (tgManager) {
            await tgManager.destroy(); // Ensure this cleans up all resources
            console.log(`Client ${clientId} destroyed.`);
            tgManager = null;
        } else {
            console.log(`Client ${clientId} not found.`);
        }
        console.log("Disconnected : ", clientId)
        TelegramService.clientsMap.set(clientId, null);
        return TelegramService.clientsMap.delete(clientId);
    }

    async disconnectAll() {
        const data = TelegramService.clientsMap.entries();
        console.log("Disconnecting All Clients");
        for (const [clientId, tgManager] of data) {
            try {
                await tgManager.client?.disconnect();
                TelegramService.clientsMap.delete(clientId);
                console.log(`Client disconnected: ${clientId}`);
            } catch (error) {
                console.log(parseError(error));
                console.log(`Failed to Disconnect : ${clientId}`);
            }
        }
        TelegramService.clientsMap.clear();
    }

    async createClient(clientDetails: IClientDetails, autoDisconnect = false, handler = true): Promise<TelegramManager> {
        const clientData = await this.getClient(clientDetails.clientId)
        if (!clientData || !clientData.client) {
            const telegramManager = new TelegramManager(clientDetails);
            try {
                const client = await telegramManager.createClient(handler);
                TelegramService.clientsMap.set(clientDetails.clientId, telegramManager);
                await client.getMe();
                if (client) {
                    if (autoDisconnect) {
                        setTimeout(async () => {
                            if (client.connected || await this.getClient(clientDetails.clientId)) {
                                console.log("SELF destroy client : ", clientDetails.clientId);
                                await telegramManager.client.disconnect();
                            } else {
                                console.log("Client Already Disconnected : ", clientDetails.clientId);
                            }
                            TelegramService.clientsMap.delete(clientDetails.clientId);
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
                const errorDetails = parseError(error, clientDetails.clientId);
            }
        } else {
            console.log("Client Already exists: ", clientDetails.clientId)
            return await this.getClient(clientDetails.clientId)
        }
    }
}