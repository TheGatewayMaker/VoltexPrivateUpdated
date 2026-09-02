import fs from "fs/promises";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import {
  GroupConversationSummary,
  GroupInviteRecord,
  GroupMember,
  GroupMemberRole,
  GroupMessageReceiptSummary,
  GroupRecord,
  GroupStoredMessage,
} from "@shared/groups";
import { storageRoot } from "./storage-paths";

const groupsRoot = path.join(storageRoot, "voltex-groups");
const groupDir = path.join(groupsRoot, "groups");
const messageDir = path.join(groupsRoot, "messages");
const hiddenDir = path.join(groupsRoot, "hidden");
const inviteDir = path.join(groupsRoot, "invites");
const readStateDir = path.join(groupsRoot, "reads");

const locks = new Map<string, Promise<void>>();

function groupPath(groupId: string): string {
  return path.join(groupDir, `${groupId}.json`);
}

function groupMessagesPath(groupId: string): string {
  return path.join(messageDir, groupId);
}

function invitePath(inviteId: string): string {
  return path.join(inviteDir, `${inviteId}.json`);
}

function hiddenPath(userId: string, groupId: string): string {
  return path.join(hiddenDir, userId, `${groupId}.json`);
}

function readStatePath(userId: string, groupId: string): string {
  return path.join(readStateDir, userId, `${groupId}.json`);
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${uuidv4()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tempPath, filePath);
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function listJsonFiles(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(dirPath, entry.name));
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function listDirectories(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dirPath, entry.name));
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) || Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(key, previous.catch(() => undefined).then(() => next));

  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (locks.get(key) === next) {
      locks.delete(key);
    }
  }
}

function getMember(group: GroupRecord, userId: string): GroupMember | undefined {
  return group.members.find((member) => member.userId === userId);
}

function isActiveMember(group: GroupRecord, userId: string): boolean {
  return getMember(group, userId)?.status === "active";
}

function sortMessages(messages: GroupStoredMessage[]): GroupStoredMessage[] {
  return [...messages].sort((a, b) => a.timestamp - b.timestamp);
}

export async function initializeGroupStore(): Promise<void> {
  await Promise.all([
    ensureDir(groupDir),
    ensureDir(messageDir),
    ensureDir(hiddenDir),
    ensureDir(inviteDir),
    ensureDir(readStateDir),
  ]);
}

export async function createGroup(params: {
  creatorId: string;
  name: string;
  bio?: string;
  avatar?: string | null;
}): Promise<GroupRecord> {
  const now = Date.now();
  const group: GroupRecord = {
    id: uuidv4(),
    name: params.name.trim(),
    bio: params.bio?.trim() || "",
    avatar: params.avatar || null,
    createdBy: params.creatorId,
    createdAt: now,
    updatedAt: now,
    members: [
      {
        userId: params.creatorId,
        role: "admin",
        status: "active",
        joinedAt: now,
        addedBy: params.creatorId,
        updatedAt: now,
      },
    ],
  };

  await writeJsonAtomic(groupPath(group.id), group);
  return group;
}

export async function listAllGroups(): Promise<GroupRecord[]> {
  const files = await listJsonFiles(groupDir);
  const groups = await Promise.all(files.map((filePath) => readJsonFile<GroupRecord>(filePath)));
  return groups.filter(Boolean) as GroupRecord[];
}

export async function getGroup(groupId: string): Promise<GroupRecord | null> {
  return readJsonFile<GroupRecord>(groupPath(groupId));
}

export async function saveGroup(group: GroupRecord): Promise<void> {
  group.updatedAt = Date.now();
  await writeJsonAtomic(groupPath(group.id), group);
}

export async function requireGroupMember(
  groupId: string,
  userId: string,
): Promise<{ group: GroupRecord; member: GroupMember }> {
  const group = await getGroup(groupId);
  if (!group) {
    throw new Error("Group not found");
  }

  const member = getMember(group, userId);
  if (!member || member.status !== "active") {
    throw new Error("You are not an active member of this group");
  }

  return { group, member };
}

