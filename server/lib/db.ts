import { Pool, PoolClient } from "pg";

/**
 * PostgreSQL connection pool
 * Manages database connections with connection pooling
 */
let pool: Pool | null = null;

/**
 * Initialize the database connection pool
 * Creates tables if they don't exist
 */
export async function initializeDatabase(): Promise<void> {
  if (pool) {
    console.log("Database pool already initialized");
    return;
  }

  const connectionString = process.env.DATABASE_URL;
  const remoteDatabaseEnabled = process.env.ENABLE_POSTGRES_STORAGE === "true";

  if (!remoteDatabaseEnabled) {
    console.log(
      "Using project-local filesystem storage under server/data. Remote PostgreSQL is disabled.",
    );
    return;
  }

  if (!connectionString) {
    console.log(
      "ENABLE_POSTGRES_STORAGE=true but DATABASE_URL is not set. Using project-local filesystem storage instead.",
    );
    return;
  }

  // Debug: Log the connection string (hide password)
  const sanitized = connectionString.replace(/:[^@]*@/, ":***@");
  console.log(`[DB-INIT] Using database connection: ${sanitized}`);

  try {
    pool = new Pool({
      connectionString,
      // Favor bounded pool pressure on a single machine over unbounded DB fan-out.
      max: parseInt(process.env.DB_POOL_MAX || "24", 10),
      min: parseInt(process.env.DB_POOL_MIN || "4", 10),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });

    // Test the connection
    const client = await pool.connect();
    console.log("Successfully connected to PostgreSQL");
    client.release();

    await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);

    // Initialize tables
    await createTables();
    console.log("Database tables initialized");
  } catch (error) {
    console.error("Failed to initialize database:", error);
    pool = null;
    throw error;
  }
}

/**
 * Create necessary tables if they don't exist
 */
