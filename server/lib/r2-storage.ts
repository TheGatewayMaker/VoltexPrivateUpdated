import fs from "fs/promises";
import path from "path";
import { enqueueBackupDelete, enqueueBackupPut } from "./cloud-backup";
import { storageDir, storageRoot } from "./storage-paths";

function encodeKeyForFilesystem(key: string): string {
  return key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join(path.sep);
}

function decodeFilesystemKeySegment(segment: string): string {
  return decodeURIComponent(segment);
}

function resolveStoragePath(bucketName: string, key: string = ""): string {
  const bucketRoot = path.resolve(storageRoot, bucketName);
  const targetPath = path.resolve(bucketRoot, encodeKeyForFilesystem(key));

  if (
    targetPath !== bucketRoot &&
    !targetPath.startsWith(`${bucketRoot}${path.sep}`)
  ) {
    throw new Error(`Invalid storage key: ${key}`);
  }

  return targetPath;
}

async function ensureParentDirectory(filePath: string): Promise<void> {
  await fs.mkdir(storageRoot, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
}

async function fsyncDirectory(directoryPath: string): Promise<void> {
  const handle = await fs.open(directoryPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const data = await fs.readFile(filePath, "utf8");
    return JSON.parse(data) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function listFilesRecursive(directoryPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    const files = await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(directoryPath, entry.name);
        return entry.isDirectory() ? listFilesRecursive(fullPath) : [fullPath];
      }),
    );

    return files.flat();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function listConversationMessages(
  conversationKey: string,
): Promise<any[]> {
  const conversationDir = resolveStoragePath(
    "voltex-messages",
    `conversations/${conversationKey}`,
  );
  const files = await listFilesRecursive(conversationDir);
  const messages = await Promise.all(
    files
      .filter((filePath) => filePath.endsWith(".json"))
      .map((filePath) => readJsonFile<any>(filePath)),
  );

  return messages
    .filter((message): message is any => !!message)
    .filter(
      (message) =>
        typeof message.messageId === "string" &&
        typeof message.timestamp === "number" &&
        typeof message.nonce === "string" &&
        typeof message.ciphertext === "string" &&
        typeof message.signature === "string",
    );
}

function getMessageDeletionKey(userId: string, conversationKey: string): string {
  return `message-deletions/${userId}/${conversationKey}.json`;
}

async function readDeletedMessageIndex(
  userId: string,
  conversationKey: string,
): Promise<{ messageIds: string[] } | null> {
  return readJsonFile<{ messageIds?: string[] }>(
    resolveStoragePath(
      "voltex-system",
      getMessageDeletionKey(userId, conversationKey),
    ),
  ).then((data) =>
    data
      ? {
          messageIds: Array.isArray(data.messageIds)
            ? data.messageIds.filter((value): value is string => typeof value === "string")
            : [],
        }
      : null,
  );
}

export function getLocalStorageRoot(): string {
  return storageDir.replace(/\\/g, "/");
}

export async function uploadToR2(
  bucketName: string,
  key: string,
  data: string | Buffer,
  _contentType: string = "application/json",
): Promise<void> {
  const filePath = resolveStoragePath(bucketName, key);
  const directoryPath = path.dirname(filePath);
  await ensureParentDirectory(filePath);

  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const handle = await fs.open(tempPath, "w", 0o600);

  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }

  await fs.rename(tempPath, filePath);
  await fsyncDirectory(directoryPath);
  await enqueueBackupPut(bucketName, key, data, _contentType);
}

