import { SessionData, UserAccount } from "@shared/crypto";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { isDatabaseConnected, query, queryOne } from "./db";
import {
  checkUsernameAvailability as checkUsernameAvailabilityR2,
  reserveUsername as reserveUsernameR2,
  getUserIdByUsername as getUserIdByUsernameR2,
  listReservedUsernames as listReservedUsernamesR2,
  saveUserAccount as saveUserAccountR2,
  getUserAccount as getUserAccountR2,
  savePassphraseRecovery as savePassphraseRecoveryR2,
  getPassphraseRecovery as getPassphraseRecoveryR2,
  saveEncryptedKeypair as saveEncryptedKeypairR2,
  getEncryptedKeypair as getEncryptedKeypairR2,
  saveSession as saveSessionR2,
  getSessionData as getSessionDataR2,
  deleteSessionData as deleteSessionDataR2,
} from "./r2-storage";
import { storageRoot } from "./storage-paths";

interface RecoverySecretRecord {
  user_id?: string;
  verifier?: string | null;
  salt?: string | null;
  iterations?: number | null;
  legacy_hash?: string | null;
  passphraseHash?: string | null;
}

export interface RecoverySecret {
  verifier?: string;
  salt?: string;
  iterations?: number;
  legacyHash?: string;
}

function hashSessionToken(sessionToken: string): string {
  return crypto.createHash("sha256").update(sessionToken).digest("hex");
}

export interface StoredSessionRecord {
  sessionId: string;
  userId: string;
  deviceId?: string;
  publicKey: string;
  signPublicKey?: string;
  expiresAt: number;
  createdAt: number;
  lastSeenAt: number;
  userAgent?: string;
  deviceName?: string;
  platform?: string;
  appKind?: "web" | "android" | "ios" | "desktop";
  ipAddress?: string;
}

export async function checkUsernameAvailability(
  username: string,
): Promise<boolean> {
  const normalized = username.toLowerCase();

  if (isDatabaseConnected()) {
    const existing = await queryOne<{ username: string }>(
      `SELECT username FROM username_reservations WHERE username = $1 LIMIT 1;`,
      [normalized],
    );
    if (existing) return false;
    return true;
  }

  return checkUsernameAvailabilityR2(normalized);
}

export async function reserveUsername(
  username: string,
  userId: string,
): Promise<void> {
  const normalized = username.toLowerCase();
  const now = Date.now();

  if (isDatabaseConnected()) {
    await query(
      `INSERT INTO username_reservations (username, user_id, created_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (username) DO NOTHING;`,
      [normalized, userId, now],
    );
    return;
  }

  await reserveUsernameR2(normalized, userId);
}

export async function getUserIdByUsername(
  username: string,
): Promise<string | null> {
  const normalized = username.toLowerCase();

  if (isDatabaseConnected()) {
    const record = await queryOne<{ user_id: string }>(
      `SELECT user_id FROM username_reservations WHERE username = $1 LIMIT 1;`,
      [normalized],
    );
    if (record?.user_id) {
      return record.user_id;
    }
    return getUserIdByUsernameR2(normalized);
  }

  return getUserIdByUsernameR2(normalized);
}

export async function searchUsernames(
  queryText: string,
  limit: number = 10,
): Promise<Array<{ username: string; userId: string }>> {
  const normalized = queryText.toLowerCase().trim().replace(/^@+/, "");
  if (!normalized) {
    return [];
  }

  if (isDatabaseConnected()) {
    const rows =
      (await query<{ username: string; user_id: string }>(
        `SELECT username, user_id
         FROM username_reservations
         WHERE username = $1
         LIMIT $2;`,
        [normalized, limit],
      )) || [];

    return rows.map((row) => ({
      username: row.username.toLowerCase(),
      userId: row.user_id,
    }));
  }

  const all = await listReservedUsernamesR2();
  return all
    .map((row) => ({
      ...row,
      username: row.username.toLowerCase(),
    }))
    .filter((row) => row.username === normalized)
    .slice(0, limit)
    .map(({ username, userId }) => ({ username, userId }));
}

