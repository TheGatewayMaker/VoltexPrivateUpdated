import { RequestHandler } from "express";
import crypto from "crypto";
import { extractBearerToken } from "../lib/auth";
import { getSessionFromToken, verifyRecoveryProofForUser } from "./auth";
import { getUserDevice, saveUserDevice } from "../lib/device-store";
import { saveDeviceBundle } from "../lib/protocol-store";
import {
  getActiveAccountHistoryKey,
  getDeviceLinkRequest,
  listWrappedHistoryKeysForDevice,
  saveAccountHistoryKey,
  saveDeviceLinkRequest,
  saveWrappedHistoryKey,
} from "../lib/history-key-store";
import { isValidPublicKey, isValidSignature } from "../lib/crypto";

const DEVICE_LINK_TTL_MS = 10 * 60 * 1000;

function randomId(bytes: number = 16): string {
  return crypto.randomBytes(bytes).toString("hex");
}

async function requireSession(req: Parameters<RequestHandler>[0]) {
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

export const handleStartDeviceLink: RequestHandler = async (req, res) => {
  try {
    const session = await requireSession(req);
    const currentDevice = await getUserDevice(session.userId, session.deviceId!);
    if (!currentDevice || currentDevice.status !== "active") {
      return res.status(403).json({ error: "Current device is not eligible to link devices" });
    }

    const createdAt = Date.now();
    const linkId = randomId(12);
    const challenge = randomId(24);
    const expiresAt = createdAt + DEVICE_LINK_TTL_MS;

    await saveDeviceLinkRequest({
      linkId,
      userId: session.userId,
      requestedByDeviceId: session.deviceId!,
      challenge,
      status: "pending",
      createdAt,
      expiresAt,
    });

    return res.status(200).json({
      linkId,
      challenge,
      expiresAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start device link";
    const status =
      message === "Authentication required" || message === "Invalid or expired session"
        ? 401
        : message === "Current session is missing a device binding"
          ? 400
          : 500;
    return res.status(status).json({ error: message });
  }
};

export const handleCompleteDeviceLink: RequestHandler = async (req, res) => {
  try {
    const session = await requireSession(req);
    const {
      linkId,
      challenge,
      deviceBundle,
      wrappedHistoryKey,
      wrapperAlgorithm,
      historyKeyVersion,
    } = req.body || {};

    if (
      typeof linkId !== "string" ||
      typeof challenge !== "string" ||
      !deviceBundle ||
      typeof deviceBundle !== "object" ||
      typeof wrappedHistoryKey !== "string" ||
      typeof wrapperAlgorithm !== "string"
    ) {
      return res.status(400).json({ error: "Invalid device link payload" });
    }

    const linkRequest = await getDeviceLinkRequest(linkId);
    if (!linkRequest || linkRequest.userId !== session.userId) {
      return res.status(404).json({ error: "Link request not found" });
    }

    if (linkRequest.status !== "pending" || linkRequest.expiresAt < Date.now()) {
      return res.status(410).json({ error: "Link request expired or already used" });
    }

    if (linkRequest.requestedByDeviceId !== session.deviceId) {
      return res.status(403).json({ error: "Link request must be completed from the originating device" });
    }

    if (linkRequest.challenge !== challenge) {
      return res.status(403).json({ error: "Invalid device link challenge" });
    }

    const nextDeviceId =
      typeof deviceBundle.deviceId === "string" ? deviceBundle.deviceId.trim() : "";
    if (!nextDeviceId) {
      return res.status(400).json({ error: "Target device ID is required" });
    }

    if (
      typeof deviceBundle.identityKey !== "string" ||
      typeof deviceBundle.signingKey !== "string" ||
      !deviceBundle.signedPreKey ||
      !Array.isArray(deviceBundle.oneTimePreKeys)
    ) {
      return res.status(400).json({ error: "Invalid device bundle" });
    }

    if (
      !isValidPublicKey(deviceBundle.identityKey) ||
      !isValidPublicKey(deviceBundle.signingKey) ||
      typeof deviceBundle.signedPreKey.keyId !== "number" ||
      !isValidPublicKey(deviceBundle.signedPreKey.publicKey) ||
      !isValidSignature(deviceBundle.signedPreKey.signature)
    ) {
      return res.status(400).json({ error: "Invalid protocol bundle cryptography" });
    }

    for (const preKey of deviceBundle.oneTimePreKeys) {
      if (
        typeof preKey?.keyId !== "number" ||
        !isValidPublicKey(preKey.publicKey)
      ) {
        return res.status(400).json({ error: "Invalid one-time prekey" });
      }
    }

    const currentHistoryKey = await getActiveAccountHistoryKey(session.userId);
    const resolvedHistoryKeyVersion =
      typeof historyKeyVersion === "number" &&
      Number.isInteger(historyKeyVersion) &&
      historyKeyVersion >= 1
        ? historyKeyVersion
        : currentHistoryKey?.historyKeyVersion || 1;

    if (!currentHistoryKey) {
      await saveAccountHistoryKey({
        userId: session.userId,
        historyKeyVersion: resolvedHistoryKeyVersion,
        status: "active",
        createdAt: Date.now(),
      });
    }

    const now = Date.now();
    await saveDeviceBundle({
      userId: session.userId,
      deviceId: nextDeviceId,
      identityKey: deviceBundle.identityKey,
      signingKey: deviceBundle.signingKey,
      signedPreKey: deviceBundle.signedPreKey,
      oneTimePreKeys: deviceBundle.oneTimePreKeys,
      registrationVersion:
        typeof deviceBundle.registrationVersion === "number" &&
        Number.isInteger(deviceBundle.registrationVersion) &&
        deviceBundle.registrationVersion >= 1
          ? deviceBundle.registrationVersion
          : 1,
      supportedMessageVersions: Array.isArray(deviceBundle.supportedMessageVersions)
        ? deviceBundle.supportedMessageVersions.filter(
            (value: unknown): value is "v1" | "v2" => value === "v1" || value === "v2",
          )
        : ["v1"],
      createdAt: now,
      updatedAt: now,
    });

    await saveUserDevice({
      userId: session.userId,
      deviceId: nextDeviceId,
      deviceName:
        typeof req.body?.deviceName === "string" ? req.body.deviceName.trim() : undefined,
      platform:
        typeof req.body?.platform === "string" ? req.body.platform.trim() : undefined,
      appKind:
        req.body?.appKind === "android" ||
        req.body?.appKind === "ios" ||
        req.body?.appKind === "desktop"
          ? req.body.appKind
          : "web",
      status: "active",
      linkedAt: now,
      lastSeenAt: now,
      createdByDeviceId: session.deviceId,
    });

    await saveWrappedHistoryKey({
      userId: session.userId,
      historyKeyVersion: resolvedHistoryKeyVersion,
      deviceId: nextDeviceId,
      wrappedKey: wrappedHistoryKey,
      wrapperAlgorithm,
      createdAt: now,
    });

    await saveDeviceLinkRequest({
      ...linkRequest,
      status: "completed",
      completedAt: now,
      targetDeviceId: nextDeviceId,
    });

    return res.status(200).json({
      success: true,
      deviceId: nextDeviceId,
      historyKeyVersion: resolvedHistoryKeyVersion,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to complete device link";
    const status =
      message === "Authentication required" || message === "Invalid or expired session"
        ? 401
        : message === "Current session is missing a device binding"
          ? 400
          : 500;
    return res.status(status).json({ error: message });
  }
};

export const handleListWrappedHistoryKeys: RequestHandler = async (req, res) => {
  try {
    const session = await requireSession(req);
    const wrappedKeys = await listWrappedHistoryKeysForDevice(
      session.userId,
      session.deviceId!,
    );

    return res.status(200).json({
      deviceId: session.deviceId,
      wrappedKeys,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load wrapped history keys";
    const status =
      message === "Authentication required" || message === "Invalid or expired session"
        ? 401
        : message === "Current session is missing a device binding"
          ? 400
          : 500;
    return res.status(status).json({ error: message });
  }
};

export const handleInitializeHistoryKey: RequestHandler = async (req, res) => {
  try {
    const session = await requireSession(req);
    const {
      wrappedKey,
      wrapperAlgorithm,
      historyKeyVersion,
    } = req.body || {};

    if (
      typeof wrappedKey !== "string" ||
      typeof wrapperAlgorithm !== "string"
    ) {
      return res.status(400).json({ error: "Wrapped history key payload is required" });
    }

    const passphraseVerified = await verifyRecoveryProofForUser(
      session.userId,
      req.body || {},
    );
    if (!passphraseVerified) {
      return res.status(403).json({ error: "Invalid recovery passphrase" });
    }

    const existing = await getActiveAccountHistoryKey(session.userId);
    const version =
      typeof historyKeyVersion === "number" &&
      Number.isInteger(historyKeyVersion) &&
      historyKeyVersion >= 1
        ? historyKeyVersion
        : existing?.historyKeyVersion || 1;

    if (!existing) {
      await saveAccountHistoryKey({
        userId: session.userId,
        historyKeyVersion: version,
        status: "active",
        createdAt: Date.now(),
      });
    }

    await saveWrappedHistoryKey({
      userId: session.userId,
      historyKeyVersion: version,
      deviceId: session.deviceId!,
      wrappedKey,
      wrapperAlgorithm,
      createdAt: Date.now(),
    });

    return res.status(200).json({
      success: true,
      historyKeyVersion: version,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to initialize history key";
    const status =
      message === "Authentication required" || message === "Invalid or expired session"
        ? 401
        : message === "Current session is missing a device binding"
          ? 400
          : message === "Invalid recovery passphrase"
            ? 403
            : 500;
    return res.status(status).json({ error: message });
  }
};
