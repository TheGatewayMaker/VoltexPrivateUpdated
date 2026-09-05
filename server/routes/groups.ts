import { RequestHandler } from "express";
import { v4 as uuidv4 } from "uuid";
import { verifyMessageSignature } from "../lib/crypto";
import { getSessionFromToken } from "./auth";
import { getUserAccount, getUserIdByUsername } from "../lib/auth-store";
import { getUserProfile } from "../lib/profile-store";
import {
  acceptInvite,
  createGroup,
  deleteGroup,
  declineInvite,
  getGroup,
  getGroupMessage,
  getHiddenMessageIds,
  getInvite,
  hideGroupMessageForUser,
  initializeGroupStore,
  listGroupConversationsForUser,
  listGroupMessages,
  listPendingInvitesForUser,
  markGroupMessageDelivered,
  markGroupMessageDeletedForEveryone,
  markGroupRead,
  markVisibleGroupMessagesDelivered,
  markVisibleGroupMessagesSeen,
  pinGroupMessage,
  removeGroupMember,
  requireGroupMember,
  sendGroupInvite,
  storeGroupMessage,
  summarizeGroupMessageReceipts,
  updateAdminRole,
  updateGroupMetadata,
} from "../lib/group-store";
import { notifyUserEvent } from "../lib/messaging";
import { sendWakeup } from "../lib/push-notifications";
import {
  GroupInviteSummary,
  GroupMessageEnvelope,
  GroupRecord,
  GroupStoredMessage,
} from "@shared/groups";

void initializeGroupStore();

const MAX_GROUP_MESSAGE_PAGE_SIZE = 100;
const MAX_GROUP_MESSAGE_OFFSET = 5000;
const GROUP_CREATE_REQUEST_TTL_MS = 5 * 60 * 1000;
const pendingGroupCreates = new Map<string, { createdAt: number; promise: Promise<GroupRecord> }>();

function getAvatarUrl(username?: string | null, avatar?: string | null): string | null {
  if (!avatar || !username) {
    return null;
  }
  return avatar;
}

async function requireSession(req: Parameters<RequestHandler>[0]) {
  const sessionToken = req.headers.authorization?.replace("Bearer ", "");
  if (!sessionToken) {
    throw new Error("Unauthorized");
  }
  const session = await getSessionFromToken(sessionToken);
  if (!session) {
    throw new Error("Invalid session");
  }
  return session;
}

async function enrichGroup(group: GroupRecord) {
  const members = await Promise.all(
    group.members.map(async (member) => {
      const [account, profile] = await Promise.all([
        getUserAccount(member.userId),
        getUserProfile(member.userId),
      ]);
      return {
        ...member,
        username: account?.username || "",
        displayName: profile?.displayName || "User",
        avatar: getAvatarUrl(account?.username, profile?.avatar || null),
        publicKey: account?.publicKey || "",
        signPublicKey: account?.signPublicKey || account?.publicKey || "",
      };
    }),
  );

  return {
    ...group,
    members,
  };
}

async function buildInviteSummary(inviteId: string): Promise<GroupInviteSummary | null> {
  const invite = await getInvite(inviteId);
  if (!invite) {
    return null;
  }
  const [group, inviterAccount, inviterProfile] = await Promise.all([
    getGroup(invite.groupId),
    getUserAccount(invite.invitedBy),
    getUserProfile(invite.invitedBy),
  ]);
  if (!group) {
    return null;
  }
  return {
    id: invite.id,
    groupId: invite.groupId,
    groupName: group.name,
    groupBio: group.bio,
    groupAvatar: group.avatar,
    invitedBy: invite.invitedBy,
    inviterUsername: inviterAccount?.username || "",
    inviterDisplayName: inviterProfile?.displayName || "User",
    createdAt: invite.createdAt,
  };
}

