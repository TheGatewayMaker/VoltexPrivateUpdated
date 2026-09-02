import fs from "fs/promises";
import path from "path";
import {
  deleteFromR2,
  downloadFromR2,
  uploadToR2,
} from "./r2-storage";
import { storageRoot } from "./storage-paths";
import { isDatabaseConnected, query, queryOne } from "./db";
import {
  StoredPasskeyChallenge,
  StoredPasskeyCredential,
} from "@shared/passkeys";

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const items = value.filter((item): item is string => typeof item === "string");
  return items.length > 0 ? items : undefined;
}

function normalizeCredentialRecord(
  value: unknown,
): StoredPasskeyCredential | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Partial<StoredPasskeyCredential>;
  if (
    typeof record.userId !== "string" ||
    typeof record.credentialId !== "string" ||
    typeof record.publicKey !== "string" ||
    typeof record.counter !== "number" ||
    typeof record.createdAt !== "number" ||
    typeof record.updatedAt !== "number"
  ) {
    return null;
  }

  return {
    userId: record.userId,
    credentialId: record.credentialId,
    publicKey: record.publicKey,
    counter: record.counter,
    transports: toStringArray(record.transports),
    deviceType:
      record.deviceType === "multiDevice" ? "multiDevice" : "singleDevice",
    backedUp: record.backedUp === true,
    aaguid: typeof record.aaguid === "string" ? record.aaguid : undefined,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastUsedAt:
      typeof record.lastUsedAt === "number" ? record.lastUsedAt : null,
  };
}

function normalizeChallengeRecord(
  value: unknown,
): StoredPasskeyChallenge | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Partial<StoredPasskeyChallenge>;
  if (
    typeof record.flowId !== "string" ||
    typeof record.challenge !== "string" ||
    (record.purpose !== "registration" &&
      record.purpose !== "authentication" &&
      record.purpose !== "step-up") ||
    typeof record.expiresAt !== "number" ||
    typeof record.createdAt !== "number"
  ) {
    return null;
  }

  return {
    flowId: record.flowId,
    challenge: record.challenge,
    purpose: record.purpose,
    userId: typeof record.userId === "string" ? record.userId : null,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
  };
}

function byUserKey(userId: string): string {
  return `passkeys/by-user/${userId}.json`;
}

function byCredentialKey(credentialId: string): string {
  return `passkeys/by-credential/${credentialId}.json`;
}

function challengeKey(flowId: string): string {
  return `passkey-challenges/${flowId}.json`;
}

async function readLocalJson<T>(filePath: string): Promise<T | null> {
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

async function listLocalFiles(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(root, entry.name);
        return entry.isDirectory() ? listLocalFiles(fullPath) : [fullPath];
      }),
    );
    return nested.flat();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function deletePasskeyCredentialIndex(
  credentialId: string,
): Promise<void> {
  if (isDatabaseConnected()) {
    await query(
      `DELETE FROM passkey_credentials WHERE credential_id = $1;`,
      [credentialId],
    );
    return;
  }

  await deleteFromR2("voltex-users", byCredentialKey(credentialId)).catch(
    () => undefined,
  );
}

