import { RequestHandler } from "express";
import { v4 as uuidv4 } from "uuid";
import { EncryptedMessage } from "@shared/crypto";
import { getSessionFromToken } from "./auth";
import {
  saveMessageWithMetadata,
  getConversationMessages as getConversationMessagesFromR2,
  getUserConversationsFromR2,
  getAllConversationMessages,
  getConversationMessageById,
  deleteMessageForEveryoneInR2,
  getDeletedMessageIdsForUser,
  markMessageDeletedForUserInR2,
} from "../lib/r2-storage";
import { getUserAccount } from "../lib/auth-store";
import { verifyMessageSignature } from "../lib/crypto";
import {
  deliverMessage,
  isUserConnected,
  notifyMessageDeletion,
  notifyMessageStatus,
} from "../lib/messaging";
import {
  storeMessage,
  getConversationMessages as getStoredMessages,
  deleteMessage as deleteStoredMessage,
  getUserConversations,
} from "../lib/conversation-history";
import {
  storeMessageInDB,
  MessageParticipantRecord,
  StoredMessage,
  getConversationMessagesFromDB,
  getConversationMessageCount,
  getUserConversationsFromDB,
  clearConversationForUserInDB,
  deleteMessageForEveryoneInDB,
  eraseConversationWithMixedScopeInDB,
  isDatabaseConnected,
  markConversationAsRead,
  getUnreadCount,
  getDeletedMessageIdsInConversationForUser,
  getMessageForParticipantById,
  findMessageByTimestampAndSenderForConversation,
  markMessageDeletedForUserInDB,
  markMessagesSeenInDB,
} from "../lib/db-messages";
import { asyncLimiters, isOverloadedError } from "../lib/load-control";
import { getUserProfile, UserProfileRecord } from "../lib/profile-store";
import { resetEmailNotificationCounter } from "../lib/email-notifications";
import { processDirectMessageEmailNotification } from "../lib/direct-message-notifications";
import { isDirectMessageBlocked } from "../lib/block-store";
import {
  normalizeUsernameForLookup,
  resolveDiscoverableUserIdByUsername,
} from "../lib/username-discovery";

const MAX_CONVERSATION_PAGE_SIZE = 100;
const MAX_CONVERSATION_OFFSET = 5000;

function getSingleParam(value: string | string[] | undefined): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0] || "";
  return "";
}

interface ConversationMessage extends EncryptedMessage {
  id?: string;
  deliveredAt?: number | null;
  readAt?: number | null;
}

function paginateFromLatest<T>(
  items: T[],
  limit: number,
  offset: number,
): T[] {
  const start = Math.max(items.length - limit - offset, 0);
  const end = Math.max(items.length - offset, 0);
  return items.slice(start, end);
}

function getAvatarUrl(
  profile: UserProfileRecord | null,
  username?: string | null,
): string | null {
  if (!profile?.avatar || !username) {
    return null;
  }

  const version = profile.updatedAt || profile.createdAt || Date.now();
  return `/api/profile/avatar/by-username/${encodeURIComponent(username)}?v=${version}`;
}

function normalizeUsername(value: unknown): string {
  return normalizeUsernameForLookup(value);
}

