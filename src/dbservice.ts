console.log(`in Db - ${process.env.dbcoll} | ${process.env.username}`);
import { MongoClient, ServerApiVersion, ConnectOptions, ObjectId } from 'mongodb';
import { parseError } from './parseError';
import { IChannel } from './utils';


export class UserDataDtoCrud {
    private static instance: UserDataDtoCrud;
    private clients = {}
    private promoteStatsDb: any;
    private activeChannelDb: any;
    public isConnected = false;
    private client: MongoClient = undefined;

    private constructor() {
        console.log("Creating MongoDb Instance");
    }

    static getInstance(): UserDataDtoCrud {
        if (!UserDataDtoCrud.instance) {
            UserDataDtoCrud.instance = new UserDataDtoCrud();
        }
        return UserDataDtoCrud.instance;
    }
    static isInstanceExist(): boolean {
        return !!UserDataDtoCrud.instance;
    }

    async connect() {
        if (!this.client && !this.isConnected) {
            console.log('trying to connect to DB......', process.env.mongodburi)
            try {
                this.client = await MongoClient.connect(process.env.mongodburi as string, { useNewUrlParser: true, useUnifiedTopology: true, serverApi: ServerApiVersion.v1, maxPoolSize: 10 } as ConnectOptions);
                console.log('Connected to MongoDB');
                this.isConnected = true;
                this.activeChannelDb = this.client.db("tgclients").collection('activeChannels');
                this.promoteStatsDb = this.client.db("tgclients").collection('promoteStats');
                await this.getClients()
                this.client.on('close', () => {
                    console.log('MongoDB connection closed.');
                    this.isConnected = false;
                });

                return true;
            } catch (error) {
                console.log(`Error connecting to MongoDB: ${error}`);
                return false;
            }
        } else {
            console.log('MongoConnection ALready Existing');
        }
    }

    async getClients() {
        const clients = await this.client.db("tgclients").collection('clients').find({}).toArray();
        clients.forEach(clt => {
            this.clients = Object.assign(this.clients, { [clt.dbcoll]: clt });
        });
        return clients;
    }

    async readPromoteStats() {
        const result = await this.promoteStatsDb.findOne({ "client": "shruthi1" });
        return result.channels.slice(0, 200);
    }    

    async updateActiveChannel(filter: any, data: any) {
        delete data["_id"]
        return await this.activeChannelDb.updateOne(
            filter,
            {
                $set: {
                    ...data
                },
            },
            { upsert: true }
        );
    }
    async getChannel(filter: any) {
        const channelDb = this.client.db("tgclients").collection('channels');
        const result: IChannel = <any>await channelDb.findOne(filter);
        return result
    }

    async getActiveChannel(filter: any) {
        const result: IChannel = <any>await this.activeChannelDb.findOne(filter);
        return result
    }

    async getPromoteMsgs() {
        try {
            const channelDb = this.client.db("tgclients").collection('promoteMsgs');
            return await channelDb.findOne({})
        } catch (e) {
            console.log(e)
        }
    }
    async closeConnection() {
        try {
            if (this.isConnected) {
                this.isConnected = false;
                console.log('MongoDB connection closed.');
            }
            await this.client?.close();
        } catch (error) {
            parseError(error)
        }
    }

    async removeFromAvailableMsgs(filter: any, valueToRemove: string) {

        try {
            return await this.activeChannelDb.updateOne(
                filter,
                { $pull: { availableMsgs: valueToRemove } }
            );
        } catch (error) {
            console.log(error, "RemoveChannelMsgErr")
        }
    }

    async addToAvailableMsgs(filter: any, valueToAdd: string) {
        try {
            return await this.activeChannelDb.updateOne(
                filter,
                { $addToSet: { availableMsgs: valueToAdd } }
            );
        } catch (error) {
            console.log(error, "AddChannelMsgErr")
        }
    }

    async removeOnefromActiveChannel(channelId: string) {
        try {
            await this.activeChannelDb.deleteOne({ channelId })
        } catch (e) {
            console.log(e)
        }
    }

    async removeOnefromChannel(channelId: string) {
        try {
            const channelDb = this.client.db("tgclients").collection('channels');
            await channelDb.deleteOne({ channelId })
        } catch (e) {
            console.log(e)
        }
    }

    async updateClient(filter: any, data: any) {
        try {
            const clientsDb = this.client.db("tgclients").collection('clients')
            return await clientsDb.updateOne(filter, { $set: data })
        } catch (error) {
            parseError(error, "Error updating Client")
        }
    }

    async findPromoteClient(filter: any) {
        try {
            const clientsDb = this.client.db("tgclients").collection('promoteClients')
            return await clientsDb.findOne(filter)
        } catch (error) {
            parseError(error, "Error updating Client")
        }
    }

    async deletePromoteClient(filter: any) {
        try {
            const clientsDb = this.client.db("tgclients").collection('promoteClients')
            return await clientsDb.deleteOne(filter)
        } catch (error) {
            parseError(error, "Error updating Client")
        }
    }
}