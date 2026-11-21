export const FS_META_TIMEOUT_MS = 15_000;
export const FS_BINARY_TIMEOUT_MS = 30_000;
export const BRIDGE_PROBE_TIMEOUT_MS = 5_000;
export const HTTP_REQUEST_TIMEOUT_MS = 60_000;

export class OperationTimeoutError extends Error {
  constructor(
    public readonly operation: string,
    public readonly timeoutMs: number,
    public readonly kind: "vault" | "http"
  ) {
    super(`${operation} timed out after ${timeoutMs}ms`);
    this.name = "OperationTimeoutError";
  }
}

export class BridgeDeadlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeDeadlockError";
  }
}

/**
 * Races an async operation against a deterministic timer, always cleaning up
 * the timer on settlement and swallowing late rejections after timeout to avoid
 * unhandled promise rejections.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string,
  kind: "vault" | "http"
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new OperationTimeoutError(operation, timeoutMs, kind));
    }, timeoutMs);

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    );
  });
}