async function createTables(): Promise<void> {
  if (!pool) return;

  const createMessagesTable = `
    CREATE TABLE IF NOT EXISTS messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      sender_id VARCHAR(255) NOT NULL,
      recipient_id VARCHAR(255) NOT NULL,
      nonce VARCHAR(32) NOT NULL,
      ciphertext TEXT NOT NULL,
      signature VARCHAR(128) NOT NULL,
      timestamp BIGINT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      archived BOOLEAN DEFAULT FALSE,
      archived_at TIMESTAMP,
      delivered_at TIMESTAMP,
      read_at TIMESTAMP,
      deleted BOOLEAN DEFAULT FALSE,
      deleted_at TIMESTAMP,
      deleted_by VARCHAR(255)
    );

    -- Index for retrieving conversation messages (excluding deleted)
    CREATE INDEX IF NOT EXISTS idx_messages_conversation
    ON messages(sender_id, recipient_id, timestamp DESC)
    WHERE deleted = FALSE;

    -- Index for retrieving messages by timestamp (for archival)
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp_archived
    ON messages(timestamp, archived);

    -- Index for finding unarchived messages
    CREATE INDEX IF NOT EXISTS idx_messages_not_archived
    ON messages(archived, created_at DESC)
    WHERE archived = FALSE;

    -- Index for conversation queries
    CREATE INDEX IF NOT EXISTS idx_messages_bidirectional
    ON messages(
      (CASE WHEN sender_id < recipient_id THEN sender_id ELSE recipient_id END),
      (CASE WHEN sender_id < recipient_id THEN recipient_id ELSE sender_id END),
      timestamp DESC
    )
    WHERE deleted = FALSE;

    -- Index for finding deleted messages by timestamp (for reconciliation)
    CREATE INDEX IF NOT EXISTS idx_messages_deleted
    ON messages(deleted, deleted_at);
  `;

  const createMessagesV2Tables = `
    CREATE TABLE IF NOT EXISTS direct_messages_v2 (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id VARCHAR(511) NOT NULL,
      sender_user_id VARCHAR(255) NOT NULL,
      sender_device_id VARCHAR(255) NOT NULL,
      recipient_user_id VARCHAR(255) NOT NULL,
      message_type VARCHAR(32) NOT NULL,
      server_timestamp BIGINT NOT NULL,
      client_timestamp BIGINT,
      client_message_id TEXT,
      deleted_for_everyone BOOLEAN DEFAULT FALSE,
      deleted_at BIGINT,
      deleted_by_user_id VARCHAR(255),
      created_at BIGINT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_direct_messages_v2_conversation
    ON direct_messages_v2(conversation_id, server_timestamp DESC);

    CREATE INDEX IF NOT EXISTS idx_direct_messages_v2_sender
    ON direct_messages_v2(sender_user_id, server_timestamp DESC);

    CREATE TABLE IF NOT EXISTS direct_message_device_envelopes (
      message_id UUID NOT NULL,
      target_user_id VARCHAR(255) NOT NULL,
      target_device_id VARCHAR(255) NOT NULL,
      nonce VARCHAR(64) NOT NULL,
      ciphertext TEXT NOT NULL,
      signature VARCHAR(256) NOT NULL,
      session_key_type VARCHAR(32),
      session_key_id BIGINT,
      envelope_version VARCHAR(16) NOT NULL,
      delivered_at BIGINT,
      seen_at BIGINT,
      created_at BIGINT NOT NULL,
      PRIMARY KEY (message_id, target_device_id)
    );

    ALTER TABLE direct_message_device_envelopes
    ADD COLUMN IF NOT EXISTS session_key_type VARCHAR(32);

    ALTER TABLE direct_message_device_envelopes
    ADD COLUMN IF NOT EXISTS session_key_id BIGINT;

    CREATE INDEX IF NOT EXISTS idx_direct_message_device_envelopes_target
    ON direct_message_device_envelopes(target_user_id, target_device_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_direct_message_device_envelopes_seen
    ON direct_message_device_envelopes(target_user_id, target_device_id, seen_at);
  `;

  const createMessageDeletionsTable = `
    CREATE TABLE IF NOT EXISTS message_deletions (
      message_id UUID NOT NULL,
      user_id VARCHAR(255) NOT NULL,
      sender_id VARCHAR(255) NOT NULL,
      recipient_id VARCHAR(255) NOT NULL,
      message_timestamp BIGINT NOT NULL,
      deleted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (message_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_message_deletions_user_message
    ON message_deletions(user_id, message_id);

    CREATE INDEX IF NOT EXISTS idx_message_deletions_user_conversation
    ON message_deletions(
      user_id,
      (CASE WHEN sender_id < recipient_id THEN sender_id ELSE recipient_id END),
      (CASE WHEN sender_id < recipient_id THEN recipient_id ELSE sender_id END),
      message_timestamp DESC
    );
  `;

  const createConversationsTable = `
    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      user_id VARCHAR(255) NOT NULL,
      other_user_id VARCHAR(255) NOT NULL,
      last_message_timestamp BIGINT NOT NULL,
      last_message_preview VARCHAR(100),
      last_read BIGINT DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- User IDs are normalized before insert, so a direct unique index is safe.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_pair
    ON conversations(user_id, other_user_id);

    -- Index for quick lookup
    CREATE INDEX IF NOT EXISTS idx_conversations_user_id
    ON conversations(user_id, updated_at DESC);
  `;

  const createAccountsTables = `
    CREATE TABLE IF NOT EXISTS user_accounts (
      user_id VARCHAR(255) PRIMARY KEY,
      public_key TEXT NOT NULL,
      sign_public_key TEXT,
      username VARCHAR(30) UNIQUE,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS username_reservations (
      username VARCHAR(30) PRIMARY KEY,
      user_id VARCHAR(255) NOT NULL UNIQUE,
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recovery_secrets (
      user_id VARCHAR(255) PRIMARY KEY,
      verifier TEXT,
      salt TEXT,
      iterations INTEGER,
      legacy_hash TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS encrypted_keypairs (
      user_id VARCHAR(255) PRIMARY KEY,
      encrypted_data TEXT NOT NULL,
      salt TEXT NOT NULL,
      iv TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      session_token VARCHAR(255) PRIMARY KEY,
      user_id VARCHAR(255) NOT NULL,
      device_id VARCHAR(255),
      public_key TEXT NOT NULL,
      sign_public_key TEXT,
      expires_at BIGINT NOT NULL,
      created_at BIGINT NOT NULL,
      last_seen_at BIGINT,
      user_agent TEXT,
      device_name TEXT,
      platform TEXT,
      ip_address TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id
    ON auth_sessions(user_id);

    CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at
    ON auth_sessions(expires_at);

    CREATE TABLE IF NOT EXISTS user_devices (
      user_id VARCHAR(255) NOT NULL,
      device_id VARCHAR(255) NOT NULL,
      device_name TEXT,
      platform VARCHAR(64),
      app_kind VARCHAR(32),
      status VARCHAR(16) NOT NULL,
      linked_at BIGINT NOT NULL,
      revoked_at BIGINT,
      last_seen_at BIGINT,
      created_by_device_id VARCHAR(255),
      PRIMARY KEY (user_id, device_id)
    );

    CREATE INDEX IF NOT EXISTS idx_user_devices_user_status
    ON user_devices(user_id, status, linked_at DESC);

    CREATE TABLE IF NOT EXISTS account_history_keys (
      user_id VARCHAR(255) NOT NULL,
      history_key_version INTEGER NOT NULL,
      status VARCHAR(16) NOT NULL,
      created_at BIGINT NOT NULL,
      rotated_at BIGINT,
      PRIMARY KEY (user_id, history_key_version)
    );

    CREATE INDEX IF NOT EXISTS idx_account_history_keys_user_status
    ON account_history_keys(user_id, status, history_key_version DESC);

    CREATE TABLE IF NOT EXISTS device_wrapped_history_keys (
      user_id VARCHAR(255) NOT NULL,
      history_key_version INTEGER NOT NULL,
      device_id VARCHAR(255) NOT NULL,
      wrapped_key TEXT NOT NULL,
      wrapper_algorithm VARCHAR(32) NOT NULL,
      created_at BIGINT NOT NULL,
      PRIMARY KEY (user_id, history_key_version, device_id)
    );

    CREATE INDEX IF NOT EXISTS idx_device_wrapped_history_keys_device
    ON device_wrapped_history_keys(user_id, device_id, history_key_version DESC);

    CREATE TABLE IF NOT EXISTS device_link_requests (
      link_id VARCHAR(255) PRIMARY KEY,
      user_id VARCHAR(255) NOT NULL,
      requested_by_device_id VARCHAR(255) NOT NULL,
      challenge TEXT NOT NULL,
      status VARCHAR(16) NOT NULL,
      created_at BIGINT NOT NULL,
      expires_at BIGINT NOT NULL,
      completed_at BIGINT,
      target_device_id VARCHAR(255)
    );

    CREATE INDEX IF NOT EXISTS idx_device_link_requests_user_status
    ON device_link_requests(user_id, status, created_at DESC);

    CREATE TABLE IF NOT EXISTS push_registrations (
      user_id VARCHAR(255) NOT NULL,
      device_id VARCHAR(255) NOT NULL,
      topic VARCHAR(64) NOT NULL,
      created_at BIGINT NOT NULL,
      last_wake_at BIGINT,
      UNIQUE (user_id, device_id)
    );

    CREATE INDEX IF NOT EXISTS idx_push_registrations_user
    ON push_registrations(user_id, created_at DESC);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_push_registrations_topic
    ON push_registrations(topic);
  `;

  const createProfilesTable = `
    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id VARCHAR(255) PRIMARY KEY,
      display_name TEXT,
      bio TEXT,
      avatar TEXT,
      notifications BOOLEAN,
      notification_email TEXT,
      privacy TEXT,
      show_timestamps BOOLEAN,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );
  `;

  const createBlocksTable = `
    CREATE TABLE IF NOT EXISTS user_blocks (
      blocker_id VARCHAR(255) NOT NULL,
      blocked_id VARCHAR(255) NOT NULL,
      created_at BIGINT NOT NULL,
      PRIMARY KEY (blocker_id, blocked_id),
      CONSTRAINT chk_user_blocks_not_self_block CHECK (blocker_id <> blocked_id)
    );

    CREATE INDEX IF NOT EXISTS idx_user_blocks_blocker
    ON user_blocks(blocker_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked
    ON user_blocks(blocked_id, created_at DESC);
  `;

  const createProtocolTable = `
    CREATE TABLE IF NOT EXISTS protocol_device_bundles (
      user_id VARCHAR(255) NOT NULL,
      device_id VARCHAR(255) NOT NULL,
      bundle_json JSONB NOT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (user_id, device_id)
    );

    CREATE INDEX IF NOT EXISTS idx_protocol_device_bundles_user_updated
    ON protocol_device_bundles(user_id, updated_at DESC);
  `;

  const createPasskeyTables = `
    CREATE TABLE IF NOT EXISTS passkey_credentials (
      credential_id TEXT PRIMARY KEY,
      user_id VARCHAR(255) NOT NULL UNIQUE,
      public_key TEXT NOT NULL,
      counter BIGINT NOT NULL DEFAULT 0,
      transports JSONB,
      device_type VARCHAR(32),
      backed_up BOOLEAN DEFAULT FALSE,
      aaguid TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      last_used_at BIGINT
    );

    CREATE INDEX IF NOT EXISTS idx_passkey_credentials_user_id
    ON passkey_credentials(user_id);

    CREATE TABLE IF NOT EXISTS passkey_challenges (
      flow_id TEXT PRIMARY KEY,
      challenge TEXT NOT NULL,
      purpose VARCHAR(32) NOT NULL,
      user_id VARCHAR(255),
      expires_at BIGINT NOT NULL,
      created_at BIGINT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_passkey_challenges_expires_at
    ON passkey_challenges(expires_at);
  `;

  // Alter table to add last_read column if it doesn't exist
  const alterConversationsTable = `
    ALTER TABLE conversations
    ADD COLUMN IF NOT EXISTS last_read BIGINT DEFAULT 0;
  `;

  // Alter messages table to add soft delete columns if they don't exist
  const alterMessagesTable = `
    ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS deleted BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS read_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS deleted_by VARCHAR(255);
  `;

  const alterProfilesTable = `
    ALTER TABLE user_profiles
    ADD COLUMN IF NOT EXISTS notification_email TEXT;
  `;

  const alterAuthSessionsTable = `
    ALTER TABLE auth_sessions
    ADD COLUMN IF NOT EXISTS device_id VARCHAR(255),
    ADD COLUMN IF NOT EXISTS last_seen_at BIGINT,
    ADD COLUMN IF NOT EXISTS user_agent TEXT,
    ADD COLUMN IF NOT EXISTS device_name TEXT,
    ADD COLUMN IF NOT EXISTS platform TEXT,
    ADD COLUMN IF NOT EXISTS ip_address TEXT;
  `;

  const createAuthSessionsDeviceIndex = `
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_device
    ON auth_sessions(user_id, device_id);
  `;

  try {
    await pool.query(createMessagesTable);
    await pool.query(createMessagesV2Tables);
    await pool.query(createMessageDeletionsTable);
    await pool.query(createConversationsTable);
    await pool.query(createAccountsTables);
    await pool.query(createProfilesTable);
    await pool.query(createBlocksTable);
    await pool.query(createProtocolTable);
    await pool.query(createPasskeyTables);
    // Run alter table to add columns if they don't exist
    await pool.query(alterConversationsTable);
    await pool.query(alterMessagesTable);
    await pool.query(alterProfilesTable);
    await pool.query(alterAuthSessionsTable);
    await pool.query(createAuthSessionsDeviceIndex);
    console.log("Tables created/updated successfully");
  } catch (error) {
    console.error("Failed to create/update tables:", error);
    throw error;
  }
}

/**
 * Get a client from the pool
 */
export async function getPoolClient(): Promise<PoolClient | null> {
  if (!pool) return null;
  try {
    return await pool.connect();
  } catch (error) {
    console.error("Failed to get pool client:", error);
    return null;
  }
}

/**
 * Execute a query
 */
export async function query<T>(
  text: string,
  values?: unknown[],
): Promise<T[] | null> {
  if (!pool) return null;

  try {
    const result = await pool.query(text, values);
    return result.rows as T[];
  } catch (error) {
    console.error("Database query error:", error);
    throw error;
  }
}

/**
 * Execute a query and return first result
 */
export async function queryOne<T>(
  text: string,
  values?: unknown[],
): Promise<T | null> {
  const results = await query<T>(text, values);
  return results ? results[0] || null : null;
}

/**
 * Close the database connection pool
 */
export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    console.log("Database connection pool closed");
  }
}

/**
 * Check if database is connected
 */
export function isDatabaseConnected(): boolean {
  return pool !== null;
}

export default {
  initializeDatabase,
  query,
  queryOne,
  getPoolClient,
  closeDatabase,
  isDatabaseConnected,
};
