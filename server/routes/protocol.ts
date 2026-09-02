import { RequestHandler } from "express";
import { getSessionFromToken } from "./auth";
import {
  consumePreKey,
  getAnyDeviceBundle,
  listDeviceBundles,
  saveDeviceBundle,
} from "../lib/protocol-store";
import { isValidPublicKey, isValidSignature } from "../lib/crypto";
import {
  normalizeUsernameForLookup,
  resolveDiscoverableUserIdByUsername,
} from "../lib/username-discovery";

function normalizeUsername(value: unknown): string {
  return normalizeUsernameForLookup(value);
}

function normalizeSupportedMessageVersions(
  value: unknown,
): Array<"v1" | "v2"> {
  if (!Array.isArray(value)) {
    return ["v1"];
  }

  const supported = value.filter(
    (entry): entry is "v1" | "v2" => entry === "v1" || entry === "v2",
  );

  if (supported.length === 0) {
    return ["v1"];
  }

  return Array.from(new Set(supported));
}

async function resolveProtocolTarget(
  req: Parameters<RequestHandler>[0],
  requesterUserId?: string,
) {
  const requestedUserId =
    typeof req.params.userId === "string" ? req.params.userId.trim() : "";
  if (requestedUserId) {
    return requestedUserId;
  }

  const username = normalizeUsername(req.params.username);
  if (!username) {
    return "";
  }

  return resolveDiscoverableUserIdByUsername({
    username,
    requesterUserId,
  });
}

export const handleRegisterDeviceBundle: RequestHandler = async (req, res) => {
  try {
    const sessionToken = req.headers.authorization?.replace("Bearer ", "");
    if (!sessionToken) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const session = await getSessionFromToken(sessionToken);
    if (!session) {
      return res.status(401).json({ error: "Invalid session" });
    }

    const {
      deviceId,
      identityKey,
      signingKey,
      signedPreKey,
      oneTimePreKeys,
      registrationVersion,
      supportedMessageVersions,
    } = req.body || {};

    if (
      typeof deviceId !== "string" ||
      !deviceId ||
      typeof identityKey !== "string" ||
      typeof signingKey !== "string" ||
      !signedPreKey ||
      !Array.isArray(oneTimePreKeys)
    ) {
      return res.status(400).json({ error: "Invalid device bundle" });
    }

    if (!isValidPublicKey(identityKey) || !isValidPublicKey(signingKey)) {
      return res.status(400).json({ error: "Invalid protocol public keys" });
    }

    if (
      typeof signedPreKey.keyId !== "number" ||
      !isValidPublicKey(signedPreKey.publicKey) ||
      !isValidSignature(signedPreKey.signature)
    ) {
      return res.status(400).json({ error: "Invalid signed prekey" });
    }

    for (const preKey of oneTimePreKeys) {
      if (
        typeof preKey?.keyId !== "number" ||
        !isValidPublicKey(preKey.publicKey)
      ) {
        return res.status(400).json({ error: "Invalid one-time prekey" });
      }
    }

    const now = Date.now();
    await saveDeviceBundle({
      userId: session.userId,
      deviceId,
      identityKey,
      signingKey,
      signedPreKey,
      oneTimePreKeys,
      registrationVersion:
        typeof registrationVersion === "number" &&
        Number.isInteger(registrationVersion) &&
        registrationVersion >= 1
          ? registrationVersion
          : 1,
      supportedMessageVersions:
        normalizeSupportedMessageVersions(supportedMessageVersions),
      createdAt: now,
      updatedAt: now,
    });

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Register device bundle error:", error);
    return res.status(500).json({ error: "Failed to register device bundle" });
  }
};

export const handleGetProtocolBundle: RequestHandler = async (req, res) => {
  try {
    const sessionToken =
      typeof req.headers.authorization === "string"
        ? req.headers.authorization.replace("Bearer ", "")
        : undefined;
    const session = sessionToken ? await getSessionFromToken(sessionToken) : null;

    const userId = await resolveProtocolTarget(req, session?.userId);
    if (!userId) {
      return res.status(404).json({ error: "User not found" });
    }

    const bundle = await getAnyDeviceBundle(userId);
    if (!bundle) {
      return res.status(404).json({ error: "No device bundle available" });
    }

    return res.status(200).json({
      deviceId: bundle.deviceId,
      identityKey: bundle.identityKey,
      signingKey: bundle.signingKey,
      signedPreKey: bundle.signedPreKey,
      oneTimePreKeyCount: bundle.oneTimePreKeys.length,
      registrationVersion: bundle.registrationVersion || 1,
      supportedMessageVersions: bundle.supportedMessageVersions || ["v1"],
    });
  } catch (error) {
    console.error("Get protocol bundle error:", error);
    return res.status(500).json({ error: "Failed to get protocol bundle" });
  }
};

