export class PromoteQueue {
    private static instance: PromoteQueue;
    public items: string[] = [];
    private maxSize = 7;
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
