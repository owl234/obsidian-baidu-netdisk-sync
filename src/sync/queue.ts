export class QueueCancelledError extends Error {
  constructor(message = "Queued task was cancelled") {
    super(message);
    this.name = "QueueCancelledError";
  }
}

interface QueuedEntry {
  run: () => Promise<void>;
  cancel: (reason: Error) => void;
}

export class AsyncQueue {
  private activeCount = 0;
  private queue: QueuedEntry[] = [];
  private idleResolvers: Array<() => void> = [];

  constructor(private concurrency: number = 3) {
    this.concurrency = Math.max(1, concurrency);
  }

  setConcurrency(concurrency: number): void {
    this.concurrency = Math.max(1, concurrency);
    this.next();
  }

  getPendingCount(): number {
    return this.queue.length;
  }

  getActiveCount(): number {
    return this.activeCount;
  }

  add<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;

      const entry: QueuedEntry = {
        run: async () => {
          try {
            const res = await task();
            if (!settled) {
              settled = true;
              resolve(res);
            }
          } catch (err) {
            if (!settled) {
              settled = true;
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          } finally {
            this.activeCount--;
            this.next();
            this.checkIdle();
          }
        },
        cancel: (reason: Error) => {
          if (!settled) {
            settled = true;
            reject(reason);
          }
        }
      };

      this.queue.push(entry);
      this.next();
    });
  }

  /**
   * Immediately cancels all unstarted tasks in the queue so callers awaiting them
   * unblock without waiting for thousands of remaining items.
   */
  clear(reason?: Error): number {
    const cancelled = this.queue.splice(0, this.queue.length);
    const err = reason ?? new QueueCancelledError();
    for (const entry of cancelled) {
      entry.cancel(err);
    }
    this.checkIdle();
    return cancelled.length;
  }

  private next(): void {
    while (this.activeCount < this.concurrency && this.queue.length > 0) {
      const entry = this.queue.shift();
      if (entry) {
        this.activeCount++;
        void entry.run();
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
