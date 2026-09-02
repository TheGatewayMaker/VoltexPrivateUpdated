import {
  DirectMessageV2Envelope,
  DirectMessageV2Record,
} from "@shared/crypto";
import { getPoolClient, isDatabaseConnected, query, queryOne } from "./db";

export interface DirectMessageV2VisibleEnvelope extends DirectMessageV2Record {
  targetUserId: string;
  targetDeviceId: string;
  nonce: string;
  ciphertext: string;
  signature: string;
  sessionKeyType?: "signed_prekey" | "one_time_prekey";
  sessionKeyId?: number;
  envelopeVersion: string;
  deliveredAt?: number;
  seenAt?: number;
}

export interface DirectMessageV2ReceiptSummary {
  recipientUserId: string;
  recipientDeviceCount: number;
  deliveredDeviceCount: number;
  seenDeviceCount: number;
  deliveredToAny: boolean;
  seenByAny: boolean;
  seenByAll: boolean;
}

export function isDirectMessageV2DatabaseConnected(): boolean {
  return isDatabaseConnected();
}

export function getDirectConversationId(userId1: string, userId2: string): string {
  return [userId1, userId2].sort((left, right) => left.localeCompare(right)).join(":");
}

export async function storeDirectMessageV2(params: {
  message: DirectMessageV2Record;
  envelopes: DirectMessageV2Envelope[];
}): Promise<boolean> {
  if (!isDatabaseConnected()) {
    return false;
  }

  const client = await getPoolClient();
  if (!client) {
    return false;
  }

  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO direct_messages_v2 (
         id,
         conversation_id,
         sender_user_id,
         sender_device_id,
         recipient_user_id,
         message_type,
         server_timestamp,
         client_timestamp,
         client_message_id,
         deleted_for_everyone,
         deleted_at,
         deleted_by_user_id,
         created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (id) DO NOTHING;`,
      [
        params.message.id,
        params.message.conversationId,
        params.message.senderUserId,
        params.message.senderDeviceId,
        params.message.recipientUserId,
        params.message.messageType,
        params.message.serverTimestamp,
        params.message.clientTimestamp || null,
        params.message.clientMessageId || null,
        params.message.deletedForEveryone,
        params.message.deletedAt || null,
        params.message.deletedByUserId || null,
        params.message.createdAt,
      ],
    );

    for (const envelope of params.envelopes) {
      await client.query(
        `INSERT INTO direct_message_device_envelopes (
           message_id,
           target_user_id,
           target_device_id,
           nonce,
           ciphertext,
           signature,
           session_key_type,
           session_key_id,
           envelope_version,
           delivered_at,
           seen_at,
           created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, NULL, $10)
         ON CONFLICT (message_id, target_device_id) DO UPDATE
         SET nonce = EXCLUDED.nonce,
             ciphertext = EXCLUDED.ciphertext,
             signature = EXCLUDED.signature,
             session_key_type = EXCLUDED.session_key_type,
             session_key_id = EXCLUDED.session_key_id,
             envelope_version = EXCLUDED.envelope_version;`,
        [
          params.message.id,
          envelope.targetUserId,
          envelope.targetDeviceId,
          envelope.nonce,
          envelope.ciphertext,
          envelope.signature,
          envelope.sessionKeyType || null,
          envelope.sessionKeyId || null,
          envelope.envelopeVersion,
          params.message.createdAt,
        ],
      );
    }

    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error("Failed to store direct message v2:", error);
    return false;
  } finally {
    client.release();
  }
}

export async function getVisibleDirectMessagesV2(params: {
  userId: string;
  deviceId: string;
  otherUserId: string;
  limit: number;
  offset: number;
}): Promise<DirectMessageV2VisibleEnvelope[]> {
  if (!isDatabaseConnected()) {
    return [];
  }

  const conversationId = getDirectConversationId(params.userId, params.otherUserId);
  const rows =
    (await query<{
      id: string;
      conversation_id: string;
      sender_user_id: string;
      sender_device_id: string;
      recipient_user_id: string;
      message_type: DirectMessageV2Record["messageType"];
      server_timestamp: number;
      client_timestamp: number | null;
      client_message_id: string | null;
      deleted_for_everyone: boolean;
      deleted_at: number | null;
      deleted_by_user_id: string | null;
      created_at: number;
      target_user_id: string;
      target_device_id: string;
      nonce: string;
      ciphertext: string;
      signature: string;
      session_key_type: "signed_prekey" | "one_time_prekey" | null;
      session_key_id: number | null;
      envelope_version: string;
      delivered_at: number | null;
      seen_at: number | null;
    }>(
      `SELECT
         m.id,
         m.conversation_id,
         m.sender_user_id,
         m.sender_device_id,
         m.recipient_user_id,
         m.message_type,
         m.server_timestamp,
         m.client_timestamp,
         m.client_message_id,
         m.deleted_for_everyone,
         m.deleted_at,
         m.deleted_by_user_id,
         m.created_at,
         e.target_user_id,
         e.target_device_id,
         e.nonce,
         e.ciphertext,
         e.signature,
         e.session_key_type,
         e.session_key_id,
         e.envelope_version,
         e.delivered_at,
         e.seen_at
       FROM direct_messages_v2 m
       JOIN direct_message_device_envelopes e
         ON e.message_id = m.id
      WHERE m.conversation_id = $1
        AND e.target_user_id = $2
        AND e.target_device_id = $3
      ORDER BY m.server_timestamp DESC
      LIMIT $4 OFFSET $5;`,
      [conversationId, params.userId, params.deviceId, params.limit, params.offset],
    )) || [];

  return rows.map((row) => ({
    id: row.id,
    conversationId: row.conversation_id,
    senderUserId: row.sender_user_id,
    senderDeviceId: row.sender_device_id,
    recipientUserId: row.recipient_user_id,
    messageType: row.message_type,
    serverTimestamp: Number(row.server_timestamp),
    clientTimestamp:
      typeof row.client_timestamp === "number" ? Number(row.client_timestamp) : undefined,
    clientMessageId: row.client_message_id || undefined,
    deletedForEveryone: row.deleted_for_everyone,
    deletedAt: typeof row.deleted_at === "number" ? Number(row.deleted_at) : undefined,
    deletedByUserId: row.deleted_by_user_id || undefined,
    createdAt: Number(row.created_at),
    targetUserId: row.target_user_id,
    targetDeviceId: row.target_device_id,
    nonce: row.nonce,
    ciphertext: row.ciphertext,
    signature: row.signature,
    sessionKeyType: row.session_key_type || undefined,
    sessionKeyId:
      typeof row.session_key_id === "number" ? Number(row.session_key_id) : undefined,
    envelopeVersion: row.envelope_version,
    deliveredAt: typeof row.delivered_at === "number" ? Number(row.delivered_at) : undefined,
    seenAt: typeof row.seen_at === "number" ? Number(row.seen_at) : undefined,
  }));
}

export async function getDirectMessageV2Count(
  userId: string,
  deviceId: string,
  otherUserId: string,
): Promise<number> {
  if (!isDatabaseConnected()) {
    return 0;
  }

  const conversationId = getDirectConversationId(userId, otherUserId);
  const row = await queryOne<{ count: string }>(
    `SELECT COUNT(*) AS count
       FROM direct_messages_v2 m
       JOIN direct_message_device_envelopes e
         ON e.message_id = m.id
      WHERE m.conversation_id = $1
        AND e.target_user_id = $2
        AND e.target_device_id = $3;`,
    [conversationId, userId, deviceId],
  );

  return row ? Number.parseInt(row.count, 10) || 0 : 0;
}

export async function markDirectMessageV2Delivered(params: {
  userId: string;
  deviceId: string;
  otherUserId: string;
}): Promise<number> {
  if (!isDatabaseConnected()) {
    return 0;
  }

  const conversationId = getDirectConversationId(params.userId, params.otherUserId);
  const deliveredAt = Date.now();
  const rows =
    (await query<{ message_id: string }>(
      `UPDATE direct_message_device_envelopes e
          SET delivered_at = COALESCE(delivered_at, $4)
         FROM direct_messages_v2 m
        WHERE e.message_id = m.id
          AND m.conversation_id = $1
          AND e.target_user_id = $2
          AND e.target_device_id = $3
          AND e.delivered_at IS NULL
      RETURNING e.message_id;`,
      [conversationId, params.userId, params.deviceId, deliveredAt],
    )) || [];

  return rows.length;
}

export async function markDirectMessageV2Seen(params: {
  userId: string;
  deviceId: string;
  otherUserId: string;
}): Promise<number> {
  if (!isDatabaseConnected()) {
    return 0;
  }

  const conversationId = getDirectConversationId(params.userId, params.otherUserId);
  const seenAt = Date.now();
  const rows =
    (await query<{ message_id: string }>(
      `UPDATE direct_message_device_envelopes e
          SET delivered_at = COALESCE(delivered_at, $4),
              seen_at = COALESCE(seen_at, $4)
         FROM direct_messages_v2 m
        WHERE e.message_id = m.id
          AND m.conversation_id = $1
          AND e.target_user_id = $2
          AND e.target_device_id = $3
          AND e.seen_at IS NULL
      RETURNING e.message_id;`,
      [conversationId, params.userId, params.deviceId, seenAt],
    )) || [];

  return rows.length;
}

export async function summarizeDirectMessageV2Receipts(
  messageId: string,
): Promise<DirectMessageV2ReceiptSummary | null> {
  if (!isDatabaseConnected()) {
    return null;
  }

  const row = await queryOne<{
    target_user_id: string;
    recipient_device_count: string;
    delivered_device_count: string;
    seen_device_count: string;
  }>(
    `SELECT
       MIN(target_user_id) AS target_user_id,
       COUNT(*)::text AS recipient_device_count,
       COUNT(*) FILTER (WHERE delivered_at IS NOT NULL)::text AS delivered_device_count,
       COUNT(*) FILTER (WHERE seen_at IS NOT NULL)::text AS seen_device_count
     FROM direct_message_device_envelopes
     WHERE message_id = $1;`,
    [messageId],
  );

  if (!row || !row.target_user_id) {
    return null;
  }

  const recipientDeviceCount = Number.parseInt(row.recipient_device_count, 10) || 0;
  const deliveredDeviceCount = Number.parseInt(row.delivered_device_count, 10) || 0;
  const seenDeviceCount = Number.parseInt(row.seen_device_count, 10) || 0;

  return {
    recipientUserId: row.target_user_id,
    recipientDeviceCount,
    deliveredDeviceCount,
    seenDeviceCount,
    deliveredToAny: deliveredDeviceCount > 0,
    seenByAny: seenDeviceCount > 0,
    seenByAll: recipientDeviceCount > 0 && seenDeviceCount >= recipientDeviceCount,
  };
}
