import { WebSocket } from "ws";
import { EncryptedMessage, SessionData } from "@shared/crypto";
import { validateEncryptedMessage } from "./crypto";
import { downloadFromR2, uploadToR2 } from "./r2-storage";
import { markMessageDeliveredInDB } from "./db-messages";
import { resetEmailNotificationCounter } from "./email-notifications";

type QueuedMessage = EncryptedMessage & {
  serverMessageId?: string;
};

type MessageStatusNotification = {
  messageId: string;
  status: "delivered" | "seen";
  metadata?: {
    serverUUID?: string;
    deliveredAt?: number;
    seenAt?: number;
  };
};

export type UserEventPayload =
  | {
      type: "group-message";
      data: Record<string, unknown>;
    }
  | {
      type:
        | "group-message-status"
        | "group-message-deleted"
        | "group-updated"
        | "group-pin-updated"
        | "group-removed"
        | "group-invite"
        | "group-invite-removed"
        | "direct-block-updated";
      data: Record<string, unknown>;
    };

/**
 * Map of userId -> WebSocket connection
 * Enables real-time message routing
 */
const userConnections = new Map<string, Set<WebSocket>>();

/**
 * Message queue for users not currently connected
 * Maps userId -> array of messages
 */
const messageQueues = new Map<string, QueuedMessage[]>();

/**
 * Deletion notification queue for users not currently connected
 * Maps userId -> array of deletion notifications
 */
const deletionQueues = new Map<
  string,
  Array<{
    messageId: string;
    deletedBy: string;
    timestamp: number;
    /** Metadata to help match messages by multiple ID formats */
    metadata?: {
      /** The actual server UUID (if different from messageId) */
      serverUUID?: string;
      /** Original timestamp from message (for ID reconstruction) */
      messageTimestamp?: number;
      /** Sender ID (for ID reconstruction) */
      senderId?: string;
    };
  }>
>();

const messageStatusQueues = new Map<string, MessageStatusNotification[]>();
const userEventQueues = new Map<string, UserEventPayload[]>();

const QUEUE_BUCKET = "voltex-system";
const MESSAGE_QUEUE_KEY = "queues/messages.json";
const DELETION_QUEUE_KEY = "queues/deletions.json";
const MESSAGE_STATUS_QUEUE_KEY = "queues/message-status.json";
const USER_EVENT_QUEUE_KEY = "queues/user-events.json";
let persistQueuesPromise: Promise<void> = Promise.resolve();

async function syncGroupDeliveryEvent(
  recipientUserId: string,
  eventPayload: UserEventPayload,
): Promise<void> {
  if (eventPayload.type !== "group-message") {
    return;
  }

  const groupId =
    typeof eventPayload.data?.groupId === "string"
      ? eventPayload.data.groupId
      : "";
  const messageId =
    typeof (eventPayload.data?.message as Record<string, unknown> | undefined)?.id ===
    "string"
      ? String((eventPayload.data?.message as Record<string, unknown>).id)
      : "";

  if (!groupId || !messageId) {
    return;
  }

  try {
    const { getGroup, markGroupMessageDelivered, summarizeGroupMessageReceipts } =
      await import("./group-store");
    const group = await getGroup(groupId);
    const updated = await markGroupMessageDelivered(groupId, messageId, recipientUserId);
    if (!group || !updated) {
      return;
    }

    notifyUserEvent(updated.senderId, {
      type: "group-message-status",
      data: {
        groupId,
        messageId,
        receipt: summarizeGroupMessageReceipts(
          updated,
          group.members
            .filter((member) => member.status === "active")
            .map((member) => member.userId),
        ),
      },
    });
  } catch (error) {
    console.error("[EVENT] Failed to sync group delivery state:", error);
  }
}

function serializeMessageQueues(): Record<string, QueuedMessage[]> {
  return Object.fromEntries(messageQueues.entries());
}

function serializeMessageStatusQueues(): Record<
  string,
  MessageStatusNotification[]
> {
  return Object.fromEntries(messageStatusQueues.entries());
}

function serializeDeletionQueues(): Record<
  string,
  Array<{
    messageId: string;
    deletedBy: string;
    timestamp: number;
    metadata?: {
      serverUUID?: string;
      messageTimestamp?: number;
      senderId?: string;
    };
  }>
