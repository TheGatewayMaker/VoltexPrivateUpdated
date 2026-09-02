import fs from "fs/promises";
import path from "path";
import {
  AccountHistoryKeyRecord,
  DeviceLinkRequestRecord,
  DeviceWrappedHistoryKeyRecord,
} from "@shared/crypto";
import { isDatabaseConnected, query, queryOne } from "./db";
import { storageRoot } from "./storage-paths";

function getHistoryRoot(): string {
  return path.join(storageRoot, "voltex-history");
}

function getUserHistoryDir(userId: string): string {
  return path.join(getHistoryRoot(), encodeURIComponent(userId));
}

function getHistoryKeyPath(userId: string, historyKeyVersion: number): string {
  return path.join(
    getUserHistoryDir(userId),
    "keys",
    `${historyKeyVersion}.json`,
  );
}

function getWrappedHistoryKeyPath(
  userId: string,
  historyKeyVersion: number,
  deviceId: string,
): string {
  return path.join(
    getUserHistoryDir(userId),
    "wrapped-keys",
    `${historyKeyVersion}`,
    `${encodeURIComponent(deviceId)}.json`,
  );
}

function getLinkRequestsDir(): string {
  return path.join(getHistoryRoot(), "link-requests");
}

function getLinkRequestPath(linkId: string): string {
  return path.join(getLinkRequestsDir(), `${encodeURIComponent(linkId)}.json`);
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

export async function saveAccountHistoryKey(
  record: AccountHistoryKeyRecord,
): Promise<void> {
  if (isDatabaseConnected()) {
    await query(
      `INSERT INTO account_history_keys (
         user_id,
         history_key_version,
         status,
         created_at,
         rotated_at
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, history_key_version) DO UPDATE
       SET status = EXCLUDED.status,
           rotated_at = EXCLUDED.rotated_at;`,
      [
        record.userId,
        record.historyKeyVersion,
        record.status,
        record.createdAt,
        record.rotatedAt || null,
      ],
    );
    return;
  }

  await writeJsonAtomic(
    getHistoryKeyPath(record.userId, record.historyKeyVersion),
    record,
  );
}

export async function getActiveAccountHistoryKey(
  userId: string,
): Promise<AccountHistoryKeyRecord | null> {
  if (isDatabaseConnected()) {
    const row = await queryOne<{
      user_id: string;
      history_key_version: number;
      status: "active" | "rotated" | "revoked";
      created_at: number;
      rotated_at: number | null;
    }>(
      `SELECT
         user_id,
         history_key_version,
         status,
         created_at,
         rotated_at
       FROM account_history_keys
       WHERE user_id = $1 AND status = 'active'
       ORDER BY history_key_version DESC
       LIMIT 1;`,
      [userId],
    );

    return row
      ? {
          userId: row.user_id,
          historyKeyVersion: Number(row.history_key_version),
          status: row.status,
          createdAt: Number(row.created_at),
          rotatedAt:
            typeof row.rotated_at === "number" ? Number(row.rotated_at) : undefined,
        }
      : null;
  }

  const keysDir = path.join(getUserHistoryDir(userId), "keys");
  try {
    const entries = await fs.readdir(keysDir);
    const records = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) => readJsonFile<AccountHistoryKeyRecord>(path.join(keysDir, entry))),
    );
    return (
      records
        .filter((record): record is AccountHistoryKeyRecord => !!record && record.status === "active")
        .sort((left, right) => right.historyKeyVersion - left.historyKeyVersion)[0] ||
      null
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function saveWrappedHistoryKey(
  record: DeviceWrappedHistoryKeyRecord,
): Promise<void> {
  if (isDatabaseConnected()) {
    await query(
      `INSERT INTO device_wrapped_history_keys (
         user_id,
         history_key_version,
         device_id,
         wrapped_key,
         wrapper_algorithm,
         created_at
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, history_key_version, device_id) DO UPDATE
       SET wrapped_key = EXCLUDED.wrapped_key,
           wrapper_algorithm = EXCLUDED.wrapper_algorithm,
           created_at = EXCLUDED.created_at;`,
      [
        record.userId,
        record.historyKeyVersion,
        record.deviceId,
        record.wrappedKey,
        record.wrapperAlgorithm,
        record.createdAt,
      ],
    );
    return;
  }

  await writeJsonAtomic(
    getWrappedHistoryKeyPath(
      record.userId,
      record.historyKeyVersion,
      record.deviceId,
    ),
    record,
  );
}

export async function listWrappedHistoryKeysForDevice(
  userId: string,
  deviceId: string,
): Promise<DeviceWrappedHistoryKeyRecord[]> {
  if (isDatabaseConnected()) {
    const rows =
      (await query<{
        user_id: string;
        history_key_version: number;
        device_id: string;
        wrapped_key: string;
        wrapper_algorithm: string;
        created_at: number;
      }>(
        `SELECT
           user_id,
           history_key_version,
           device_id,
           wrapped_key,
           wrapper_algorithm,
           created_at
         FROM device_wrapped_history_keys
         WHERE user_id = $1 AND device_id = $2
         ORDER BY history_key_version DESC;`,
        [userId, deviceId],
      )) || [];

    return rows.map((row) => ({
      userId: row.user_id,
      historyKeyVersion: Number(row.history_key_version),
      deviceId: row.device_id,
      wrappedKey: row.wrapped_key,
      wrapperAlgorithm: row.wrapper_algorithm,
      createdAt: Number(row.created_at),
    }));
  }

  const wrappedRoot = path.join(getUserHistoryDir(userId), "wrapped-keys");
  try {
    const versionDirs = await fs.readdir(wrappedRoot);
    const records: DeviceWrappedHistoryKeyRecord[] = [];

    for (const versionDir of versionDirs) {
      const version = Number.parseInt(versionDir, 10);
      if (!Number.isInteger(version)) {
        continue;
      }
      const record = await readJsonFile<DeviceWrappedHistoryKeyRecord>(
        getWrappedHistoryKeyPath(userId, version, deviceId),
      );
      if (record) {
        records.push(record);
      }
    }

    return records.sort(
      (left, right) => right.historyKeyVersion - left.historyKeyVersion,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function saveDeviceLinkRequest(
  record: DeviceLinkRequestRecord,
): Promise<void> {
  if (isDatabaseConnected()) {
    await query(
      `INSERT INTO device_link_requests (
         link_id,
         user_id,
         requested_by_device_id,
         challenge,
         status,
         created_at,
         expires_at,
         completed_at,
         target_device_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (link_id) DO UPDATE
       SET status = EXCLUDED.status,
           expires_at = EXCLUDED.expires_at,
           completed_at = EXCLUDED.completed_at,
           target_device_id = EXCLUDED.target_device_id;`,
      [
        record.linkId,
        record.userId,
        record.requestedByDeviceId,
        record.challenge,
        record.status,
        record.createdAt,
        record.expiresAt,
        record.completedAt || null,
        record.targetDeviceId || null,
      ],
    );
    return;
  }

  await writeJsonAtomic(getLinkRequestPath(record.linkId), record);
}

export async function getDeviceLinkRequest(
  linkId: string,
): Promise<DeviceLinkRequestRecord | null> {
  if (isDatabaseConnected()) {
    const row = await queryOne<{
      link_id: string;
      user_id: string;
      requested_by_device_id: string;
      challenge: string;
      status: "pending" | "completed" | "cancelled" | "expired";
      created_at: number;
      expires_at: number;
      completed_at: number | null;
      target_device_id: string | null;
    }>(
      `SELECT
         link_id,
         user_id,
         requested_by_device_id,
         challenge,
         status,
         created_at,
         expires_at,
         completed_at,
         target_device_id
       FROM device_link_requests
       WHERE link_id = $1
       LIMIT 1;`,
      [linkId],
    );

    return row
      ? {
          linkId: row.link_id,
          userId: row.user_id,
          requestedByDeviceId: row.requested_by_device_id,
          challenge: row.challenge,
          status: row.status,
          createdAt: Number(row.created_at),
          expiresAt: Number(row.expires_at),
          completedAt:
            typeof row.completed_at === "number" ? Number(row.completed_at) : undefined,
          targetDeviceId: row.target_device_id || undefined,
        }
      : null;
  }

  return readJsonFile<DeviceLinkRequestRecord>(getLinkRequestPath(linkId));
}
