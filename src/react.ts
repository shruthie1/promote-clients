import { Api } from "telegram";
import { getEntity } from "telegram/client/users";
import { NewMessageEvent } from "telegram/events";
import { sleep } from "telegram/Helpers";
import { fetchWithTimeout } from "./fetchWithTimeout";
import { parseError } from "./parseError";
import { ReactQueue } from "./ReactQueue";
import { contains, ppplbot, startNewUserProcess } from "./utils";
import { IClientDetails, restartClient } from "./express";
const notifbot = `https://api.telegram.org/bot5856546982:AAEW5QCbfb7nFAcmsTyVjHXyV86TVVLcL_g/sendMessage?chat_id=${process.env.notifChannel}`

export class Reactions {
    private flag = true;
    private flag2 = true;
    private waitReactTime = Date.now();
    private chatReactionsCache = new Map();
    private lastReactedtime = Date.now() - 180000;
    private lastNotifiedTime = Date.now();
    private reactionsRestarted = Date.now();
    private totalReactionDelay = 0;
    private successfulReactions = 0;
    private averageReactionDelay = 0;
    private minWaitTime = 18000;
    private maxWaitTime = 21000;
    private reactSleepTime = 19000;
    private floodTriggeredTime = 0;
    private floodCount = 0;
    private targetReactionDelay = 18000;
    private reactQueue: ReactQueue;
    private clientDetails: IClientDetails;
    private processId: number = Math.floor(Math.random() * 1234);
    private floodReleaseTime = 0;

    constructor(clientDetails: IClientDetails) {
        this.clientDetails = clientDetails;
        this.reactQueue = new ReactQueue()
    }

    private standardEmoticons = ['👍', '❤', '🔥', '👏', '🥰', '😁']
    private emoticons = [
        '❤', '🔥', '👏', '🥰', '😁', '🤔',
        '🤯', '😱', '🤬', '😢', '🎉', '🤩',
        '🤮', '💩', '🙏', '👌', '🕊', '🤡',
        '🥱', '🥴', '😍', '🐳', '❤‍🔥', '💯',
        '🤣', '💔', '🏆', '😭', '😴', '👍',
        '🌚', '⚡', '🍌', '😐', '💋', '👻',
        '👀', '🙈', '🤝', '🤗', '🆒',
        '🗿', '🙉', '🙊', '🤷', '👎'
    ]
    private standardReactions = this.standardEmoticons.map(emoticon => new Api.ReactionEmoji({ emoticon }));
    private defaultReactions = this.emoticons.map(emoticon => new Api.ReactionEmoji({ emoticon }));

    private reactRestrictedIds = ['1798767939',
        process.env.updatesChannel,
        process.env.notifChannel,
        "1703065531", "1972065816", "1949920904",
        "2184447313", "2189566730", "1870673087",
        "1261993766", "1202668523", "1738391281", "1906584870",
        "1399025405", "1868271399", "1843478697", "2113315849", "1937606045",
        "1782145954", "1623008940", "1738135934", "1798503017", "1889233160", "1472089976",
        "1156516733", "1514843822", "2029851294", "2097005513", "1897072643", "1903237199",
        "1807801643", "1956951800", "1970106364", "2028322484", "2135964892", "2045602167",
        "1486096882", "1336087349", "1878652859", "1711250382", "1959564784", "1345564184",
        "1663368151", "1476492615", "1524427911", "1400204596", "1812110874", "1654557420",
        "1765654210", "1860635416", "1675260943", "1730253703", "2030437007", "1213518210",
        "1235057378", "1586912179", "1672828024", "2069091557", "1860671752", "2125364202",
        "1959951200", "1607289097", "1929774605", "1780733848", "1685018515", "2057393918",
        "1887746719", "1916123414", "1970767061", "2057158588"
    ]