export async function updateGroupMetadata(
  groupId: string,
  actorId: string,
  updates: { name?: string; bio?: string; avatar?: string | null },
): Promise<GroupRecord> {
  return withLock(`group:${groupId}`, async () => {
    const { group, member } = await requireGroupMember(groupId, actorId);
    if (member.role !== "admin") {
      throw new Error("Admin access required");
    }

    if (typeof updates.name === "string") {
      group.name = updates.name.trim();
    }
    if (typeof updates.bio === "string") {
      group.bio = updates.bio.trim();
    }
    if (updates.avatar !== undefined) {
      group.avatar = updates.avatar;
    }

    await saveGroup(group);
    return group;
  });
}

export async function pinGroupMessage(params: {
  groupId: string;
  actorId: string;
  messageId: string;
}): Promise<GroupRecord> {
  return withLock(`group:${params.groupId}`, async () => {
    const { group, member } = await requireGroupMember(params.groupId, params.actorId);
    if (member.role !== "admin") {
      throw new Error("Admin access required");
    }

    const message = await getGroupMessage(params.groupId, params.messageId);
    if (!message || message.deletedForEveryone) {
      throw new Error("Message not found");
    }
    if (!message.envelopes[params.actorId]) {
      throw new Error("Cannot pin an inaccessible message");
    }

    group.pinnedMessageId = message.id;
    group.pinnedMessageBy = params.actorId;
    group.pinnedMessageAt = Date.now();
    await saveGroup(group);
    return group;
  });
}

export async function sendGroupInvite(params: {
  groupId: string;
  inviterId: string;
  invitedUserId: string;
}): Promise<GroupInviteRecord> {
  return withLock(`group:${params.groupId}`, async () => {
    const { group, member } = await requireGroupMember(params.groupId, params.inviterId);
    if (member.role !== "admin") {
      throw new Error("Admin access required");
    }

    if (params.invitedUserId === params.inviterId) {
      throw new Error("You are already in the group");
    }

    const existingMember = getMember(group, params.invitedUserId);
    if (existingMember?.status === "active") {
      throw new Error("User is already in the group");
    }

    const existingInvite = (await listPendingInvitesForUser(params.invitedUserId)).find(
      (invite) => invite.groupId === params.groupId && invite.status === "pending",
    );
    if (existingInvite) {
      throw new Error("An invitation is already pending");
    }

    const invite: GroupInviteRecord = {
      id: uuidv4(),
      groupId: params.groupId,
      invitedUserId: params.invitedUserId,
      invitedBy: params.inviterId,
      createdAt: Date.now(),
      status: "pending",
    };

    await writeJsonAtomic(invitePath(invite.id), invite);
    return invite;
  });
}

export async function getInvite(inviteId: string): Promise<GroupInviteRecord | null> {
  return readJsonFile<GroupInviteRecord>(invitePath(inviteId));
}

export async function saveInvite(invite: GroupInviteRecord): Promise<void> {
  await writeJsonAtomic(invitePath(invite.id), invite);
}

