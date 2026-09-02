import { RequestHandler } from "express";
import { v4 as uuidv4 } from "uuid";
import {
  DirectMessageV2Envelope,
  DirectMessageV2Record,
  SessionData,
} from "@shared/crypto";
import { extractBearerToken } from "../lib/auth";
import {
  getDirectMessageV2Count,
  getVisibleDirectMessagesV2,
  isDirectMessageV2DatabaseConnected,
  markDirectMessageV2Delivered,
  markDirectMessageV2Seen,
  storeDirectMessageV2,
  summarizeDirectMessageV2Receipts,
} from "../lib/db-messages-v2";
import { isDirectMessageBlocked } from "../lib/block-store";
import { listUserDevices } from "../lib/device-store";
import { listDeviceBundles } from "../lib/protocol-store";
import {
  normalizeUsernameForLookup,
  resolveDiscoverableUserIdByUsername,
} from "../lib/username-discovery";
import { getSessionFromToken } from "./auth";

const MAX_CONVERSATION_PAGE_SIZE = 100;
const MAX_CONVERSATION_OFFSET = 5000;

function normalizeUsername(value: unknown): string {
  return normalizeUsernameForLookup(value);
}

function normalizeMessageType(
  value: unknown,
): DirectMessageV2Record["messageType"] | null {
  switch (value) {
    case "text":
    case "image":
    case "gif":
    case "sticker":
    case "system":
      return value;
    default:
      return null;
  }
}

function parsePagination(
  limitValue: unknown,
  offsetValue: unknown,
): { limit: number; offset: number } {
  const rawLimit =
    typeof limitValue === "string" ? Number.parseInt(limitValue, 10) : Number.NaN;
  const rawOffset =
    typeof offsetValue === "string" ? Number.parseInt(offsetValue, 10) : Number.NaN;

  return {
    limit:
      Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(rawLimit, MAX_CONVERSATION_PAGE_SIZE)
        : 50,
    offset:
      Number.isFinite(rawOffset) && rawOffset >= 0
        ? Math.min(rawOffset, MAX_CONVERSATION_OFFSET)
        : 0,
  };
}

