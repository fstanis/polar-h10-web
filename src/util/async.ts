/**
 * Small async primitives: a closeable single-consumer queue and a FIFO mutex.
 * @packageDocumentation
 */

/**
 * A single-consumer FIFO. Producers `push`; the consumer `await next()`.
 * Closing or failing the queue rejects the current and future waiters, which is
 * how a GATT disconnect surfaces at the point of consumption. Buffered values
 * are still delivered before the terminal error.
 */
export class AsyncQueue<T> {
  private readonly buffer: T[] = [];
  private waiter: { resolve: (v: T) => void; reject: (e: unknown) => void } | null = null;
  private closedError: Error | null = null;
  private done = false;

  /** Enqueue a value; dropped silently after the queue has terminated. */
  push(value: T): void {
    if (this.done) return;
    if (this.waiter) {
      const { resolve } = this.waiter;
      this.waiter = null;
      resolve(value);
    } else {
      this.buffer.push(value);
    }
  }

  /** Reject the pending and all future `next()` calls. */
  fail(error: Error): void {
    if (this.done) return;
    this.done = true;
    this.closedError = error;
    if (this.waiter) {
      const { reject } = this.waiter;
      this.waiter = null;
      reject(error);
    }
  }

  /** Mark end-of-stream; buffered values are still delivered, then `next()` rejects. */
  close(): void {
    this.fail(new Error('queue closed'));
  }

  /**
   * Await the next value. Rejects with the failure reason once the queue was
   * failed/closed and no buffered values remain.
   */
  next(): Promise<T> {
    const buffered = this.buffer.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    if (this.closedError) return Promise.reject(this.closedError);
    if (this.waiter) return Promise.reject(new Error('AsyncQueue: concurrent next() not allowed'));
    return new Promise<T>((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  clear(): void {
    this.buffer.length = 0;
  }

  /**
   * Iterate values until the queue terminates. Ends silently when `signal` was
   * aborted; otherwise the terminal error propagates to the consumer.
   */
  async *consume(signal?: AbortSignal): AsyncIterableIterator<T> {
    while (true) {
      let value: T;
      try {
        value = await this.next();
      } catch (error) {
        if (signal?.aborted) return;
        throw error;
      }
      yield value;
    }
  }
}

/** A minimal FIFO mutex so device operations serialize on the shared control points. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  /** Run `fn` once all previously-queued sections have completed. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    // Keep the chain alive regardless of individual failures.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** Reject after `ms` with a factory-built error, unless the guarded promise settles first. */
export function withTimeout<T>(promise: Promise<T>, ms: number, makeError: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(makeError()), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