function parseSyntheticMessageId(messageId: string): {
  timestamp: number | null;
  senderId: string | null;
} {
  const dashIndex = messageId.indexOf("-");
  if (dashIndex === -1) {
    return { timestamp: null, senderId: null };
  }

  const timestamp = Number.parseInt(messageId.slice(0, dashIndex), 10);
  const senderId = messageId.slice(dashIndex + 1) || null;

  return {
    timestamp: Number.isFinite(timestamp) ? timestamp : null,
    senderId,
  };
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

async function resolveMessageForParticipant(
  messageId: string,
  userId: string,
  otherUserId: string,
): Promise<MessageParticipantRecord | null> {
  if (isDatabaseConnected()) {
    if (isUuidLike(messageId)) {
      const directMatch = await getMessageForParticipantById(
        messageId,
        userId,
        otherUserId,
      );
      if (directMatch) {
        return directMatch;
      }
    }

    const parsed = parseSyntheticMessageId(messageId);
    if (parsed.timestamp && parsed.senderId) {
      const syntheticMatch = await findMessageByTimestampAndSenderForConversation(
        parsed.timestamp,
        parsed.senderId,
        userId,
        otherUserId,
      );
      if (syntheticMatch) {
        return syntheticMatch;
      }
    }
  }

  const r2Message = isUuidLike(messageId)
    ? await getConversationMessageById(userId, otherUserId, messageId)
    : null;

  if (r2Message?.messageId) {
    return {
      id: r2Message.messageId,
      sender_id: r2Message.senderId,
      recipient_id: r2Message.recipientId,
      timestamp: Number(r2Message.timestamp),
    };
  }

  const inMemoryMessages = getStoredMessages(userId, otherUserId);
  const parsed = parseSyntheticMessageId(messageId);
  const inMemoryMatch = inMemoryMessages.find((message) => {
    const syntheticId = `${message.timestamp}-${message.senderId}`;
    if (syntheticId === messageId) {
      return true;
    }

    return (
      parsed.timestamp === Number(message.timestamp) &&
      parsed.senderId === message.senderId
    );
  });

  if (!inMemoryMatch) {
    return null;
  }

  return {
    id: isUuidLike(messageId) ? messageId : `${inMemoryMatch.timestamp}-${inMemoryMatch.senderId}`,
    sender_id: inMemoryMatch.senderId,
    recipient_id: inMemoryMatch.recipientId,
    timestamp: Number(inMemoryMatch.timestamp),
  };
}

async function resolveRecipientUserId(input: {
  recipientId?: unknown;
  recipientUsername?: unknown;
  usernameParam?: unknown;
  requesterUserId?: string;
}): Promise<string> {
  const directRecipientId =
    typeof input.recipientId === "string" ? input.recipientId.trim() : "";
  if (directRecipientId) {
    return directRecipientId;
  }

  const username =
    normalizeUsername(input.recipientUsername) ||
    normalizeUsername(input.usernameParam);

  if (!username) {
    return "";
  }

  return resolveDiscoverableUserIdByUsername({
    username,
    requesterUserId: input.requesterUserId,
  });
}

/**
 * POST /api/messages/send
 * Store an encrypted message with signature verification
 */
export const handleSendMessage: RequestHandler = async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const sessionToken =
      typeof authHeader === "string"
        ? authHeader.replace("Bearer ", "")
        : undefined;

    if (!sessionToken) {
      return res.status(401).json({ error: "Unauthorized - no session token" });
    }

    let session;
    try {
      session = await getSessionFromToken(sessionToken);
    } catch (sessionError) {
      console.error("Session validation error:", sessionError);
      return res.status(401).json({ error: "Invalid session token" });
    }

    if (!session) {
      return res.status(401).json({ error: "Session not found or expired" });
    }

    const { nonce, ciphertext, signature, timestamp } = req.body;
    const recipientId = await resolveRecipientUserId({
      recipientId: req.body?.recipientId,
      recipientUsername: req.body?.recipientUsername,
      requesterUserId: session.userId,
    });

    if (!recipientId || !nonce || !ciphertext || !signature || !timestamp) {
      return res.status(400).json({
        error:
          "Missing required fields: recipientUsername, nonce, ciphertext, signature, timestamp",
      });
    }

    const blockStatus = await isDirectMessageBlocked(session.userId, recipientId);
    if (!blockStatus.canSend) {
      return res.status(403).json({
        error: blockStatus.blockedByMe
          ? "You have blocked this user. Unblock them to send messages."
          : blockStatus.blockedMe
            ? "You have been blocked by this user. You cannot send messages."
            : "Messaging is unavailable for this conversation.",
        code: "DIRECT_MESSAGE_BLOCKED",
        blockStatus,
      });
    }

    // Validate timestamp format and value
    if (typeof timestamp !== "number" || timestamp <= 0) {
      return res.status(400).json({
        error: "Invalid timestamp - must be a positive number",
      });
    }

    // Ensure timestamp is not too far in the past or future (allow 24 hour clock skew)
    const now = Date.now();
    const MAX_CLOCK_SKEW = 24 * 60 * 60 * 1000; // 24 hours
    if (Math.abs(now - timestamp) > MAX_CLOCK_SKEW) {
      console.warn(
        `Message timestamp ${timestamp} is too far from server time ${now} (difference: ${Math.abs(now - timestamp)}ms)`,
      );
      return res.status(400).json({
        error:
          "Message timestamp is too far from server time. Please check your device clock.",
      });
    }

    // Validate signature format (64 bytes base64-encoded)
    if (typeof signature !== "string" || signature.length === 0) {
      return res.status(400).json({
        error: "Invalid signature format",
      });
    }

    // Create encrypted message object
    const message: EncryptedMessage = {
      nonce,
      ciphertext,
      signature,
      senderId: session.userId,
      recipientId,
      timestamp,
    };

    // Generate server timestamp NOW - this is the authoritative timestamp for the message
    // This ensures timestamps are consistent and don't depend on client time sync or recipient being online
    const serverTimestamp = Date.now();

    // Verify message signature using sender's sign public key
    let signPublicKeyToUse = session.signPublicKey;
    let userAccount = null;

    // If signPublicKey is not in session, fetch it from user account
    if (!signPublicKeyToUse) {
      try {
        userAccount = await getUserAccount(session.userId);
        if (userAccount && userAccount.signPublicKey) {
          signPublicKeyToUse = userAccount.signPublicKey;
        }
      } catch (error) {
        console.error("Failed to fetch user account for signPublicKey:", error);
        return res.status(500).json({
          error: `Failed to fetch user account: ${error instanceof Error ? error.message : "Unknown error"}`,
        });
      }
    }

    // If we still don't have a signPublicKey, we cannot verify the signature
    if (!signPublicKeyToUse) {
      console.warn(
        `No sign public key available for user ${session.userId}. ` +
          `Session has signPublicKey: ${!!session.signPublicKey}, ` +
          `User account found: ${!!userAccount}`,
      );
      return res.status(403).json({
        error:
          "User account is missing signing key. Please sign out and sign in again, or create a new account",
      });
    }

    let isSignatureValid;
    try {
      isSignatureValid = verifyMessageSignature(message, signPublicKeyToUse);
    } catch (verifyError) {
      console.error("Signature verification error:", verifyError);
      return res.status(500).json({
        error: `Signature verification failed: ${verifyError instanceof Error ? verifyError.message : "Unknown error"}`,
      });
    }

    if (!isSignatureValid) {
      console.warn(
        `Invalid message signature from ${session.userId} to ${recipientId}. ` +
          `Signature: ${signature.substring(0, 20)}...`,
      );
      return res.status(403).json({
        error: "Invalid message signature - authenticity verification failed",
      });
    }

    console.log(
      `Message signature verified successfully for user ${session.userId}`,
    );

    // Generate unique message ID
    const messageId = uuidv4();

    // Use server timestamp instead of client timestamp for storage and delivery
    // This ensures all timestamps are consistent and authoritative
    const messageWithServerTimestamp: EncryptedMessage = {
      ...message,
      timestamp: serverTimestamp,
    };

    // Store in both PostgreSQL and R2 in PARALLEL for speed
    // CRITICAL: At least one storage backend must succeed, otherwise message is lost
    let dbStorageSuccess = false;
    let r2StorageSuccess = false;
    let storageErrors: string[] = [];

    try {
      await asyncLimiters.messagePersistence.run(async () => {
        const storagePromises: Promise<any>[] = [];

        if (isDatabaseConnected()) {
          storagePromises.push(
            storeMessageInDB(messageId, session.userId, recipientId, {
              nonce,
              ciphertext,
              signature,
              senderId: session.userId,
              recipientId,
              timestamp: serverTimestamp,
            })
              .then((success) => {
                dbStorageSuccess = success;
                if (success) {
                  console.log(
                    `Message ${messageId} stored in PostgreSQL with timestamp ${serverTimestamp}`,
                  );
                }
                return success;
              })
              .catch((dbError) => {
                const dbErrorMsg =
                  dbError instanceof Error ? dbError.message : String(dbError);
                console.error("Failed to store message in PostgreSQL:", dbErrorMsg);
                storageErrors.push(`PostgreSQL: ${dbErrorMsg}`);
              }),
          );
        }

        if (!isDatabaseConnected()) {
          storagePromises.push(
            saveMessageWithMetadata(messageId, session.userId, recipientId, {
              nonce,
              ciphertext,
              signature,
              timestamp: serverTimestamp,
            })
              .then(() => {
                console.log(
                  `Message ${messageId} stored in R2 with timestamp ${serverTimestamp}`,
                );
                r2StorageSuccess = true;
              })
              .catch((r2Error) => {
                const r2ErrorMsg =
                  r2Error instanceof Error ? r2Error.message : String(r2Error);
                console.error("Failed to store message in R2:", r2ErrorMsg);
                storageErrors.push(`R2: ${r2ErrorMsg}`);
              }),
          );
        }

        if (storagePromises.length > 0) {
          await Promise.all(storagePromises);
        }
      });
    } catch (error) {
      if (isOverloadedError(error)) {
        return res.status(error.statusCode).json({
          error: error.message,
          retryAfter: error.retryAfterSeconds,
        });
      }

      throw error;
    }

    // CRITICAL: Ensure message was persisted to at least one backend
    // If both storage operations failed, the message will be lost when server restarts
    // or when users leave the conversation before in-memory cache is flushed
    if (!dbStorageSuccess && !r2StorageSuccess) {
      console.error(
        `CRITICAL: Message ${messageId} failed to persist to any storage backend. Errors: ${storageErrors.join("; ")}`,
      );
      return res.status(500).json({
        error: `Failed to persist message to any storage backend. Message was not saved. Please try again. Details: ${storageErrors.join("; ")}`,
        critical: true,
      });
    }

    // Only expose a message to conversation state after durable persistence succeeds.
    storeMessage(session.userId, recipientId, messageWithServerTimestamp);

    // Attempt to deliver message to recipient in real-time (if connected)
    const recipientWasConnected = isUserConnected(recipientId);
    const delivered = deliverMessage({
      ...messageWithServerTimestamp,
      serverMessageId: messageId,
    });
    if (delivered) {
      console.log(`Message delivered in real-time to ${recipientId}`);
    } else {
      console.log(
        `Message queued for ${recipientId} (not currently connected)`,
      );
      await processDirectMessageEmailNotification({
        senderId: session.userId,
        recipientId,
        delivered,
        recipientWasConnected,
      });
    }

    return res.status(200).json({
      success: true,
      // CANONICAL MESSAGE ID: Use the server-generated UUID
      // This is the authoritative message ID for all operations (deletion, etc.)
      messageId: messageId,
      // LEGACY COMPATIBILITY: Include timestamp-based ID for backward compatibility with polling
      clientMessageId: `${serverTimestamp}-${session.userId}`,
      // SERVER TIMESTAMP: The authoritative server time for this message
      timestamp: serverTimestamp,
      // PERSISTENCE STATUS: Confirm which backends succeeded
      persisted: dbStorageSuccess || r2StorageSuccess,
      persistedInDB: dbStorageSuccess,
      persistedInR2: r2StorageSuccess,
      // DELIVERY STATUS: Whether message was delivered to recipient in real-time
      delivered,
    });
  } catch (error) {
    console.error("Unexpected error in send message handler:", error);
    // Return the actual error message to help with debugging
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return res
      .status(500)
      .json({ error: `Failed to send message: ${errorMessage}` });
  }
};

