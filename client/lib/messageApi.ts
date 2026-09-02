/**
 * Client-side utility functions for message API calls
 * All messages are encrypted on client before sending to server
 */

import { EncryptedMessage } from "@shared/crypto";

/**
 * Send an encrypted message to the server
 * Message is already encrypted on client before this call
 */
export async function sendEncryptedMessage(
  recipientId: string,
  nonce: string,
  ciphertext: string,
  signature: string,
  timestamp: number,
  sessionToken: string,
): Promise<{ success: boolean; messageId: string; timestamp: number }> {
  const response = await fetch("/api/messages/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sessionToken}`,
    },
    body: JSON.stringify({
      recipientId,
      nonce,
      ciphertext,
      signature,
      timestamp,
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to send message");
  }

  return response.json();
}

/**
 * Get conversation history with a specific user
 * Messages are returned encrypted - client must decrypt them
 */
export async function getConversationHistory(
  recipientUsername: string,
  sessionToken: string,
  limit: number = 50,
  offset: number = 0,
): Promise<{
  recipientId: string;
  messages: EncryptedMessage[];
  total: number;
  limit: number;
  offset: number;
}> {
  const url = new URL(
    `/api/messages/conversation/by-username/${recipientUsername}`,
    window.location.origin,
  );
  url.searchParams.set("limit", limit.toString());
  url.searchParams.set("offset", offset.toString());

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${sessionToken}`,
    },
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to load conversation");
  }

  return response.json();
}

/**
 * Get list of all conversations
 * Returns metadata about conversations (last message, timestamp)
 * Messages themselves are encrypted and not included here
 */
export async function getConversations(sessionToken: string): Promise<{
  conversations: Array<{
    userId: string;
    lastMessage: string;
    timestamp: number;
  }>;
  count: number;
}> {
  const response = await fetch("/api/messages/conversations", {
    headers: {
      Authorization: `Bearer ${sessionToken}`,
    },
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to load conversations");
  }

  return response.json();
}

/**
 * Delete a conversation and all its messages
 * This is permanent and cannot be undone
 */
export async function deleteConversation(
  recipientUsername: string,
  sessionToken: string,
): Promise<{ success: boolean; deleted: boolean }> {
  const response = await fetch(
    `/api/messages/conversation/by-username/${recipientUsername}`,
    {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${sessionToken}`,
    },
    },
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to delete conversation");
  }

  return response.json();
}

/**
 * Get a user's public key for encryption
 * This is a public endpoint - no authentication required
 */
export async function getPublicKey(username: string): Promise<{
  publicKey: string;
}> {
  const response = await fetch(`/api/auth/public-key/by-username/${username}`);

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "User not found");
  }

  return response.json();
}

/**
 * Load more messages from a conversation (pagination)
 * Useful for loading older messages as user scrolls up
 */
export async function loadMoreMessages(
  recipientUsername: string,
  sessionToken: string,
  offset: number,
): Promise<EncryptedMessage[]> {
  const data = await getConversationHistory(
    recipientUsername,
    sessionToken,
    50,
    offset,
  );
  return data.messages;
}