async function requireDeviceSession(
  req: Parameters<RequestHandler>[0],
): Promise<SessionData> {
  const sessionToken = extractBearerToken(req);
  if (!sessionToken) {
    throw new Error("Authentication required");
  }

  const session = await getSessionFromToken(sessionToken);
  if (!session) {
    throw new Error("Invalid or expired session");
  }

  if (!session.deviceId) {
    throw new Error("Current session is missing a device binding");
  }

  return session;
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

function normalizeEnvelopeList(value: unknown): DirectMessageV2Envelope[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const envelopes: DirectMessageV2Envelope[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const envelope = entry as Record<string, unknown>;
    if (
      typeof envelope.targetUserId !== "string" ||
      typeof envelope.targetDeviceId !== "string" ||
      typeof envelope.nonce !== "string" ||
      typeof envelope.ciphertext !== "string" ||
      typeof envelope.signature !== "string"
    ) {
      continue;
    }

    envelopes.push({
      targetUserId: envelope.targetUserId.trim(),
      targetDeviceId: envelope.targetDeviceId.trim(),
      nonce: envelope.nonce,
      ciphertext: envelope.ciphertext,
      signature: envelope.signature,
      sessionKeyType:
        envelope.sessionKeyType === "signed_prekey" ||
        envelope.sessionKeyType === "one_time_prekey"
          ? envelope.sessionKeyType
          : undefined,
      sessionKeyId:
        typeof envelope.sessionKeyId === "number" &&
        Number.isInteger(envelope.sessionKeyId) &&
        envelope.sessionKeyId >= 0
          ? envelope.sessionKeyId
          : undefined,
      envelopeVersion: envelope.envelopeVersion === "v2" ? "v2" : "v2",
    });
  }

  return envelopes.filter(
    (envelope) =>
      envelope.targetUserId.length > 0 &&
      envelope.targetDeviceId.length > 0 &&
      envelope.nonce.length > 0 &&
      envelope.ciphertext.length > 0 &&
      envelope.signature.length > 0,
  );
}

async function getEligibleDeviceIds(userId: string): Promise<Set<string>> {
  const [devices, bundles] = await Promise.all([
    listUserDevices(userId),
    listDeviceBundles(userId),
  ]);
  const bundledIds = new Set(bundles.map((bundle) => bundle.deviceId));
  return new Set(
    devices
      .filter((device) => device.status === "active" && bundledIds.has(device.deviceId))
      .map((device) => device.deviceId),
  );
}

function buildEnvelopeCoverage(
  envelopes: DirectMessageV2Envelope[],
  senderUserId: string,
  recipientUserId: string,
): {
  duplicateTarget: string | null;
  senderTargets: Set<string>;
  recipientTargets: Set<string>;
  unexpectedTarget: string | null;
} {
  const seenTargets = new Set<string>();
  const senderTargets = new Set<string>();
  const recipientTargets = new Set<string>();

  for (const envelope of envelopes) {
    const targetKey = `${envelope.targetUserId}:${envelope.targetDeviceId}`;
    if (seenTargets.has(targetKey)) {
      return {
        duplicateTarget: targetKey,
        senderTargets,
        recipientTargets,
        unexpectedTarget: null,
      };
    }

    seenTargets.add(targetKey);
    if (envelope.targetUserId === senderUserId) {
      senderTargets.add(envelope.targetDeviceId);
      continue;
    }

    if (envelope.targetUserId === recipientUserId) {
      recipientTargets.add(envelope.targetDeviceId);
      continue;
    }

    return {
      duplicateTarget: null,
      senderTargets,
      recipientTargets,
      unexpectedTarget: targetKey,
    };
  }

  return {
    duplicateTarget: null,
    senderTargets,
    recipientTargets,
    unexpectedTarget: null,
  };
}

function findMissingEligibleTargets(
  eligibleTargets: Set<string>,
  coveredTargets: Set<string>,
): string[] {
  const missing: string[] = [];
  for (const deviceId of eligibleTargets) {
    if (!coveredTargets.has(deviceId)) {
      missing.push(deviceId);
    }
  }
  return missing.sort((left, right) => left.localeCompare(right));
}

export const handleSendMessageV2: RequestHandler = async (req, res) => {
  try {
    if (!isDirectMessageV2DatabaseConnected()) {
      return res.status(503).json({
        error: "Direct message v2 requires PostgreSQL storage",
      });
    }

    const session = await requireDeviceSession(req);
    const recipientId = await resolveRecipientUserId({
      recipientId: req.body?.recipientId,
      recipientUsername: req.body?.recipientUsername,
      requesterUserId: session.userId,
    });
    const messageType = normalizeMessageType(req.body?.messageType);
    const envelopes = normalizeEnvelopeList(req.body?.envelopes);

    if (!recipientId) {
      return res.status(400).json({ error: "recipientUsername is required" });
    }

    if (recipientId === session.userId) {
      return res.status(400).json({ error: "Cannot open a direct v2 conversation with yourself" });
    }

    if (!messageType) {
      return res.status(400).json({ error: "Invalid messageType" });
    }

    if (envelopes.length === 0) {
      return res.status(400).json({ error: "At least one encrypted device envelope is required" });
    }

    if (await isDirectMessageBlocked(session.userId, recipientId)) {
      return res.status(403).json({ error: "Cannot send messages to this user" });
    }

    const [senderEligibleTargets, recipientEligibleTargets] = await Promise.all([
      getEligibleDeviceIds(session.userId),
      getEligibleDeviceIds(recipientId),
    ]);

    if (recipientEligibleTargets.size === 0) {
      return res.status(409).json({
        error: "Recipient has no active multi-device bundles available",
      });
    }

    const coverage = buildEnvelopeCoverage(envelopes, session.userId, recipientId);
    if (coverage.duplicateTarget) {
      return res.status(400).json({
        error: `Duplicate device envelope target: ${coverage.duplicateTarget}`,
      });
    }

    if (coverage.unexpectedTarget) {
      return res.status(400).json({
        error: `Unexpected envelope target: ${coverage.unexpectedTarget}`,
      });
    }

    const missingRecipientTargets = findMissingEligibleTargets(
      recipientEligibleTargets,
      coverage.recipientTargets,
    );
    if (missingRecipientTargets.length > 0) {
      return res.status(400).json({
        error: "Missing recipient device envelopes",
        missingDeviceIds: missingRecipientTargets,
      });
    }

    const missingSenderTargets = findMissingEligibleTargets(
      senderEligibleTargets,
      coverage.senderTargets,
    );
    if (missingSenderTargets.length > 0) {
      return res.status(400).json({
        error: "Missing sender device envelopes",
        missingDeviceIds: missingSenderTargets,
      });
    }

    if (!coverage.senderTargets.has(session.deviceId)) {
      return res.status(400).json({
        error: "The current sender device must include its own encrypted envelope",
      });
    }

    const now = Date.now();
    const stored = await storeDirectMessageV2({
      message: {
        id: uuidv4(),
        conversationId: [session.userId, recipientId]
          .sort((left, right) => left.localeCompare(right))
          .join(":"),
        senderUserId: session.userId,
        senderDeviceId: session.deviceId,
        recipientUserId: recipientId,
        messageType,
        serverTimestamp: now,
        clientTimestamp:
          typeof req.body?.clientTimestamp === "number" &&
          Number.isFinite(req.body.clientTimestamp)
            ? req.body.clientTimestamp
            : undefined,
        clientMessageId:
          typeof req.body?.clientMessageId === "string" &&
          req.body.clientMessageId.trim().length > 0
            ? req.body.clientMessageId.trim()
            : undefined,
        deletedForEveryone: false,
        createdAt: now,
      },
      envelopes,
    });

    if (!stored) {
      return res.status(500).json({ error: "Failed to store direct message v2" });
    }

    return res.status(200).json({
      success: true,
      recipientDeviceCount: recipientEligibleTargets.size,
      senderDeviceCount: senderEligibleTargets.size,
      serverTimestamp: now,
    });
  } catch (error) {
    console.error("Send message v2 error:", error);
    const message = error instanceof Error ? error.message : "Failed to send direct message v2";
    const status =
      message === "Authentication required" || message === "Invalid or expired session"
        ? 401
        : message === "Current session is missing a device binding"
          ? 400
          : 500;
    return res.status(status).json({ error: message });
  }
};

export const handleGetConversationV2: RequestHandler = async (req, res) => {
  try {
    if (!isDirectMessageV2DatabaseConnected()) {
      return res.status(503).json({
        error: "Direct message v2 requires PostgreSQL storage",
      });
    }

    const session = await requireDeviceSession(req);
    const recipientId = await resolveRecipientUserId({
      recipientId: req.params.recipientId,
      usernameParam: req.params.username,
      requesterUserId: session.userId,
    });

    if (!recipientId) {
      return res.status(400).json({ error: "recipientId is required" });
    }

    const { limit, offset } = parsePagination(req.query.limit, req.query.offset);
    await markDirectMessageV2Delivered({
      userId: session.userId,
      deviceId: session.deviceId,
      otherUserId: recipientId,
    });

    const [messages, total] = await Promise.all([
      getVisibleDirectMessagesV2({
        userId: session.userId,
        deviceId: session.deviceId,
        otherUserId: recipientId,
        limit,
        offset,
      }),
      getDirectMessageV2Count(session.userId, session.deviceId, recipientId),
    ]);

    const receiptSummaries = await Promise.all(
      messages.map(async (message) => ({
        messageId: message.id,
        summary: await summarizeDirectMessageV2Receipts(message.id),
      })),
    );
    const receiptSummaryByMessageId = Object.fromEntries(
      receiptSummaries
        .filter((entry) => !!entry.summary)
        .map((entry) => [entry.messageId, entry.summary]),
    );

    return res.status(200).json({
      messages,
      total,
      limit,
      offset,
      hasMore: offset + messages.length < total,
      receiptSummaryByMessageId,
      deviceId: session.deviceId,
    });
  } catch (error) {
    console.error("Get conversation v2 error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to load direct message v2 conversation";
    const status =
      message === "Authentication required" || message === "Invalid or expired session"
        ? 401
        : message === "Current session is missing a device binding"
          ? 400
          : 500;
    return res.status(status).json({ error: message });
  }
};

export const handleMarkConversationAsReadV2: RequestHandler = async (
  req,
  res,
) => {
  try {
    if (!isDirectMessageV2DatabaseConnected()) {
      return res.status(503).json({
        error: "Direct message v2 requires PostgreSQL storage",
      });
    }

    const session = await requireDeviceSession(req);
    const recipientId = await resolveRecipientUserId({
      recipientId: req.params.recipientId,
      usernameParam: req.params.username,
      requesterUserId: session.userId,
    });

    if (!recipientId) {
      return res.status(400).json({ error: "Missing recipientId" });
    }

    const updatedCount = await markDirectMessageV2Seen({
      userId: session.userId,
      deviceId: session.deviceId,
      otherUserId: recipientId,
    });

    return res.status(200).json({
      success: true,
      updatedCount,
      deviceId: session.deviceId,
      message: "Conversation marked as read",
    });
  } catch (error) {
    console.error("Mark conversation as read v2 error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to mark direct message v2 conversation as read";
    const status =
      message === "Authentication required" || message === "Invalid or expired session"
        ? 401
        : message === "Current session is missing a device binding"
          ? 400
          : 500;
    return res.status(status).json({ error: message });
  }
};
