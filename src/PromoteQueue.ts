export class PromoteQueue {
    private static instance: PromoteQueue;
    public items: string[] = [];
    private maxSize = 10;
    private timer: NodeJS.Timeout;
    private pushCount: Map<string, { count: number, timestamp: number }> = new Map();

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
        // Remove items older than 1 hour from the pushCount map
        const now = Date.now();
        this.pushCount.forEach((data, key) => {
            if (now - data.timestamp > 60 * 60 * 1000) {  // 1 hour = 60 minutes * 60 seconds * 1000 ms
                this.pushCount.delete(key);
            }
        });

        // Proceed with the normal push operation
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

        // Update push count with timestamp
        if (this.pushCount.has(item)) {
            const existingData = this.pushCount.get(item)!;
            existingData.count += 1;
            existingData.timestamp = now;  // Update timestamp to current time
        } else {
            this.pushCount.set(item, { count: 1, timestamp: now });
        }
    }

    public clear() {
        this.items = [];
        this.pushCount.clear();
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
        // Retrieve the count for the item within the last hour
        const data = this.pushCount.get(item);
        if (data && Date.now() - data.timestamp <= 60 * 60 * 1000) {
            return data.count;
        } else {
            return 0;
        }
    }
}
