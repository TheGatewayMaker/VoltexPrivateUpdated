import { EncryptedMessage } from "@shared/crypto";
import {
  query,
  queryOne,
  getPoolClient,
  isDatabaseConnected as checkDatabaseConnected,
} from "./db";

// Re-export for convenience
export const isDatabaseConnected = checkDatabaseConnected;

export interface StoredMessage {
  id?: string;
  nonce: string;
  ciphertext: string;
  signature: string;
  senderId: string;
  recipientId: string;
  timestamp: number | string;
  created_at?: string;
  archived?: boolean;
  archived_at?: string | null;
  delivered_at?: string | null;
  read_at?: string | null;
  sender_id?: string;
  recipient_id?: string;
}

export interface MessageParticipantRecord {
  id: string;
  sender_id: string;
  recipient_id: string;
  timestamp: number;
}

export interface ConversationDeletionSummary {
  hiddenForUser: MessageParticipantRecord[];
  deletedForEveryone: MessageParticipantRecord[];
}

/**
 * Store a message in PostgreSQL
 * Falls back to in-memory storage if PostgreSQL is not available
 */
export async function storeMessageInDB(
  messageId: string,
  senderId: string,
  recipientId: string,
  message: EncryptedMessage,
): Promise<boolean> {
  if (!checkDatabaseConnected()) {
    console.log("Database not connected, falling back to in-memory storage");
    return false;
  }

  try {
    const result = await query(
      `INSERT INTO messages (
        id, sender_id, recipient_id, nonce, ciphertext, signature, timestamp, archived, delivered_at, read_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, NULL)
      ON CONFLICT (id) DO NOTHING
      RETURNING id;`,
      [
        messageId,
        senderId,
        recipientId,
        message.nonce,
        message.ciphertext,
        message.signature,
        message.timestamp,
        false,
      ],
    );

    if (result && result.length > 0) {
      console.log(`Message ${messageId} stored in PostgreSQL`);
      // Also update conversation
      await updateConversation(senderId, recipientId, message);
      return true;
    }
    return false;
  } catch (error) {
    console.error("Failed to store message in PostgreSQL:", error);
    return false;
  }
}

/**
 * Retrieve conversation messages from PostgreSQL
 * Returns only non-archived, non-deleted messages (recent messages)
 * Excludes messages that have been soft deleted by either party
 */
export async function getConversationMessagesFromDB(
  userId1: string,
  userId2: string,
  limit: number = 50,
  offset: number = 0,
): Promise<StoredMessage[]> {
  if (!checkDatabaseConnected()) {
    return [];
  }

  try {
    // Query both directions of conversation
    const results = await query<StoredMessage>(
      `SELECT
        m.id, m.sender_id, m.recipient_id, m.nonce, m.ciphertext, m.signature, m.timestamp,
        created_at, archived, archived_at, delivered_at, read_at
      FROM messages m
      LEFT JOIN message_deletions md
        ON md.message_id = m.id
       AND md.user_id = $1
      WHERE m.archived = FALSE
        AND m.deleted = FALSE
        AND md.message_id IS NULL
        AND (
          (m.sender_id = $1 AND m.recipient_id = $2) OR
          (m.sender_id = $2 AND m.recipient_id = $1)
        )
      ORDER BY m.timestamp DESC
      LIMIT $3 OFFSET $4;`,
      [userId1, userId2, limit, offset],
    );

    return (results || []).map((message) => ({
      ...message,
      timestamp: Number(message.timestamp),
    }));
  } catch (error) {
    console.error("Failed to retrieve messages from PostgreSQL:", error);
    return [];
  }
}

/**
 * Get total count of messages in a conversation
 * Excludes archived and deleted messages
 */
