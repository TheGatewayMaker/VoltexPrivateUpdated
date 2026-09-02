import { RequestHandler } from "express";
import { getSessionFromToken } from "./auth";
import { getUserAccount } from "../lib/auth-store";
import { isDirectMessageBlocked } from "../lib/block-store";
import { requireGroupMember } from "../lib/group-store";
import {
  ENCRYPTED_MEDIA_CONTENT_TYPE,
  getImageMediaRecord,
  IMAGE_CONTENT_TYPES,
  isSupportedImageContentType,
  readImageMediaBody,
  saveImageMedia,
} from "../lib/media-storage";
import { asyncLimiters, isOverloadedError } from "../lib/load-control";
import {
  normalizeUsernameForLookup,
  resolveDiscoverableUserIdByUsername,
} from "../lib/username-discovery";

const MAX_IMAGE_UPLOAD_BYTES = 12 * 1024 * 1024;
const MAX_ENCRYPTED_IMAGE_UPLOAD_BYTES = MAX_IMAGE_UPLOAD_BYTES + 1024;
const ENCRYPTED_MEDIA_VERSION = "aes-gcm-v1";

async function requireSession(req: Parameters<RequestHandler>[0]) {
  const authHeader = req.headers.authorization;
  const sessionToken =
    typeof authHeader === "string"
      ? authHeader.replace("Bearer ", "")
      : undefined;

  if (!sessionToken) {
    throw new Error("Unauthorized");
  }

  const session = await getSessionFromToken(sessionToken);
  if (!session) {
    throw new Error("Invalid session");
  }

  return session;
}

function normalizeUsername(value: unknown): string {
  return normalizeUsernameForLookup(value);
}

function getUploadedImageBuffer(req: Parameters<RequestHandler>[0]): Buffer {
  return Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
}

function getMediaEncryptionHeader(
  req: Parameters<RequestHandler>[0],
): "aes-gcm-v1" | null {
  const value =
    typeof req.headers["x-voltex-media-encryption"] === "string"
      ? req.headers["x-voltex-media-encryption"].trim().toLowerCase()
      : "";
  return value === ENCRYPTED_MEDIA_VERSION ? ENCRYPTED_MEDIA_VERSION : null;
}

function getOriginalImageContentType(
  req: Parameters<RequestHandler>[0],
): (typeof IMAGE_CONTENT_TYPES)[number] | null {
  const value =
    typeof req.headers["x-voltex-original-content-type"] === "string"
      ? req.headers["x-voltex-original-content-type"].split(";")[0].trim().toLowerCase()
      : "";
  return isSupportedImageContentType(value) ? value : null;
}

function validateUploadRequest(
  req: Parameters<RequestHandler>[0],
): {
  buffer: Buffer;
  contentType: (typeof IMAGE_CONTENT_TYPES)[number] | typeof ENCRYPTED_MEDIA_CONTENT_TYPE;
  width?: string;
  height?: string;
  encryptionVersion?: "aes-gcm-v1";
  originalContentType?: (typeof IMAGE_CONTENT_TYPES)[number];
} {
  const buffer = getUploadedImageBuffer(req);
  if (buffer.length === 0) {
    throw new Error("Image body is required");
  }

  const encryptionVersion = getMediaEncryptionHeader(req);
  if (!encryptionVersion) {
    throw new Error("Encrypted image upload is required");
  }

  if (buffer.length > MAX_IMAGE_UPLOAD_BYTES) {
    throw new Error("Image exceeds the 12MB limit");
  }

  const originalContentType = getOriginalImageContentType(req);
  if (!originalContentType) {
    throw new Error("Encrypted image uploads must declare the original image type");
  }

  if (buffer.length > MAX_ENCRYPTED_IMAGE_UPLOAD_BYTES) {
    throw new Error("Image exceeds the 12MB limit");
  }

  return {
    buffer,
    contentType: ENCRYPTED_MEDIA_CONTENT_TYPE,
    width:
      typeof req.headers["x-image-width"] === "string"
        ? req.headers["x-image-width"]
        : undefined,
    height:
      typeof req.headers["x-image-height"] === "string"
        ? req.headers["x-image-height"]
        : undefined,
    encryptionVersion,
    originalContentType,
  };
}