/**
 * GET /api/messages/conversation/:recipientId
 * Retrieve conversation history (from PostgreSQL + R2 for older messages)
 */
export const handleGetConversation: RequestHandler = async (req, res) => {
  try {
    const sessionToken = req.headers.authorization?.replace("Bearer ", "");
    if (!sessionToken) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const session = await getSessionFromToken(sessionToken);
    if (!session) {
      return res.status(401).json({ error: "Invalid session" });
    }

    const recipientId = await resolveRecipientUserId({
      recipientId: req.params.recipientId,
      usernameParam: req.params.username,
      requesterUserId: session.userId,
    });
    const rawLimit = parseInt(req.query.limit as string, 10);
    const rawOffset = parseInt(req.query.offset as string, 10);
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(rawLimit, MAX_CONVERSATION_PAGE_SIZE)
        : 50;
    const offset =
      Number.isFinite(rawOffset) && rawOffset >= 0
        ? Math.min(rawOffset, MAX_CONVERSATION_OFFSET)
        : 0;
    const anchor =
      typeof req.query.anchor === "string" && req.query.anchor === "latest"
        ? "latest"
        : "start";

    if (!recipientId) {
      return res.status(400).json({ error: "recipientId is required" });
    }

    let viewerDeletedMessageIds = new Set<string>();
    try {
      viewerDeletedMessageIds = isDatabaseConnected()
        ? await getDeletedMessageIdsInConversationForUser(
            session.userId,
            recipientId,
          )
        : await getDeletedMessageIdsForUser(session.userId, recipientId);
    } catch (deletionLookupError) {
      console.error(
        "[MESSAGE-VISIBILITY] Failed to load per-user deletions for conversation:",
        deletionLookupError,
      );
      if (isDatabaseConnected()) {
        return res.status(500).json({
          error: "Failed to load conversation visibility state",
        });
      }
    }

    // CRITICAL: Get in-memory messages FIRST to catch messages that were just sent
    // but not yet persisted to DB/R2 (they exist in memory and should not be lost)
    const inMemoryMessages = (
      getStoredMessages(session.userId, recipientId) as ConversationMessage[]
    ).filter((message) => {
      const syntheticId = `${message.timestamp}-${message.senderId}`;
      return (
        !viewerDeletedMessageIds.has(syntheticId) &&
        !viewerDeletedMessageIds.has(message.id || "")
      );
    });
    const messageIds = new Set<string>();

    // Start with in-memory messages (most recent, not yet persisted)
    let allMessages: ConversationMessage[] = [];
    if (inMemoryMessages.length > 0) {
      allMessages = inMemoryMessages;
      inMemoryMessages.forEach((m) => {
        messageIds.add(m.id || `${m.timestamp}-${m.senderId}`);
      });
      console.log(
        `Loaded ${inMemoryMessages.length} messages from memory for conversation ${session.userId}:${recipientId}`,
      );
    }

    // Then load from PostgreSQL (hot storage - most recent persisted messages)
    let fromDatabase = false;
    let totalMessages = allMessages.length;
    if (isDatabaseConnected()) {
      try {
        totalMessages = await getConversationMessageCount(
          session.userId,
          recipientId,
        );
        const dbMessages = await getConversationMessagesFromDB(
          session.userId,
          recipientId,
          Math.min(limit + offset, 500),
          0,
        );

        if (dbMessages && dbMessages.length > 0) {
          // Convert database message format to EncryptedMessage format
          const convertedMessages: ConversationMessage[] = dbMessages.map(
            (msg: StoredMessage) => ({
              id: msg.id, // Include unique message ID for deduplication
              nonce: msg.nonce,
              ciphertext: msg.ciphertext,
              signature: msg.signature,
              senderId: msg.sender_id || msg.senderId,
              recipientId: msg.recipient_id || msg.recipientId,
              timestamp: Number(msg.timestamp),
              deliveredAt: msg.delivered_at
                ? new Date(msg.delivered_at).getTime()
                : null,
              readAt: msg.read_at ? new Date(msg.read_at).getTime() : null,
            }),
          );

          const existingBySyntheticId = new Map(
            allMessages.map((message, index) => [
              `${message.timestamp}-${message.senderId}`,
              index,
            ]),
          );

          const newMessages: ConversationMessage[] = [];

          for (const message of convertedMessages) {
            const syntheticId = `${message.timestamp}-${message.senderId}`;
            const existingIndex = existingBySyntheticId.get(syntheticId);

            if (typeof existingIndex === "number") {
              allMessages[existingIndex] = {
                ...allMessages[existingIndex],
                ...message,
              };
              messageIds.add(message.id || syntheticId);
              continue;
            }

            if (!messageIds.has(message.id || syntheticId)) {
              newMessages.push(message);
              messageIds.add(message.id || syntheticId);
            }
          }

          allMessages = [...allMessages, ...newMessages];

          fromDatabase = true;
          console.log(
            `Loaded ${convertedMessages.length} messages from PostgreSQL (${newMessages.length} new) for conversation ${session.userId}:${recipientId}`,
          );
        }
      } catch (dbError) {
        console.error("Error loading messages from PostgreSQL:", dbError);
      }
    }

    // Finally, try R2 persistence for older messages or if DB is empty
    if (!isDatabaseConnected() && allMessages.length < limit + offset) {
      try {
        const r2Messages = await getConversationMessagesFromR2(
          session.userId,
          recipientId,
          Math.min(limit + offset, 500),
          0,
        );

        if (r2Messages && r2Messages.length > 0) {
          // CRITICAL: Get list of deleted message IDs for reconciliation
          // This ensures late-join users don't see soft-deleted messages from R2 archival
          // MANDATORY: Must always fetch deleted IDs, not optional
          let deletedMessageIds = viewerDeletedMessageIds;
          if (isDatabaseConnected()) {
            try {
              if (deletedMessageIds.size > 0) {
                console.log(
                  `[R2-RECONCILE] Found ${deletedMessageIds.size} deleted messages for reconciliation in conversation ${session.userId}:${recipientId}`,
                );
                // Log which IDs are deleted for debugging
                console.log(
                  `[R2-RECONCILE] Deleted message IDs: ${Array.from(deletedMessageIds).slice(0, 5).join(", ")}${deletedMessageIds.size > 5 ? "..." : ""}`,
                );
              }
            } catch (deletionCheckError) {
              // CRITICAL: If we can't fetch deleted IDs, we must FAIL SAFELY
              // Not checking deleted messages could result in showing deleted content
              console.error(
                "[R2-RECONCILE] ERROR fetching deleted messages - will skip R2 reconciliation to be safe:",
                deletionCheckError,
              );
              // IMPORTANT: Do not continue R2 reconciliation without deleted IDs
              // Risk: Soft-deleted messages could reappear
              console.warn(
                "[R2-RECONCILE] Skipping R2 reconciliation to prevent deleted messages from reappearing",
              );
              r2Messages.length = 0; // Clear to skip reconciliation
            }
          } else {
            // In filesystem-only mode, deletions are applied directly to the local
            // R2-backed message files, so there is no separate soft-delete state to
            // reconcile against. Skipping R2 here makes persisted history disappear
            // after restarts or memory cleanup.
            console.log(
              "[R2-RECONCILE] Database not connected - loading persisted R2 messages directly in filesystem-only mode.",
            );
          }

          // Only add messages we don't already have AND are not soft-deleted
          if (r2Messages.length > 0) {
            const newMessages = r2Messages.filter((m) => {
              const syntheticId = `${m.timestamp}-${m.senderId}`;

              // CRITICAL: Always use the UUID from R2 (m.id)
              // m.id is set from messageData.messageId when loading from R2
              // This is the authoritative UUID for deletion matching
              if (!m.id || typeof m.id !== "string") {
                console.warn(
                  `[R2-RECONCILE] Skipping message without valid UUID from R2 (timestamp: ${m.timestamp}, sender: ${m.senderId}, id: ${m.id})`,
                );
                return false; // Safety: exclude messages without proper IDs
              }

              const messageId = m.id; // Use UUID, not constructed ID

              // Exclude if already have it
              if (messageIds.has(messageId)) {
                console.log(
                  `[R2-RECONCILE] Skipping message already in result set: ${messageId}`,
                );
                return false;
              }

              // CRITICAL: Exclude if soft-deleted in database
              // This is essential to prevent deleted messages from reappearing
              if (deletedMessageIds.has(messageId)) {
                console.log(
                  `[R2-RECONCILE] ✓ Filtering out soft-deleted message ${messageId} from R2`,
                );
                return false;
              }

              if (deletedMessageIds.has(syntheticId)) {
                return false;
              }

              console.log(
                `[R2-RECONCILE] ✓ Including message from R2: ${messageId} (sender: ${m.senderId}, timestamp: ${m.timestamp})`,
              );
              return true;
            });

            allMessages = [...allMessages, ...newMessages];
            newMessages.forEach((m) => {
              messageIds.add(m.id);
            });

            console.log(
              `[R2-RECONCILE] Loaded ${r2Messages.length} messages from R2 (${newMessages.length} new) for conversation ${session.userId}:${recipientId}`,
            );
            totalMessages = Math.max(totalMessages, allMessages.length);
          }
        }
      } catch (r2Error) {
        console.error(
          "[R2-RECONCILE] Error loading messages from R2:",
          r2Error,
        );
      }
    }

    // Sort all messages by timestamp (oldest first)
    allMessages.sort((a, b) => a.timestamp - b.timestamp);

    // Apply pagination. Default behavior stays oldest-first for compatibility.
    const paginatedMessages =
      anchor === "latest"
        ? paginateFromLatest(allMessages, limit, offset)
        : allMessages.slice(offset, offset + limit);

    return res.status(200).json({
      messages: paginatedMessages,
      total: Math.max(totalMessages, allMessages.length),
      limit,
      offset,
      source: fromDatabase ? "database+r2" : "r2+memory",
    });
  } catch (error) {
    console.error("Get conversation error:", error);
    return res.status(500).json({ error: "Failed to retrieve conversation" });
  }
};