export async function saveUserAccount(
  userId: string,
  accountData: UserAccount,
): Promise<void> {
  const now = Date.now();

  if (isDatabaseConnected()) {
    await query(
      `INSERT INTO user_accounts (
         user_id, public_key, sign_public_key, username, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id) DO UPDATE
       SET public_key = EXCLUDED.public_key,
           sign_public_key = EXCLUDED.sign_public_key,
           username = EXCLUDED.username,
           updated_at = EXCLUDED.updated_at;`,
      [
        userId,
        accountData.publicKey,
        accountData.signPublicKey || null,
        accountData.username || null,
        accountData.createdAt,
        now,
      ],
    );
    return;
  }

  await saveUserAccountR2(userId, accountData);
}

export async function getUserAccount(userId: string): Promise<UserAccount | null> {
  if (isDatabaseConnected()) {
    const record = await queryOne<{
      user_id: string;
      public_key: string;
      sign_public_key: string | null;
      username: string | null;
      created_at: number;
    }>(
      `SELECT user_id, public_key, sign_public_key, username, created_at
       FROM user_accounts
       WHERE user_id = $1
       LIMIT 1;`,
      [userId],
    );

    if (record) {
      return {
        userId: record.user_id,
        publicKey: record.public_key,
        signPublicKey: record.sign_public_key || undefined,
        username: record.username || undefined,
        createdAt: record.created_at,
      };
    }
    return getUserAccountR2(userId);
  }

  return getUserAccountR2(userId);
}

export async function saveRecoverySecret(
  userId: string,
  recovery: RecoverySecret,
): Promise<void> {
  const now = Date.now();

  if (isDatabaseConnected()) {
    await query(
      `INSERT INTO recovery_secrets (
         user_id, verifier, salt, iterations, legacy_hash, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id) DO UPDATE
       SET verifier = EXCLUDED.verifier,
           salt = EXCLUDED.salt,
           iterations = EXCLUDED.iterations,
           legacy_hash = EXCLUDED.legacy_hash,
           updated_at = EXCLUDED.updated_at;`,
      [
        userId,
        recovery.verifier || null,
        recovery.salt || null,
        recovery.iterations || null,
        recovery.legacyHash || null,
        now,
        now,
      ],
    );
    return;
  }

  await savePassphraseRecoveryR2(userId, {
    verifier: recovery.verifier,
    salt: recovery.salt,
    iterations: recovery.iterations,
    legacyHash: recovery.legacyHash,
  });
}

export async function getRecoverySecret(
  userId: string,
): Promise<RecoverySecret | null> {
  if (isDatabaseConnected()) {
    const record = await queryOne<RecoverySecretRecord>(
      `SELECT user_id, verifier, salt, iterations, legacy_hash
       FROM recovery_secrets
       WHERE user_id = $1
       LIMIT 1;`,
      [userId],
    );

    if (record) {
      return {
        verifier: record.verifier || undefined,
        salt: record.salt || undefined,
        iterations:
          typeof record.iterations === "number" ? record.iterations : undefined,
        legacyHash: record.legacy_hash || undefined,
      };
    }
    const legacy = await getPassphraseRecoveryR2(userId);
    if (!legacy) return null;

    return {
      verifier: legacy.verifier || undefined,
      salt: legacy.salt || undefined,
      iterations:
        typeof legacy.iterations === "number" ? legacy.iterations : undefined,
      legacyHash: legacy.legacyHash || legacy.passphraseHash,
    };
  }

  const legacy = await getPassphraseRecoveryR2(userId);
  if (!legacy) return null;

  return {
    verifier: legacy.verifier || undefined,
    salt: legacy.salt || undefined,
    iterations:
      typeof legacy.iterations === "number" ? legacy.iterations : undefined,
    legacyHash: legacy.legacyHash || legacy.passphraseHash,
  };
}

