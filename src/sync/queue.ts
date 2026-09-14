export class AsyncQueue {
  private activeCount = 0;
  private queue: Array<() => Promise<void>> = [];

  constructor(private concurrency: number = 3) {}

  setConcurrency(concurrency: number): void {
    this.concurrency = Math.max(1, concurrency);
  }

  add<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const runner = async () => {
        try {
          const res = await task();
          resolve(res);
        } catch (err) {
          reject(err);
        } finally {
          this.activeCount--;
          this.next();
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
        task();
      }
    }
  }

  async waitAll(): Promise<void> {
    while (this.activeCount > 0 || this.queue.length > 0) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}