export async function getConversationMessageCount(
  userId1: string,
  userId2: string,
): Promise<number> {
  if (!checkDatabaseConnected()) {
    return 0;
  }

  try {
    const result = await queryOne<{ count: string }>(
      `SELECT COUNT(*) as count
      FROM messages m
      LEFT JOIN message_deletions md
        ON md.message_id = m.id
       AND md.user_id = $1
      WHERE m.archived = FALSE
        AND m.deleted = FALSE
        AND md.message_id IS NULL
        AND (
          (m.sender_id = $1 AND m.recipient_id = $2) OR
          (m.sender_id = $2 AND m.recipient_id = $1)
        );`,
      [userId1, userId2],
    );

    return result ? parseInt(result.count, 10) : 0;
  } catch (error) {
    console.error("Failed to get message count:", error);
    return 0;
  }
}

/**
 * Get conversations for a user (only non-archived, non-deleted messages)
 * CRITICAL: Excludes deleted messages to show correct last message preview
 */
export async function getUserConversationsFromDB(
  userId: string,
): Promise<Map<string, { lastMessage: StoredMessage | null; timestamp: number }>> {
  if (!checkDatabaseConnected()) {
    return new Map();
  }

  try {
    const results = await query<any>(
      `WITH visible_messages AS (
        SELECT
          CASE
            WHEN m.sender_id = $1 THEN m.recipient_id
            ELSE m.sender_id
          END as other_user_id,
          m.sender_id, m.recipient_id, m.nonce, m.ciphertext, m.signature, m.timestamp
        FROM messages m
        LEFT JOIN message_deletions md
          ON md.message_id = m.id
         AND md.user_id = $1
        WHERE m.archived = FALSE
          AND m.deleted = FALSE
          AND md.message_id IS NULL
          AND (m.sender_id = $1 OR m.recipient_id = $1)
      ),
      ranked_messages AS (
        SELECT
          other_user_id,
          sender_id,
          recipient_id,
          nonce,
          ciphertext,
          signature,
          timestamp,
          ROW_NUMBER() OVER (
            PARTITION BY other_user_id
            ORDER BY timestamp DESC
          ) as rn
        FROM visible_messages
      )
      SELECT
        other_user_id,
        timestamp as last_message_timestamp,
        m.sender_id,
        m.recipient_id,
        m.nonce,
        m.ciphertext,
        m.signature,
        m.timestamp
      FROM ranked_messages m
      WHERE m.rn = 1
      ORDER BY m.timestamp DESC;`,
      [userId],
    );

    const conversations = new Map<
      string,
      { lastMessage: StoredMessage | null; timestamp: number }
    >();

    if (results) {
      for (const row of results) {
        const normalizedTimestamp = Number(
          row.last_message_timestamp ?? row.timestamp,
        );
        conversations.set(row.other_user_id, {
          lastMessage:
            row.nonce && row.ciphertext && row.signature && row.sender_id && row.recipient_id
              ? {
                  nonce: row.nonce,
                  ciphertext: row.ciphertext,
                  signature: row.signature,
                  senderId: row.sender_id,
                  recipientId: row.recipient_id,
                  timestamp: Number(row.timestamp),
                }
              : null,
          timestamp: normalizedTimestamp,
        });
      }
    }

    return conversations;
  } catch (error) {
    console.error("Failed to retrieve conversations from PostgreSQL:", error);
    return new Map();
  }
}

/**
 * Update conversation metadata
 */
async function updateConversation(
  senderId: string,
  recipientId: string,
  message: EncryptedMessage,
): Promise<void> {
  if (!checkDatabaseConnected()) {
    return;
  }

  try {
    const preview = message.ciphertext.substring(0, 100);

    await Promise.all([
      query(
        `INSERT INTO conversations (
           user_id, other_user_id, last_message_timestamp, last_message_preview, last_read, updated_at
         )
         VALUES ($1, $2, $3, $4, $3, CURRENT_TIMESTAMP)
         ON CONFLICT (user_id, other_user_id) DO UPDATE
         SET last_message_timestamp = EXCLUDED.last_message_timestamp,
             last_message_preview = EXCLUDED.last_message_preview,
             last_read = GREATEST(conversations.last_read, EXCLUDED.last_read),
             updated_at = CURRENT_TIMESTAMP;`,
        [senderId, recipientId, message.timestamp, preview],
      ),
      query(
        `INSERT INTO conversations (
           user_id, other_user_id, last_message_timestamp, last_message_preview, updated_at
         )
         VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
         ON CONFLICT (user_id, other_user_id) DO UPDATE
         SET last_message_timestamp = EXCLUDED.last_message_timestamp,
             last_message_preview = EXCLUDED.last_message_preview,
             updated_at = CURRENT_TIMESTAMP;`,
        [recipientId, senderId, message.timestamp, preview],
      ),
    ]);
  } catch (error) {
    console.error("Failed to update conversation:", error);
  }
}

