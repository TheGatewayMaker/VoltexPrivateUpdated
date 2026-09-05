import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { isDatabaseConnected, query, queryOne } from "./db";
import { storageRoot } from "./storage-paths";

export interface PushRegistrationRecord {
  userId: string;
  deviceId: string;
  topic: string;
  createdAt: number;
  lastWakeAt?: number;
}

function getPushRoot(): string {
  return path.join(storageRoot, "voltex-users", "push");
}

function getPushFilePath(userId: string, deviceId: string): string {
  return path.join(
    getPushRoot(),
    encodeURIComponent(userId),
    `${encodeURIComponent(deviceId)}.json`,
  );
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tempPath, filePath);
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * Wake-up topics are freshly random and carry no relationship to the account,
 * username or device they belong to. Anyone observing the ntfy traffic learns
 * only that some opaque topic received a wake-up.
 */
export function generatePushTopic(): string {
  return crypto.randomBytes(16).toString("hex");
}

function mapPushRow(row: {
  user_id: string;
  device_id: string;
  topic: string;
  created_at: number;
  last_wake_at: number | null;
}): PushRegistrationRecord {
  return {
    userId: row.user_id,
    deviceId: row.device_id,
    topic: row.topic,
    createdAt: Number(row.created_at || Date.now()),
    lastWakeAt:
      row.last_wake_at === null || row.last_wake_at === undefined
        ? undefined
        : Number(row.last_wake_at),
  };
}

export async function savePushRegistration(params: {
  userId: string;
  deviceId: string;
  topic?: string;
}): Promise<PushRegistrationRecord> {
  const now = Date.now();
  const existing = await getPushRegistration(params.userId, params.deviceId);
  const topic = params.topic || existing?.topic || generatePushTopic();
  const createdAt = existing?.createdAt || now;

  const record: PushRegistrationRecord = {
    userId: params.userId,
    deviceId: params.deviceId,
    topic,
    createdAt,
    lastWakeAt: existing?.lastWakeAt,
  };

  if (isDatabaseConnected()) {
    await query(
      `INSERT INTO push_registrations (
         user_id,
         device_id,
         topic,
         created_at,
         last_wake_at
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, device_id) DO UPDATE
       SET topic = EXCLUDED.topic;`,
      [record.userId, record.deviceId, record.topic, record.createdAt, record.lastWakeAt ?? null],
    );
    return record;
  }

  await writeJsonAtomic(getPushFilePath(record.userId, record.deviceId), record);
  return record;
}

export async function getPushRegistration(
  userId: string,
  deviceId: string,
): Promise<PushRegistrationRecord | null> {
  if (isDatabaseConnected()) {
    const row = await queryOne<{
      user_id: string;
      device_id: string;
      topic: string;
      created_at: number;
      last_wake_at: number | null;
    }>(
      `SELECT user_id, device_id, topic, created_at, last_wake_at
       FROM push_registrations
       WHERE user_id = $1 AND device_id = $2
       LIMIT 1;`,
      [userId, deviceId],
    );

    return row ? mapPushRow(row) : null;
  }

  return readJsonFile<PushRegistrationRecord>(getPushFilePath(userId, deviceId));
}

export async function getPushRegistrationsForUser(
  userId: string,
): Promise<PushRegistrationRecord[]> {
  if (isDatabaseConnected()) {
    const rows =
      (await query<{
        user_id: string;
        device_id: string;
        topic: string;
        created_at: number;
        last_wake_at: number | null;
      }>(
        `SELECT user_id, device_id, topic, created_at, last_wake_at
         FROM push_registrations
         WHERE user_id = $1
         ORDER BY created_at DESC;`,
        [userId],
      )) || [];

    return rows.map(mapPushRow);
  }

  const userDir = path.join(getPushRoot(), encodeURIComponent(userId));
  try {
    const entries = await fs.readdir(userDir);
    const records = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) =>
          readJsonFile<PushRegistrationRecord>(path.join(userDir, entry)),
        ),
    );
    return records.filter(
      (record): record is PushRegistrationRecord => !!record,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function deletePushRegistration(
  userId: string,
  deviceId: string,
): Promise<boolean> {
  if (isDatabaseConnected()) {
    const rows = await query<{ device_id: string }>(
      `DELETE FROM push_registrations
       WHERE user_id = $1 AND device_id = $2
       RETURNING device_id;`,
      [userId, deviceId],
    );
    return !!rows && rows.length > 0;
  }

  try {
    await fs.unlink(getPushFilePath(userId, deviceId));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/**
 * Called when a device or its session is revoked, so a revoked device loses the
 * ability to be woken as well as the ability to read.
 */
export async function deletePushRegistrationsForDevice(
  userId: string,
  deviceId: string,
): Promise<void> {
  try {
    await deletePushRegistration(userId, deviceId);
  } catch (error) {
    console.error(
      `[PUSH] Failed to remove push registration for device ${deviceId}:`,
      error,
    );
  }
}

/**
 * Used when the push transport reports that a topic no longer exists, so a dead
 * registration is not retried forever.
 */
export async function deletePushRegistrationByTopic(
  topic: string,
): Promise<void> {
  if (isDatabaseConnected()) {
    await query(`DELETE FROM push_registrations WHERE topic = $1;`, [topic]);
    return;
  }

  let userDirs: string[] = [];
  try {
    userDirs = await fs.readdir(getPushRoot());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const userDir of userDirs) {
    const dirPath = path.join(getPushRoot(), userDir);
    let entries: string[] = [];
    try {
      entries = await fs.readdir(dirPath);
    } catch {
      continue;
    }
    for (const entry of entries.filter((name) => name.endsWith(".json"))) {
      const filePath = path.join(dirPath, entry);
      const record = await readJsonFile<PushRegistrationRecord>(filePath);
      if (record?.topic === topic) {
        await fs.unlink(filePath).catch(() => undefined);
      }
    }
  }
}

export async function touchPushRegistrationWake(
  userId: string,
  deviceId: string,
  lastWakeAt: number = Date.now(),
): Promise<void> {
  if (isDatabaseConnected()) {
    await query(
      `UPDATE push_registrations
       SET last_wake_at = GREATEST(COALESCE(last_wake_at, 0), $3)
       WHERE user_id = $1 AND device_id = $2;`,
      [userId, deviceId, lastWakeAt],
    );
    return;
  }

  const existing = await getPushRegistration(userId, deviceId);
  if (!existing) {
    return;
  }

  await writeJsonAtomic(getPushFilePath(userId, deviceId), {
    ...existing,
    lastWakeAt: Math.max(existing.lastWakeAt || 0, lastWakeAt),
  });
}