> {
  return Object.fromEntries(deletionQueues.entries());
}

function serializeUserEventQueues(): Record<string, UserEventPayload[]> {
  return Object.fromEntries(userEventQueues.entries());
}

function scheduleQueuePersistence(): void {
  persistQueuesPromise = persistQueuesPromise
    .catch(() => undefined)
    .then(async () => {
      await Promise.all([
        uploadToR2(
          QUEUE_BUCKET,
          MESSAGE_QUEUE_KEY,
          JSON.stringify(serializeMessageQueues()),
        ),
        uploadToR2(
          QUEUE_BUCKET,
          DELETION_QUEUE_KEY,
          JSON.stringify(serializeDeletionQueues()),
        ),
        uploadToR2(
          QUEUE_BUCKET,
          MESSAGE_STATUS_QUEUE_KEY,
          JSON.stringify(serializeMessageStatusQueues()),
        ),
        uploadToR2(
          QUEUE_BUCKET,
          USER_EVENT_QUEUE_KEY,
          JSON.stringify(serializeUserEventQueues()),
        ),
      ]);
    })
    .catch((error) => {
      console.error("[QUEUE] Failed to persist delivery queues:", error);
    });
}

export async function initializeMessagingPersistence(): Promise<void> {
  try {
    const [
      storedMessageQueues,
      storedDeletionQueues,
      storedStatusQueues,
      storedUserEventQueues,
    ] =
      await Promise.all([
        downloadFromR2(QUEUE_BUCKET, MESSAGE_QUEUE_KEY),
        downloadFromR2(QUEUE_BUCKET, DELETION_QUEUE_KEY),
        downloadFromR2(QUEUE_BUCKET, MESSAGE_STATUS_QUEUE_KEY),
        downloadFromR2(QUEUE_BUCKET, USER_EVENT_QUEUE_KEY),
      ]);

    if (storedMessageQueues) {
      const parsed = JSON.parse(storedMessageQueues) as Record<
        string,
        QueuedMessage[]
      >;
      messageQueues.clear();
      for (const [userId, queue] of Object.entries(parsed)) {
        if (Array.isArray(queue) && queue.length > 0) {
          messageQueues.set(userId, queue);
        }
      }
    }

    if (storedDeletionQueues) {
      const parsed = JSON.parse(storedDeletionQueues) as Record<
        string,
        Array<{
          messageId: string;
          deletedBy: string;
          timestamp: number;
          metadata?: {
            serverUUID?: string;
            messageTimestamp?: number;
            senderId?: string;
          };
        }>
      >;
      deletionQueues.clear();
      for (const [userId, queue] of Object.entries(parsed)) {
        if (Array.isArray(queue) && queue.length > 0) {
          deletionQueues.set(userId, queue);
        }
      }
    }

    if (storedStatusQueues) {
      const parsed = JSON.parse(storedStatusQueues) as Record<
        string,
        MessageStatusNotification[]
      >;
      messageStatusQueues.clear();
      for (const [userId, queue] of Object.entries(parsed)) {
        if (Array.isArray(queue) && queue.length > 0) {
          messageStatusQueues.set(userId, queue);
        }
      }
    }

    if (storedUserEventQueues) {
      const parsed = JSON.parse(storedUserEventQueues) as Record<
        string,
        UserEventPayload[]
      >;
      userEventQueues.clear();
      for (const [userId, queue] of Object.entries(parsed)) {
        if (Array.isArray(queue) && queue.length > 0) {
          userEventQueues.set(userId, queue);
        }
      }
    }
  } catch (error) {
    console.error("[QUEUE] Failed to initialize persisted delivery queues:", error);
  }
}

export async function flushMessagingPersistence(): Promise<void> {
  await persistQueuesPromise;
}

export function resetMessagingRuntimeState(): void {
  userConnections.clear();
  messageQueues.clear();
  deletionQueues.clear();
  messageStatusQueues.clear();
  userEventQueues.clear();
  persistQueuesPromise = Promise.resolve();
}

/**
 * Register a user's WebSocket connection
 */