async function refreshConversationForUser(
  userId: string,
  otherUserId: string,
): Promise<void> {
  if (!checkDatabaseConnected() || !otherUserId) {
    return;
  }

  try {
    const latestVisibleMessage = await queryOne<{
      timestamp: number;
      ciphertext: string;
    }>(
      `SELECT m.timestamp, m.ciphertext
       FROM messages m
       LEFT JOIN message_deletions md
         ON md.message_id = m.id
        AND md.user_id = $1
       WHERE m.archived = FALSE
         AND m.deleted = FALSE
         AND md.message_id IS NULL
         AND (
           (m.sender_id = $1 AND m.recipient_id = $2) OR
           (m.sender_id = $2 AND m.recipient_id = $1)
         )
       ORDER BY m.timestamp DESC
       LIMIT 1;`,
      [userId, otherUserId],
    );

    if (!latestVisibleMessage) {
      await query(
        `DELETE FROM conversations
         WHERE user_id = $1
           AND other_user_id = $2;`,
        [userId, otherUserId],
      );
      return;
    }

    await query(
      `INSERT INTO conversations (
         user_id,
         other_user_id,
         last_message_timestamp,
         last_message_preview,
         updated_at
       ) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id, other_user_id) DO UPDATE
       SET last_message_timestamp = EXCLUDED.last_message_timestamp,
           last_message_preview = EXCLUDED.last_message_preview,
           updated_at = CURRENT_TIMESTAMP;`,
      [
        userId,
        otherUserId,
        latestVisibleMessage.timestamp,
        latestVisibleMessage.ciphertext.substring(0, 100),
      ],
    );
  } catch (error) {
    console.error("Failed to refresh conversation metadata for user:", error);
  }
}

/**
 * Update the last_read timestamp for a conversation
 */
export async function markConversationAsRead(
  userId: string,
  otherUserId: string,
): Promise<void> {
  if (!checkDatabaseConnected()) {
    return;
  }

  try {
    const now = Date.now();
    await query(
      `WITH latest_message AS (
         SELECT MAX(timestamp) AS last_message_timestamp
         FROM messages m
         LEFT JOIN message_deletions md
           ON md.message_id = m.id
          AND md.user_id = $1
         WHERE m.deleted = FALSE
           AND md.message_id IS NULL
           AND (
             (m.sender_id = $1 AND m.recipient_id = $2) OR
             (m.sender_id = $2 AND m.recipient_id = $1)
           )
       )
       INSERT INTO conversations (
         user_id,
         other_user_id,
         last_message_timestamp,
         last_read,
         updated_at
       )
      SELECT
        $1,
        $2,
        latest_message.last_message_timestamp,
        $3,
        CURRENT_TIMESTAMP
      FROM latest_message
      WHERE latest_message.last_message_timestamp IS NOT NULL
      ON CONFLICT (user_id, other_user_id) DO UPDATE
      SET last_read = $3,
          updated_at = CURRENT_TIMESTAMP;`,
      [userId, otherUserId, now],
    );
  } catch (error) {
    console.error("Failed to mark conversation as read:", error);
  }
}

