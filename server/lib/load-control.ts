import { RequestHandler } from "express";

export class OverloadedError extends Error {
  statusCode: number;
  retryAfterSeconds: number;

  constructor(message: string, retryAfterSeconds: number = 2) {
    super(message);
    this.name = "OverloadedError";
    this.statusCode = 503;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

type QueueEntry<T> = {
  run: () => Promise<T> | T;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  timer: NodeJS.Timeout;
};

type AsyncLimiterOptions = {
  name: string;
  maxConcurrent: number;
  maxQueue: number;
  queueTimeoutMs?: number;
  rejectionMessage?: string;
};

export function isOverloadedError(error: unknown): error is OverloadedError {
  return error instanceof OverloadedError;
}

export function createAsyncLimiter(options: AsyncLimiterOptions) {
  const {
    maxConcurrent,
    maxQueue,
    queueTimeoutMs = 10_000,
    rejectionMessage = "Server is busy, please retry in a moment",
  } = options;

  let activeCount = 0;
  const queue: Array<QueueEntry<unknown>> = [];

  const drainQueue = () => {
    while (activeCount < maxConcurrent && queue.length > 0) {
      const entry = queue.shift();
      if (!entry) {
        return;
      }

      clearTimeout(entry.timer);
      activeCount += 1;

      Promise.resolve(entry.run())
        .then(entry.resolve)
        .catch(entry.reject)
        .finally(() => {
          activeCount = Math.max(0, activeCount - 1);
          drainQueue();
        });
    }
  };

  const run = <T>(task: () => Promise<T> | T): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const startTask = () => {
        activeCount += 1;

        Promise.resolve(task())
          .then(resolve)
          .catch(reject)
          .finally(() => {
            activeCount = Math.max(0, activeCount - 1);
            drainQueue();
          });
      };

      if (activeCount < maxConcurrent) {
        startTask();
        return;
      }

      if (queue.length >= maxQueue) {
        reject(new OverloadedError(rejectionMessage));
        return;
      }

      const timer = setTimeout(() => {
        const index = queue.findIndex((entry) => entry.reject === reject);
        if (index >= 0) {
          queue.splice(index, 1);
        }
        reject(new OverloadedError(rejectionMessage));
      }, queueTimeoutMs);
      timer.unref?.();

      queue.push({
        run: task,
        resolve,
        reject,
        timer,
      });
    });

  return {
    run,
    getStats: () => ({
      activeCount,
      queuedCount: queue.length,
      maxConcurrent,
      maxQueue,
      name: options.name,
    }),
  };
}

type RequestGateOptions = AsyncLimiterOptions;

export function createRequestGate(options: RequestGateOptions): RequestHandler {
  const limiter = createAsyncLimiter(options);

  return (req, res, next) => {
    void limiter
      .run(
        () =>
          new Promise<void>((resolve) => {
            let released = false;

            const release = () => {
              if (released) {
                return;
              }
              released = true;
              resolve();
            };

            res.once("finish", release);
            res.once("close", release);
            next();
          }),
      )
      .catch((error) => {
        if (res.headersSent) {
          return;
        }

        if (isOverloadedError(error)) {
          res.setHeader("Retry-After", String(error.retryAfterSeconds));
          res.status(error.statusCode).json({
            error: error.message,
            retryAfter: error.retryAfterSeconds,
          });
          return;
        }

        next(error);
      });
  };
}

type MemoryCacheEntry<T> = {
  value: T;
  expiresAt: number;
};