export function registerUserConnection(userId: string, ws: WebSocket): void {
  const existingConnections = userConnections.get(userId);
  if (existingConnections) {
    existingConnections.add(ws);
  } else {
    userConnections.set(userId, new Set([ws]));
  }
  void resetEmailNotificationCounter({ recipientId: userId });
  console.log(
    `[REGISTRY] User ${userId} registered WebSocket connection. Total connected users: ${userConnections.size}, sockets for user: ${userConnections.get(userId)?.size || 0}`,
  );

  // If user has queued messages, send them now
  const queuedMessages = messageQueues.get(userId) || [];
  if (queuedMessages.length > 0) {
    console.log(
      `[REGISTRY] Flushing ${queuedMessages.length} queued messages for ${userId}`,
    );
    queuedMessages.forEach((message) => {
      try {
        ws.send(
          JSON.stringify({
            type: "message",
            data: {
              id: message.serverMessageId,
              nonce: message.nonce,
              ciphertext: message.ciphertext,
              signature: message.signature,
              senderId: message.senderId,
              recipientId: message.recipientId,
              timestamp: message.timestamp,
            },
          }),
        );
        console.log(
          `[REGISTRY] ✓ Delivered queued message from ${message.senderId}`,
        );
        void markDeliveredAndNotifySender(message);
      } catch (error) {
        console.error(
          `[REGISTRY] ✗ Error sending queued message to ${userId}:`,
          error,
        );
      }
    });
    messageQueues.delete(userId);
    scheduleQueuePersistence();
  }

  // If user has queued deletion notifications, send them now
  const queuedDeletions = deletionQueues.get(userId) || [];
  if (queuedDeletions.length > 0) {
    console.log(
      `[REGISTRY] Flushing ${queuedDeletions.length} queued deletion notifications for ${userId}`,
    );
    queuedDeletions.forEach((deletion) => {
      try {
        ws.send(
          JSON.stringify({
            type: "message-deleted",
            data: {
              messageId: deletion.messageId,
              deletedBy: deletion.deletedBy,
              timestamp: deletion.timestamp,
              metadata: deletion.metadata,
            },
          }),
        );
        console.log(
          `[REGISTRY] ✓ Delivered queued deletion notification for message ${deletion.messageId}`,
        );
      } catch (error) {
        console.error(
          `[REGISTRY] ✗ Error sending queued deletion notification to ${userId}:`,
          error,
        );
      }
    });
    deletionQueues.delete(userId);
    scheduleQueuePersistence();
  }

  const queuedStatuses = messageStatusQueues.get(userId) || [];
  if (queuedStatuses.length > 0) {
    console.log(
      `[REGISTRY] Flushing ${queuedStatuses.length} queued message status updates for ${userId}`,
    );
    queuedStatuses.forEach((statusUpdate) => {
      try {
        ws.send(
          JSON.stringify({
            type: "message-status",
            ...statusUpdate,
          }),
        );
      } catch (error) {
        console.error(
          `[REGISTRY] ✗ Error sending queued status notification to ${userId}:`,
          error,
        );
      }
    });
    messageStatusQueues.delete(userId);
    scheduleQueuePersistence();
  }

  const queuedEvents = userEventQueues.get(userId) || [];
  if (queuedEvents.length > 0) {
    queuedEvents.forEach((eventPayload) => {
      try {
        ws.send(JSON.stringify(eventPayload));
        void syncGroupDeliveryEvent(userId, eventPayload);
      } catch (error) {
        console.error(
          `[REGISTRY] ✗ Error sending queued user event to ${userId}:`,
          error,
        );
      }
    });
    userEventQueues.delete(userId);
    scheduleQueuePersistence();
  }
}

/**
 * Unregister a user's WebSocket connection
 */
export function unregisterUserConnection(userId: string, ws?: WebSocket): void {
  if (!ws) {
    userConnections.delete(userId);
    return;
  }

  const existingConnections = userConnections.get(userId);
  if (!existingConnections) {
    return;
  }

  existingConnections.delete(ws);
  if (existingConnections.size === 0) {
    userConnections.delete(userId);
  }
}

function getOpenUserSockets(userId: string): WebSocket[] {
  const sockets = userConnections.get(userId);
  if (!sockets || sockets.size === 0) {
    return [];
  }

  const openSockets: WebSocket[] = [];
  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN) {
      openSockets.push(socket);
      continue;
    }

    if (
      socket.readyState === WebSocket.CLOSING ||
      socket.readyState === WebSocket.CLOSED
    ) {
      sockets.delete(socket);
    }
  }

  if (sockets.size === 0) {
    userConnections.delete(userId);
  }

  return openSockets;
}

