export class AsyncQueue {
  private activeCount = 0;
  private queue: Array<() => Promise<void>> = [];
  private idleResolvers: Array<() => void> = [];

  constructor(private concurrency: number = 3) {
    this.concurrency = Math.max(1, concurrency);
  }

  setConcurrency(concurrency: number): void {
    this.concurrency = Math.max(1, concurrency);
    this.next();
  }

  add<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const runner = async () => {
        try {
          const res = await task();
          resolve(res);
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        } finally {
          this.activeCount--;
          this.next();
          this.checkIdle();
        }
      };

      this.queue.push(runner);
      this.next();
    });
  }

  private next(): void {
    while (this.activeCount < this.concurrency && this.queue.length > 0) {
      const task = this.queue.shift();
      if (task) {
        this.activeCount++;
        void task();
      }
    }
  }

  private checkIdle(): void {
    if (this.activeCount === 0 && this.queue.length === 0 && this.idleResolvers.length > 0) {
      const resolvers = this.idleResolvers;
      this.idleResolvers = [];
      for (const resolve of resolvers) {
        resolve();
      }
    }
  }

  waitAll(): Promise<void> {
    if (this.activeCount === 0 && this.queue.length === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }
}