/**
 * GET /api/messages/conversations
 * Get list of conversations (users you've chatted with)
 */
export const handleGetConversations: RequestHandler = async (req, res) => {
  try {
    const sessionToken = req.headers.authorization?.replace("Bearer ", "");
    if (!sessionToken) {
      console.warn(
        `[CONVERSATIONS] ✗ Request rejected: No authorization header`,
      );
      return res
        .status(401)
        .json({ error: "Unauthorized: No authentication token" });
    }

    const session = await getSessionFromToken(sessionToken);
    if (!session) {
      console.warn(
        `[CONVERSATIONS] ✗ Request rejected: Session validation failed for token ${sessionToken.substring(0, 8)}...`,
      );
      return res
        .status(401)
        .json({ error: "Invalid or expired session. Please sign in again." });
    }

    console.log(
      `[CONVERSATIONS] Loading conversations for user ${session.userId}`,
    );

    // Get conversations from ALL sources and merge them (don't early return)
    // This ensures conversations aren't lost even if one source is incomplete
    let userConversations = new Map<
      string,
      { lastMessage: ConversationMessage | null; timestamp: number }
    >();
    let fromDatabase = false;
    let loadedFromDB = 0;
    let loadedFromR2 = 0;
    let loadedFromMemory = 0;

    // 1. Load from PostgreSQL (hot storage - most recent)
    if (isDatabaseConnected()) {
      try {
        const dbConversations = await getUserConversationsFromDB(
          session.userId,
        );
        if (dbConversations.size > 0) {
          fromDatabase = true;
          loadedFromDB = dbConversations.size;
          console.log(
            `Loaded ${dbConversations.size} conversations from PostgreSQL for user ${session.userId}`,
          );
          // Merge into result map
          for (const [userId, data] of dbConversations) {
            const normalizedLastMessage = data.lastMessage
              ? {
                  ...data.lastMessage,
                  timestamp: Number(data.lastMessage.timestamp),
                }
              : null;
            userConversations.set(userId, {
              lastMessage: normalizedLastMessage,
              timestamp: Number(data.timestamp),
            });
          }
        }
      } catch (dbError) {
        console.error("Error loading conversations from PostgreSQL:", dbError);
      }
    }

    // 2. Also load from R2 persistence (cold storage - archive) - ALWAYS check even if DB has results
    // This ensures we don't lose conversations that exist only in R2
    if (!isDatabaseConnected()) {
      try {
        const r2Conversations = await getUserConversationsFromR2(session.userId);
        loadedFromR2 = r2Conversations.size;
        console.log(
          `Loaded ${r2Conversations.size} conversations from R2 for user ${session.userId}`,
        );
        // Merge with existing, newer timestamps win
        for (const [userId, data] of r2Conversations) {
          const existing = userConversations.get(userId);
          if (!existing || data.timestamp > existing.timestamp) {
            userConversations.set(userId, data);
          }
        }
      } catch (r2Error) {
        console.error("Error loading conversations from R2:", r2Error);
      }
    }

    // 3. Also check in-memory conversations (real-time)
    const inMemoryConversations = getUserConversations(session.userId);
    loadedFromMemory = inMemoryConversations.size;
    if (inMemoryConversations.size > 0) {
      console.log(
        `Loaded ${inMemoryConversations.size} conversations from memory for user ${session.userId}`,
      );
      // Merge with existing, newer timestamps win (in-memory is most recent)
      for (const [userId] of inMemoryConversations) {
        let deletedIds = new Set<string>();
        try {
          deletedIds = isDatabaseConnected()
            ? await getDeletedMessageIdsInConversationForUser(
                session.userId,
                userId,
              )
            : await getDeletedMessageIdsForUser(session.userId, userId);
        } catch (error) {
          console.error(
            `Failed to load deleted message ids for in-memory conversation ${session.userId}:${userId}:`,
            error,
          );
        }

        const visibleMessages = getStoredMessages(session.userId, userId)
          .filter((message) => {
            const syntheticId = `${message.timestamp}-${message.senderId}`;
            return !deletedIds.has(syntheticId);
          })
          .sort((a, b) => a.timestamp - b.timestamp);

        const lastVisibleMessage =
          visibleMessages.length > 0
            ? (visibleMessages[visibleMessages.length - 1] as ConversationMessage)
            : null;

        if (!lastVisibleMessage) {
          continue;
        }

        const existing = userConversations.get(userId);
        if (!existing || lastVisibleMessage.timestamp > existing.timestamp) {
          userConversations.set(userId, {
            lastMessage: lastVisibleMessage,
            timestamp: lastVisibleMessage.timestamp,
          });
        }
      }
    }

    console.log(
      `Total conversations merged for user ${session.userId}: DB=${loadedFromDB}, R2=${loadedFromR2}, Memory=${loadedFromMemory}, Final=${userConversations.size}`,
    );

    // Convert to API response format
    const conversations = await Promise.all(
      Array.from(userConversations.entries()).map(async ([userId, data]) => {
        let unreadCount = 0;
        const account = await getUserAccount(userId);
        const profile = await getUserProfile(userId);
        if (isDatabaseConnected()) {
          try {
            unreadCount = await getUnreadCount(session.userId, userId);
          } catch (error) {
            console.error(`Failed to get unread count for ${userId}:`, error);
          }
        }

        return {
          username: account?.username || "",
          displayName: profile?.displayName || "User",
          avatar: getAvatarUrl(profile, account?.username),
          lastMessage: data.lastMessage,
          timestamp: data.timestamp,
          unread: unreadCount,
        };
      }),
    );

    // Sort by timestamp (newest first)
    conversations.sort((a, b) => b.timestamp - a.timestamp);

    return res.status(200).json({
      conversations,
      count: conversations.length,
      source: fromDatabase ? "database+r2" : "r2+memory",
    });
  } catch (error) {
    console.error("Get conversations error:", error);
    return res.status(500).json({ error: "Failed to retrieve conversations" });
  }
};