export function createMemoryCache<T>(options: {
  ttlMs: number;
  maxEntries: number;
}) {
  const store = new Map<string, MemoryCacheEntry<T>>();

  const pruneExpired = (now: number) => {
    for (const [key, entry] of store.entries()) {
      if (entry.expiresAt <= now) {
        store.delete(key);
      }
    }
  };

  const evictOverflow = () => {
    while (store.size > options.maxEntries) {
      const oldestKey = store.keys().next().value;
      if (!oldestKey) {
        return;
      }
      store.delete(oldestKey);
    }
  };

  return {
    get(key: string): T | null {
      const now = Date.now();
      const entry = store.get(key);

      if (!entry) {
        return null;
      }

      if (entry.expiresAt <= now) {
        store.delete(key);
        return null;
      }

      store.delete(key);
      store.set(key, entry);
      return entry.value;
    },
    set(key: string, value: T): void {
      const now = Date.now();
      pruneExpired(now);
      store.set(key, {
        value,
        expiresAt: now + options.ttlMs,
      });
      evictOverflow();
    },
    delete(key: string): void {
      store.delete(key);
    },
    clear(): void {
      store.clear();
    },
  };
}

export const requestGates = {
  profileRead: createRequestGate({
    name: "profile-read",
    maxConcurrent: 80,
    maxQueue: 240,
    queueTimeoutMs: 5_000,
    rejectionMessage: "Profile service is busy, please retry in a moment",
  }),
  userLookup: createRequestGate({
    name: "user-lookup",
    maxConcurrent: 250,
    maxQueue: 2_000,
    queueTimeoutMs: 15_000,
    rejectionMessage: "User lookup is busy, please retry in a moment",
  }),
  conversationRead: createRequestGate({
    name: "conversation-read",
    maxConcurrent: 24,
    maxQueue: 120,
    queueTimeoutMs: 8_000,
    rejectionMessage: "Chat history is busy, please retry in a moment",
  }),
  messageSend: createRequestGate({
    name: "message-send",
    maxConcurrent: 100,
    maxQueue: 400,
    queueTimeoutMs: 6_000,
    rejectionMessage: "Messaging is busy, please retry in a moment",
  }),
  avatarRead: createRequestGate({
    name: "avatar-read",
    maxConcurrent: 24,
    maxQueue: 160,
    queueTimeoutMs: 5_000,
    rejectionMessage: "Avatar service is busy, please retry in a moment",
  }),
  avatarMutation: createRequestGate({
    name: "avatar-mutation",
    maxConcurrent: 2,
    maxQueue: 40,
    queueTimeoutMs: 15_000,
    rejectionMessage: "Avatar uploads are busy, please retry in a moment",
  }),
  mediaRead: createRequestGate({
    name: "media-read",
    maxConcurrent: 32,
    maxQueue: 192,
    queueTimeoutMs: 6_000,
    rejectionMessage: "Media service is busy, please retry in a moment",
  }),
  mediaMutation: createRequestGate({
    name: "media-mutation",
    maxConcurrent: 3,
    maxQueue: 48,
    queueTimeoutMs: 20_000,
    rejectionMessage: "Image uploads are busy, please retry in a moment",
  }),
};

export const asyncLimiters = {
  messagePersistence: createAsyncLimiter({
    name: "message-persistence",
    maxConcurrent: 48,
    maxQueue: 240,
    queueTimeoutMs: 8_000,
    rejectionMessage: "Messaging is busy, please retry in a moment",
  }),
  avatarMutation: createAsyncLimiter({
    name: "avatar-mutation-task",
    maxConcurrent: 2,
    maxQueue: 40,
    queueTimeoutMs: 15_000,
    rejectionMessage: "Avatar uploads are busy, please retry in a moment",
  }),
  mediaRead: createAsyncLimiter({
    name: "media-read-task",
    maxConcurrent: 32,
    maxQueue: 192,
    queueTimeoutMs: 6_000,
    rejectionMessage: "Media service is busy, please retry in a moment",
  }),
  mediaMutation: createAsyncLimiter({
    name: "media-mutation-task",
    maxConcurrent: 3,
    maxQueue: 48,
    queueTimeoutMs: 20_000,
    rejectionMessage: "Image uploads are busy, please retry in a moment",
  }),
};