/**
 * Send an encrypted message to a user
 * If user is connected, send immediately
 * Otherwise, queue the message
 */
export function deliverMessage(message: QueuedMessage): boolean {
  const recipientId = message.recipientId;
  const recipientSockets = getOpenUserSockets(recipientId);
  const isConnected = recipientSockets.length > 0;

  console.log(
    `[DELIVERY] Attempting to deliver message from ${message.senderId} to ${recipientId}`,
  );
  console.log(
    `[DELIVERY] Recipient connection status: sockets=${recipientSockets.length}, connected=${isConnected}`,
  );
  console.log(
    `[DELIVERY] Current connected users: ${getConnectedUserIds().join(", ") || "(none)"}`,
  );

  if (isConnected) {
    try {
      const payload = JSON.stringify({
        type: "message",
        data: {
          id: message.serverMessageId,
          nonce: message.nonce,
          ciphertext: message.ciphertext,
          signature: message.signature,
          senderId: message.senderId,
          recipientId: message.recipientId,
          timestamp: message.timestamp,
        },
      });
      for (const socket of recipientSockets) {
        socket.send(payload);
      }
      console.log(
        `[DELIVERY] ✓ Message delivered in real-time to ${recipientId} on ${recipientSockets.length} socket(s)`,
      );
      void markDeliveredAndNotifySender(message, false);
      return true;
    } catch (error) {
      console.error(
        `[DELIVERY] ✗ Error sending message to ${recipientId}:`,
        error,
      );
      queueMessage(message);
      return false;
    }
  } else {
    // User not connected, queue message
    console.log(
      `[DELIVERY] ℹ User ${recipientId} not connected, queuing message`,
    );
    queueMessage(message);
    return false;
  }
}

/**
 * Queue a message for later delivery
 * Max 500 messages per user to prevent memory bloat
 */
export function queueMessage(message: QueuedMessage): void {
  const recipientId = message.recipientId;
  if (!messageQueues.has(recipientId)) {
    messageQueues.set(recipientId, []);
  }

  const queue = messageQueues.get(recipientId)!;
  const MAX_QUEUE_SIZE = 500; // Reduced from 1000 for better memory management

  // Limit queue size to prevent memory issues
  if (queue.length < MAX_QUEUE_SIZE) {
    queue.push(message);
    console.log(
      `[QUEUE] Message queued for ${recipientId}. Queue size: ${queue.length}/${MAX_QUEUE_SIZE}`,
    );
  } else {
    // Drop oldest message and add new one (FIFO overflow)
    queue.shift();
    queue.push(message);
    console.warn(
      `[QUEUE] Message queue for ${recipientId} full (${MAX_QUEUE_SIZE}), dropped oldest message to make space`,
    );
  }

  scheduleQueuePersistence();
}

export function getQueuedDirectMessageCount(
  senderId: string,
  recipientId: string,
): number {
  const queue = messageQueues.get(recipientId);
  if (!queue || queue.length === 0) {
    return 0;
  }

  return queue.reduce((count, message) => {
    if (message.senderId === senderId && message.recipientId === recipientId) {
      return count + 1;
    }
    return count;
  }, 0);
}

/**
 * Get queue statistics for monitoring
 */
export function getQueueStats(): {
  totalQueuedMessages: number;
  usersWithQueuedMessages: number;
} {
  let totalQueuedMessages = 0;
  for (const queue of messageQueues.values()) {
    totalQueuedMessages += queue.length;
  }

  return {
    totalQueuedMessages,
    usersWithQueuedMessages: messageQueues.size,
  };
}

/**
 * Get all queued messages for a user
 * Used for message syncing
 */
export function getQueuedMessages(userId: string): QueuedMessage[] {
  const messages = messageQueues.get(userId) || [];
  messageQueues.delete(userId);
  scheduleQueuePersistence();
  return messages;
}