export async function savePasskeyCredential(
  credential: StoredPasskeyCredential,
): Promise<void> {
  const now = Date.now();
  const nextCredential: StoredPasskeyCredential = {
    ...credential,
    updatedAt: now,
  };

  const existing = await getPasskeyCredentialByUserId(credential.userId);
  if (existing && existing.credentialId !== credential.credentialId) {
    await deletePasskeyCredentialIndex(existing.credentialId);
  }

  if (isDatabaseConnected()) {
    await query(
      `INSERT INTO passkey_credentials (
         user_id,
         credential_id,
         public_key,
         counter,
         transports,
         device_type,
         backed_up,
         aaguid,
         created_at,
         updated_at,
         last_used_at
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (credential_id) DO UPDATE
       SET user_id = EXCLUDED.user_id,
           public_key = EXCLUDED.public_key,
           counter = EXCLUDED.counter,
           transports = EXCLUDED.transports,
           device_type = EXCLUDED.device_type,
           backed_up = EXCLUDED.backed_up,
           aaguid = EXCLUDED.aaguid,
           updated_at = EXCLUDED.updated_at,
           last_used_at = EXCLUDED.last_used_at;`,
      [
        nextCredential.userId,
        nextCredential.credentialId,
        nextCredential.publicKey,
        nextCredential.counter,
        JSON.stringify(nextCredential.transports || []),
        nextCredential.deviceType || "singleDevice",
        nextCredential.backedUp === true,
        nextCredential.aaguid || null,
        nextCredential.createdAt,
        nextCredential.updatedAt,
        nextCredential.lastUsedAt || null,
      ],
    );
    await query(
      `DELETE FROM passkey_credentials
       WHERE user_id = $1 AND credential_id <> $2;`,
      [nextCredential.userId, nextCredential.credentialId],
    );
    return;
  }

  const payload = JSON.stringify(nextCredential);
  await Promise.all([
    uploadToR2("voltex-users", byUserKey(nextCredential.userId), payload),
    uploadToR2(
      "voltex-users",
      byCredentialKey(nextCredential.credentialId),
      payload,
    ),
  ]);
}

export async function getPasskeyCredentialByUserId(
  userId: string,
): Promise<StoredPasskeyCredential | null> {
  if (isDatabaseConnected()) {
    const row = await queryOne<{
      user_id: string;
      credential_id: string;
      public_key: string;
      counter: number;
      transports: string[] | null;
      device_type: "singleDevice" | "multiDevice" | null;
      backed_up: boolean | null;
      aaguid: string | null;
      created_at: number;
      updated_at: number;
      last_used_at: number | null;
    }>(
      `SELECT
         user_id,
         credential_id,
         public_key,
         counter,
         transports,
         device_type,
         backed_up,
         aaguid,
         created_at,
         updated_at,
         last_used_at
       FROM passkey_credentials
       WHERE user_id = $1
       ORDER BY updated_at DESC
       LIMIT 1;`,
      [userId],
    );

    if (!row) {
      return null;
    }

    return {
      userId: row.user_id,
      credentialId: row.credential_id,
      publicKey: row.public_key,
      counter: Number(row.counter || 0),
      transports: toStringArray(row.transports || []),
      deviceType: row.device_type || "singleDevice",
      backedUp: row.backed_up === true,
      aaguid: row.aaguid || undefined,
      createdAt: Number(row.created_at || 0),
      updatedAt: Number(row.updated_at || 0),
      lastUsedAt:
        typeof row.last_used_at === "number" ? row.last_used_at : null,
    };
  }

  const raw = await downloadFromR2("voltex-users", byUserKey(userId));
  return raw ? normalizeCredentialRecord(JSON.parse(raw)) : null;
}

export async function getPasskeyCredentialByCredentialId(
  credentialId: string,
): Promise<StoredPasskeyCredential | null> {
  if (isDatabaseConnected()) {
    const row = await queryOne<{
      user_id: string;
      credential_id: string;
      public_key: string;
      counter: number;
      transports: string[] | null;
      device_type: "singleDevice" | "multiDevice" | null;
      backed_up: boolean | null;
      aaguid: string | null;
      created_at: number;
      updated_at: number;
      last_used_at: number | null;
    }>(
      `SELECT
         user_id,
         credential_id,
         public_key,
         counter,
         transports,
         device_type,
         backed_up,
         aaguid,
         created_at,
         updated_at,
         last_used_at
       FROM passkey_credentials
       WHERE credential_id = $1
       LIMIT 1;`,
      [credentialId],
    );

    if (!row) {
      return null;
    }

    return {
      userId: row.user_id,
      credentialId: row.credential_id,
      publicKey: row.public_key,
      counter: Number(row.counter || 0),
      transports: toStringArray(row.transports || []),
      deviceType: row.device_type || "singleDevice",
      backedUp: row.backed_up === true,
      aaguid: row.aaguid || undefined,
      createdAt: Number(row.created_at || 0),
      updatedAt: Number(row.updated_at || 0),
      lastUsedAt:
        typeof row.last_used_at === "number" ? row.last_used_at : null,
    };
  }

  const raw = await downloadFromR2(
    "voltex-users",
    byCredentialKey(credentialId),
  );
  return raw ? normalizeCredentialRecord(JSON.parse(raw)) : null;
}