export async function listPendingInvitesForUser(
  userId: string,
): Promise<GroupInviteRecord[]> {
  const files = await listJsonFiles(inviteDir);
  const invites = await Promise.all(files.map((filePath) => readJsonFile<GroupInviteRecord>(filePath)));
  return (invites.filter(Boolean) as GroupInviteRecord[])
    .filter((invite) => invite.invitedUserId === userId && invite.status === "pending")
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function acceptInvite(
  inviteId: string,
  userId: string,
): Promise<{ invite: GroupInviteRecord; group: GroupRecord }> {
  const invite = await getInvite(inviteId);
  if (!invite || invite.invitedUserId !== userId || invite.status !== "pending") {
    throw new Error("Invitation not found");
  }

  return withLock(`group:${invite.groupId}`, async () => {
    const latestInvite = await getInvite(inviteId);
    if (!latestInvite || latestInvite.status !== "pending") {
      throw new Error("Invitation not found");
    }

    const group = await getGroup(latestInvite.groupId);
    if (!group) {
      throw new Error("Group not found");
    }

    const now = Date.now();
    const existing = getMember(group, userId);
    if (existing) {
      existing.role = existing.role === "admin" ? "admin" : "member";
      existing.status = "active";
      existing.joinedAt = now;
      existing.updatedAt = now;
      delete existing.removedAt;
    } else {
      group.members.push({
        userId,
        role: "member",
        status: "active",
        joinedAt: now,
        addedBy: latestInvite.invitedBy,
        updatedAt: now,
      });
    }

    latestInvite.status = "accepted";
    latestInvite.respondedAt = now;

    await Promise.all([saveGroup(group), saveInvite(latestInvite)]);
    return { invite: latestInvite, group };
  });
}

export async function declineInvite(
  inviteId: string,
  userId: string,
): Promise<GroupInviteRecord> {
  const invite = await getInvite(inviteId);
  if (!invite || invite.invitedUserId !== userId || invite.status !== "pending") {
    throw new Error("Invitation not found");
  }

  invite.status = "declined";
  invite.respondedAt = Date.now();
  await saveInvite(invite);
  return invite;
}

function ensureAdminAfterRemoval(group: GroupRecord): void {
  const activeAdmins = group.members.filter(
    (member) => member.status === "active" && member.role === "admin",
  );
  if (activeAdmins.length > 0) {
    return;
  }

  const nextActiveMember = group.members.find((member) => member.status === "active");
  if (nextActiveMember) {
    nextActiveMember.role = "admin";
    nextActiveMember.updatedAt = Date.now();
  }
}

export async function updateAdminRole(params: {
  groupId: string;
  actorId: string;
  targetUserId: string;
  action: "assign" | "revoke" | "transfer";
}): Promise<GroupRecord> {
  return withLock(`group:${params.groupId}`, async () => {
    const { group, member } = await requireGroupMember(params.groupId, params.actorId);
    if (member.role !== "admin") {
      throw new Error("Admin access required");
    }

    const target = getMember(group, params.targetUserId);
    if (!target || target.status !== "active") {
      throw new Error("Target member not found");
    }

    if (params.action === "assign") {
      target.role = "admin";
      target.updatedAt = Date.now();
    } else if (params.action === "revoke") {
      target.role = "member";
      target.updatedAt = Date.now();
      ensureAdminAfterRemoval(group);
    } else {
      if (group.createdBy !== params.actorId) {
        throw new Error("Only the group owner can transfer ownership");
      }
      target.role = "admin";
      target.updatedAt = Date.now();
      member.role = "member";
      member.updatedAt = Date.now();
      group.createdBy = target.userId;
    }

    await saveGroup(group);
    return group;
  });
}

export async function removeGroupMember(params: {
  groupId: string;
  actorId: string;
  targetUserId: string;
  voluntary?: boolean;
}): Promise<GroupRecord> {
  return withLock(`group:${params.groupId}`, async () => {
    const { group, member } = await requireGroupMember(params.groupId, params.actorId);
    const target = getMember(group, params.targetUserId);
    if (!target || target.status !== "active") {
      throw new Error("Target member not found");
    }

    const isSelf = params.actorId === params.targetUserId;
    if (!isSelf && member.role !== "admin") {
      throw new Error("Admin access required");
    }

    if (!isSelf && target.role === "admin" && member.userId !== target.userId) {
      const adminCount = group.members.filter(
        (item) => item.status === "active" && item.role === "admin",
      ).length;
      if (adminCount <= 1) {
        throw new Error("Transfer or assign another admin before removing the last admin");
      }
    }

    target.status = params.voluntary ? "left" : "removed";
    target.removedAt = Date.now();
    target.updatedAt = target.removedAt;
    if (!params.voluntary) {
      target.role = "member";
    }

    ensureAdminAfterRemoval(group);
    await saveGroup(group);
    return group;
  });
}

export async function deleteGroup(params: {
  groupId: string;
  actorId: string;
}): Promise<{
  group: GroupRecord;
  activeUserIds: string[];
  pendingInvites: GroupInviteRecord[];
}> {
  return withLock(`group:${params.groupId}`, async () => {
    const { group } = await requireGroupMember(params.groupId, params.actorId);
    if (group.createdBy !== params.actorId) {
      throw new Error("Only the group owner can delete this group");
    }

    const activeUserIds = group.members
      .filter((member) => member.status === "active")
      .map((member) => member.userId);
    const pendingInvites = (await Promise.all(
      (await listJsonFiles(inviteDir)).map((filePath) =>
        readJsonFile<GroupInviteRecord>(filePath),
      ),
    ))
      .filter(Boolean)
      .filter(
        (invite): invite is GroupInviteRecord =>
          !!invite &&
          invite.groupId === params.groupId &&
          invite.status === "pending",
      );

    await Promise.all(
      pendingInvites.map((invite) => fs.rm(invitePath(invite.id), { force: true })),
    );

    const [hiddenUserDirs, readUserDirs] = await Promise.all([
      listDirectories(hiddenDir),
      listDirectories(readStateDir),
    ]);

    await Promise.all([
      fs.rm(groupPath(params.groupId), { force: true }),
      fs.rm(groupMessagesPath(params.groupId), { recursive: true, force: true }),
      ...hiddenUserDirs.map((dirPath) =>
        fs.rm(path.join(dirPath, `${params.groupId}.json`), { force: true }),
      ),
      ...readUserDirs.map((dirPath) =>
        fs.rm(path.join(dirPath, `${params.groupId}.json`), { force: true }),
      ),
    ]);

    return {
      group,
      activeUserIds,
      pendingInvites,
    };
  });
}

export async function listGroupMessages(groupId: string): Promise<GroupStoredMessage[]> {
  const files = await listJsonFiles(groupMessagesPath(groupId));
  const messages = await Promise.all(
    files.map((filePath) => readJsonFile<GroupStoredMessage>(filePath)),
  );
  return sortMessages(messages.filter(Boolean) as GroupStoredMessage[]);
}

export async function storeGroupMessage(message: GroupStoredMessage): Promise<void> {
  const dirPath = groupMessagesPath(message.groupId);
  await ensureDir(dirPath);
  message.deliveredTo = message.deliveredTo || {};
  message.seenBy = message.seenBy || {};
  await writeJsonAtomic(path.join(dirPath, `${message.id}.json`), message);
}

export async function getGroupMessage(
  groupId: string,
  messageId: string,
): Promise<GroupStoredMessage | null> {
  return readJsonFile<GroupStoredMessage>(
    path.join(groupMessagesPath(groupId), `${messageId}.json`),
  );
}

export async function saveGroupMessage(message: GroupStoredMessage): Promise<void> {
  message.deliveredTo = message.deliveredTo || {};
  message.seenBy = message.seenBy || {};
  await writeJsonAtomic(path.join(groupMessagesPath(message.groupId), `${message.id}.json`), message);
}

export async function getHiddenMessageIds(
  userId: string,
  groupId: string,
): Promise<Set<string>> {
  const record =
    (await readJsonFile<{ messageIds: string[] }>(hiddenPath(userId, groupId))) || {
      messageIds: [],
    };
  return new Set(record.messageIds);
}

export async function hideGroupMessageForUser(
  userId: string,
  groupId: string,
  messageId: string,
): Promise<void> {
  const hidden = await getHiddenMessageIds(userId, groupId);
  hidden.add(messageId);
  await writeJsonAtomic(hiddenPath(userId, groupId), {
    messageIds: Array.from(hidden.values()),
  });
}

export async function markGroupMessageDeletedForEveryone(
  groupId: string,
  messageId: string,
  actorId: string,
): Promise<GroupStoredMessage> {
  return withLock(`group-message:${groupId}:${messageId}`, async () => {
    const message = await getGroupMessage(groupId, messageId);
    if (!message) {
      throw new Error("Message not found");
    }
    if (message.senderId !== actorId) {
      throw new Error("Only the sender can permanently delete this message");
    }
    message.deletedForEveryone = true;
    message.deletedAt = Date.now();
    message.deletedBy = actorId;
    await saveGroupMessage(message);

    const group = await getGroup(groupId);
    if (group?.pinnedMessageId === messageId) {
      delete group.pinnedMessageId;
      delete group.pinnedMessageBy;
      delete group.pinnedMessageAt;
      await saveGroup(group);
    }

    return message;
  });
}

export async function markGroupRead(userId: string, groupId: string): Promise<void> {
  await writeJsonAtomic(readStatePath(userId, groupId), {
    lastReadAt: Date.now(),
  });
}

export function summarizeGroupMessageReceipts(
  message: GroupStoredMessage,
  activeUserIds: string[],
): GroupMessageReceiptSummary {
  const recipientIds = activeUserIds.filter((userId) => userId !== message.senderId);
  const deliveredTo = message.deliveredTo || {};
  const seenBy = message.seenBy || {};
  const deliveredCount = recipientIds.filter((userId) => !!deliveredTo[userId]).length;
  const seenCount = recipientIds.filter((userId) => !!seenBy[userId]).length;

  return {
    recipientCount: recipientIds.length,
    deliveredCount,
    seenCount,
    deliveredToAll: recipientIds.length === 0 || deliveredCount >= recipientIds.length,
    seenByAny: seenCount > 0,
    seenByAll: recipientIds.length === 0 || seenCount >= recipientIds.length,
  };
}

export async function markGroupMessageDelivered(
  groupId: string,
  messageId: string,
  userId: string,
): Promise<GroupStoredMessage | null> {
  return withLock(`group-message:${groupId}:${messageId}`, async () => {
    const message = await getGroupMessage(groupId, messageId);
    if (!message || message.deletedForEveryone || message.senderId === userId) {
      return message;
    }

    message.deliveredTo = message.deliveredTo || {};
    if (!message.deliveredTo[userId]) {
      message.deliveredTo[userId] = Date.now();
      await saveGroupMessage(message);
    }
    return message;
  });
}

export async function markVisibleGroupMessagesDelivered(
  groupId: string,
  userId: string,
  joinedAt: number,
): Promise<GroupStoredMessage[]> {
  const messages = await listGroupMessages(groupId);
  const changed: GroupStoredMessage[] = [];

  for (const message of messages) {
    if (
      message.deletedForEveryone ||
      message.senderId === userId ||
      message.timestamp < joinedAt ||
      !message.envelopes[userId]
    ) {
      continue;
    }

    const updated = await markGroupMessageDelivered(groupId, message.id, userId);
    if (updated && (updated.deliveredTo?.[userId] || 0) > 0) {
      changed.push(updated);
    }
  }

  return changed;
}

export async function markVisibleGroupMessagesSeen(
  groupId: string,
  userId: string,
  joinedAt: number,
): Promise<GroupStoredMessage[]> {
  const messages = await listGroupMessages(groupId);
  const changed: GroupStoredMessage[] = [];

  for (const message of messages) {
    if (
      message.deletedForEveryone ||
      message.senderId === userId ||
      message.timestamp < joinedAt ||
      !message.envelopes[userId]
    ) {
      continue;
    }

    await withLock(`group-message:${groupId}:${message.id}`, async () => {
      const current = await getGroupMessage(groupId, message.id);
      if (!current || current.deletedForEveryone || current.senderId === userId) {
        return;
      }

      current.deliveredTo = current.deliveredTo || {};
      current.seenBy = current.seenBy || {};

      let mutated = false;
      if (!current.deliveredTo[userId]) {
        current.deliveredTo[userId] = Date.now();
        mutated = true;
      }
      if (!current.seenBy[userId]) {
        current.seenBy[userId] = Date.now();
        mutated = true;
      }

      if (mutated) {
        await saveGroupMessage(current);
        changed.push(current);
      }
    });
  }

  return changed;
}

export async function getGroupReadState(
  userId: string,
  groupId: string,
): Promise<number> {
  const record =
    (await readJsonFile<{ lastReadAt: number }>(readStatePath(userId, groupId))) ||
    null;
  return record?.lastReadAt || 0;
}

export async function listGroupConversationsForUser(
  userId: string,
): Promise<GroupConversationSummary[]> {
  const groups = await listAllGroups();
  const summaries: GroupConversationSummary[] = [];

  for (const group of groups) {
    const member = getMember(group, userId);
    if (!member || member.status !== "active") {
      continue;
    }

    const messages = await listGroupMessages(group.id);
    const hidden = await getHiddenMessageIds(userId, group.id);
    const readAt = await getGroupReadState(userId, group.id);
    const visibleMessages = messages.filter(
      (message) =>
        !message.deletedForEveryone &&
        message.timestamp >= member.joinedAt &&
        !hidden.has(message.id) &&
        !!message.envelopes[userId],
    );
    const lastMessage = visibleMessages[visibleMessages.length - 1];
    const unreadCount = visibleMessages.filter(
      (message) => message.senderId !== userId && message.timestamp > readAt,
    ).length;

    summaries.push({
      id: group.id,
      name: group.name,
      bio: group.bio,
      avatar: group.avatar,
      timestamp: lastMessage?.timestamp || group.updatedAt,
      unreadCount,
      memberCount: group.members.filter((item) => item.status === "active").length,
    });
  }

  return summaries.sort((a, b) => b.timestamp - a.timestamp);
}