export const handleUploadDirectImage: RequestHandler = async (req, res) => {
  try {
    const session = await requireSession(req);
    const recipientUsername = normalizeUsername(req.params.username);
    if (!recipientUsername) {
      return res.status(400).json({ error: "Recipient username is required" });
    }

    const recipientId = await resolveDiscoverableUserIdByUsername({
      username: recipientUsername,
      requesterUserId: session.userId,
    });
    if (!recipientId) {
      return res.status(404).json({ error: "Recipient not found" });
    }

    const senderAccount = await getUserAccount(session.userId);
    const senderUsername = normalizeUsername(senderAccount?.username);
    if (!senderUsername) {
      return res.status(500).json({ error: "Sender username is unavailable" });
    }

    const blockStatus = await isDirectMessageBlocked(session.userId, recipientId);
    if (!blockStatus.canSend) {
      return res.status(403).json({
        error: "Image sending is unavailable for this conversation",
        code: "DIRECT_MESSAGE_BLOCKED",
        blockStatus,
      });
    }

    const upload = validateUploadRequest(req);

    let record;
    try {
      record = await asyncLimiters.mediaMutation.run(() =>
        saveImageMedia({
          ownerId: session.userId,
          scope: {
            type: "direct",
            participantIds: [session.userId, recipientId],
            participantUsernames: [senderUsername, recipientUsername],
          },
          buffer: upload.buffer,
          contentType: upload.contentType,
          width: upload.width,
          height: upload.height,
          encryptionVersion: upload.encryptionVersion,
          originalContentType: upload.originalContentType,
        }),
      );
    } catch (error) {
      if (isOverloadedError(error)) {
        return res.status(error.statusCode).json({
          error: error.message,
          retryAfter: error.retryAfterSeconds,
        });
      }
      throw error;
    }

    return res.status(201).json({
      mediaId: record.id,
      mimeType: record.contentType,
      size: record.size,
      width: record.width,
      height: record.height,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to upload image";
    const status =
      message === "Unauthorized" || message === "Invalid session"
        ? 401
        : message === "Image body is required" ||
            message === "Encrypted image upload is required" ||
            message === "Image exceeds the 12MB limit" ||
            message === "Encrypted image uploads must declare the original image type"
          ? 400
          : 500;
    return res.status(status).json({ error: message });
  }
};

export const handleUploadGroupImage: RequestHandler = async (req, res) => {
  try {
    const session = await requireSession(req);
    const groupId =
      typeof req.params.groupId === "string" ? req.params.groupId.trim() : "";
    if (!groupId) {
      return res.status(400).json({ error: "Group ID is required" });
    }

    await requireGroupMember(groupId, session.userId);
    const upload = validateUploadRequest(req);

    let record;
    try {
      record = await asyncLimiters.mediaMutation.run(() =>
        saveImageMedia({
          ownerId: session.userId,
          scope: {
            type: "group",
            groupId,
          },
          buffer: upload.buffer,
          contentType: upload.contentType,
          width: upload.width,
          height: upload.height,
          encryptionVersion: upload.encryptionVersion,
          originalContentType: upload.originalContentType,
        }),
      );
    } catch (error) {
      if (isOverloadedError(error)) {
        return res.status(error.statusCode).json({
          error: error.message,
          retryAfter: error.retryAfterSeconds,
        });
      }
      throw error;
    }

    return res.status(201).json({
      mediaId: record.id,
      mimeType: record.contentType,
      size: record.size,
      width: record.width,
      height: record.height,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to upload image";
    const status =
      message === "Unauthorized" || message === "Invalid session"
        ? 401
        : message === "Group not found" || message === "You are not an active member of this group"
          ? 404
        : message === "Group ID is required" ||
              message === "Image body is required" ||
              message === "Encrypted image upload is required" ||
              message === "Image exceeds the 12MB limit" ||
              message === "Encrypted image uploads must declare the original image type"
            ? 400
            : 500;
    return res.status(status).json({ error: message });
  }
};

export const handleGetImageMedia: RequestHandler = async (req, res) => {
  try {
    const session = await requireSession(req);
    const mediaId =
      typeof req.params.mediaId === "string" ? req.params.mediaId.trim() : "";
    if (!mediaId) {
      return res.status(400).json({ error: "Media ID is required" });
    }

    const record = await getImageMediaRecord(mediaId);
    if (!record) {
      return res.status(404).end();
    }

    if (record.type === "direct") {
      if (!record.participantIds.includes(session.userId)) {
        return res.status(403).end();
      }
    } else {
      try {
        await requireGroupMember(record.groupId, session.userId);
      } catch {
        return res.status(403).end();
      }
    }

    let body;
    try {
      body = await asyncLimiters.mediaRead.run(() => readImageMediaBody(record));
    } catch (error) {
      if (isOverloadedError(error)) {
        return res.status(error.statusCode).json({
          error: error.message,
          retryAfter: error.retryAfterSeconds,
        });
      }
      throw error;
    }

    res.removeHeader("Pragma");
    res.removeHeader("Expires");
    res.setHeader("Cache-Control", "private, max-age=86400, immutable");
    res.setHeader("Content-Type", record.contentType);
    if (record.originalContentType) {
      res.setHeader("X-Voltex-Original-Content-Type", record.originalContentType);
    }
    if (record.encryptionVersion) {
      res.setHeader("X-Voltex-Media-Encryption", record.encryptionVersion);
    }
    res.setHeader("Content-Length", String(body.length));
    res.setHeader("ETag", `"${record.sha256}"`);
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    return res.status(200).send(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load image";
    const status =
      message === "Unauthorized" || message === "Invalid session" ? 401 : 500;
    return res.status(status).json({ error: message });
  }
};