export async function deletePasskeyCredentialForUser(
  userId: string,
): Promise<void> {
  const existing = await getPasskeyCredentialByUserId(userId);

  if (isDatabaseConnected()) {
    await query(`DELETE FROM passkey_credentials WHERE user_id = $1;`, [userId]);
    return;
  }

  await deleteFromR2("voltex-users", byUserKey(userId)).catch(() => undefined);
  if (existing?.credentialId) {
    await deleteFromR2(
      "voltex-users",
      byCredentialKey(existing.credentialId),
    ).catch(() => undefined);
  }
}

export async function savePasskeyChallenge(
  flow: StoredPasskeyChallenge,
): Promise<void> {
  if (isDatabaseConnected()) {
    await query(
      `INSERT INTO passkey_challenges (
         flow_id,
         challenge,
         purpose,
         user_id,
         expires_at,
         created_at
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (flow_id) DO UPDATE
       SET challenge = EXCLUDED.challenge,
           purpose = EXCLUDED.purpose,
           user_id = EXCLUDED.user_id,
           expires_at = EXCLUDED.expires_at,
           created_at = EXCLUDED.created_at;`,
      [
        flow.flowId,
        flow.challenge,
        flow.purpose,
        flow.userId || null,
        flow.expiresAt,
        flow.createdAt,
      ],
    );
    return;
  }

  await uploadToR2(
    "voltex-system",
    challengeKey(flow.flowId),
    JSON.stringify(flow),
  );
}

export async function getPasskeyChallenge(
  flowId: string,
): Promise<StoredPasskeyChallenge | null> {
  if (isDatabaseConnected()) {
    const row = await queryOne<{
      flow_id: string;
      challenge: string;
      purpose: "registration" | "authentication";
      user_id: string | null;
      expires_at: number;
      created_at: number;
    }>(
      `SELECT flow_id, challenge, purpose, user_id, expires_at, created_at
       FROM passkey_challenges
       WHERE flow_id = $1
       LIMIT 1;`,
      [flowId],
    );

    if (!row) {
      return null;
    }

    return {
      flowId: row.flow_id,
      challenge: row.challenge,
      purpose: row.purpose,
      userId: row.user_id || null,
      expiresAt: Number(row.expires_at || 0),
      createdAt: Number(row.created_at || 0),
    };
  }

  const raw = await downloadFromR2("voltex-system", challengeKey(flowId));
  return raw ? normalizeChallengeRecord(JSON.parse(raw)) : null;
}

export async function deletePasskeyChallenge(flowId: string): Promise<void> {
  if (isDatabaseConnected()) {
    await query(`DELETE FROM passkey_challenges WHERE flow_id = $1;`, [flowId]);
    return;
  }

  await deleteFromR2("voltex-system", challengeKey(flowId)).catch(
    () => undefined,
  );
}

export async function cleanupExpiredPasskeyChallenges(): Promise<void> {
  const now = Date.now();

  if (isDatabaseConnected()) {
    await query(`DELETE FROM passkey_challenges WHERE expires_at < $1;`, [now]);
    return;
  }

  const root = path.join(storageRoot, "voltex-system", "passkey-challenges");
  const files = await listLocalFiles(root);
  await Promise.all(
    files
      .filter((filePath) => filePath.endsWith(".json"))
      .map(async (filePath) => {
        const data = await readLocalJson<StoredPasskeyChallenge>(filePath);
        const normalized = normalizeChallengeRecord(data);
        if (!normalized || normalized.expiresAt < now) {
          await fs.unlink(filePath).catch(() => undefined);
        }
      }),
  );
}
