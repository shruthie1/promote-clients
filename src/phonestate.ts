import BigInt from 'big-integer';
import { MTProtoState } from 'telegram/network/MTProtoState';
import { Logger } from 'telegram/extensions/Logger';
import * as Helpers from 'telegram/Helpers';
import { AuthKey } from 'telegram/crypto/AuthKey';
import { generateRandomBytes, readBigIntFromBuffer } from 'telegram/Helpers';

let currentPhoneCallState: PhoneCallState | undefined;

export function generateRandomInt() {
    return readBigIntFromBuffer(generateRandomBytes(4), true, true).toJSNumber();
}

class PhoneCallState {
    private state?: MTProtoState;

    private seq = 0;

    private gA?: bigInt.BigInteger;

    private gB: any;

    private p?: bigInt.BigInteger;

    private random?: bigInt.BigInteger;

    private waitForState: Promise<void>;

    private resolveState?: VoidFunction;

    constructor() {
        this.waitForState = new Promise((resolve) => {
            this.resolveState = resolve;
        });
    }

    async requestCall({ p, g, random }) {
        const pBN = Helpers.readBigIntFromBuffer(Buffer.from(p), false);
        const randomBN = Helpers.readBigIntFromBuffer(Buffer.from(random), false);
        const gA = Helpers.modExp(BigInt(g), randomBN, pBN);

        this.gA = gA;
        this.p = pBN;
        this.random = randomBN;

        const gAHash = await Helpers.sha256(Helpers.getByteArray(gA));
        return Array.from(gAHash);
    }

    acceptCall({ p, g, random }) {
        const pLast = Helpers.readBigIntFromBuffer(p, false);
        const randomLast = Helpers.readBigIntFromBuffer(random, false);

        const gB = Helpers.modExp(BigInt(g), randomLast, pLast);
        this.gB = gB;
        this.p = pLast;
        this.random = randomLast;

        return Array.from(Helpers.getByteArray(gB));
    }

    async confirmCall(gB: any) {
        this.gB = Helpers.readBigIntFromBuffer(Buffer.from(gB), false);

        const authKey = Helpers.modExp(
            this.gB,
            this.random,
            this.p,
        );
        const fingerprint = await Helpers.sha1(Helpers.getByteArray(authKey));
        const keyFingerprint = Helpers.readBigIntFromBuffer(fingerprint.slice(-8).reverse(), false);

        const key = new AuthKey();
        await key.setKey(Helpers.getByteArray(authKey));
        this.state = new MTProtoState(key, new Logger(), true);
        this.resolveState();

        return { gA: Array.from(Helpers.getByteArray(this.gA)), keyFingerprint: keyFingerprint.toString() };
    }

    async encode(data: string) {
        if (!this.state) return undefined;

        const seqArray = new Uint32Array(1);
        seqArray[0] = this.seq++;
        const encodedData = await this.state.encryptMessageData(
            Buffer.concat([Helpers.convertToLittle(Buffer.from(seqArray)), Buffer.from(data)]),
        );
        return Array.from(encodedData);
    }

    async decode(data: string) {
        if (!this.state) {
            return this.waitForState.then(() => {
                return this.decode(data);
            });
        }

        const message = await this.state.decryptMessageData(Buffer.from(data));

        return JSON.parse(message.toString());
    }
}

function computeEmojiIndex(bytes) {
    return ((BigInt(bytes[0]).and(0x7F)).shiftLeft(56))
        .or((BigInt(bytes[1]).shiftLeft(48)))
        .or((BigInt(bytes[2]).shiftLeft(40)))
        .or((BigInt(bytes[3]).shiftLeft(32)))
        .or((BigInt(bytes[4]).shiftLeft(24)))
        .or((BigInt(bytes[5]).shiftLeft(16)))
        .or((BigInt(bytes[6]).shiftLeft(8)))
        .or((BigInt(bytes[7])));
}

export async function generateEmojiFingerprint(
    authKey, gA, emojiData, emojiOffsets,
) {
    const hash = await Helpers.sha256(Buffer.concat([new Uint8Array(authKey), new Uint8Array(gA)]));
    const result = [];
    const emojiCount = emojiOffsets.length - 1;
    const kPartSize = 8;
    for (let partOffset = 0; partOffset !== hash.byteLength; partOffset += kPartSize) {
        const value = computeEmojiIndex(hash.subarray(partOffset, partOffset + kPartSize));
        const index = value.modPow(1, emojiCount).toJSNumber();
        const offset = emojiOffsets[index];
        const size = emojiOffsets[index + 1] - offset;
        result.push(String.fromCharCode(...emojiData.subarray(offset, offset + size)));
    }
    return result.join('');
}

export function createPhoneCallState() {
    currentPhoneCallState = new PhoneCallState();
}

export function destroyPhoneCallState() {
    console.log("Delete Call State!!")
    currentPhoneCallState = undefined;
}

export function encodePhoneCallData(params) {
    return currentPhoneCallState.encode(params);
}

export function decodePhoneCallData(params) {
    return currentPhoneCallState.decode(params);
}

export function confirmPhoneCall(params) {
    return currentPhoneCallState?.confirmCall(params);
}

export function acceptPhoneCall(params) {
    return currentPhoneCallState?.acceptCall(params);
}

export function requestPhoneCall(params) {
    return currentPhoneCallState?.requestCall(params);
}
