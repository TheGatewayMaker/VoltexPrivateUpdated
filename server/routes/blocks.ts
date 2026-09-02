import { RequestHandler } from "express";
import { getSessionFromToken } from "./auth";
import {
  getDirectBlockStatus,
  removeUserBlock,
  setUserBlock,
} from "../lib/block-store";
import { notifyUserEvent } from "../lib/messaging";
import {
  normalizeUsernameForLookup,
  resolveDiscoverableUserIdByUsername,
} from "../lib/username-discovery";

function normalizeUsername(value: unknown): string {
  const normalized = normalizeUsernameForLookup(value);
  if (!/^[a-z0-9_]{3,30}$/.test(normalized)) {
    return "";
  }
  return normalized;
}

async function resolveTargetUserIdByUsername(
  usernameParam: unknown,
  requesterUserId?: string,
): Promise<string> {
  const normalizedUsername = normalizeUsername(usernameParam);
  if (!normalizedUsername) {
    return "";
  }

  return resolveDiscoverableUserIdByUsername({
    username: normalizedUsername,
    requesterUserId,
  });
}

async function getAuthenticatedSession(req: Parameters<RequestHandler>[0]) {
  const authHeader = req.headers.authorization;
  const sessionToken =
    typeof authHeader === "string"
      ? authHeader.replace("Bearer ", "")
      : undefined;

  if (!sessionToken) {
    return null;
  }

  return getSessionFromToken(sessionToken);
}

async function broadcastDirectBlockUpdate(
  actorUserId: string,
  targetUserId: string,
): Promise<void> {
  const actorStatus = await getDirectBlockStatus(actorUserId, targetUserId);
  const targetStatus = await getDirectBlockStatus(targetUserId, actorUserId);
  const updatedAt = Date.now();

  notifyUserEvent(actorUserId, {
    type: "direct-block-updated",
    data: {
      otherUserId: targetUserId,
      status: actorStatus,
      updatedBy: actorUserId,
      updatedAt,
    },
  });

  notifyUserEvent(targetUserId, {
    type: "direct-block-updated",
    data: {
      otherUserId: actorUserId,
      status: targetStatus,
      updatedBy: actorUserId,
      updatedAt,
    },
  });
}

export const handleGetDirectBlockStatusByUsername: RequestHandler = async (
  req,
  res,
) => {
  try {
    const session = await getAuthenticatedSession(req);
    if (!session) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const targetUserId = await resolveTargetUserIdByUsername(
      req.params.username,
      session.userId,
    );
    if (!targetUserId) {
      return res.status(404).json({ error: "User not found" });
    }

    if (targetUserId === session.userId) {
      return res.status(400).json({ error: "Cannot block yourself" });
    }

    const status = await getDirectBlockStatus(session.userId, targetUserId);

    return res.status(200).json({
      success: true,
      targetUserId,
      status,
    });
  } catch (error) {
    console.error("[BLOCK] Failed to fetch block status:", error);
    return res.status(500).json({ error: "Failed to fetch block status" });
  }
};

export const handleBlockUserByUsername: RequestHandler = async (req, res) => {
  try {
    const session = await getAuthenticatedSession(req);
    if (!session) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const targetUserId = await resolveTargetUserIdByUsername(
      req.params.username,
      session.userId,
    );
    if (!targetUserId) {
      return res.status(404).json({ error: "User not found" });
    }

    if (targetUserId === session.userId) {
      return res.status(400).json({ error: "Cannot block yourself" });
    }

    await setUserBlock(session.userId, targetUserId);
    const status = await getDirectBlockStatus(session.userId, targetUserId);
    await broadcastDirectBlockUpdate(session.userId, targetUserId);

    return res.status(200).json({
      success: true,
      blockedUserId: targetUserId,
      status,
    });
  } catch (error) {
    console.error("[BLOCK] Failed to block user:", error);
    return res.status(500).json({ error: "Failed to block user" });
  }
};

export const handleUnblockUserByUsername: RequestHandler = async (req, res) => {
  try {
    const session = await getAuthenticatedSession(req);
    if (!session) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const targetUserId = await resolveTargetUserIdByUsername(
      req.params.username,
      session.userId,
    );
    if (!targetUserId) {
      return res.status(404).json({ error: "User not found" });
    }

    if (targetUserId === session.userId) {
      return res.status(400).json({ error: "Cannot unblock yourself" });
    }

    await removeUserBlock(session.userId, targetUserId);
    const status = await getDirectBlockStatus(session.userId, targetUserId);
    await broadcastDirectBlockUpdate(session.userId, targetUserId);

    return res.status(200).json({
      success: true,
      unblockedUserId: targetUserId,
      status,
    });
  } catch (error) {
    console.error("[BLOCK] Failed to unblock user:", error);
    return res.status(500).json({ error: "Failed to unblock user" });
  }
};
