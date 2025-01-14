import { Api } from "telegram";
import * as fs from "fs";
import * as path from "path";

const chatReactionsCache = new Map();

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
    const cacheObject: Record<string, Api.ReactionEmoji[]> = {};

    for (const [chatId, reactions] of chatReactionsCache.entries()) {
        cacheObject[chatId] = reactions;
    }

    fs.writeFileSync("./reactions.json", JSON.stringify(cacheObject, null, 2), "utf-8");
}

export async function loadReactionsFromFile() {
    const filePath = "./reactions.json";
    if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath, "utf-8");
        const cacheObject: Record<string, Api.ReactionEmoji[]> = JSON.parse(data);

        for (const [chatId, reactions] of Object.entries(cacheObject)) {
            chatReactionsCache.set(chatId, reactions);
        }
    } else {
        console.error(`File not found: ${filePath}`);
    }
}