import { Api, TelegramClient } from 'telegram';
import { sleep } from 'telegram/Helpers';
import * as fs from 'fs';
import * as path from 'path';

interface ChannelCache {
    id: string;
    title: string;
    username: string;
    accessHash: string;
    participantsCount: number;
    onlineCount: number;
    topMessage: number;
    unreadCount: number;
    lastReadMessage: number;
}

class ChannelCacheManager {
    private client: TelegramClient;
    private mobile: string;
    private cache: Map<string, ChannelCache>;
    private filePath: string;

    constructor(client: TelegramClient) {
        this.client = client;
        this.cache = new Map<string, ChannelCache>();
    }

    // Helper method to sort the cache by onlineCount
    private sortCache(): void {
        const sortedChannels = Array.from(this.cache.values()).sort((a, b) => b.onlineCount - a.onlineCount);
        this.cache.clear();
        sortedChannels.forEach(channel => this.cache.set(channel.id, channel));
    }

    // Populate cache with channel information and ensure it's sorted
    async setChannels(limit = 350): Promise<void> {
        try {
            const dialogs = await this.client.getDialogs({ limit, archived: false });
            console.log('Dialogs:', dialogs.length);

            for (const dialog of dialogs) {
                if (dialog.entity instanceof Api.Channel) {
                    try {
                        const result = await this.client.invoke(new Api.channels.GetFullChannel({ channel: dialog.id }));
                        const fullChat = <Api.ChannelFull>result.fullChat;
                        await sleep(1000); // Avoid rate-limiting issues

                        const info: ChannelCache = {
                            id: fullChat.id.toString().replace(/^-100/, ""),
                            title: dialog.title,
                            username: dialog.entity.username,
                            accessHash: dialog.entity.accessHash?.toString(),
                            participantsCount: fullChat.participantsCount,
                            onlineCount: fullChat.onlineCount,
                            topMessage: dialog.dialog.topMessage,
                            unreadCount: fullChat.unreadCount,
                            lastReadMessage: dialog.dialog.topMessage - fullChat.unreadCount
                        };

                        this.cache.set(info.id, info);
                    } catch (error) {
                        console.error(`Failed to fetch channel details for ${dialog.title}:`, error);
                    }
                }
            }

            // Sort the cache after populating it
            this.sortCache();
        } catch (error) {
            console.error('Failed to set channels:', error);
        }
    }

    // Retrieve or add channel information if missing, and ensure it's sorted
    async getOrAddChannelCache(channelId: string): Promise<ChannelCache | undefined> {
        let cachedChannel = this.cache.get(channelId);
        if (!cachedChannel) {
            try {
                const result = await this.client.invoke(new Api.channels.GetFullChannel({ channel: channelId }));
                const fullChat = <Api.ChannelFull>result.fullChat;
                const dialog = <Api.Channel>await this.client.getEntity(parseInt(channelId));
                cachedChannel = {
                    id: channelId,
                    title: dialog.title,
                    username: dialog.username,
                    accessHash: dialog.accessHash?.toString(),
                    participantsCount: fullChat.participantsCount,
                    onlineCount: fullChat.onlineCount,
                    topMessage: 0,
                    unreadCount: fullChat.unreadCount,
                    lastReadMessage: 0
                };

                this.cache.set(channelId, cachedChannel);
            } catch (error) {
                console.error(`Failed to fetch or add channel cache for ${channelId}:`, error);
                return undefined;
            }
        }

        // Sort the cache after adding/updating the channel
        this.sortCache();
        return cachedChannel;
    }

    // Get cached channel or add if missing, ensuring sorted order
    async getChannelCacheWithAdd(channelId: string): Promise<ChannelCache | undefined> {
        return this.getOrAddChannelCache(channelId);
    }

    // Get all cached channels sorted by onlineCount
    getAllCachedChannels(): ChannelCache[] {
        return Array.from(this.cache.values()).sort((a, b) => b.onlineCount - a.onlineCount);
    }

    // Search channels by title or username, and sort by onlineCount
    searchChannels(query: string): ChannelCache[] {
        return Array.from(this.cache.values())
            .filter(
                channel =>
                    channel.title.toLowerCase().includes(query.toLowerCase()) ||
                    (channel.username?.toLowerCase().includes(query.toLowerCase()) ?? false)
            )
            .sort((a, b) => b.onlineCount - a.onlineCount); // Sort after filtering
    }

    // Update specific channel cache and ensure it's sorted
    async updateChannelCache(channelId: string): Promise<void> {
        try {
            const channel = Array.from(this.cache.values()).find(c => c.id === channelId);
            if (!channel) {
                throw new Error('Channel not found in cache');
            }

            const result = await this.client.invoke(new Api.channels.GetFullChannel({ channel: parseInt(channelId) }));
            const fullChat = <Api.ChannelFull>result.fullChat;
            const updatedInfo: ChannelCache = {
                ...channel,
                participantsCount: fullChat.participantsCount,
                onlineCount: fullChat.onlineCount,
                unreadCount: fullChat.unreadCount
            };

            this.cache.set(channelId, updatedInfo);

            // Sort the cache after updating the channel
            this.sortCache();
        } catch (error) {
            console.error(`Failed to update channel cache for ${channelId}:`, error);
        }
    }