/**
 * DELETE /api/messages/conversation/:recipientId
 * Apply scoped conversation deletion semantics.
 */
export const handleDeleteConversation: RequestHandler = async (req, res) => {
  try {
    const sessionToken = req.headers.authorization?.replace("Bearer ", "");
    if (!sessionToken) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const session = await getSessionFromToken(sessionToken);
    if (!session) {
      return res.status(401).json({ error: "Invalid session" });
    }

    const recipientId = await resolveRecipientUserId({
      recipientId: req.params.recipientId,
      usernameParam: req.params.username,
      requesterUserId: session.userId,
    });

    if (!recipientId) {
      return res.status(400).json({ error: "recipientId is required" });
    }

    const scope =
      typeof req.body?.scope === "string" ? req.body.scope.trim() : "self";

    if (scope !== "self" && scope !== "mixed") {
      return res.status(400).json({
        error: "scope must be either 'self' or 'mixed'",
      });
    }

    if (isDatabaseConnected()) {
      if (scope === "self") {
        const result = await clearConversationForUserInDB(
          session.userId,
          recipientId,
        );

        if (!result) {
          return res.status(500).json({
            error: "Failed to clear conversation for current user",
          });
        }

        return res.status(200).json({
          success: true,
          deleted: true,
          scope: "self",
          hiddenForUser: result.hiddenForUser.length,
          deletedForEveryone: 0,
        });
      }

      const result = await eraseConversationWithMixedScopeInDB(
        session.userId,
        recipientId,
      );

      if (!result) {
        return res.status(500).json({
          error: "Failed to erase conversation with requested scope",
        });
      }

      for (const hiddenMessage of result.hiddenForUser) {
        // No global mutation in memory for hide-for-me rows.
        void hiddenMessage;
      }

      for (const deletedMessage of result.deletedForEveryone) {
        const syntheticId = `${deletedMessage.timestamp}-${deletedMessage.sender_id}`;
        deleteStoredMessage(session.userId, recipientId, syntheticId);
        notifyMessageDeletion(recipientId, deletedMessage.id, session.userId, {
          serverUUID: deletedMessage.id,
          messageTimestamp: deletedMessage.timestamp,
          senderId: deletedMessage.sender_id,
        });
      }

      return res.status(200).json({
        success: true,
        deleted: true,
        scope: "mixed",
        hiddenForUser: result.hiddenForUser.length,
        deletedForEveryone: result.deletedForEveryone.length,
      });
    }

    const r2Messages = await getAllConversationMessages(session.userId, recipientId);

    if (scope === "self") {
      for (const message of r2Messages) {
        const tombstoneId =
          typeof message.messageId === "string" && message.messageId.length > 0
            ? message.messageId
            : `${message.timestamp}-${message.senderId}`;
        await markMessageDeletedForUserInR2(
          tombstoneId,
          session.userId,
          recipientId,
        );
      }

      return res.status(200).json({
        success: true,
        deleted: true,
        scope: "self",
        hiddenForUser: r2Messages.length,
        deletedForEveryone: 0,
      });
    }

    let hiddenForUser = 0;
    let deletedForEveryone = 0;

    for (const message of r2Messages) {
      const messageId =
        typeof message.messageId === "string" && message.messageId.length > 0
          ? message.messageId
          : `${message.timestamp}-${message.senderId}`;

      if (message.senderId === session.userId && typeof message.messageId === "string") {
        await deleteMessageForEveryoneInR2(
          message.messageId,
          session.userId,
          recipientId,
        );
        deleteStoredMessage(
          session.userId,
          recipientId,
          `${message.timestamp}-${message.senderId}`,
        );
        notifyMessageDeletion(recipientId, message.messageId, session.userId, {
          serverUUID: message.messageId,
          messageTimestamp: Number(message.timestamp),
          senderId: message.senderId,
        });
        deletedForEveryone += 1;
        continue;
      }

      await markMessageDeletedForUserInR2(messageId, session.userId, recipientId);
      hiddenForUser += 1;
    }

    return res.status(200).json({
      success: true,
      deleted: true,
      scope: "mixed",
      hiddenForUser,
      deletedForEveryone,
    });
  } catch (error) {
    console.error("Delete conversation error:", error);
    return res.status(500).json({ error: "Failed to delete conversation" });
  }
};

