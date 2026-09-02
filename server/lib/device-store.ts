import fs from "fs/promises";
import path from "path";
import { UserDeviceRecord } from "@shared/crypto";
import { isDatabaseConnected, query, queryOne } from "./db";
import { storageRoot } from "./storage-paths";

function getDevicesRoot(): string {
  return path.join(storageRoot, "voltex-users", "devices");
}

function getDeviceFilePath(userId: string, deviceId: string): string {
  return path.join(
    getDevicesRoot(),
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

function mapDeviceRow(
  row: {
    user_id: string;
    device_id: string;
    device_name: string | null;
    platform: string | null;
    app_kind: string | null;
    status: string;
    linked_at: number;
    revoked_at: number | null;
    last_seen_at: number | null;
    created_by_device_id: string | null;
  },
): UserDeviceRecord {
  return {
    userId: row.user_id,
    deviceId: row.device_id,
    deviceName: row.device_name || undefined,
    platform: row.platform || undefined,
    appKind:
      row.app_kind === "android" ||
      row.app_kind === "ios" ||
      row.app_kind === "desktop"
        ? row.app_kind
        : "web",
    status:
      row.status === "revoked" || row.status === "pending_link"
        ? row.status
        : "active",
    linkedAt: Number(row.linked_at || Date.now()),
    revokedAt:
      typeof row.revoked_at === "number" ? Number(row.revoked_at) : undefined,
    lastSeenAt:
      typeof row.last_seen_at === "number" ? Number(row.last_seen_at) : undefined,
    createdByDeviceId: row.created_by_device_id || undefined,
  };
}

export async function saveUserDevice(device: UserDeviceRecord): Promise<void> {
  const linkedAt =
    typeof device.linkedAt === "number" && Number.isFinite(device.linkedAt)
      ? device.linkedAt
      : Date.now();
  const lastSeenAt =
    typeof device.lastSeenAt === "number" && Number.isFinite(device.lastSeenAt)
      ? device.lastSeenAt
      : linkedAt;

  if (isDatabaseConnected()) {
    await query(
      `INSERT INTO user_devices (
         user_id,
         device_id,
         device_name,
         platform,
         app_kind,
         status,
         linked_at,
         revoked_at,
         last_seen_at,
         created_by_device_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (user_id, device_id) DO UPDATE
       SET device_name = EXCLUDED.device_name,
           platform = EXCLUDED.platform,
           app_kind = EXCLUDED.app_kind,
           status = EXCLUDED.status,
           revoked_at = EXCLUDED.revoked_at,
           last_seen_at = EXCLUDED.last_seen_at,
           created_by_device_id = COALESCE(user_devices.created_by_device_id, EXCLUDED.created_by_device_id);`,
      [
        device.userId,
        device.deviceId,
        device.deviceName || null,
        device.platform || null,
        device.appKind || "web",
        device.status,
        linkedAt,
        device.revokedAt || null,
        lastSeenAt,
        device.createdByDeviceId || null,
      ],
    );
    return;
  }

  await writeJsonAtomic(getDeviceFilePath(device.userId, device.deviceId), {
    ...device,
    linkedAt,
    lastSeenAt,
  });
}

export async function getUserDevice(
  userId: string,
  deviceId: string,
): Promise<UserDeviceRecord | null> {
  if (isDatabaseConnected()) {
    const row = await queryOne<{
      user_id: string;
      device_id: string;
      device_name: string | null;
      platform: string | null;
      app_kind: string | null;
      status: string;
      linked_at: number;
      revoked_at: number | null;
      last_seen_at: number | null;
      created_by_device_id: string | null;
    }>(
      `SELECT
         user_id,
         device_id,
         device_name,
         platform,
         app_kind,
         status,
         linked_at,
         revoked_at,
         last_seen_at,
         created_by_device_id
       FROM user_devices
       WHERE user_id = $1 AND device_id = $2
       LIMIT 1;`,
      [userId, deviceId],
    );

    return row ? mapDeviceRow(row) : null;
  }

  return readJsonFile<UserDeviceRecord>(getDeviceFilePath(userId, deviceId));
}

export async function listUserDevices(userId: string): Promise<UserDeviceRecord[]> {
  if (isDatabaseConnected()) {
    const rows =
      (await query<{
        user_id: string;
        device_id: string;
        device_name: string | null;
        platform: string | null;
        app_kind: string | null;
        status: string;
        linked_at: number;
        revoked_at: number | null;
        last_seen_at: number | null;
        created_by_device_id: string | null;
      }>(
        `SELECT
           user_id,
           device_id,
           device_name,
           platform,
           app_kind,
           status,
           linked_at,
           revoked_at,
           last_seen_at,
           created_by_device_id
         FROM user_devices
         WHERE user_id = $1
         ORDER BY linked_at DESC;`,
        [userId],
      )) || [];

    return rows.map(mapDeviceRow);
  }

  const userDir = path.join(getDevicesRoot(), encodeURIComponent(userId));
  try {
    const entries = await fs.readdir(userDir);
    const records = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) =>
          readJsonFile<UserDeviceRecord>(path.join(userDir, entry)),
        ),
    );
    return records.filter((record): record is UserDeviceRecord => !!record);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function touchUserDeviceActivity(
  userId: string,
  deviceId: string,
  lastSeenAt: number = Date.now(),
): Promise<void> {
  if (isDatabaseConnected()) {
    await query(
      `UPDATE user_devices
       SET last_seen_at = GREATEST(COALESCE(last_seen_at, 0), $3)
       WHERE user_id = $1 AND device_id = $2;`,
      [userId, deviceId, lastSeenAt],
    );
    return;
  }

  const existing = await getUserDevice(userId, deviceId);
  if (!existing) {
    return;
  }

  await saveUserDevice({
    ...existing,
    lastSeenAt: Math.max(existing.lastSeenAt || 0, lastSeenAt),
  });
}

export async function revokeUserDevice(
  userId: string,
  deviceId: string,
): Promise<boolean> {
  const existing = await getUserDevice(userId, deviceId);
  if (!existing) {
    return false;
  }

  await saveUserDevice({
    ...existing,
    status: "revoked",
    revokedAt: Date.now(),
  });
  return true;
}