    // Update unread count for a specific channel
    async updateUnreadCount(channelId: string): Promise<void> {
        try {
            const channel = this.cache.get(channelId);
            if (!channel) {
                throw new Error('Channel not found in cache');
            }

            const result = await this.client.invoke(new Api.channels.GetFullChannel({ channel: parseInt(channelId) }));
            const fullChat = <Api.ChannelFull>result.fullChat;
            channel.unreadCount = fullChat.unreadCount;
            this.cache.set(channelId, channel);

            // Sort the cache after updating the unread count
            this.sortCache();
        } catch (error) {
            console.error(`Failed to update unread count for ${channelId}:`, error);
        }
    }

    // Update last read message for a specific channel
    async updateLastReadMessage(channelId: string): Promise<void> {
        try {
            const channel = this.cache.get(channelId);
            if (!channel) {
                throw new Error('Channel not found in cache');
            }

            const result = await this.client.invoke(new Api.channels.GetFullChannel({ channel: parseInt(channelId) }));
            const fullChat = <Api.ChannelFull>result.fullChat;
            channel.lastReadMessage = fullChat.readInboxMaxId;
            this.cache.set(channelId, channel);

            // Sort the cache after updating the last read message
            this.sortCache();
        } catch (error) {
            console.error(`Failed to update last read message for ${channelId}:`, error);
        }
    }

    // Get the total number of unread messages across all cached channels
    getTotalUnreadCount(): number {
        return Array.from(this.cache.values()).reduce((total, channel) => total + channel.unreadCount, 0);
    }

    // Get the total number of participants across all cached channels
    getTotalParticipantsCount(): number {
        return Array.from(this.cache.values()).reduce((total, channel) => total + channel.participantsCount, 0);
    }

    // Get the total number of online users across all cached channels
    getTotalOnlineCount(): number {
        return Array.from(this.cache.values()).reduce((total, channel) => total + channel.onlineCount, 0);
    }

    // Clear a specific channel's cache
    clearChannelCache(channelId: string): void {
        this.cache.delete(channelId);
    }

    // Clear all channel caches
    clearAllCache(): void {
        this.cache.clear();
    }

    // Export cache to JSON
    exportCacheToJSON(): string {
        return JSON.stringify(Array.from(this.cache.values()), null, 2);
    }

    // Import cache from JSON
    importCacheFromJSON(jsonString: string): void {
        try {
            const parsed = JSON.parse(jsonString) as ChannelCache[];
            parsed.forEach(channel => this.cache.set(channel.id, channel));

            // Sort after importing
            this.sortCache();
        } catch (error) {
            console.error('Failed to import cache from JSON:', error);
        }
    }

    // Check if channel exists in cache
    isChannelCached(channelId: string): boolean {
        return this.cache.has(channelId);
    }

    // Get count of cached channels
    getCacheCount(): number {
        return this.cache.size;
    }

    // Refresh all caches and ensure sorted order
    async refreshAllCaches(): Promise<void> {
        try {
            const channelIds = Array.from(this.cache.keys());
            for (const channelId of channelIds) {
                await this.updateChannelCache(channelId);
            }

            // After refreshing, sort the cache
            this.sortCache();
        } catch (error) {
            console.error('Failed to refresh all caches:', error);
        }
    }

    // Ensure all dialogs are cached
    async ensureAllDialogsCached(limit = 350): Promise<void> {
        try {
            const dialogs = await this.client.getDialogs({ limit, archived: false });
            for (const dialog of dialogs) {
                if (dialog.entity instanceof Api.Channel) {
                    await this.getOrAddChannelCache(dialog.id.toString().replace(/^-100/, ""));
                }
            }
        } catch (error) {
            console.error('Failed to ensure all dialogs are cached:', error);
        }
    }

    // Add missing channels to the cache and ensure sorted order
    async addMissingChannels(channelIds: string[]): Promise<void> {
        try {
            for (const channelId of channelIds) {
                if (!this.cache.has(channelId)) {
                    await this.getOrAddChannelCache(channelId);
                }
            }

            // After adding missing channels, sort the cache
            this.sortCache();
        } catch (error) {
            console.error('Failed to add missing channels:', error);
        }
    }

    // Display cache summary (sorted count)
    getCacheSummary(): string {
        return `Total Channels Cached: ${this.cache.size}`;
    }

    async exportCacheToFile(): Promise<void> {
        try {
            if (!this.mobile) {
                throw new Error('Mobile number is not set');
            }
            this.filePath = path.join(__dirname, `Promotions-${this.mobile}.json`);
            const jsonData = this.exportCacheToJSON();
            fs.writeFileSync(this.filePath, jsonData, 'utf-8');
            console.log(`Cache has been successfully saved to ${this.filePath}`);
        } catch (error) {
            console.error('Failed to save cache to file:', error);
        }
    }

    async importCacheFromFile(): Promise<void> {
        try {
            if (!this.mobile) {
                throw new Error('Mobile number is not set');
            }
            this.filePath = path.join(__dirname, `Promotions-${this.mobile}.json`);
            if (fs.existsSync(this.filePath)) {
                const jsonData = fs.readFileSync(this.filePath, 'utf-8');
                this.importCacheFromJSON(jsonData);
                console.log(`Cache has been successfully loaded from ${this.filePath}`);
            } else {
                console.error(`File not found at ${this.filePath}`);
            }
        } catch (error) {
            console.error('Failed to load cache from file:', error);
        }
    }

}

export default ChannelCacheManager;