export async function saveEncryptedKeypair(
  userId: string,
  encryptedData: string,
  salt: string,
  iv: string,
): Promise<void> {
  const now = Date.now();

  if (isDatabaseConnected()) {
    await query(
      `INSERT INTO encrypted_keypairs (
         user_id, encrypted_data, salt, iv, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id) DO UPDATE
       SET encrypted_data = EXCLUDED.encrypted_data,
           salt = EXCLUDED.salt,
           iv = EXCLUDED.iv,
           updated_at = EXCLUDED.updated_at;`,
      [userId, encryptedData, salt, iv, now, now],
    );
    return;
  }

  await saveEncryptedKeypairR2(userId, encryptedData, salt, iv);
}

export async function getEncryptedKeypair(
  userId: string,
): Promise<{ encryptedData: string; salt: string; iv: string } | null> {
  if (isDatabaseConnected()) {
    const record = await queryOne<{
      encrypted_data: string;
      salt: string;
      iv: string;
    }>(
      `SELECT encrypted_data, salt, iv
       FROM encrypted_keypairs
       WHERE user_id = $1
       LIMIT 1;`,
      [userId],
    );

    if (record) {
      return {
        encryptedData: record.encrypted_data,
        salt: record.salt,
        iv: record.iv,
      };
    }
    return getEncryptedKeypairR2(userId);
  }

  return getEncryptedKeypairR2(userId);
}

export async function saveSession(
  sessionToken: string,
  sessionData: SessionData,
): Promise<void> {
  const tokenHash = hashSessionToken(sessionToken);
  const createdAt =
    typeof sessionData.createdAt === "number" && Number.isFinite(sessionData.createdAt)
      ? sessionData.createdAt
      : Date.now();
  const lastSeenAt =
    typeof sessionData.lastSeenAt === "number" && Number.isFinite(sessionData.lastSeenAt)
      ? sessionData.lastSeenAt
      : createdAt;

  if (isDatabaseConnected()) {
    await query(
      `INSERT INTO auth_sessions (
         session_token,
         user_id,
         device_id,
         public_key,
         sign_public_key,
         expires_at,
         created_at,
         last_seen_at,
         user_agent,
         device_name,
         platform,
         ip_address
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (session_token) DO UPDATE
       SET user_id = EXCLUDED.user_id,
           device_id = EXCLUDED.device_id,
           public_key = EXCLUDED.public_key,
           sign_public_key = EXCLUDED.sign_public_key,
           expires_at = EXCLUDED.expires_at,
           last_seen_at = EXCLUDED.last_seen_at,
           user_agent = EXCLUDED.user_agent,
           device_name = EXCLUDED.device_name,
           platform = EXCLUDED.platform,
           ip_address = EXCLUDED.ip_address;`,
      [
        tokenHash,
        sessionData.userId,
        sessionData.deviceId || null,
        sessionData.publicKey,
        sessionData.signPublicKey || null,
        sessionData.expiresAt,
        createdAt,
        lastSeenAt,
        sessionData.userAgent || null,
        sessionData.deviceName || null,
        sessionData.platform || null,
        sessionData.ipAddress || null,
      ],
    );
    return;
  }

  await saveSessionR2(tokenHash, {
    ...sessionData,
    createdAt,
    lastSeenAt,
  });
}

