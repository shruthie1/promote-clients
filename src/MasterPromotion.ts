class PromoteQueue {
    private static instance: PromoteQueue;
    public items: string[] = [];
    private maxSize = 12;
    private timer: NodeJS.Timeout;

    private constructor() { }

    public static getInstance(): PromoteQueue {
        if (!PromoteQueue.instance) {
            PromoteQueue.instance = new PromoteQueue();
        }
        while (PromoteQueue.instance.items.length >= PromoteQueue.instance.maxSize) {
            PromoteQueue.instance.items.shift();
        }
        return PromoteQueue.instance;
    }

    public push(item: string) {
        while (this.items.length >= this.maxSize) {
            this.items.shift();
        }
        this.items.push(item);
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => {
            this.pop();
        }, 100000); // 1 minute
    }

    public clear() {
        this.items = []
    }
    public pop() {
        if (this.items.length === 0) {
            return undefined;
        }

        const item = this.items.shift();
        return item;
    }

    public contains(item: string) {
        return this.items.indexOf(item) !== -1;
    }

    public isEmpty() {
        return this.items.length === 0;
    }

    public isFull() {
        return this.items.length === this.maxSize;
    }
}

//Master Promotion class (singleton) to provide channels, current channel index, past few channels (maintained in Queue) to skip for near future and more
export class MasterPromotion {
    private static instance: MasterPromotion;
    private channels: Map<string, IChannel> = new Map();
    private currentChannelId: string;
    private pastChannels: PromoteQueue = PromoteQueue.getInstance();

    private constructor() {
        const initialChannels = [
            { channelId: "channel1" },
            { channelId: "channel2" },
            { channelId: "channel3" },
            { channelId: "channel4" },
            { channelId: "channel5" }
        ];
        initialChannels.forEach(channel => this.channels.set(channel.channelId, channel));
        this.currentChannelId = initialChannels[0].channelId;
    }

    public static getInstance(): MasterPromotion {
        if (!MasterPromotion.instance) {
            MasterPromotion.instance = new MasterPromotion();
        }
        return MasterPromotion.instance;
    }

    public getCurrentChannel(): IChannel {
        return this.channels.get(this.currentChannelId);
    }

    public nextChannel(): IChannel {
        this.pastChannels.push(this.currentChannelId);
        const channelIds = Array.from(this.channels.keys());
        const currentIndex = channelIds.indexOf(this.currentChannelId);
        this.currentChannelId = channelIds[(currentIndex + 1) % channelIds.length];
        return this.getCurrentChannel();
    }

    public skipCurrentChannel(): IChannel {
        this.pastChannels.push(this.currentChannelId);
        const channelIds = Array.from(this.channels.keys());
        let currentIndex = channelIds.indexOf(this.currentChannelId);
        do {
            currentIndex = (currentIndex + 1) % channelIds.length;
            this.currentChannelId = channelIds[currentIndex];
        } while (this.pastChannels.contains(this.currentChannelId));
        return this.getCurrentChannel();
    }

    public getPastChannels(): string[] {
        return this.pastChannels.items;
    }

    public setChannels(newChannels: IChannel[]) {
        if (!Array.isArray(newChannels) || newChannels.length === 0) {
            throw new Error("Channels should be a non-empty array of IChannel objects.");
        }
        this.channels.clear();
        newChannels.forEach(channel => this.channels.set(channel.channelId, channel));
        this.currentChannelId = newChannels[0].channelId;
        this.pastChannels.clear();
    }

    public addChannel(channel: IChannel) {
        if (typeof channel.channelId !== 'string' || channel.channelId.trim() === '') {
            throw new Error("Channel should have a non-empty string channelId.");
        }
        this.channels.set(channel.channelId, channel);
    }

    public removeChannel(channelId: string) {
        if (!this.channels.has(channelId)) {
            throw new Error("Channel not found.");
        }
        this.channels.delete(channelId);
        if (this.currentChannelId === channelId) {
            const channelIds = Array.from(this.channels.keys());
            this.currentChannelId = channelIds.length > 0 ? channelIds[0] : null;
        }
    }

    public getChannels(): IChannel[] {
        return Array.from(this.channels.values());
    }

    public setChannelRestrictions(channelId: string, restrictions: Partial<IChannel>) {
        const channel = this.channels.get(channelId);
        if (!channel) {
            throw new Error("Channel not found.");
        }
        Object.assign(channel, restrictions);
    }

    public getChannelRestrictions(channelId: string): Partial<IChannel> {
        const channel = this.channels.get(channelId);
        if (!channel) {
            throw new Error("Channel not found.");
        }
        return {
            restricted: channel.restricted,
            wordRestriction: channel.wordRestriction,
            dMRestriction: channel.dMRestriction,
            banned: channel.banned,
            forbidden: channel.forbidden,
            reactRestricted: channel.reactRestricted
        };
    }
}

interface IChannel {
    channelId: string;
    restricted?: boolean;
    wordRestriction?: boolean;
    dMRestriction?: boolean;
    banned?: boolean;
    forbidden?: boolean;
    reactRestricted?: boolean;
}