export async function markMessageDeliveredInDB(params: {
  messageId?: string;
  senderId: string;
  recipientId: string;
  timestamp: number;
  deliveredAt?: number;
}): Promise<boolean> {
  if (!checkDatabaseConnected()) {
    return false;
  }

  const deliveredAt = params.deliveredAt ?? Date.now();

  try {
    const result = params.messageId
      ? await queryOne<{ id: string }>(
          `UPDATE messages
           SET delivered_at = COALESCE(delivered_at, TO_TIMESTAMP($2 / 1000.0))
           WHERE id = $1
           RETURNING id;`,
          [params.messageId, deliveredAt],
        )
      : await queryOne<{ id: string }>(
          `UPDATE messages
           SET delivered_at = COALESCE(delivered_at, TO_TIMESTAMP($4 / 1000.0))
           WHERE sender_id = $1
             AND recipient_id = $2
             AND timestamp = $3
           RETURNING id;`,
          [
            params.senderId,
            params.recipientId,
            params.timestamp,
            deliveredAt,
          ],
        );

    return !!result;
  } catch (error) {
    console.error("Failed to mark message as delivered:", error);
    return false;
  }
}

export async function markMessagesSeenInDB(
  viewerUserId: string,
  otherUserId: string,
  seenAt: number = Date.now(),
): Promise<Array<{ id: string; sender_id: string; timestamp: number }>> {
  if (!checkDatabaseConnected()) {
    return [];
  }

  try {
    const results = await query<{ id: string; sender_id: string; timestamp: number }>(
      `UPDATE messages
       SET delivered_at = COALESCE(delivered_at, TO_TIMESTAMP($3 / 1000.0)),
           read_at = COALESCE(read_at, TO_TIMESTAMP($3 / 1000.0))
       WHERE sender_id = $1
         AND recipient_id = $2
         AND deleted = FALSE
         AND NOT EXISTS (
           SELECT 1
           FROM message_deletions md
           WHERE md.message_id = messages.id
             AND md.user_id = $2
         )
         AND read_at IS NULL
       RETURNING id, sender_id, timestamp;`,
      [otherUserId, viewerUserId, seenAt],
    );

    return results || [];
  } catch (error) {
    console.error("Failed to mark messages as seen:", error);
    return [];
  }
}

/**
 * Get unread count for a conversation
 * Excludes archived and deleted messages
 */
export async function getUnreadCount(
  userId: string,
  otherUserId: string,
): Promise<number> {
  if (!checkDatabaseConnected()) {
    return 0;
  }

  try {
    const result = await queryOne<{ count: number }>(
      `SELECT COUNT(*) as count
      FROM messages m
      LEFT JOIN message_deletions md
        ON md.message_id = m.id
       AND md.user_id = $1
      WHERE m.archived = FALSE
        AND m.deleted = FALSE
        AND md.message_id IS NULL
        AND m.sender_id = $2
        AND m.recipient_id = $1
        AND m.read_at IS NULL;`,
      [userId, otherUserId],
    );

    const countValue = result?.count;
    return typeof countValue === "number"
      ? countValue
      : Number.parseInt(String(countValue || "0"), 10) || 0;
  } catch (error) {
    console.error("Failed to get unread count:", error);
    return 0;
  }
}

export async function getUnreadUndeliveredCount(
  senderId: string,
  recipientId: string,
): Promise<number> {
  if (!checkDatabaseConnected()) {
    return 0;
  }

  try {
    const result = await queryOne<{ count: number }>(
      `SELECT COUNT(*) as count
       FROM messages m
       LEFT JOIN message_deletions md
         ON md.message_id = m.id
        AND md.user_id = $2
       WHERE m.archived = FALSE
         AND m.deleted = FALSE
         AND md.message_id IS NULL
         AND m.sender_id = $1
         AND m.recipient_id = $2
         AND m.delivered_at IS NULL
         AND m.read_at IS NULL;`,
      [senderId, recipientId],
    );

    return result?.count || 0;
  } catch (error) {
    console.error("Failed to get unread undelivered count:", error);
    return 0;
  }
}

/**
 * Delete a specific message
 */
/**
 * Find message UUID by timestamp and sender
 * Used when client sends timestamp-based message ID format
 */
export async function findMessageIdByTimestampAndSender(
  timestamp: number,
  senderId: string,
): Promise<string | null> {
  if (!checkDatabaseConnected()) {
    return null;
  }

  try {
    const result = await queryOne<{ id: string }>(
      `SELECT id FROM messages WHERE timestamp = $1 AND sender_id = $2 LIMIT 1;`,
      [timestamp, senderId],
    );

    return result?.id || null;
  } catch (error) {
    console.error(
      `Failed to find message by timestamp ${timestamp} and sender ${senderId}:`,
      error,
    );
    return null;
  }
}

