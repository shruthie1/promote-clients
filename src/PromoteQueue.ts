export class PromoteQueue {
    private static instance: PromoteQueue;
    public items: string[] = [];
    private maxSize = 10;
    private timer: NodeJS.Timeout;
    private pushCount: Map<string, number> = new Map();

    private constructor() {}

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
        }, 100000);
        // Update push count
        if (this.pushCount.has(item)) {
            this.pushCount.set(item, this.pushCount.get(item)! + 1);
        } else {
            this.pushCount.set(item, 1);
        }
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

    public getSentCount(item: string): number {
        return this.pushCount.get(item) || 0;
    }
}