/**
 * DELETE /api/messages/message
 * Hide a specific message for the authenticated user only.
 */
export const handleDeleteMessage: RequestHandler = async (req, res) => {
  try {
    const sessionToken = req.headers.authorization?.replace("Bearer ", "");
    if (!sessionToken) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const session = await getSessionFromToken(sessionToken);
    if (!session) {
      return res.status(401).json({ error: "Invalid session" });
    }

    const { messageId, scope } = req.body;
    const recipientId = await resolveRecipientUserId({
      recipientId: req.body?.recipientId,
      recipientUsername: req.body?.recipientUsername,
      requesterUserId: session.userId,
    });

    if (!messageId || !recipientId) {
      return res
        .status(400)
        .json({ error: "messageId and recipientUsername are required" });
    }

    const resolvedMessage = await resolveMessageForParticipant(
      messageId,
      session.userId,
      recipientId,
    );

    if (!resolvedMessage) {
      return res.status(404).json({
        error:
          "Message not found in this conversation, or you do not have access to it",
        success: false,
        deleted: false,
      });
    }

    const canonicalMessageId = resolvedMessage.id;
    const syntheticMessageId = `${resolvedMessage.timestamp}-${resolvedMessage.sender_id}`;

    if (scope === "everyone") {
      if (resolvedMessage.sender_id !== session.userId) {
        return res.status(403).json({
          error: "Only the sender can permanently delete a message for both parties",
          success: false,
          deleted: false,
        });
      }

      let persistedInDatabase = false;
      let persistedInR2 = false;

      deleteStoredMessage(session.userId, recipientId, syntheticMessageId);

      if (isDatabaseConnected() && isUuidLike(canonicalMessageId)) {
        persistedInDatabase = await deleteMessageForEveryoneInDB(
          canonicalMessageId,
          {
            senderId: resolvedMessage.sender_id,
            recipientId: resolvedMessage.recipient_id,
          },
        );

        if (!persistedInDatabase) {
          return res.status(500).json({
            error: "Failed to permanently delete the message from database storage",
            success: false,
            deleted: false,
          });
        }
      }

      if (isUuidLike(canonicalMessageId)) {
        try {
          await deleteMessageForEveryoneInR2(
            canonicalMessageId,
            session.userId,
            recipientId,
          );
          persistedInR2 = true;
        } catch (error) {
          console.error("Failed to permanently delete message from filesystem/R2:", error);
          if (!isDatabaseConnected()) {
            return res.status(500).json({
              error: "Failed to permanently delete the message from storage",
              success: false,
              deleted: false,
            });
          }
        }
      }

      notifyMessageDeletion(recipientId, canonicalMessageId, session.userId, {
        serverUUID: isUuidLike(canonicalMessageId) ? canonicalMessageId : undefined,
        messageTimestamp: resolvedMessage.timestamp,
        senderId: resolvedMessage.sender_id,
      });

      return res.status(200).json({
        success: true,
        deleted: true,
        scope: "everyone",
        messageId: canonicalMessageId,
        syntheticMessageId,
        recipientId,
        persisted: {
          database: persistedInDatabase,
          r2: persistedInR2,
        },
      });
    }

    let persistedInDatabase = false;
    let persistedInR2 = false;

    if (isDatabaseConnected() && isUuidLike(canonicalMessageId)) {
      persistedInDatabase = await markMessageDeletedForUserInDB(
        canonicalMessageId,
        session.userId,
        {
          senderId: resolvedMessage.sender_id,
          recipientId: resolvedMessage.recipient_id,
          timestamp: resolvedMessage.timestamp,
        },
      );

      if (!persistedInDatabase) {
        return res.status(500).json({
          error: "Failed to persist message visibility update",
          success: false,
          deleted: false,
        });
      }
    } else {
      const tombstoneId = isUuidLike(canonicalMessageId)
        ? canonicalMessageId
        : syntheticMessageId;
      persistedInR2 = await markMessageDeletedForUserInR2(
        tombstoneId,
        session.userId,
        recipientId,
      );
    }

    res.status(200).json({
      success: true,
      deleted: true,
      scope: "self",
      messageId: canonicalMessageId,
      syntheticMessageId,
      recipientId,
      persisted: {
        database: persistedInDatabase,
        r2: persistedInR2,
      },
    });
  } catch (error) {
    console.error("Delete message error:", error);
    return res.status(500).json({ error: "Failed to delete message" });
  }
};