/**
 * Get message metadata by UUID (ID)
 * CRITICAL: Used to resolve UUID to sender/timestamp for deletion notification metadata
 * When client sends serverUUID, we need to look up the message details
 * to properly notify the recipient and delete from in-memory cache
 */
export async function getMessageMetadataById(messageId: string): Promise<{
  id: string;
  sender_id: string;
  recipient_id: string;
  timestamp: number;
} | null> {
  if (!checkDatabaseConnected()) {
    return null;
  }

  try {
    const result = await queryOne<{
      id: string;
      sender_id: string;
      recipient_id: string;
      timestamp: number;
    }>(
      `SELECT id, sender_id, recipient_id, timestamp
       FROM messages
       WHERE id = $1
       LIMIT 1;`,
      [messageId],
    );

    return result || null;
  } catch (error) {
    console.error(`Failed to get message metadata for ${messageId}:`, error);
    return null;
  }
}

/**
 * Check if a message is soft-deleted
 * CRITICAL: Used for late-join reconciliation to exclude deleted messages from R2 results
 * When loading archived messages from R2, we must filter out messages that were soft-deleted
 */
export async function isMessageDeleted(messageId: string): Promise<boolean> {
  if (!checkDatabaseConnected()) {
    console.warn(
      `[DB-DELETE-CHECK] Database not connected - cannot verify deletion status for ${messageId}`,
    );
    return false; // If no DB, assume not deleted to avoid losing messages
  }

  try {
    const result = await queryOne<{
      deleted: boolean;
      deleted_at: string | null;
    }>(`SELECT deleted, deleted_at FROM messages WHERE id = $1 LIMIT 1;`, [
      messageId,
    ]);

    if (!result) {
      console.warn(
        `[DB-DELETE-CHECK] Message ${messageId} not found in database`,
      );
      return false; // Message not found, assume not deleted
    }

    const isDeleted = result.deleted ?? false;
    if (isDeleted) {
      console.log(
        `[DB-DELETE-CHECK] Message ${messageId} is deleted (deleted_at: ${result.deleted_at})`,
      );
    }
    return isDeleted;
  } catch (error) {
    console.error(
      `[DB-DELETE-CHECK] Failed to check if message ${messageId} is deleted:`,
      error,
    );
    return false; // On error, assume not deleted to avoid losing messages
  }
}

/**
 * Get all deleted message IDs for a conversation (for reconciliation)
 * CRITICAL: Used when loading old messages from R2 to filter out soft-deleted messages
 * This ensures late-join users see the correct message state
 *
 * IMPORTANT: Returns a Set of UUIDs that have been soft-deleted
 * These UUIDs match the message IDs stored in R2 and must be excluded during reconciliation
 */
export async function getDeletedMessageIdsInConversationForUser(
  userId: string,
  otherUserId: string,
): Promise<Set<string>> {
  if (!checkDatabaseConnected()) {
    console.warn(
      `[DB-DELETED-IDS] Database not connected - cannot fetch deleted message IDs for reconciliation`,
    );
    return new Set();
  }

  try {
    const results = await query<{ id: string }>(
      `SELECT message_id as id
      FROM message_deletions
      WHERE user_id = $1
        AND (
          (sender_id = $1 AND recipient_id = $2) OR
          (sender_id = $2 AND recipient_id = $1)
        );`,
      [userId, otherUserId],
    );

    const deletedIds = new Set<string>();
    if (results && results.length > 0) {
      for (const row of results) {
        if (row.id) {
          deletedIds.add(row.id);
        }
      }
      console.log(
        `[DB-DELETED-IDS] Found ${deletedIds.size} deleted message UUIDs for conversation ${userId}:${otherUserId}`,
      );
      if (deletedIds.size > 0 && deletedIds.size <= 5) {
        console.log(
          `[DB-DELETED-IDS] Deleted message IDs: ${Array.from(deletedIds).join(", ")}`,
        );
      }
    } else {
      console.log(
        `[DB-DELETED-IDS] No deleted messages found for conversation ${userId}:${otherUserId}`,
      );
    }
    return deletedIds;
  } catch (error) {
    console.error(
      `[DB-DELETED-IDS] CRITICAL ERROR fetching deleted message IDs for reconciliation:`,
      error,
    );
    // IMPORTANT: On error, return empty set
    // This is conservative - we'd rather skip R2 reconciliation than show deleted messages
    throw error; // Let caller decide how to handle
  }
}