function emitGroupReceiptUpdate(
  group: GroupRecord,
  message: GroupStoredMessage,
): void {
  const activeUserIds = group.members
    .filter((member) => member.status === "active")
    .map((member) => member.userId);
  const receipt = summarizeGroupMessageReceipts(message, activeUserIds);

  notifyUserEvent(message.senderId, {
    type: "group-message-status",
    data: {
      groupId: group.id,
      messageId: message.id,
      receipt,
    },
  });
}

function cleanupExpiredPendingGroupCreates(): void {
  const cutoff = Date.now() - GROUP_CREATE_REQUEST_TTL_MS;
  for (const [key, value] of pendingGroupCreates.entries()) {
    if (value.createdAt < cutoff) {
      pendingGroupCreates.delete(key);
    }
  }
}

async function buildPinnedMessagePayload(
  groupId: string,
  userId: string,
  pinnedMessageId?: string,
): Promise<Record<string, unknown> | null> {
  if (!pinnedMessageId) {
    return null;
  }

  const pinnedMessage = await getGroupMessage(groupId, pinnedMessageId);
  if (!pinnedMessage || pinnedMessage.deletedForEveryone) {
    return null;
  }
  const envelope = pinnedMessage.envelopes[userId];
  if (!envelope) {
    return null;
  }

  return {
    id: pinnedMessage.id,
    nonce: envelope.nonce,
    ciphertext: envelope.ciphertext,
    signature: envelope.signature,
    senderId: pinnedMessage.senderId,
    recipientId: userId,
    timestamp: pinnedMessage.timestamp,
  };
}