/**
 * PUT /api/messages/conversations/:recipientId/read
 * Mark conversation as read
 */
export const handleMarkConversationAsRead: RequestHandler = async (
  req,
  res,
) => {
  try {
    const sessionToken = req.headers.authorization?.replace("Bearer ", "");
    if (!sessionToken) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const session = await getSessionFromToken(sessionToken);
    if (!session) {
      return res.status(401).json({ error: "Invalid session" });
    }

    const recipientId = await resolveRecipientUserId({
      recipientId: req.params.recipientId,
      usernameParam: req.params.username,
      requesterUserId: session.userId,
    });
    if (!recipientId) {
      return res.status(400).json({ error: "Missing recipientId" });
    }

    // Mark conversation as read in database
    await markConversationAsRead(session.userId, recipientId);
    const seenMessages = await markMessagesSeenInDB(session.userId, recipientId);
    await resetEmailNotificationCounter({
      senderId: recipientId,
      recipientId: session.userId,
    });

    for (const message of seenMessages) {
      notifyMessageStatus(recipientId, {
        messageId: `${message.timestamp}-${message.sender_id}`,
        status: "seen",
        metadata: {
          serverUUID: message.id,
          seenAt: Date.now(),
        },
      });
    }

    return res.status(200).json({
      success: true,
      message: "Conversation marked as read",
    });
  } catch (error) {
    console.error("Mark conversation as read error:", error);
    return res
      .status(500)
      .json({ error: "Failed to mark conversation as read" });
  }
};
