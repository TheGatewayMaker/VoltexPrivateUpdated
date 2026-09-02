import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { query, queryOne, isDatabaseConnected } from "./db";
import { downloadFromR2, uploadToR2 } from "./r2-storage";
import { getLocalStorageRoot } from "./r2-storage";

export interface PublishedPreKey {
  keyId: number;
  publicKey: string;
}

export interface PublishedSignedPreKey extends PublishedPreKey {
  signature: string;
}

export interface DeviceBundle {
  userId: string;
  deviceId: string;
  identityKey: string;
  signingKey: string;
  signedPreKey: PublishedSignedPreKey;
  oneTimePreKeys: PublishedPreKey[];
  registrationVersion?: number;
  supportedMessageVersions?: Array<"v1" | "v2">;
  createdAt: number;
  updatedAt: number;
}

function deviceBundleKey(userId: string, deviceId: string): string {
  return `devices/${userId}/${deviceId}.json`;
}

async function listFilesystemDeviceBundles(
  userId: string,
): Promise<DeviceBundle[]> {
  const deviceDir = path.join(
    getLocalStorageRoot(),
    "voltex-protocol",
    "devices",
    encodeURIComponent(userId),
  );

  try {
    const entries = await fs.readdir(deviceDir, { withFileTypes: true });
    const bundles = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          const raw = await fs.readFile(path.join(deviceDir, entry.name), "utf8");
          return JSON.parse(raw) as DeviceBundle;
        }),
    );

    return bundles.filter(
      (bundle) =>
        bundle &&
        typeof bundle.userId === "string" &&
        typeof bundle.deviceId === "string",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function saveDeviceBundle(bundle: DeviceBundle): Promise<void> {
  if (isDatabaseConnected()) {
    await query(
      `INSERT INTO protocol_device_bundles (
         user_id, device_id, bundle_json, created_at, updated_at
       ) VALUES ($1, $2, $3::jsonb, $4, $5)
       ON CONFLICT (user_id, device_id) DO UPDATE
       SET bundle_json = EXCLUDED.bundle_json,
           updated_at = EXCLUDED.updated_at;`,
      [
        bundle.userId,
        bundle.deviceId,
        JSON.stringify(bundle),
        bundle.createdAt,
        bundle.updatedAt,
      ],
    );
    return;
  }

  await uploadToR2(
    "voltex-protocol",
    deviceBundleKey(bundle.userId, bundle.deviceId),
    JSON.stringify(bundle),
  );
}

export async function getDeviceBundle(
  userId: string,
  deviceId: string,
): Promise<DeviceBundle | null> {
  if (isDatabaseConnected()) {
    const row = await queryOne<{ bundle_json: DeviceBundle }>(
      `SELECT bundle_json
       FROM protocol_device_bundles
       WHERE user_id = $1 AND device_id = $2
       LIMIT 1;`,
      [userId, deviceId],
    );

    if (row?.bundle_json) {
      return row.bundle_json;
    }
    return null;
  }

  const data = await downloadFromR2(
    "voltex-protocol",
    deviceBundleKey(userId, deviceId),
  );
  return data ? (JSON.parse(data) as DeviceBundle) : null;
}

export async function getAnyDeviceBundle(userId: string): Promise<DeviceBundle | null> {
  if (isDatabaseConnected()) {
    const row = await queryOne<{ bundle_json: DeviceBundle }>(
      `SELECT bundle_json
       FROM protocol_device_bundles
       WHERE user_id = $1
       ORDER BY updated_at DESC
       LIMIT 1;`,
      [userId],
    );

    if (row?.bundle_json) {
      return row.bundle_json;
    }
    return null;
  }

  const bundles = await listFilesystemDeviceBundles(userId);
  if (bundles.length === 0) {
    return null;
  }

  bundles.sort((left, right) => right.updatedAt - left.updatedAt);
  return bundles[0] || null;
}

export async function listDeviceBundles(userId: string): Promise<DeviceBundle[]> {
  if (isDatabaseConnected()) {
    const rows =
      (await query<{ bundle_json: DeviceBundle }>(
        `SELECT bundle_json
         FROM protocol_device_bundles
         WHERE user_id = $1
         ORDER BY updated_at DESC;`,
        [userId],
      )) || [];

    return rows
      .map((row) => row.bundle_json)
      .filter(
        (bundle): bundle is DeviceBundle =>
          !!bundle &&
          typeof bundle.userId === "string" &&
          typeof bundle.deviceId === "string",
      );
  }

  const bundles = await listFilesystemDeviceBundles(userId);
  bundles.sort((left, right) => right.updatedAt - left.updatedAt);
  return bundles;
}

export async function consumePreKey(
  userId: string,
  deviceId: string,
): Promise<{ bundle: DeviceBundle; preKey: PublishedPreKey | null } | null> {
  const bundle = await getDeviceBundle(userId, deviceId);
  if (!bundle) return null;

  const nextPreKey = bundle.oneTimePreKeys.shift() || null;
  bundle.updatedAt = Date.now();
  await saveDeviceBundle(bundle);
  return {
    bundle,
    preKey: nextPreKey,
  };
}

export function createDeviceId(): string {
  return crypto.randomBytes(12).toString("hex");
}
