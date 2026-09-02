import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Pool } from "pg";

type JsonRecord = Record<string, unknown>;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const dataRoot = path.join(projectRoot, "server", "data");

function requireDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL must be set for migration");
  }
  return databaseUrl;
}

async function readJson<T>(filePath: string): Promise<T | null> {
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

async function listJsonFiles(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(root, entry.name);
        if (entry.isDirectory()) {
          return listJsonFiles(fullPath);
        }
        return fullPath.endsWith(".json") ? [fullPath] : [];
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

function toNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toNullableBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function toNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

async function migrateAccounts(pool: Pool): Promise<number> {
  const accountDir = path.join(dataRoot, "voltex-users", "accounts");
  const files = await listJsonFiles(accountDir);
  let migrated = 0;

  for (const filePath of files) {
    const record = await readJson<JsonRecord>(filePath);
    if (!record) continue;

    const userId = toNullableString(record.userId);
    const publicKey = toNullableString(record.publicKey);
    const createdAt = toNumber(record.createdAt, Date.now());
    const updatedAt = toNumber(record.updatedAt, createdAt);
    if (!userId || !publicKey) continue;

    await pool.query(
      `INSERT INTO user_accounts (
         user_id, public_key, sign_public_key, username, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id) DO UPDATE
       SET public_key = EXCLUDED.public_key,
           sign_public_key = EXCLUDED.sign_public_key,
           username = EXCLUDED.username,
           created_at = LEAST(user_accounts.created_at, EXCLUDED.created_at),
           updated_at = GREATEST(user_accounts.updated_at, EXCLUDED.updated_at);`,
      [
        userId,
        publicKey,
        toNullableString(record.signPublicKey),
        toNullableString(record.username)?.toLowerCase() ?? null,
        createdAt,
        updatedAt,
      ],
    );
    migrated += 1;
  }

  return migrated;
}

async function migrateUsernames(pool: Pool): Promise<number> {
  const usernameDir = path.join(dataRoot, "voltex-users", "usernames");
  const files = await listJsonFiles(usernameDir);
  let migrated = 0;

  for (const filePath of files) {
    const record = await readJson<JsonRecord>(filePath);
    if (!record) continue;

    const username = toNullableString(record.username)?.toLowerCase();
    const userId = toNullableString(record.userId);
    const createdAt = toNumber(record.createdAt, Date.now());
    if (!username || !userId) continue;

    await pool.query(
      `INSERT INTO username_reservations (username, user_id, created_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (username) DO UPDATE
       SET user_id = EXCLUDED.user_id,
           created_at = LEAST(username_reservations.created_at, EXCLUDED.created_at);`,
      [username, userId, createdAt],
    );
    migrated += 1;
  }

  return migrated;
}

async function migrateRecovery(pool: Pool): Promise<number> {
  const recoveryDir = path.join(dataRoot, "voltex-recovery");
  const userDirs = await fs.readdir(recoveryDir, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) =>
      error.code === "ENOENT" ? [] : Promise.reject(error),
  );
  let migrated = 0;

  for (const entry of userDirs) {
    if (!entry.isDirectory()) continue;
    const userId = entry.name;
    const passphrase = await readJson<JsonRecord>(
      path.join(recoveryDir, userId, "passphrase.json"),
    );
    if (passphrase) {
      const createdAt = toNumber(passphrase.createdAt, Date.now());
      await pool.query(
        `INSERT INTO recovery_secrets (
           user_id, verifier, salt, iterations, legacy_hash, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_id) DO UPDATE
         SET verifier = EXCLUDED.verifier,
             salt = EXCLUDED.salt,
             iterations = EXCLUDED.iterations,
             legacy_hash = EXCLUDED.legacy_hash,
             updated_at = GREATEST(recovery_secrets.updated_at, EXCLUDED.updated_at);`,
        [
          userId,
          toNullableString(passphrase.verifier),
          toNullableString(passphrase.salt),
          typeof passphrase.iterations === "number"
            ? passphrase.iterations
            : null,
          toNullableString(passphrase.legacyHash) ??
            toNullableString(passphrase.passphraseHash),
          createdAt,
          createdAt,
        ],
      );
      migrated += 1;
    }

    const keypair = await readJson<JsonRecord>(
      path.join(recoveryDir, userId, "keypair.json"),
    );
    if (keypair) {
      const createdAt = toNumber(keypair.createdAt, Date.now());
      await pool.query(
        `INSERT INTO encrypted_keypairs (
           user_id, encrypted_data, salt, iv, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id) DO UPDATE
         SET encrypted_data = EXCLUDED.encrypted_data,
             salt = EXCLUDED.salt,
             iv = EXCLUDED.iv,
             updated_at = GREATEST(encrypted_keypairs.updated_at, EXCLUDED.updated_at);`,
        [
          userId,
          toNullableString(keypair.encryptedData),
          toNullableString(keypair.salt),
          toNullableString(keypair.iv),
          createdAt,
          createdAt,
        ],
      );
    }
  }

  return migrated;
}

async function migrateSessions(pool: Pool): Promise<number> {
  const sessionDir = path.join(dataRoot, "voltex-users", "sessions");
  const files = await listJsonFiles(sessionDir);
  let migrated = 0;

  for (const filePath of files) {
    const record = await readJson<JsonRecord>(filePath);
    if (!record) continue;

    const tokenHash = path.basename(filePath, ".json");
    const userId = toNullableString(record.userId);
    const publicKey = toNullableString(record.publicKey);
    const expiresAt = toNumber(record.expiresAt, 0);
    const createdAt = toNumber(record.createdAt, Date.now());
    if (!tokenHash || !userId || !publicKey || expiresAt <= 0) continue;

    await pool.query(
      `INSERT INTO auth_sessions (
         session_token, user_id, public_key, sign_public_key, expires_at, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (session_token) DO UPDATE
       SET user_id = EXCLUDED.user_id,
           public_key = EXCLUDED.public_key,
           sign_public_key = EXCLUDED.sign_public_key,
           expires_at = EXCLUDED.expires_at,
           created_at = LEAST(auth_sessions.created_at, EXCLUDED.created_at);`,
      [
        tokenHash,
        userId,
        publicKey,
        toNullableString(record.signPublicKey),
        expiresAt,
        createdAt,
      ],
    );
    migrated += 1;
  }

  return migrated;
}

async function migrateProfiles(pool: Pool): Promise<number> {
  const profileDir = path.join(dataRoot, "voltex-users", "profiles");
  const files = await listJsonFiles(profileDir);
  let migrated = 0;

  for (const filePath of files) {
    const record = await readJson<JsonRecord>(filePath);
    if (!record) continue;

    const userId = toNullableString(record.userId);
    const createdAt = toNumber(record.createdAt, Date.now());
    const updatedAt = toNumber(record.updatedAt, createdAt);
    if (!userId) continue;

    await pool.query(
      `INSERT INTO user_profiles (
         user_id, display_name, bio, avatar, notifications, privacy,
         show_timestamps, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (user_id) DO UPDATE
       SET display_name = EXCLUDED.display_name,
           bio = EXCLUDED.bio,
           avatar = EXCLUDED.avatar,
           notifications = EXCLUDED.notifications,
           privacy = EXCLUDED.privacy,
           show_timestamps = EXCLUDED.show_timestamps,
           created_at = LEAST(user_profiles.created_at, EXCLUDED.created_at),
           updated_at = GREATEST(user_profiles.updated_at, EXCLUDED.updated_at);`,
      [
        userId,
        toNullableString(record.displayName),
        toNullableString(record.bio),
        toNullableString(record.avatar),
        toNullableBoolean(record.notifications),
        toNullableString(record.privacy),
        toNullableBoolean(record.showTimestamps),
        createdAt,
        updatedAt,
      ],
    );
    migrated += 1;
  }

  return migrated;
}

async function migrateProtocol(pool: Pool): Promise<number> {
  const protocolDir = path.join(dataRoot, "voltex-protocol", "devices");
  const files = await listJsonFiles(protocolDir);
  let migrated = 0;

  for (const filePath of files) {
    const record = await readJson<JsonRecord>(filePath);
    if (!record) continue;

    const userId = toNullableString(record.userId);
    const deviceId = toNullableString(record.deviceId);
    const createdAt = toNumber(record.createdAt, Date.now());
    const updatedAt = toNumber(record.updatedAt, createdAt);
    if (!userId || !deviceId) continue;

    await pool.query(
      `INSERT INTO protocol_device_bundles (
         user_id, device_id, bundle_json, created_at, updated_at
       ) VALUES ($1, $2, $3::jsonb, $4, $5)
       ON CONFLICT (user_id, device_id) DO UPDATE
       SET bundle_json = EXCLUDED.bundle_json,
           created_at = LEAST(protocol_device_bundles.created_at, EXCLUDED.created_at),
           updated_at = GREATEST(protocol_device_bundles.updated_at, EXCLUDED.updated_at);`,
      [userId, deviceId, JSON.stringify(record), createdAt, updatedAt],
    );
    migrated += 1;
  }

  return migrated;
}

async function migrateMessages(pool: Pool): Promise<number> {
  const conversationDir = path.join(dataRoot, "voltex-messages", "conversations");
  const files = await listJsonFiles(conversationDir);
  let migrated = 0;

  for (const filePath of files) {
    const record = await readJson<JsonRecord>(filePath);
    if (!record) continue;

    const messageId = toNullableString(record.messageId);
    const senderId = toNullableString(record.senderId);
    const recipientId = toNullableString(record.recipientId);
    const nonce = toNullableString(record.nonce);
    const ciphertext = toNullableString(record.ciphertext);
    const signature = toNullableString(record.signature);
    const timestamp = toNumber(record.timestamp, 0);
    const createdAt = toNumber(record.createdAt, Date.now());
    if (
      !messageId ||
      !senderId ||
      !recipientId ||
      !nonce ||
      !ciphertext ||
      !signature ||
      timestamp <= 0
    ) {
      continue;
    }

    await pool.query(
      `INSERT INTO messages (
         id, sender_id, recipient_id, nonce, ciphertext, signature, timestamp,
         created_at, archived, deleted
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8 / 1000.0), FALSE, FALSE)
       ON CONFLICT (id) DO UPDATE
       SET sender_id = EXCLUDED.sender_id,
           recipient_id = EXCLUDED.recipient_id,
           nonce = EXCLUDED.nonce,
           ciphertext = EXCLUDED.ciphertext,
           signature = EXCLUDED.signature,
           timestamp = EXCLUDED.timestamp;`,
      [
        messageId,
        senderId,
        recipientId,
        nonce,
        ciphertext,
        signature,
        timestamp,
        createdAt,
      ],
    );
    migrated += 1;
  }

  await pool.query(`
    INSERT INTO conversations (
      user_id, other_user_id, last_message_timestamp, last_message_preview, updated_at
    )
    SELECT
      LEAST(sender_id, recipient_id) AS user_id,
      GREATEST(sender_id, recipient_id) AS other_user_id,
      MAX(timestamp) AS last_message_timestamp,
      (
        ARRAY_AGG(ciphertext ORDER BY timestamp DESC)
      )[1]::varchar(100) AS last_message_preview,
      CURRENT_TIMESTAMP
    FROM messages
    WHERE deleted = FALSE
    GROUP BY LEAST(sender_id, recipient_id), GREATEST(sender_id, recipient_id)
    ON CONFLICT (user_id, other_user_id) DO UPDATE
    SET last_message_timestamp = EXCLUDED.last_message_timestamp,
        last_message_preview = EXCLUDED.last_message_preview,
        updated_at = CURRENT_TIMESTAMP;
  `);

  return migrated;
}

async function main(): Promise<void> {
  const pool = new Pool({
    connectionString: requireDatabaseUrl(),
  });

  try {
    const counts = {
      accounts: await migrateAccounts(pool),
      usernames: await migrateUsernames(pool),
      recovery: await migrateRecovery(pool),
      sessions: await migrateSessions(pool),
      profiles: await migrateProfiles(pool),
      protocol: await migrateProtocol(pool),
      messages: await migrateMessages(pool),
    };

    console.log("Migration completed:", counts);
  } finally {
    await pool.end();
  }
}

void main().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