export async function downloadFromR2(
  bucketName: string,
  key: string,
): Promise<string | null> {
  try {
    const filePath = resolveStoragePath(bucketName, key);
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function deleteFromR2(
  bucketName: string,
  key: string,
): Promise<void> {
  try {
    const filePath = resolveStoragePath(bucketName, key);
    await fs.unlink(filePath);
    await enqueueBackupDelete(bucketName, key);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
}

export async function fileExistsInR2(
  bucketName: string,
  key: string,
): Promise<boolean> {
  try {
    const filePath = resolveStoragePath(bucketName, key);
    await fs.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function saveUserProfile(
  userId: string,
  profileData: any,
): Promise<void> {
  await uploadToR2(
    "voltex-users",
    `profiles/${userId}.json`,
    JSON.stringify({
      ...profileData,
      updatedAt: Date.now(),
    }),
  );
}

export async function getUserProfile(userId: string): Promise<any | null> {
  return readJsonFile<any>(resolveStoragePath("voltex-users", `profiles/${userId}.json`));
}

export async function saveMessage(
  messageId: string,
  messageData: any,
): Promise<void> {
  await uploadToR2(
    "voltex-messages",
    `messages/${messageId}.json`,
    JSON.stringify({
      ...messageData,
      savedAt: Date.now(),
    }),
  );
}

export async function getMessage(messageId: string): Promise<any | null> {
  return readJsonFile<any>(
    resolveStoragePath("voltex-messages", `messages/${messageId}.json`),
  );
}

export async function checkUsernameAvailability(
  username: string,
): Promise<boolean> {
  const normalized = username.toLowerCase();
  return !(await fileExistsInR2(
    "voltex-users",
    `usernames/${normalized}.json`,
  ));
}

export async function reserveUsername(
  username: string,
  userId: string,
): Promise<void> {
  const normalized = username.toLowerCase();
  await uploadToR2(
    "voltex-users",
    `usernames/${normalized}.json`,
    JSON.stringify({
      username: normalized,
      userId,
      createdAt: Date.now(),
    }),
  );
}

export async function getUserIdByUsername(
  username: string,
): Promise<string | null> {
  const data = await readJsonFile<{ userId?: string }>(
    resolveStoragePath("voltex-users", `usernames/${username.toLowerCase()}.json`),
  );
  return data?.userId || null;
}

export async function listReservedUsernames(): Promise<
  Array<{ username: string; userId: string }>
> {
  const root = resolveStoragePath("voltex-users", "usernames");
  const files = await listFilesRecursive(root);
  const records = await Promise.all(
    files
      .filter((filePath) => filePath.endsWith(".json"))
      .map((filePath) =>
        readJsonFile<{ username?: string; userId?: string }>(filePath),
      ),
  );

  return records
    .filter(
      (record): record is { username: string; userId: string } =>
        !!record &&
        typeof record.username === "string" &&
        record.username.length > 0 &&
        typeof record.userId === "string" &&
        record.userId.length > 0,
    )
    .map((record) => ({
      username: record.username.toLowerCase(),
      userId: record.userId,
    }));
}

export async function saveUserAccount(
  userId: string,
  accountData: any,
): Promise<void> {
  await uploadToR2(
    "voltex-users",
    `accounts/${userId}.json`,
    JSON.stringify({
      ...accountData,
      updatedAt: Date.now(),
    }),
  );
}

export async function getUserAccount(userId: string): Promise<any | null> {
  return readJsonFile<any>(
    resolveStoragePath("voltex-users", `accounts/${userId}.json`),
  );
}

export async function savePassphraseRecovery(
  userId: string,
  recoveryData:
    | string
    | {
        verifier?: string;
        salt?: string;
        iterations?: number;
        legacyHash?: string;
      },
): Promise<void> {
  const payload =
    typeof recoveryData === "string"
      ? {
          userId,
          passphraseHash: recoveryData,
          createdAt: Date.now(),
        }
      : {
          userId,
          verifier: recoveryData.verifier || null,
          salt: recoveryData.salt || null,
          iterations: recoveryData.iterations || null,
          legacyHash: recoveryData.legacyHash || null,
          createdAt: Date.now(),
        };

  await uploadToR2(
    "voltex-recovery",
    `${userId}/passphrase.json`,
    JSON.stringify(payload),
  );
}

export async function getPassphraseRecovery(
  userId: string,
): Promise<any | null> {
  return readJsonFile<any>(
    resolveStoragePath("voltex-recovery", `${userId}/passphrase.json`),
  );
}

export async function saveMessageWithMetadata(
  messageId: string,
  senderId: string,
  recipientId: string,
  messageData: any,
): Promise<void> {
  if (!messageId || !senderId || !recipientId) {
    throw new Error("Message metadata is incomplete");
  }

  const conversationKey = [senderId, recipientId].sort().join(":");
  await uploadToR2(
    "voltex-messages",
    `conversations/${conversationKey}/${messageId}.json`,
    JSON.stringify({
      messageId,
      senderId,
      recipientId,
      timestamp: messageData.timestamp,
      nonce: messageData.nonce,
      ciphertext: messageData.ciphertext,
      signature: messageData.signature,
      createdAt: Date.now(),
    }),
  );
}

export async function getConversationMessages(
  userId1: string,
  userId2: string,
  limit: number = 50,
  offset: number = 0,
): Promise<any[]> {
  const conversationKey = [userId1, userId2].sort().join(":");
  const messages = await listConversationMessages(conversationKey);

  return messages
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(offset, offset + limit)
    .map((message) => ({
      id: message.messageId,
      nonce: message.nonce,
      ciphertext: message.ciphertext,
      signature: message.signature,
      senderId: message.senderId,
      recipientId: message.recipientId,
      timestamp: message.timestamp,
    }));
}

export async function getConversationMessageById(
  userId1: string,
  userId2: string,
  messageId: string,
): Promise<any | null> {
  const conversationKey = [userId1, userId2].sort().join(":");
  const messages = await listConversationMessages(conversationKey);
  return messages.find((message) => message.messageId === messageId) || null;
}

export async function getAllConversationMessages(
  userId1: string,
  userId2: string,
): Promise<any[]> {
  const conversationKey = [userId1, userId2].sort().join(":");
  return listConversationMessages(conversationKey);
}

export async function getDeletedMessageIdsForUser(
  userId: string,
  otherUserId: string,
): Promise<Set<string>> {
  const conversationKey = [userId, otherUserId].sort().join(":");
  const deletedIndex = await readDeletedMessageIndex(userId, conversationKey);
  return new Set(deletedIndex?.messageIds || []);
}

export async function markMessageDeletedForUserInR2(
  messageId: string,
  userId: string,
  otherUserId: string,
): Promise<boolean> {
  const conversationKey = [userId, otherUserId].sort().join(":");
  const existing = await getDeletedMessageIdsForUser(userId, otherUserId);
  existing.add(messageId);

  await uploadToR2(
    "voltex-system",
    getMessageDeletionKey(userId, conversationKey),
    JSON.stringify({
      userId,
      conversationKey,
      messageIds: Array.from(existing).sort(),
      updatedAt: Date.now(),
    }),
  );

  return true;
}

export async function deleteMessageForEveryoneInR2(
  messageId: string,
  userId1: string,
  userId2: string,
): Promise<void> {
  const conversationKey = [userId1, userId2].sort().join(":");
  await deleteFromR2(
    "voltex-messages",
    `conversations/${conversationKey}/${messageId}.json`,
  );
}

export async function getUserConversationsFromR2(
  userId: string,
): Promise<Map<string, { lastMessage: any; timestamp: number }>> {
  const conversations = new Map<string, { lastMessage: any; timestamp: number }>();
  const conversationsRoot = resolveStoragePath("voltex-messages", "conversations");

  try {
    const entries = await fs.readdir(conversationsRoot, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const conversationKey = decodeFilesystemKeySegment(entry.name);
      const [user1, user2] = conversationKey.split(":");
      if (user1 !== userId && user2 !== userId) continue;

      const messages = await listConversationMessages(conversationKey);
      if (messages.length === 0) continue;

      const otherUserId = user1 === userId ? user2 : user1;
      const deletedMessageIds = await getDeletedMessageIdsForUser(
        userId,
        otherUserId,
      );
      const lastMessage = messages
        .sort((a, b) => b.timestamp - a.timestamp)
        .find((message) => !deletedMessageIds.has(message.messageId));

      if (!lastMessage) {
        continue;
      }

      conversations.set(otherUserId, {
        lastMessage,
        timestamp: lastMessage.timestamp,
      });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  return conversations;
}

export async function saveEncryptedKeypair(
  userId: string,
  encryptedData: string,
  salt: string,
  iv: string,
): Promise<void> {
  await uploadToR2(
    "voltex-recovery",
    `${userId}/keypair.json`,
    JSON.stringify({
      userId,
      encryptedData,
      salt,
      iv,
      createdAt: Date.now(),
    }),
  );
}

export async function getEncryptedKeypair(
  userId: string,
): Promise<{ encryptedData: string; salt: string; iv: string } | null> {
  const data = await readJsonFile<{
    encryptedData: string;
    salt: string;
    iv: string;
  }>(resolveStoragePath("voltex-recovery", `${userId}/keypair.json`));

  if (!data) return null;

  return {
    encryptedData: data.encryptedData,
    salt: data.salt,
    iv: data.iv,
  };
}

export async function saveSession(
  sessionToken: string,
  sessionData: any,
): Promise<void> {
  const createdAt =
    typeof sessionData?.createdAt === "number" ? sessionData.createdAt : Date.now();
  const lastSeenAt =
    typeof sessionData?.lastSeenAt === "number"
      ? sessionData.lastSeenAt
      : createdAt;
  await uploadToR2(
    "voltex-users",
    `sessions/${sessionToken}.json`,
    JSON.stringify({
      ...sessionData,
      createdAt,
      lastSeenAt,
    }),
  );
}

export async function getSessionData(
  sessionToken: string,
): Promise<any | null> {
  return readJsonFile<any>(
    resolveStoragePath("voltex-users", `sessions/${sessionToken}.json`),
  );
}

export async function deleteSessionData(sessionToken: string): Promise<void> {
  await deleteFromR2("voltex-users", `sessions/${sessionToken}.json`);
}

export async function saveMessageArchiveToR2(
  archiveKey: string,
  messages: any[],
): Promise<void> {
  await uploadToR2(
    "voltex-messages",
    archiveKey,
    JSON.stringify({
      messages,
      archivedAt: Date.now(),
      messageCount: messages.length,
    }),
  );
}

export async function deleteArchivedMessagesFromR2(
  archiveKey: string,
): Promise<void> {
  await deleteFromR2("voltex-messages", archiveKey);
}
