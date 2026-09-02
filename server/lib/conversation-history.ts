import { EncryptedMessage } from "@shared/crypto";

/**
 * Shared conversation history module
 * Used by both WebSocket and HTTP routes to ensure messages are stored consistently
 * Structure: { "senderId:recipientId": [messages] }
 */
const conversationHistory = new Map<string, EncryptedMessage[]>();

/**
 * Helper: Get conversation key (ordered to support bidirectional chats)
 */
export function getConversationKey(userId1: string, userId2: string): string {
  const sorted = [userId1, userId2].sort();
  return `${sorted[0]}:${sorted[1]}`;
}

/**
 * Store a message in conversation history
 */
export function storeMessage(
  senderId: string,
  recipientId: string,
  message: EncryptedMessage,
): void {
  const conversationKey = getConversationKey(senderId, recipientId);

  if (!conversationHistory.has(conversationKey)) {
    conversationHistory.set(conversationKey, []);
  }

  const messages = conversationHistory.get(conversationKey)!;

  // CRITICAL FIX: Prevent duplicate messages from being stored in memory
  // Check if a message with the same timestamp and sender already exists
  // This prevents duplicates when the same message is received via multiple paths
  // (e.g., stored via WebSocket and then fetched via HTTP)
  const messageId = `${message.timestamp}-${message.senderId}`;
  const isDuplicate = messages.some(
    (m) => `${m.timestamp}-${m.senderId}` === messageId,
  );

  if (!isDuplicate) {
    messages.push(message);
  } else {
    console.log(
      `[MEMORY] Skipping duplicate message ${messageId} in conversation ${conversationKey}`,
    );
  }

  // Keep only last 100 messages per conversation in memory
  // Messages are persisted in PostgreSQL/R2, so this is just for real-time delivery
  if (messages.length > 100) {
    messages.splice(0, messages.length - 100);
  }
}

/**
 * Cleanup older messages from memory after they're persisted
 * Keeps only the most recent N messages for real-time delivery
 */
export function cleanupMessagesAfterPersist(
  userId1: string,
  userId2: string,
  maxMessagesInMemory: number = 50,
): void {
  const conversationKey = getConversationKey(userId1, userId2);
  const messages = conversationHistory.get(conversationKey);

  if (messages && messages.length > maxMessagesInMemory) {
    // Remove oldest messages, keep only recent ones
    messages.splice(0, messages.length - maxMessagesInMemory);
  }
}

/**
 * Get messages for a conversation
 */
export function getConversationMessages(
  userId1: string,
  userId2: string,
): EncryptedMessage[] {
  const conversationKey = getConversationKey(userId1, userId2);
  return conversationHistory.get(conversationKey) || [];
}

/**
 * Delete a specific message from conversation history
 */
export function deleteMessage(
  userId1: string,
  userId2: string,
  messageId: string,
): void {
  const conversationKey = getConversationKey(userId1, userId2);
  const messages = conversationHistory.get(conversationKey);

  if (messages) {
    const filtered = messages.filter(
      (m) => `${m.timestamp}-${m.senderId}` !== messageId,
    );
    conversationHistory.set(conversationKey, filtered);
  }
}

/**
 * Delete all messages in a conversation
 */
export function deleteConversation(userId1: string, userId2: string): void {
  const conversationKey = getConversationKey(userId1, userId2);
  conversationHistory.delete(conversationKey);
}

/**
 * Get all conversations for a user (returns map of userId -> lastMessage)
 */
export function getUserConversations(
  userId: string,
): Map<string, { lastMessage: EncryptedMessage; timestamp: number }> {
  const conversations = new Map<
    string,
    { lastMessage: EncryptedMessage; timestamp: number }
  >();

  for (const [conversationKey, messages] of conversationHistory.entries()) {
    const [user1, user2] = conversationKey.split(":");
    const otherUserId = user1 === userId ? user2 : user1;

    if (user1 === userId || user2 === userId) {
      if (messages.length > 0) {
        const lastMessage = messages[messages.length - 1];
        conversations.set(otherUserId, {
          lastMessage,
          timestamp: lastMessage.timestamp,
        });
      }
    }
  }

  return conversations;
}

/**
 * Get all stored conversations (for debugging/admin)
 */
export function getAllConversations(): Map<string, EncryptedMessage[]> {
  return new Map(conversationHistory);
}

/**
 * Clear all conversation history (for testing)
 */
export function clearAll(): void {
  conversationHistory.clear();
}