export async function getSessionData(
  sessionToken: string,
): Promise<SessionData | null> {
  const tokenHash = hashSessionToken(sessionToken);

  if (isDatabaseConnected()) {
    const record = await queryOne<{
      user_id: string;
      device_id: string | null;
      public_key: string;
      sign_public_key: string | null;
      expires_at: number;
      created_at: number;
      last_seen_at: number | null;
      user_agent: string | null;
      device_name: string | null;
      platform: string | null;
      ip_address: string | null;
    }>(
      `SELECT
         user_id,
         device_id,
         public_key,
         sign_public_key,
         expires_at,
         created_at,
         last_seen_at,
         user_agent,
         device_name,
         platform,
         ip_address
       FROM auth_sessions
       WHERE session_token = $1
       LIMIT 1;`,
      [tokenHash],
    );

    if (record) {
      return {
        userId: record.user_id,
        deviceId: record.device_id || undefined,
        publicKey: record.public_key,
        signPublicKey: record.sign_public_key || undefined,
        sessionToken,
        expiresAt: record.expires_at,
        createdAt: Number(record.created_at || Date.now()),
        lastSeenAt:
          typeof record.last_seen_at === "number"
            ? Number(record.last_seen_at)
            : Number(record.created_at || Date.now()),
        userAgent: record.user_agent || undefined,
        deviceName: record.device_name || undefined,
        platform: record.platform || undefined,
        ipAddress: record.ip_address || undefined,
      };
    }
    return null;
  }

  const stored = await getSessionDataR2(tokenHash);
  if (!stored) {
    return null;
  }

  const createdAt =
    typeof stored.createdAt === "number" ? stored.createdAt : Date.now();
  const lastSeenAt =
    typeof stored.lastSeenAt === "number" ? stored.lastSeenAt : createdAt;

  return {
    userId: stored.userId,
    deviceId:
      typeof stored.deviceId === "string" ? stored.deviceId : undefined,
    publicKey: stored.publicKey,
    signPublicKey:
      typeof stored.signPublicKey === "string"
        ? stored.signPublicKey
        : undefined,
    sessionToken,
    expiresAt: stored.expiresAt,
    createdAt,
    lastSeenAt,
    userAgent:
      typeof stored.userAgent === "string" ? stored.userAgent : undefined,
    deviceName:
      typeof stored.deviceName === "string" ? stored.deviceName : undefined,
    platform:
      typeof stored.platform === "string" ? stored.platform : undefined,
    appKind:
      stored.appKind === "android" ||
      stored.appKind === "ios" ||
      stored.appKind === "desktop"
        ? stored.appKind
        : undefined,
    ipAddress:
      typeof stored.ipAddress === "string" ? stored.ipAddress : undefined,
  };
}

