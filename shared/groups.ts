import { EncryptedMessage } from "./crypto";

export type GroupMemberRole = "admin" | "member";
export type GroupMembershipStatus = "active" | "left" | "removed";

export interface GroupMember {
  userId: string;
  role: GroupMemberRole;
  status: GroupMembershipStatus;
  joinedAt: number;
  addedBy: string;
  updatedAt: number;
  removedAt?: number;
}

export interface GroupRecord {
  id: string;
  name: string;
  bio: string;
  avatar: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  pinnedMessageId?: string;
  pinnedMessageBy?: string;
  pinnedMessageAt?: number;
  members: GroupMember[];
}

export interface GroupInviteRecord {
  id: string;
  groupId: string;
  invitedUserId: string;
  invitedBy: string;
  createdAt: number;
  status: "pending" | "accepted" | "declined" | "revoked";
  respondedAt?: number;
}

export interface GroupMessageEnvelope
  extends Omit<EncryptedMessage, "senderId" | "recipientId"> {
  recipientId: string;
}

export interface GroupStoredMessage {
  id: string;
  groupId: string;
  senderId: string;
  timestamp: number;
  createdAt: number;
  deletedForEveryone: boolean;
  deletedAt?: number;
  deletedBy?: string;
  deliveredTo?: Record<string, number>;
  seenBy?: Record<string, number>;
  envelopes: Record<string, GroupMessageEnvelope>;
}

export interface GroupMessageReceiptSummary {
  recipientCount: number;
  deliveredCount: number;
  seenCount: number;
  deliveredToAll: boolean;
  seenByAny: boolean;
  seenByAll: boolean;
}

export interface GroupConversationSummary {
  id: string;
  name: string;
  bio: string;
  avatar: string | null;
  timestamp: number;
  unreadCount: number;
  memberCount: number;
}

export interface GroupInviteSummary {
  id: string;
  groupId: string;
  groupName: string;
  groupBio: string;
  groupAvatar: string | null;
  invitedBy: string;
  inviterUsername: string;
  inviterDisplayName: string;
  createdAt: number;
}