/**
 * Mark a message hidden for a specific user without deleting the canonical row.
 */
export async function markMessageDeletedForUserInDB(
  messageId: string,
  userId: string,
  metadata: {
    senderId: string;
    recipientId: string;
    timestamp: number;
  },
): Promise<boolean> {
  if (!checkDatabaseConnected()) {
    return false;
  }

  try {
    const result = await query<{ message_id: string }>(
      `INSERT INTO message_deletions (
         message_id,
         user_id,
         sender_id,
         recipient_id,
         message_timestamp,
         deleted_at
       ) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
       ON CONFLICT (message_id, user_id) DO NOTHING
       RETURNING message_id;`,
      [
        messageId,
        userId,
        metadata.senderId,
        metadata.recipientId,
        metadata.timestamp,
      ],
    );

    await refreshConversationForUser(userId, [
      metadata.senderId,
      metadata.recipientId,
    ].find((value) => value !== userId) || "");

    return result !== null;
  } catch (error) {
    console.error("Failed to mark message deleted for user in PostgreSQL:", error);
    return false;
  }
}

export async function deleteMessageForEveryoneInDB(
  messageId: string,
  metadata: {
    senderId: string;
    recipientId: string;
  },
): Promise<boolean> {
  if (!checkDatabaseConnected()) {
    return false;
  }

  try {
    await query(`DELETE FROM message_deletions WHERE message_id = $1;`, [messageId]);

    const result = await query<{ id: string }>(
      `DELETE FROM messages
       WHERE id = $1
       RETURNING id;`,
      [messageId],
    );

    await refreshConversationForUser(metadata.senderId, metadata.recipientId);
    await refreshConversationForUser(metadata.recipientId, metadata.senderId);

    return !!(result && result.length > 0);
  } catch (error) {
    console.error("Failed to permanently delete message from PostgreSQL:", error);
    return false;
  }
}

export async function getMessageForParticipantById(
  messageId: string,
  userId: string,
  otherUserId: string,
): Promise<MessageParticipantRecord | null> {
  if (!checkDatabaseConnected()) {
    return null;
  }

  try {
    return await queryOne<MessageParticipantRecord>(
      `SELECT id, sender_id, recipient_id, timestamp
       FROM messages
       WHERE id = $1
         AND (
           (sender_id = $2 AND recipient_id = $3) OR
           (sender_id = $3 AND recipient_id = $2)
         )
       LIMIT 1;`,
      [messageId, userId, otherUserId],
    );
  } catch (error) {
    console.error("Failed to load message by id for participant:", error);
    return null;
  }
}

export async function findMessageByTimestampAndSenderForConversation(
  timestamp: number,
  senderId: string,
  userId: string,
  otherUserId: string,
): Promise<MessageParticipantRecord | null> {
  if (!checkDatabaseConnected()) {
    return null;
  }

  try {
    return await queryOne<MessageParticipantRecord>(
      `SELECT id, sender_id, recipient_id, timestamp
       FROM messages
       WHERE timestamp = $1
         AND sender_id = $2
         AND (
           (sender_id = $3 AND recipient_id = $4) OR
           (sender_id = $4 AND recipient_id = $3)
         )
       ORDER BY created_at DESC
       LIMIT 1;`,
      [timestamp, senderId, userId, otherUserId],
    );
  } catch (error) {
    console.error("Failed to resolve message by timestamp and sender:", error);
    return null;
  }
}