export async function listSessionsForUser(
  userId: string,
): Promise<StoredSessionRecord[]> {
  if (isDatabaseConnected()) {
    const rows =
      (await query<{
        session_token: string;
        user_id: string;
        device_id: string | null;
        public_key: string;
        sign_public_key: string | null;
        expires_at: number;
        created_at: number;
        last_seen_at: number | null;
        user_agent: string | null;
        device_name: string | null;
        platform: string | null;
        ip_address: string | null;
      }>(
        `SELECT
           session_token,
           user_id,
           device_id,
           public_key,
           sign_public_key,
           expires_at,
           created_at,
           last_seen_at,
           user_agent,
           device_name,
           platform,
           ip_address
         FROM auth_sessions
         WHERE user_id = $1
         ORDER BY last_seen_at DESC NULLS LAST, created_at DESC;`,
        [userId],
      )) || [];

    return rows.map((row) => ({
      sessionId: row.session_token,
      userId: row.user_id,
      deviceId: row.device_id || undefined,
      publicKey: row.public_key,
      signPublicKey: row.sign_public_key || undefined,
      expiresAt: Number(row.expires_at || 0),
      createdAt: Number(row.created_at || 0),
      lastSeenAt:
        typeof row.last_seen_at === "number"
          ? Number(row.last_seen_at)
          : Number(row.created_at || 0),
      userAgent: row.user_agent || undefined,
      deviceName: row.device_name || undefined,
      platform: row.platform || undefined,
      ipAddress: row.ip_address || undefined,
    }));
  }

  const sessionsDir = path.join(storageRoot, "voltex-users", "sessions");
  try {
    const entries = await fs.readdir(sessionsDir);
    const records: StoredSessionRecord[] = [];

    for (const entry of entries) {
      if (!entry.endsWith(".json")) {
        continue;
      }

      const fullPath = path.join(sessionsDir, entry);
      try {
        const raw = await fs.readFile(fullPath, "utf8");
        const parsed = JSON.parse(raw) as SessionData;
        if (parsed.userId !== userId) {
          continue;
        }

        const sessionId = entry.replace(/\.json$/i, "");
        const createdAt =
          typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now();
        const lastSeenAt =
          typeof parsed.lastSeenAt === "number" ? parsed.lastSeenAt : createdAt;

        records.push({
          sessionId,
          userId,
          deviceId:
            typeof parsed.deviceId === "string" ? parsed.deviceId : undefined,
          publicKey: parsed.publicKey,
          signPublicKey: parsed.signPublicKey,
          expiresAt: parsed.expiresAt,
          createdAt,
          lastSeenAt,
          userAgent:
            typeof parsed.userAgent === "string" ? parsed.userAgent : undefined,
          deviceName:
            typeof parsed.deviceName === "string" ? parsed.deviceName : undefined,
          platform:
            typeof parsed.platform === "string" ? parsed.platform : undefined,
          appKind:
            parsed.appKind === "android" ||
            parsed.appKind === "ios" ||
            parsed.appKind === "desktop"
              ? parsed.appKind
              : undefined,
          ipAddress:
            typeof parsed.ipAddress === "string" ? parsed.ipAddress : undefined,
        });
      } catch {
        // Ignore malformed files.
      }
    }

    records.sort((a, b) =>
      (b.lastSeenAt || b.createdAt) - (a.lastSeenAt || a.createdAt),
    );
    return records;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function deleteSessionBySessionId(
  userId: string,
  sessionId: string,
): Promise<boolean> {
  if (isDatabaseConnected()) {
    const existing = await queryOne<{ session_token: string }>(
      `SELECT session_token
       FROM auth_sessions
       WHERE session_token = $1 AND user_id = $2
       LIMIT 1;`,
      [sessionId, userId],
    );
    if (!existing) {
      return false;
    }
    await query(`DELETE FROM auth_sessions WHERE session_token = $1;`, [
      sessionId,
    ]);
    return true;
  }

  const sessionData = await getSessionDataR2(sessionId);
  if (!sessionData || sessionData.userId !== userId) {
    return false;
  }

  await deleteSessionDataR2(sessionId);
  return true;
}

export async function deleteSessionData(sessionToken: string): Promise<void> {
  const tokenHash = hashSessionToken(sessionToken);

  if (isDatabaseConnected()) {
    await query(`DELETE FROM auth_sessions WHERE session_token = $1;`, [
      tokenHash,
    ]);
    return;
  }

  await deleteSessionDataR2(tokenHash);
}

export async function deleteSessionsForUser(userId: string): Promise<void> {
  if (isDatabaseConnected()) {
    await query(`DELETE FROM auth_sessions WHERE user_id = $1;`, [userId]);
    return;
  }

  const sessionsDir = path.join(storageRoot, "voltex-users", "sessions");
  try {
    const entries = await fs.readdir(sessionsDir);
    for (const entry of entries) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      const fullPath = path.join(sessionsDir, entry);
      try {
        const raw = await fs.readFile(fullPath, "utf8");
        const session = JSON.parse(raw) as { userId?: string };
        if (session.userId === userId) {
          await fs.unlink(fullPath).catch(() => undefined);
        }
      } catch {
        // Ignore malformed or race-deleted files and continue.
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
}

export async function deleteSessionsForUserDevice(
  userId: string,
  deviceId: string,
): Promise<void> {
  if (isDatabaseConnected()) {
    await query(
      `DELETE FROM auth_sessions WHERE user_id = $1 AND device_id = $2;`,
      [userId, deviceId],
    );
    return;
  }

  const sessionsDir = path.join(storageRoot, "voltex-users", "sessions");
  try {
    const entries = await fs.readdir(sessionsDir);
    for (const entry of entries) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      const fullPath = path.join(sessionsDir, entry);
      try {
        const raw = await fs.readFile(fullPath, "utf8");
        const session = JSON.parse(raw) as { userId?: string; deviceId?: string };
        if (session.userId === userId && session.deviceId === deviceId) {
          await fs.unlink(fullPath).catch(() => undefined);
        }
      } catch {
        // Ignore malformed or race-deleted files and continue.
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
}