function queueUserEvent(userId: string, eventPayload: UserEventPayload): void {
  if (!userEventQueues.has(userId)) {
    userEventQueues.set(userId, []);
  }

  const queue = userEventQueues.get(userId)!;
  const MAX_QUEUE_SIZE = 500;
  if (queue.length >= MAX_QUEUE_SIZE) {
    queue.shift();
  }
  queue.push(eventPayload);
  scheduleQueuePersistence();
}

function queueMessageStatus(
  userId: string,
  statusNotification: MessageStatusNotification,
): void {
  if (!messageStatusQueues.has(userId)) {
    messageStatusQueues.set(userId, []);
  }

  const queue = messageStatusQueues.get(userId)!;
  const MAX_QUEUE_SIZE = 500;

  if (queue.length >= MAX_QUEUE_SIZE) {
    queue.shift();
  }

  queue.push(statusNotification);
  scheduleQueuePersistence();
}

export function notifyMessageStatus(
  userId: string,
  statusNotification: MessageStatusNotification,
): boolean {
  const recipientSockets = getOpenUserSockets(userId);
  const isConnected = recipientSockets.length > 0;

  if (isConnected) {
    try {
      const payload = JSON.stringify({
        type: "message-status",
        ...statusNotification,
      });
      for (const socket of recipientSockets) {
        socket.send(payload);
      }
      return true;
    } catch (error) {
      console.error(
        `[STATUS] Failed to send status update to ${userId}, queueing:`,
        error,
      );
    }
  }

  queueMessageStatus(userId, statusNotification);
  return false;
}

export function notifyUserEvent(
  userId: string,
  eventPayload: UserEventPayload,
): boolean {
  const sockets = getOpenUserSockets(userId);
  if (sockets.length > 0) {
    try {
      const payload = JSON.stringify(eventPayload);
      for (const socket of sockets) {
        socket.send(payload);
      }
      void syncGroupDeliveryEvent(userId, eventPayload);
      return true;
    } catch (error) {
      console.error(`[EVENT] Failed to send event to ${userId}, queueing:`, error);
    }
  }

  queueUserEvent(userId, eventPayload);
  return false;
}

async function markDeliveredAndNotifySender(
  message: QueuedMessage,
  notifySender: boolean = true,
): Promise<void> {
  const deliveredAt = Date.now();

  try {
    await markMessageDeliveredInDB({
      messageId: message.serverMessageId,
      senderId: message.senderId,
      recipientId: message.recipientId,
      timestamp: message.timestamp,
      deliveredAt,
    });
  } catch (error) {
    console.error("[STATUS] Failed to persist delivered status:", error);
  }

  if (!notifySender) {
    return;
  }

  notifyMessageStatus(message.senderId, {
    messageId: `${message.timestamp}-${message.senderId}`,
    status: "delivered",
    metadata: {
      serverUUID: message.serverMessageId,
      deliveredAt,
    },
  });
}

/**
 * Get number of connected users
 */
export function getConnectedUserCount(): number {
  return userConnections.size;
}

/**
 * Get connection status for a user
 */
export function isUserConnected(userId: string): boolean {
  return getOpenUserSockets(userId).length > 0;
}

/**
 * Broadcast a message to all connected users
 * Used for notifications, user status updates, etc.
 */
export function broadcastToAll(message: any): void {
  const payload = JSON.stringify(message);
  userConnections.forEach((sockets) => {
    sockets.forEach((socket) => {
      if (socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(payload);
        } catch (error) {
          console.error("Error broadcasting message:", error);
        }
      }
    });
  });
}

/**
 * Close all connections and clear state
 */
export function closeAllConnections(): void {
  userConnections.forEach((sockets) => {
    sockets.forEach((socket) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.close();
      }
    });
  });
  userConnections.clear();
}

/**
 * Get all connected user IDs
 */
export function getConnectedUserIds(): string[] {
  return Array.from(userConnections.keys());
}

export function disconnectUserConnections(userId: string): void {
  const sockets = userConnections.get(userId);
  if (!sockets || sockets.size === 0) {
    return;
  }

  for (const socket of sockets) {
    try {
      if (socket.readyState === WebSocket.OPEN) {
        socket.close(4003, "Account banned");
      }
    } catch (error) {
      console.error(`[REGISTRY] Failed to close socket for ${userId}:`, error);
    }
  }

  userConnections.delete(userId);
}