export async function listConversationMessageParticipants(
  userId1: string,
  userId2: string,
): Promise<MessageParticipantRecord[]> {
  if (!checkDatabaseConnected()) {
    return [];
  }

  try {
    const results = await query<MessageParticipantRecord>(
      `SELECT id, sender_id, recipient_id, timestamp
       FROM messages
       WHERE (sender_id = $1 AND recipient_id = $2)
          OR (sender_id = $2 AND recipient_id = $1)
       ORDER BY timestamp ASC;`,
      [userId1, userId2],
    );

    return results || [];
  } catch (error) {
    console.error("Failed to list conversation message participants:", error);
    return [];
  }
}

export async function clearConversationForUserInDB(
  userId: string,
  otherUserId: string,
): Promise<ConversationDeletionSummary | null> {
  if (!checkDatabaseConnected()) {
    return null;
  }

  const client = await getPoolClient();
  if (!client) {
    return null;
  }

  try {
    await client.query("BEGIN");

    const allMessages = await client.query<MessageParticipantRecord>(
      `SELECT id, sender_id, recipient_id, timestamp
       FROM messages
       WHERE (sender_id = $1 AND recipient_id = $2)
          OR (sender_id = $2 AND recipient_id = $1)
       ORDER BY timestamp ASC;`,
      [userId, otherUserId],
    );

    if (allMessages.rows.length > 0) {
      await client.query(
        `INSERT INTO message_deletions (
           message_id,
           user_id,
           sender_id,
           recipient_id,
           message_timestamp,
           deleted_at
         )
         SELECT
           id,
           $1::varchar,
           sender_id,
           recipient_id,
           timestamp,
           CURRENT_TIMESTAMP
         FROM messages
         WHERE (sender_id = $2::varchar AND recipient_id = $3::varchar)
            OR (sender_id = $3::varchar AND recipient_id = $2::varchar)
         ON CONFLICT (message_id, user_id) DO NOTHING;`,
        [userId, userId, otherUserId],
      );
    }

    await client.query("COMMIT");
    await refreshConversationForUser(userId, otherUserId);

    return {
      hiddenForUser: allMessages.rows,
      deletedForEveryone: [],
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error("Failed to clear conversation for user in PostgreSQL:", error);
    return null;
  } finally {
    client.release();
  }
}

export async function eraseConversationWithMixedScopeInDB(
  userId: string,
  otherUserId: string,
): Promise<ConversationDeletionSummary | null> {
  if (!checkDatabaseConnected()) {
    return null;
  }

  const client = await getPoolClient();
  if (!client) {
    return null;
  }

  try {
    await client.query("BEGIN");

    const sentMessages = await client.query<MessageParticipantRecord>(
      `SELECT id, sender_id, recipient_id, timestamp
       FROM messages
       WHERE sender_id = $1::varchar
         AND recipient_id = $2::varchar
       ORDER BY timestamp ASC;`,
      [userId, otherUserId],
    );

    const receivedMessages = await client.query<MessageParticipantRecord>(
      `SELECT id, sender_id, recipient_id, timestamp
       FROM messages
       WHERE sender_id = $2::varchar
         AND recipient_id = $1::varchar
       ORDER BY timestamp ASC;`,
      [userId, otherUserId],
    );

    if (receivedMessages.rows.length > 0) {
      await client.query(
        `INSERT INTO message_deletions (
           message_id,
           user_id,
           sender_id,
           recipient_id,
           message_timestamp,
           deleted_at
         )
         SELECT
           id,
           $1::varchar,
           sender_id,
           recipient_id,
           timestamp,
           CURRENT_TIMESTAMP
         FROM messages
         WHERE sender_id = $2::varchar
           AND recipient_id = $3::varchar
         ON CONFLICT (message_id, user_id) DO NOTHING;`,
        [userId, otherUserId, userId],
      );
    }

    if (sentMessages.rows.length > 0) {
      const sentIds = sentMessages.rows.map((message) => message.id);
      await client.query(`DELETE FROM message_deletions WHERE message_id = ANY($1::uuid[]);`, [
        sentIds,
      ]);
      await client.query(`DELETE FROM messages WHERE id = ANY($1::uuid[]);`, [sentIds]);
    }

    await client.query("COMMIT");
    await refreshConversationForUser(userId, otherUserId);
    await refreshConversationForUser(otherUserId, userId);

    return {
      hiddenForUser: receivedMessages.rows,
      deletedForEveryone: sentMessages.rows,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error("Failed to erase conversation with mixed scope in PostgreSQL:", error);
    return null;
  } finally {
    client.release();
  }
}

/**
 * Delete entire conversation
 */
export async function deleteConversationFromDB(
  userId1: string,
  userId2: string,
): Promise<boolean> {
  if (!checkDatabaseConnected()) {
    return false;
  }

  try {
    await query(
      `DELETE FROM messages
      WHERE (sender_id = $1 AND recipient_id = $2)
         OR (sender_id = $2 AND recipient_id = $1);`,
      [userId1, userId2],
    );

    return true;
  } catch (error) {
    console.error("Failed to delete conversation from PostgreSQL:", error);
    return false;
  }
}

/**
 * Get messages ready for archival (older than specified age)
 * Age is in milliseconds
 */
export async function getMessagesForArchival(
  ageMs: number,
  limit: number = 1000,
): Promise<StoredMessage[]> {
  if (!checkDatabaseConnected()) {
    return [];
  }

  try {
    const cutoffTime = Date.now() - ageMs;

    const results = await query<StoredMessage>(
      `SELECT 
        id, sender_id, recipient_id, nonce, ciphertext, signature, timestamp,
        created_at, archived, archived_at
      FROM messages
      WHERE archived = FALSE AND timestamp < $1
      ORDER BY timestamp ASC
      LIMIT $2;`,
      [cutoffTime, limit],
    );

    return results || [];
  } catch (error) {
    console.error("Failed to get messages for archival:", error);
    return [];
  }
}

/**
 * Mark messages as archived
 */
export async function markMessagesAsArchived(
  messageIds: string[],
): Promise<number> {
  if (!checkDatabaseConnected() || messageIds.length === 0) {
    return 0;
  }

  try {
    // Use parameterized query to safely insert array
    const placeholders = messageIds.map((_, i) => `$${i + 1}`).join(",");

    const result = await query(
      `UPDATE messages 
      SET archived = TRUE, archived_at = CURRENT_TIMESTAMP
      WHERE id IN (${placeholders})
      RETURNING id;`,
      messageIds,
    );

    const count = result ? result.length : 0;
    console.log(`Marked ${count} messages as archived`);
    return count;
  } catch (error) {
    console.error("Failed to mark messages as archived:", error);
    return 0;
  }
}

/**
 * Delete archived messages
 */
export async function deleteArchivedMessages(
  messageIds: string[],
): Promise<number> {
  if (!checkDatabaseConnected() || messageIds.length === 0) {
    return 0;
  }

  try {
    const placeholders = messageIds.map((_, i) => `$${i + 1}`).join(",");

    const result = await query(
      `DELETE FROM messages 
      WHERE id IN (${placeholders})
      RETURNING id;`,
      messageIds,
    );

    const count = result ? result.length : 0;
    console.log(`Deleted ${count} archived messages from PostgreSQL`);
    return count;
  } catch (error) {
    console.error("Failed to delete archived messages:", error);
    return 0;
  }
}

/**
 * Get database statistics
 */
export async function getDatabaseStats(): Promise<{
  total: number;
  archived: number;
  active: number;
}> {
  if (!checkDatabaseConnected()) {
    return { total: 0, archived: 0, active: 0 };
  }

  try {
    const result = await queryOne<{
      total: string;
      archived: string;
      active: string;
    }>(
      `SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN archived = TRUE THEN 1 ELSE 0 END) as archived,
        SUM(CASE WHEN archived = FALSE THEN 1 ELSE 0 END) as active
      FROM messages;`,
    );

    if (result) {
      return {
        total: parseInt(result.total, 10),
        archived: parseInt(result.archived || "0", 10),
        active: parseInt(result.active || "0", 10),
      };
    }

    return { total: 0, archived: 0, active: 0 };
  } catch (error) {
    console.error("Failed to get database stats:", error);
    return { total: 0, archived: 0, active: 0 };
  }
}