export const handleGetProtocolBundles: RequestHandler = async (req, res) => {
  try {
    const sessionToken =
      typeof req.headers.authorization === "string"
        ? req.headers.authorization.replace("Bearer ", "")
        : undefined;
    const session = sessionToken ? await getSessionFromToken(sessionToken) : null;

    const userId = await resolveProtocolTarget(req, session?.userId);
    if (!userId) {
      return res.status(404).json({ error: "User not found" });
    }

    const bundles = await listDeviceBundles(userId);
    if (bundles.length === 0) {
      return res.status(404).json({ error: "No device bundles available" });
    }

    return res.status(200).json({
      userId,
      bundles: bundles.map((bundle) => ({
        deviceId: bundle.deviceId,
        identityKey: bundle.identityKey,
        signingKey: bundle.signingKey,
        signedPreKey: bundle.signedPreKey,
        oneTimePreKeyCount: bundle.oneTimePreKeys.length,
        registrationVersion: bundle.registrationVersion || 1,
        supportedMessageVersions: bundle.supportedMessageVersions || ["v1"],
        updatedAt: bundle.updatedAt,
      })),
    });
  } catch (error) {
    console.error("Get protocol bundles error:", error);
    return res.status(500).json({ error: "Failed to get protocol bundles" });
  }
};

export const handleConsumeProtocolBundle: RequestHandler = async (req, res) => {
  try {
    const sessionToken =
      typeof req.headers.authorization === "string"
        ? req.headers.authorization.replace("Bearer ", "")
        : undefined;
    const session = sessionToken ? await getSessionFromToken(sessionToken) : null;

    const userId = await resolveProtocolTarget(req, session?.userId);
    if (!userId) {
      return res.status(404).json({ error: "User not found" });
    }

    const latestBundle = await getAnyDeviceBundle(userId);
    if (!latestBundle) {
      return res.status(404).json({ error: "No protocol bundle available" });
    }

    const result = await consumePreKey(userId, latestBundle.deviceId);
    if (!result) {
      return res.status(404).json({ error: "No protocol bundle available" });
    }

    return res.status(200).json({
      deviceId: result.bundle.deviceId,
      identityKey: result.bundle.identityKey,
      signingKey: result.bundle.signingKey,
      signedPreKey: result.bundle.signedPreKey,
      oneTimePreKey: result.preKey,
      remainingOneTimePreKeys: result.bundle.oneTimePreKeys.length,
      registrationVersion: result.bundle.registrationVersion || 1,
      supportedMessageVersions:
        result.bundle.supportedMessageVersions || ["v1"],
    });
  } catch (error) {
    console.error("Consume protocol bundle error:", error);
    return res.status(500).json({ error: "Failed to consume protocol bundle" });
  }
};

export const handleConsumeProtocolDeviceBundle: RequestHandler = async (
  req,
  res,
) => {
  try {
    const sessionToken =
      typeof req.headers.authorization === "string"
        ? req.headers.authorization.replace("Bearer ", "")
        : undefined;
    const session = sessionToken ? await getSessionFromToken(sessionToken) : null;

    const userId = await resolveProtocolTarget(req, session?.userId);
    if (!userId) {
      return res.status(404).json({ error: "User not found" });
    }

    const deviceId =
      typeof req.params.deviceId === "string" ? req.params.deviceId.trim() : "";
    if (!deviceId) {
      return res.status(400).json({ error: "deviceId is required" });
    }

    const result = await consumePreKey(userId, deviceId);
    if (!result) {
      return res.status(404).json({ error: "No protocol bundle available" });
    }

    return res.status(200).json({
      deviceId: result.bundle.deviceId,
      identityKey: result.bundle.identityKey,
      signingKey: result.bundle.signingKey,
      signedPreKey: result.bundle.signedPreKey,
      oneTimePreKey: result.preKey,
      remainingOneTimePreKeys: result.bundle.oneTimePreKeys.length,
      registrationVersion: result.bundle.registrationVersion || 1,
      supportedMessageVersions:
        result.bundle.supportedMessageVersions || ["v1"],
    });
  } catch (error) {
    console.error("Consume protocol device bundle error:", error);
    return res.status(500).json({ error: "Failed to consume protocol device bundle" });
  }
};