export const handleCreateGroup: RequestHandler = async (req, res) => {
  try {
    const session = await requireSession(req);
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const bio = typeof req.body?.bio === "string" ? req.body.bio.trim() : "";
    const avatar =
      typeof req.body?.avatar === "string" && req.body.avatar.trim().length > 0
        ? req.body.avatar.trim()
        : null;

    if (!name || name.length > 80) {
      return res.status(400).json({ error: "Group name is required and must be at most 80 characters" });
    }
    if (bio.length > 240) {
      return res.status(400).json({ error: "Group bio must be at most 240 characters" });
    }

    const requestId =
      typeof req.body?.requestId === "string" ? req.body.requestId.trim() : "";
    cleanupExpiredPendingGroupCreates();

    const groupPromise =
      requestId.length > 0
        ? (() => {
            const dedupeKey = `${session.userId}:${requestId}`;
            const existing = pendingGroupCreates.get(dedupeKey);
            if (existing) {
              return existing.promise;
            }

            const promise = createGroup({
              creatorId: session.userId,
              name,
              bio,
              avatar,
            }).catch((error) => {
              pendingGroupCreates.delete(dedupeKey);
              throw error;
            });

            pendingGroupCreates.set(dedupeKey, {
              createdAt: Date.now(),
              promise,
            });
            return promise;
          })()
        : createGroup({
            creatorId: session.userId,
            name,
            bio,
            avatar,
          });

    const group = await groupPromise;

    return res.status(201).json({
      success: true,
      group: await enrichGroup(group),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create group";
    return res.status(message === "Unauthorized" || message === "Invalid session" ? 401 : 500).json({ error: message });
  }
};

export const handleDeleteGroup: RequestHandler = async (req, res) => {
  try {
    const session = await requireSession(req);
    const groupId = typeof req.params.groupId === "string" ? req.params.groupId : "";
    const { activeUserIds, pendingInvites } = await deleteGroup({
      groupId,
      actorId: session.userId,
    });

    for (const userId of activeUserIds) {
      notifyUserEvent(userId, {
        type: "group-removed",
        data: { groupId, reason: "deleted" },
      });
    }

    for (const invite of pendingInvites) {
      notifyUserEvent(invite.invitedUserId, {
        type: "group-invite-removed",
        data: { inviteId: invite.id },
      });
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to delete group";
    const status =
      message === "Unauthorized" || message === "Invalid session"
        ? 401
        : message === "Only the group owner can delete this group"
          ? 403
          : message === "Group not found" || message === "You are not an active member of this group"
            ? 404
            : 400;
    return res.status(status).json({ error: message });
  }
};

export const handleListGroupConversations: RequestHandler = async (req, res) => {
  try {
    const session = await requireSession(req);
    const [groups, invites] = await Promise.all([
      listGroupConversationsForUser(session.userId),
      listPendingInvitesForUser(session.userId),
    ]);

    const inviteSummaries = (
      await Promise.all(invites.map((invite) => buildInviteSummary(invite.id)))
    ).filter(Boolean);

    return res.status(200).json({
      groups,
      invites: inviteSummaries,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load group conversations";
    return res.status(message === "Unauthorized" || message === "Invalid session" ? 401 : 500).json({ error: message });
  }
};

export const handleGetGroup: RequestHandler = async (req, res) => {
  try {
    const session = await requireSession(req);
    const groupId = typeof req.params.groupId === "string" ? req.params.groupId : "";
    const { group } = await requireGroupMember(groupId, session.userId);
    return res.status(200).json({
      group: await enrichGroup(group),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load group";
    const status =
      message === "Unauthorized" || message === "Invalid session"
        ? 401
        : message === "Group not found" || message === "You are not an active member of this group"
          ? 404
          : 500;
    return res.status(status).json({ error: message });
  }
};

export const handleUpdateGroup: RequestHandler = async (req, res) => {
  try {
    const session = await requireSession(req);
    const groupId = typeof req.params.groupId === "string" ? req.params.groupId : "";
    const nextGroup = await updateGroupMetadata(groupId, session.userId, {
      name: typeof req.body?.name === "string" ? req.body.name : undefined,
      bio: typeof req.body?.bio === "string" ? req.body.bio : undefined,
      avatar: req.body?.avatar !== undefined ? req.body.avatar || null : undefined,
    });

    const enriched = await enrichGroup(nextGroup);
    for (const member of enriched.members) {
      if (member.status === "active") {
        notifyUserEvent(member.userId, {
          type: "group-updated",
          data: { group: enriched },
        });
      }
    }

    return res.status(200).json({ success: true, group: enriched });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update group";
    const status =
      message === "Unauthorized" || message === "Invalid session"
        ? 401
        : message === "Admin access required"
          ? 403
          : 500;
    return res.status(status).json({ error: message });
  }
};

export const handleInviteToGroup: RequestHandler = async (req, res) => {
  try {
    const session = await requireSession(req);
    const groupId = typeof req.params.groupId === "string" ? req.params.groupId : "";
    const username =
      typeof req.body?.username === "string"
        ? req.body.username.trim().replace(/^@+/, "").toLowerCase()
        : "";
    if (!username) {
      return res.status(400).json({ error: "Username is required" });
    }
    const invitedUserId = await getUserIdByUsername(username);
    if (!invitedUserId) {
      return res.status(404).json({ error: "User not found" });
    }

    const invite = await sendGroupInvite({
      groupId,
      inviterId: session.userId,
      invitedUserId,
    });

    const summary = await buildInviteSummary(invite.id);
    if (summary) {
      const deliveredInRealtime = notifyUserEvent(invitedUserId, {
        type: "group-invite",
        data: { invite: summary },
      });

      if (!deliveredInRealtime) {
        try {
          await sendWakeup(invitedUserId, {
            excludeDeviceId: session.deviceId,
          });
        } catch (error) {
          console.error("[PUSH] Failed to send group invite wake-up:", error);
        }
      }
    }

    return res.status(201).json({
      success: true,
      invite: summary,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to invite user";
    const status =
      message === "Unauthorized" || message === "Invalid session"
        ? 401
        : message === "Admin access required"
          ? 403
          : message === "User not found" || message === "Group not found"
            ? 404
            : 400;
    return res.status(status).json({ error: message });
  }
};

export const handleGetInvite: RequestHandler = async (req, res) => {
  try {
    const session = await requireSession(req);
    const inviteId = typeof req.params.inviteId === "string" ? req.params.inviteId : "";
    const invite = await getInvite(inviteId);
    if (!invite || invite.invitedUserId !== session.userId || invite.status !== "pending") {
      return res.status(404).json({ error: "Invitation not found" });
    }
    return res.status(200).json({
      invite: await buildInviteSummary(inviteId),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load invitation";
    return res.status(message === "Unauthorized" || message === "Invalid session" ? 401 : 500).json({ error: message });
  }
};

export const handleAcceptInvite: RequestHandler = async (req, res) => {
  try {
    const session = await requireSession(req);
    const inviteId = typeof req.params.inviteId === "string" ? req.params.inviteId : "";
    const { invite, group } = await acceptInvite(inviteId, session.userId);
    const enriched = await enrichGroup(group);

    for (const member of enriched.members) {
      if (member.status === "active") {
        notifyUserEvent(member.userId, {
          type: "group-updated",
          data: { group: enriched },
        });
      }
    }

    notifyUserEvent(session.userId, {
      type: "group-invite-removed",
      data: { inviteId: invite.id },
    });

    return res.status(200).json({
      success: true,
      group: enriched,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to accept invitation";
    return res.status(message === "Unauthorized" || message === "Invalid session" ? 401 : 400).json({ error: message });
  }
};

export const handleDeclineInvite: RequestHandler = async (req, res) => {
  try {
    const session = await requireSession(req);
    const inviteId = typeof req.params.inviteId === "string" ? req.params.inviteId : "";
    const invite = await declineInvite(inviteId, session.userId);
    notifyUserEvent(session.userId, {
      type: "group-invite-removed",
      data: { inviteId: invite.id },
    });
    return res.status(200).json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to decline invitation";
    return res.status(message === "Unauthorized" || message === "Invalid session" ? 401 : 400).json({ error: message });
  }
};

export const handleUpdateGroupAdmin: RequestHandler = async (req, res) => {
  try {
    const session = await requireSession(req);
    const groupId = typeof req.params.groupId === "string" ? req.params.groupId : "";
    const targetUserId = typeof req.body?.userId === "string" ? req.body.userId : "";
    const action =
      req.body?.action === "assign" || req.body?.action === "revoke" || req.body?.action === "transfer"
        ? req.body.action
        : null;
    if (!targetUserId || !action) {
      return res.status(400).json({ error: "userId and a valid action are required" });
    }

    const group = await updateAdminRole({
      groupId,
      actorId: session.userId,
      targetUserId,
      action,
    });
    const enriched = await enrichGroup(group);
    for (const member of enriched.members) {
      if (member.status === "active") {
        notifyUserEvent(member.userId, {
          type: "group-updated",
          data: { group: enriched },
        });
      }
    }

    return res.status(200).json({ success: true, group: enriched });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update admins";
    const status =
      message === "Unauthorized" || message === "Invalid session"
        ? 401
        : message === "Admin access required" ||
            message === "Only the group owner can transfer ownership"
          ? 403
          : 400;
    return res.status(status).json({ error: message });
  }
};

export const handleRemoveGroupMember: RequestHandler = async (req, res) => {
  try {
    const session = await requireSession(req);
    const groupId = typeof req.params.groupId === "string" ? req.params.groupId : "";
    const targetUserId = typeof req.params.userId === "string" ? req.params.userId : "";
    const group = await removeGroupMember({
      groupId,
      actorId: session.userId,
      targetUserId,
    });
    const enriched = await enrichGroup(group);

    notifyUserEvent(targetUserId, {
      type: "group-removed",
      data: { groupId, reason: "removed" },
    });

    for (const member of enriched.members) {
      if (member.status === "active") {
        notifyUserEvent(member.userId, {
          type: "group-updated",
          data: { group: enriched },
        });
      }
    }

    return res.status(200).json({ success: true, group: enriched });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to remove member";
    const status =
      message === "Unauthorized" || message === "Invalid session"
        ? 401
        : message === "Admin access required"
          ? 403
          : 400;
    return res.status(status).json({ error: message });
  }
};

export const handleLeaveGroup: RequestHandler = async (req, res) => {
  try {
    const session = await requireSession(req);
    const groupId = typeof req.params.groupId === "string" ? req.params.groupId : "";
    const group = await removeGroupMember({
      groupId,
      actorId: session.userId,
      targetUserId: session.userId,
      voluntary: true,
    });
    const enriched = await enrichGroup(group);

    notifyUserEvent(session.userId, {
      type: "group-removed",
      data: { groupId, reason: "left" },
    });

    for (const member of enriched.members) {
      if (member.status === "active") {
        notifyUserEvent(member.userId, {
          type: "group-updated",
          data: { group: enriched },
        });
      }
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to leave group";
    return res.status(message === "Unauthorized" || message === "Invalid session" ? 401 : 400).json({ error: message });
  }
};

export const handleGetGroupMessages: RequestHandler = async (req, res) => {
  try {
    const session = await requireSession(req);
    const groupId = typeof req.params.groupId === "string" ? req.params.groupId : "";
    const rawLimit = parseInt(req.query.limit as string, 10);
    const rawOffset = parseInt(req.query.offset as string, 10);
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(rawLimit, MAX_GROUP_MESSAGE_PAGE_SIZE)
        : 50;
    const offset =
      Number.isFinite(rawOffset) && rawOffset >= 0
        ? Math.min(rawOffset, MAX_GROUP_MESSAGE_OFFSET)
        : 0;
    const anchor =
      typeof req.query.anchor === "string" && req.query.anchor === "latest"
        ? "latest"
        : "start";

    const { group, member } = await requireGroupMember(groupId, session.userId);
    const hiddenIds = await getHiddenMessageIds(session.userId, groupId);
    const deliveredMessages = await markVisibleGroupMessagesDelivered(
      groupId,
      session.userId,
      member.joinedAt,
    );
    for (const deliveredMessage of deliveredMessages) {
      emitGroupReceiptUpdate(group, deliveredMessage);
    }
    const messages = await listGroupMessages(groupId);
    const visibleMessages = messages
      .filter(
        (message) =>
          !message.deletedForEveryone &&
          message.timestamp >= member.joinedAt &&
          !hiddenIds.has(message.id) &&
          !!message.envelopes[session.userId],
      );
    const paginatedVisibleMessages =
      anchor === "latest"
        ? visibleMessages.slice(
            Math.max(visibleMessages.length - limit - offset, 0),
            Math.max(visibleMessages.length - offset, 0),
          )
        : visibleMessages.slice(offset, offset + limit);
    const visible = paginatedVisibleMessages
      .map((message) => ({
        id: message.id,
        nonce: message.envelopes[session.userId].nonce,
        ciphertext: message.envelopes[session.userId].ciphertext,
        signature: message.envelopes[session.userId].signature,
        senderId: message.senderId,
        recipientId: session.userId,
        timestamp: message.timestamp,
        receipt:
          message.senderId === session.userId
            ? summarizeGroupMessageReceipts(
                message,
                group.members
                  .filter((item) => item.status === "active")
                  .map((item) => item.userId),
              )
            : undefined,
      }));

    return res.status(200).json({
      messages: visible,
      total: visibleMessages.length,
      group: await enrichGroup(group),
      pinnedMessage: await buildPinnedMessagePayload(
        groupId,
        session.userId,
        group.pinnedMessageId,
      ),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load group messages";
    const status =
      message === "Unauthorized" || message === "Invalid session"
        ? 401
        : message === "Group not found" || message === "You are not an active member of this group"
          ? 404
          : 500;
    return res.status(status).json({ error: message });
  }
};

export const handlePinGroupMessage: RequestHandler = async (req, res) => {
  try {
    const session = await requireSession(req);
    const groupId = typeof req.params.groupId === "string" ? req.params.groupId : "";
    const messageId = typeof req.body?.messageId === "string" ? req.body.messageId : "";
    if (!messageId) {
      return res.status(400).json({ error: "messageId is required" });
    }

    const group = await pinGroupMessage({
      groupId,
      actorId: session.userId,
      messageId,
    });
    const enriched = await enrichGroup(group);
    const activeMembers = enriched.members.filter((member) => member.status === "active");

    await Promise.all(
      activeMembers.map(async (member) => {
        notifyUserEvent(member.userId, {
          type: "group-pin-updated",
          data: {
            groupId,
            pinnedMessage: await buildPinnedMessagePayload(
              groupId,
              member.userId,
              group.pinnedMessageId,
            ),
          },
        });
      }),
    );

    return res.status(200).json({
      success: true,
      group: enriched,
      pinnedMessage: await buildPinnedMessagePayload(
        groupId,
        session.userId,
        group.pinnedMessageId,
      ),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to pin message";
    const status =
      message === "Unauthorized" || message === "Invalid session"
        ? 401
        : message === "Admin access required"
          ? 403
          : message === "Group not found" ||
              message === "You are not an active member of this group" ||
              message === "Message not found"
            ? 404
            : 400;
    return res.status(status).json({ error: message });
  }
};

export const handleSendGroupMessage: RequestHandler = async (req, res) => {
  try {
    const session = await requireSession(req);
    const groupId = typeof req.params.groupId === "string" ? req.params.groupId : "";
    const { group } = await requireGroupMember(groupId, session.userId);
    const timestamp =
      typeof req.body?.timestamp === "number" && Number.isFinite(req.body.timestamp)
        ? req.body.timestamp
        : Date.now();
    const rawEnvelopes =
      req.body?.envelopes && typeof req.body.envelopes === "object"
        ? (req.body.envelopes as Record<string, GroupMessageEnvelope>)
        : null;

    if (!rawEnvelopes) {
      return res.status(400).json({ error: "Encrypted envelopes are required" });
    }

    const activeMembers = group.members.filter((member) => member.status === "active");
    const activeUserIds = activeMembers.map((member) => member.userId).sort();
    const envelopeUserIds = Object.keys(rawEnvelopes).sort();
    if (activeUserIds.join(",") !== envelopeUserIds.join(",")) {
      return res.status(400).json({ error: "Encrypted envelopes must be provided for every active member" });
    }

    const senderAccount = await getUserAccount(session.userId);
    const signPublicKey = senderAccount?.signPublicKey || session.signPublicKey;
    if (!signPublicKey) {
      return res.status(400).json({ error: "Sender signing key is not available" });
    }

    for (const recipientId of envelopeUserIds) {
      const envelope = rawEnvelopes[recipientId];
      const encrypted = {
        nonce: envelope.nonce,
        ciphertext: envelope.ciphertext,
        signature: envelope.signature,
        senderId: session.userId,
        recipientId,
        timestamp,
      };
      if (!verifyMessageSignature(encrypted, signPublicKey)) {
        return res.status(403).json({ error: "Invalid message signature" });
      }
    }

    const serverTimestamp = Date.now();
    const message: GroupStoredMessage = {
      id: uuidv4(),
      groupId,
      senderId: session.userId,
      timestamp: serverTimestamp,
      createdAt: serverTimestamp,
      deletedForEveryone: false,
      deliveredTo: {},
      seenBy: {},
      envelopes: Object.fromEntries(
        Object.entries(rawEnvelopes).map(([recipientId, envelope]) => [
          recipientId,
          {
            nonce: envelope.nonce,
            ciphertext: envelope.ciphertext,
            signature: envelope.signature,
            recipientId,
            timestamp: serverTimestamp,
          },
        ]),
      ),
    };

    await storeGroupMessage(message);

    const membersToWake: string[] = [];

    for (const member of activeMembers) {
      if (member.userId === session.userId) {
        continue;
      }
      const deliveredInRealtime = notifyUserEvent(member.userId, {
        type: "group-message",
        data: {
          groupId,
          message: {
            id: message.id,
            nonce: message.envelopes[member.userId].nonce,
            ciphertext: message.envelopes[member.userId].ciphertext,
            signature: message.envelopes[member.userId].signature,
            senderId: message.senderId,
            recipientId: member.userId,
            timestamp: message.timestamp,
          },
        },
      });

      if (deliveredInRealtime) {
        const updated = await markGroupMessageDelivered(groupId, message.id, member.userId);
        if (updated) {
          emitGroupReceiptUpdate(group, updated);
        }
      } else {
        membersToWake.push(member.userId);
      }
    }

    // Members without a live socket get a contentless wake-up so a killed app can
    // reconnect and fetch. Nothing about the group or the sender is published.
    for (const memberId of membersToWake) {
      try {
        await sendWakeup(memberId, { excludeDeviceId: session.deviceId });
      } catch (error) {
        console.error("[PUSH] Failed to send group message wake-up:", error);
      }
    }

    const persistedMessage = (await getGroupMessage(groupId, message.id)) || message;

    return res.status(200).json({
      success: true,
      messageId: persistedMessage.id,
      timestamp: persistedMessage.timestamp,
      receipt: summarizeGroupMessageReceipts(
        persistedMessage,
        activeMembers.map((member) => member.userId),
      ),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to send group message";
    const status =
      message === "Unauthorized" || message === "Invalid session"
        ? 401
        : message === "Group not found" || message === "You are not an active member of this group"
          ? 404
          : 400;
    return res.status(status).json({ error: message });
  }
};

export const handleDeleteGroupMessage: RequestHandler = async (req, res) => {
  try {
    const session = await requireSession(req);
    const groupId = typeof req.params.groupId === "string" ? req.params.groupId : "";
    const messageId = typeof req.params.messageId === "string" ? req.params.messageId : "";
    const scope = req.body?.scope === "everyone" ? "everyone" : "self";
    await requireGroupMember(groupId, session.userId);

    if (scope === "everyone") {
      const message = await markGroupMessageDeletedForEveryone(groupId, messageId, session.userId);
      const group = await getGroup(groupId);
      for (const member of group?.members || []) {
        if (member.status === "active") {
          notifyUserEvent(member.userId, {
            type: "group-message-deleted",
            data: { groupId, messageId: message.id, deletedBy: session.userId },
          });
        }
      }

      if (group) {
        await Promise.all(
          group.members
            .filter((member) => member.status === "active")
            .map(async (member) => {
              notifyUserEvent(member.userId, {
                type: "group-pin-updated",
                data: {
                  groupId,
                  pinnedMessage: await buildPinnedMessagePayload(
                    groupId,
                    member.userId,
                    group.pinnedMessageId,
                  ),
                },
              });
            }),
        );
      }

      return res.status(200).json({ success: true });
    }

    await hideGroupMessageForUser(session.userId, groupId, messageId);
    return res.status(200).json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to delete group message";
    const status =
      message === "Unauthorized" || message === "Invalid session"
        ? 401
        : message === "Only the sender can permanently delete this message"
          ? 403
          : 400;
    return res.status(status).json({ error: message });
  }
};

export const handleMarkGroupRead: RequestHandler = async (req, res) => {
  try {
    const session = await requireSession(req);
    const groupId = typeof req.params.groupId === "string" ? req.params.groupId : "";
    const { group, member } = await requireGroupMember(groupId, session.userId);
    await markGroupRead(session.userId, groupId);
    const seenMessages = await markVisibleGroupMessagesSeen(
      groupId,
      session.userId,
      member.joinedAt,
    );
    for (const seenMessage of seenMessages) {
      emitGroupReceiptUpdate(group, seenMessage);
    }
    return res.status(200).json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to mark group as read";
    return res.status(message === "Unauthorized" || message === "Invalid session" ? 401 : 400).json({ error: message });
  }
};