/**
 * Notify a user about message deletion (with guaranteed delivery)
 * This ensures the recipient sees the deletion instantly:
 * - If online: sends immediately via WebSocket
 * - If offline: queues and delivers on reconnect
 * - If WebSocket send fails: queues for retry on reconnect
 *
 * This matches WhatsApp/Telegram/Signal behavior where deletion
 * is delivered reliably to all parties involved
 *
 * @param metadata Optional metadata to help match messages by multiple ID formats
 */
export function notifyMessageDeletion(
  recipientId: string,
  messageId: string,
  deletedBy: string,
  metadata?: {
    /** The actual server UUID (if different from messageId) */
    serverUUID?: string;
    /** Original timestamp from message (for ID reconstruction) */
    messageTimestamp?: number;
    /** Sender ID (for ID reconstruction) */
    senderId?: string;
  },
): boolean {
  const recipientSockets = getOpenUserSockets(recipientId);
  const isConnected = recipientSockets.length > 0;
  const timestamp = Date.now();

  console.log(
    `[DELETION-NOTIFY] Notifying ${recipientId} about message deletion (deleted by: ${deletedBy})`,
  );
  console.log(
    `[DELETION-NOTIFY] Connection status: sockets=${recipientSockets.length}, connected=${isConnected}`,
  );
  if (metadata) {
    console.log(
      `[DELETION-NOTIFY] Metadata: serverUUID=${metadata.serverUUID}, timestamp=${metadata.messageTimestamp}, senderId=${metadata.senderId}`,
    );
  }

  // ATTEMPT 1: Send immediately if user is connected
  if (isConnected) {
    try {
      const notificationPayload = JSON.stringify({
        type: "message-deleted",
        data: {
          messageId,
          deletedBy,
          timestamp,
          metadata,
        },
      });

      for (const socket of recipientSockets) {
        socket.send(notificationPayload);
      }
      console.log(
        `[DELETION-NOTIFY] ✓ Deletion notification sent immediately to ${recipientId} on ${recipientSockets.length} socket(s)`,
      );
      return true; // Success - recipient received instantly
    } catch (sendError) {
      console.error(
        `[DELETION-NOTIFY] ✗ WebSocket send error for ${recipientId}:`,
        sendError,
      );
      // Send failed, queue it for retry on reconnect
      console.log(
        `[DELETION-NOTIFY] ℹ Queueing notification due to send failure`,
      );
      queueDeletionNotification(
        recipientId,
        messageId,
        deletedBy,
        timestamp,
        metadata,
      );
      return false; // Will be delivered on reconnect
    }
  }

  // ATTEMPT 2: User is offline - queue for delivery on reconnect
  console.log(
    `[DELETION-NOTIFY] ℹ User ${recipientId} offline - queueing deletion notification for reconnect`,
  );
  queueDeletionNotification(
    recipientId,
    messageId,
    deletedBy,
    timestamp,
    metadata,
  );
  return false; // Queued for delivery on reconnect
}

/**
 * Queue a deletion notification for a user who is not currently connected
 * Will be delivered when user reconnects
 * Max 500 notifications per user to prevent memory bloat
 */
function queueDeletionNotification(
  userId: string,
  messageId: string,
  deletedBy: string,
  timestamp: number,
  metadata?: {
    serverUUID?: string;
    messageTimestamp?: number;
    senderId?: string;
  },
): void {
  if (!deletionQueues.has(userId)) {
    deletionQueues.set(userId, []);
  }

  const queue = deletionQueues.get(userId)!;
  const MAX_QUEUE_SIZE = 500;

  // Limit queue size to prevent memory issues
  if (queue.length < MAX_QUEUE_SIZE) {
    queue.push({ messageId, deletedBy, timestamp, metadata });
    console.log(
      `[QUEUE] Deletion notification queued for ${userId}. Queue size: ${queue.length}/${MAX_QUEUE_SIZE}`,
    );
  } else {
    // Drop oldest notification and add new one (FIFO overflow)
    queue.shift();
    queue.push({ messageId, deletedBy, timestamp, metadata });
    console.warn(
      `[QUEUE] Deletion queue for ${userId} full (${MAX_QUEUE_SIZE}), dropped oldest notification to make space`,
    );
  }

  scheduleQueuePersistence();
}
