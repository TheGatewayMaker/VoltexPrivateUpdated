import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

type BackupOperation =
  | {
      type: "put";
      bucket: string;
      key: string;
      body: string;
      contentType: string;
      attemptCount: number;
      nextAttemptAt: number;
      updatedAt: number;
    }
  | {
      type: "delete";
      bucket: string;
      key: string;
      attemptCount: number;
      nextAttemptAt: number;
      updatedAt: number;
    };

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDir, "../..");
const storageDir =
  process.env.LOCAL_STORAGE_DIR || path.join("server", "data");
const queueFilePath = path.resolve(
  projectRoot,
  storageDir,
  "voltex-system",
  "backup",
  "r2-sync-queue.json",
);

const backupQueue = new Map<string, BackupOperation>();
let backupClient: S3Client | null = null;
let queueLoaded = false;
let processing = false;
let persistChain: Promise<void> = Promise.resolve();
let workerInterval: NodeJS.Timeout | null = null;

function queueMapKey(bucket: string, key: string): string {
  return `${bucket}:${key}`;
}

function getR2Client(): S3Client | null {
  if (backupClient) {
    return backupClient;
  }

  if (process.env.ENABLE_R2_BACKUP !== "true") {
    return null;
  }

  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const endpoint = process.env.R2_ENDPOINT_URL;

  if (!accessKeyId || !secretAccessKey || !endpoint) {
    console.warn(
      "[R2-BACKUP] ENABLE_R2_BACKUP=true but R2 credentials are incomplete. Backup sync is disabled.",
    );
    return null;
  }

  backupClient = new S3Client({
    region: "auto",
    endpoint,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });

  return backupClient;
}

async function ensureQueueDirectory(): Promise<void> {
  await fs.mkdir(path.dirname(queueFilePath), {
    recursive: true,
    mode: 0o700,
  });
}

async function fsyncDirectory(directoryPath: string): Promise<void> {
  const handle = await fs.open(directoryPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function persistQueue(): Promise<void> {
  persistChain = persistChain
    .catch(() => undefined)
    .then(async () => {
      await ensureQueueDirectory();
      const tempPath = `${queueFilePath}.${process.pid}.${Date.now()}.tmp`;
      const payload = JSON.stringify(
        {
          operations: Array.from(backupQueue.values()),
        },
        null,
        2,
      );

      const handle = await fs.open(tempPath, "w", 0o600);
      try {
        await handle.writeFile(payload, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }

      await fs.rename(tempPath, queueFilePath);
      await fsyncDirectory(path.dirname(queueFilePath));
    });

  await persistChain;
}

async function loadQueue(): Promise<void> {
  if (queueLoaded) {
    return;
  }

  queueLoaded = true;

  try {
    const data = await fs.readFile(queueFilePath, "utf8");
    const parsed = JSON.parse(data) as { operations?: BackupOperation[] };
    backupQueue.clear();

    for (const operation of parsed.operations || []) {
      backupQueue.set(queueMapKey(operation.bucket, operation.key), operation);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[R2-BACKUP] Failed to load backup queue:", error);
    }
  }
}

function scheduleWorker(): void {
  if (workerInterval) {
    return;
  }

  workerInterval = setInterval(() => {
    void processBackupQueue();
  }, 5000);
  workerInterval.unref?.();
}

function computeNextAttemptDelay(attemptCount: number): number {
  return Math.min(300000, 5000 * Math.pow(2, Math.min(attemptCount, 6)));
}

async function processOperation(operation: BackupOperation): Promise<void> {
  const client = getR2Client();
  if (!client) {
    return;
  }

  if (operation.type === "put") {
    await client.send(
      new PutObjectCommand({
        Bucket: operation.bucket,
        Key: operation.key,
        Body: operation.body,
        ContentType: operation.contentType,
      }),
    );
    return;
  }

  await client.send(
    new DeleteObjectCommand({
      Bucket: operation.bucket,
      Key: operation.key,
    }),
  );
}

export async function processBackupQueue(): Promise<void> {
  if (processing) {
    return;
  }

  await loadQueue();
  const client = getR2Client();
  if (!client) {
    return;
  }

  processing = true;
  try {
    const now = Date.now();
    const operations = Array.from(backupQueue.values()).sort(
      (a, b) => a.updatedAt - b.updatedAt,
    );

    for (const operation of operations) {
      if (operation.nextAttemptAt > now) {
        continue;
      }

      try {
        await processOperation(operation);
        backupQueue.delete(queueMapKey(operation.bucket, operation.key));
        await persistQueue();
      } catch (error) {
        operation.attemptCount += 1;
        operation.updatedAt = Date.now();
        operation.nextAttemptAt =
          operation.updatedAt + computeNextAttemptDelay(operation.attemptCount);
        backupQueue.set(queueMapKey(operation.bucket, operation.key), operation);
        await persistQueue();
        console.error(
          `[R2-BACKUP] Failed to sync ${operation.type} ${operation.bucket}/${operation.key}:`,
          error,
        );
      }
    }
  } finally {
    processing = false;
  }
}

export async function enqueueBackupPut(
  bucket: string,
  key: string,
  body: string | Buffer,
  contentType: string = "application/json",
): Promise<void> {
  await loadQueue();
  const operation: BackupOperation = {
    type: "put",
    bucket,
    key,
    body: typeof body === "string" ? body : body.toString("utf8"),
    contentType,
    attemptCount: 0,
    nextAttemptAt: Date.now(),
    updatedAt: Date.now(),
  };

  backupQueue.set(queueMapKey(bucket, key), operation);
  await persistQueue();
  void processBackupQueue();
}

export async function enqueueBackupDelete(
  bucket: string,
  key: string,
): Promise<void> {
  await loadQueue();
  const operation: BackupOperation = {
    type: "delete",
    bucket,
    key,
    attemptCount: 0,
    nextAttemptAt: Date.now(),
    updatedAt: Date.now(),
  };

  backupQueue.set(queueMapKey(bucket, key), operation);
  await persistQueue();
  void processBackupQueue();
}

export async function initializeCloudBackupSync(): Promise<void> {
  await loadQueue();
  scheduleWorker();
  void processBackupQueue();
}

export async function flushCloudBackupSync(): Promise<void> {
  await persistChain.catch(() => undefined);
  await processBackupQueue();
}

export function getCloudBackupStatus(): {
  enabled: boolean;
  queuedOperations: number;
} {
  return {
    enabled: !!getR2Client(),
    queuedOperations: backupQueue.size,
  };
}

export function resetCloudBackupRuntimeState(): void {
  backupQueue.clear();
  queueLoaded = false;
  processing = false;
  persistChain = Promise.resolve();
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
  }
  backupClient = null;
}
