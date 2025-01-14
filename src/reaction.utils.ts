import { Api } from "telegram";
import * as fs from "fs";
import * as path from "path";

const chatReactionsCache = new Map<string, Api.ReactionEmoji[]>();

export function getAReaction(chatId: string): string {
    const availableReactions: Api.ReactionEmoji[] = chatReactionsCache.get(chatId)
    if (availableReactions && availableReactions.length > 0) {
        const reactionIndex = Math.floor(Math.random() * availableReactions.length);
        return availableReactions[reactionIndex]?.emoticon;
    } else {
        return '👍'
    }
}

export function getAllReactions(chatId: string): Api.ReactionEmoji[] {
    return chatReactionsCache.get(chatId) || [];
}

export function setReactions(chatId: string, reactions: Api.ReactionEmoji[]) {
    chatReactionsCache.set(chatId, reactions);
}

export function hasReactions(chatId: string) {
    return chatReactionsCache.has(chatId);
}

export async function saveReactionsToFile() {
    const dir = path.dirname("./reactions.json");
    await fs.promises.mkdir(dir, { recursive: true });
    const cacheObject: Record<string, string[]> = {};

    for (const [chatId, reactions] of chatReactionsCache.entries()) {
        const emoticons = reactions.map(reaction => reaction?.emoticon);
        cacheObject[chatId] = emoticons;
    }

    fs.writeFileSync("./reactions.json", JSON.stringify(cacheObject, null, 2), "utf-8");
}

export async function loadReactionsFromFile() {
    const filePath = "./reactions.json";
    if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath, "utf-8");
        const cacheObject: Record<string, string[]> = JSON.parse(data);

        for (const [chatId, emoticons] of Object.entries(cacheObject)) {
            const reactions = emoticons.map(emoticon => new Api.ReactionEmoji({ emoticon }));
            chatReactionsCache.set(chatId, reactions);
        }
    } else {
        console.error(`File not found: ${filePath}`);
    }
}