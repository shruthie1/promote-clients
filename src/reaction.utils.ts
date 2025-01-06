import { Api } from "telegram";

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
    return chatReactionsCache.get(chatId);
}

export function setReactions(chatId: string, reactions: Api.ReactionEmoji[]) {
    chatReactionsCache.set(chatId, reactions);
}

export function hasReactions(chatId: string) {
    return chatReactionsCache.has(chatId);
}