    async react(event: NewMessageEvent) {
        const chatId = event.message.chatId.toString();
        try {
            await event.client.connect();
            if (!this.chatReactionsCache.has(chatId) && this.flag2) {
                this.flag2 = false;
                try {
                    const result = await event.client.invoke(new Api.channels.GetFullChannel({ channel: event.chatId }));
                    const reactionsJson: any = result?.fullChat?.availableReactions?.toJSON();
                    const availableReactions: Api.ReactionEmoji[] = reactionsJson?.reactions;

                    if (availableReactions && (availableReactions.length > 3 || availableReactions.length > this.defaultReactions.length)) {
                        this.defaultReactions = availableReactions;
                    }

                    if ((!availableReactions || availableReactions.length < 1) && this.defaultReactions.length > 1) {
                        this.chatReactionsCache.set(chatId, this.defaultReactions);
                    } else {
                        this.chatReactionsCache.set(chatId, availableReactions);
                    }
                } catch (error) {
                    parseError(error, `${this.clientDetails?.clientId} :: Fetching Reactions`, false);
                    if (this.defaultReactions.length > 1) {
                        this.chatReactionsCache.set(chatId, this.defaultReactions);
                    }
                    await startNewUserProcess(error, this.clientDetails?.clientId)
                } finally {
                    this.flag2 = true;
                }
                await sleep(3000);
            }

            if (this.flag && this.waitReactTime < Date.now() && !this.reactQueue.contains(chatId) && !contains(chatId, this.reactRestrictedIds)) {
                this.flag = false;
                const availableReactions = this.chatReactionsCache.get(chatId);

                if (availableReactions && availableReactions.length > 0) {
                    const reactionIndex = Math.floor(Math.random() * availableReactions.length);
                    const reaction = [availableReactions[reactionIndex]];
                    this.waitReactTime = Date.now() + this.reactSleepTime;
                    try {
                        const MsgClass = new Api.messages.SendReaction({
                            peer: event.message.chat,
                            msgId: event.message.id,
                            reaction: reaction
                        });

                        await event.client.invoke(MsgClass);

                        const reactionDelay = Math.min(Date.now() - this.lastReactedtime, 25000);
                        this.lastReactedtime = Date.now();
                        this.totalReactionDelay += reactionDelay;
                        this.successfulReactions += 1;
                        this.averageReactionDelay = Math.floor(this.totalReactionDelay / this.successfulReactions);

                        if (this.averageReactionDelay < this.targetReactionDelay) {
                            this.reactSleepTime = Math.min(this.reactSleepTime + 200, this.maxWaitTime);
                        } else {
                            if (Date.now() > (this.floodTriggeredTime + 600000) && this.floodCount < 3) {
                                this.reactSleepTime = Math.max(this.reactSleepTime - 50, this.minWaitTime);
                            }
                        }

                        // const chatEntity = <Api.Channel>await getEntity(event.client, chatId);
                        // console.log("Reacted Successfully, Average Reaction Delay:", this.averageReactionDelay, "ms", reaction[0]?.toJSON().emoticon, chatEntity?.toJSON().title, chatEntity?.toJSON().username);
                        this.reactQueue.push(chatId);

                    } catch (error) {
                        if (error.seconds) {
                            this.waitReactTime = Date.now() + (error.seconds * 1001);
                            // if (floodTriggeredTime == 0 || floodTriggeredTime > (Date.now() - 30 * 60 * 1000)) {
                            // }
                            this.minWaitTime = Math.floor(this.minWaitTime + (error.seconds * 3));
                            this.reactSleepTime = 17000;
                            this.targetReactionDelay = this.targetReactionDelay + 500
                            this.floodTriggeredTime = Date.now();
                            this.floodCount++;
                            this.floodReleaseTime = Date.now() + (error.seconds * 1000) + 10000
                            await fetchWithTimeout(`${notifbot}&text=${process.env.clientId} | ${this.clientDetails.clientId?.toUpperCase()}: Reaction Flood: sleeping for ${error.seconds}`);
                        } else {
                            if (error.errorMessage == "REACTION_INVALID") {
                                availableReactions.splice(reactionIndex, 1);
                                this.chatReactionsCache.set(chatId, availableReactions);
                            }
                            const chatEntity = <Api.Channel>await getEntity(event.client, chatId);
                            console.log(`${process.env.clientId} | ${this.clientDetails.clientId.toUpperCase()} Failed to React:`, reaction[0]?.toJSON().emoticon, chatEntity?.toJSON().username, error.errorMessage);
                        }
                        await startNewUserProcess(error, this.clientDetails?.clientId)
                    }
                    this.flag = true;
                } else {
                    this.chatReactionsCache.set(chatId, this.defaultReactions);
                    this.flag = true;
                }
            } else {
                if (this.lastReactedtime < Date.now() - 60000 && (!this.flag || this.reactQueue.contains(chatId)) && this.reactionsRestarted < Date.now() - 30000) {
                    this.flag = true;
                    this.reactionsRestarted = Date.now();
                    console.log(`
                        === Client Process Debug Info ===
                        ClientID: ${this.clientDetails.clientId.toUpperCase()}
                        ------ Restarted Reactions ------
                        Flag: ${this.flag}
                        WaitReactTimePassed: ${this.waitReactTime < Date.now()}
                        InReactQueue: ${this.reactQueue.contains(chatId)}
                        InRestrictedIDs: ${contains(chatId, this.reactRestrictedIds)}
                        WaitTimeElapsed: ${Math.floor((Date.now() - this.lastReactedtime) / 1000)} seconds
                        ==================================
                    `);
                }

                // if (lastReactedtime < Date.now() - 240000) {
                //     const chatEntity = <Api.Channel>await getEntity(event.client, chatId);
                //     console.log("Restarted not working Reactions", flag, waitReactTime < Date.now(), !reactQueue.contains(chatId), !isLimitReached, !contains(chatId, reactRestrictedIds), chatId, chatEntity?.toJSON().username, chatEntity?.toJSON().title);
                // }

                if (this.lastReactedtime < Date.now() - 240000 && Date.now() > this.floodReleaseTime && this.lastNotifiedTime < Date.now() - 5 * 60 * 1000) {
                    this.lastNotifiedTime = Date.now();
                    console.log(`
                        ClientID: ${this.clientDetails.clientId.toUpperCase()}
                        Flag: ${this.flag}
                        WaitReactTimePassed: ${this.waitReactTime < Date.now()}
                        InReactQueue: ${this.reactQueue.contains(chatId)}
                        InRestrictedIDs: ${contains(chatId, this.reactRestrictedIds)}
                    `);
                    if (Math.floor((Date.now() - this.lastReactedtime) / 1000) > 500) {
                        console.log("Reactions Stopped", this.clientDetails.clientId, (Date.now() - this.lastReactedtime) / 1000)
                        // await restartClient(this.clientDetails.clientId);
                        this.reactQueue.clear()
                    }
                    if (Math.floor((Date.now() - this.lastReactedtime) / 1000) > 800) {
                        console.log("Reactions Stopped", this.clientDetails.clientId, (Date.now() - this.lastReactedtime) / 1000);
                        await fetchWithTimeout(`${ppplbot()}&text=@${(process.env.clientId).toUpperCase()}  ${this.clientDetails.clientId.toUpperCase()}: processId: ${this.processId}| Reactions Not working: ${this.flag}|${this.waitReactTime < Date.now()}|${!this.reactQueue.contains(chatId)}|${!contains(chatId, this.reactRestrictedIds)}|${this.chatReactionsCache.get(chatId)?.length} since: ${Math.floor((Date.now() - this.lastReactedtime) / 1000)}`)// | Waittime: ${Math.floor((this.floodReleaseTime - Date.now()) / 1000)}`);
                        // await restartClient(this.clientDetails.clientId);
                        this.reactRestrictedIds = []
                    }
                }
            }
        } catch (error) {
            parseError(error, `${this.clientDetails?.clientId} :: Reaction Error`);
            await startNewUserProcess(error, this.clientDetails?.clientId)
            this.flag = true;
            this.flag2 = true;
        }
    }
}