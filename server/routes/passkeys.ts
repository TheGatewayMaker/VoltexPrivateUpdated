import { RequestHandler } from "express";
import crypto from "crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type VerifiedAuthenticationResponse,
  type VerifiedRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticatorTransportFuture,
  WebAuthnCredential,
} from "@simplewebauthn/server";
import { extractBearerToken } from "../lib/auth";
import { getSessionFromToken, createAuthenticatedSession, verifyRecoveryProofForUser } from "./auth";
import { getUserAccount } from "../lib/auth-store";
import { getUserProfile } from "../lib/profile-store";
import {
  cleanupExpiredPasskeyChallenges,
  deletePasskeyChallenge,
  deletePasskeyCredentialForUser,
  getPasskeyChallenge,
  getPasskeyCredentialByCredentialId,
  getPasskeyCredentialByUserId,
  savePasskeyChallenge,
  savePasskeyCredential,
} from "../lib/passkey-store";
import { PasskeyStatusResponse } from "@shared/passkeys";
import {
  enforcePreAuthAccessGuards,
  logAuthSuccess,
} from "../lib/admin-panel-store";

const PASSKEY_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const PASSKEY_TIMEOUT_MS = 90_000;
const PASSKEY_STEP_UP_TTL_MS = 2 * 60 * 1000;
const RP_NAME = "Voltex";
const passkeyStepUpTokens = new Map<
  string,
  {
    userId: string;
    expiresAt: number;
  }
>();

type PreferredAuthenticatorType = "securityKey" | "localDevice" | "remoteDevice";

function normalizePreferredAuthenticatorType(
  value: unknown,
): PreferredAuthenticatorType | undefined {
  return value === "securityKey" ||
    value === "localDevice" ||
    value === "remoteDevice"
    ? value
    : undefined;
}

function getRequestOrigin(req: Parameters<RequestHandler>[0]): string {
  const hostHeader = req.headers.host;
  if (!hostHeader || typeof hostHeader !== "string") {
    throw new Error("Request host is unavailable");
  }

  const forwardedProtoHeader = req.headers["x-forwarded-proto"];
  const forwardedProto =
    typeof forwardedProtoHeader === "string"
      ? forwardedProtoHeader.split(",")[0]?.trim()
      : undefined;
  const protocol =
    forwardedProto ||
    (req.secure
      ? "https"
      : process.env.NODE_ENV === "production"
        ? "https"
        : "http");

  return `${protocol}://${hostHeader}`;
}

function getExpectedOrigins(req: Parameters<RequestHandler>[0]): string[] {
  const origins = new Set<string>();
  const addOrigin = (value?: string | null) => {
    if (!value) {
      return;
    }

    try {
      origins.add(new URL(value).origin);
    } catch {
      // Ignore malformed configured origins.
    }
  };

  addOrigin(process.env.PUBLIC_APP_ORIGIN || null);
  addOrigin(getRequestOrigin(req));

  const configuredOrigins = process.env.ALLOWED_ORIGINS;
  if (configuredOrigins) {
    configuredOrigins
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
      .forEach((origin) => addOrigin(origin));
  }

  return Array.from(origins);
}

function getExpectedRpIds(req: Parameters<RequestHandler>[0]): string[] {
  const rpIds = new Set<string>();
  const configuredRpId = process.env.PASSKEY_RP_ID?.trim();
  if (configuredRpId) {
    rpIds.add(configuredRpId);
  }

  for (const origin of getExpectedOrigins(req)) {
    try {
      rpIds.add(new URL(origin).hostname);
    } catch {
      // Ignore malformed origin.
    }
  }

  return Array.from(rpIds);
}

function getPrimaryRpId(req: Parameters<RequestHandler>[0]): string {
  const rpIds = getExpectedRpIds(req);
  if (rpIds.length === 0) {
    throw new Error("Unable to determine passkey RP ID");
  }
  return rpIds[0];
}

function toWebAuthnCredential(
  record: NonNullable<Awaited<ReturnType<typeof getPasskeyCredentialByCredentialId>>>,
): WebAuthnCredential {
  return {
    id: record.credentialId,
    publicKey: new Uint8Array(Buffer.from(record.publicKey, "base64url")),
    counter: record.counter,
    transports: (record.transports || []) as AuthenticatorTransportFuture[],
  };
}

async function getAuthenticatedSession(
  req: Parameters<RequestHandler>[0],
) {
  const sessionToken = extractBearerToken(req);
  if (!sessionToken) {
    return null;
  }

  return getSessionFromToken(sessionToken);
}

async function requireVerifiedPassphrase(
  userId: string,
  body: Record<string, unknown>,
): Promise<boolean> {
  return verifyRecoveryProofForUser(userId, {
    passphraseHash: body.passphraseHash,
    recoveryVerifier: body.recoveryVerifier,
  });
}

function buildStatusResponse(
  record: Awaited<ReturnType<typeof getPasskeyCredentialByUserId>>,
): PasskeyStatusResponse {
  if (!record) {
    return { enabled: false };
  }

  return {
    enabled: true,
    credentialId: record.credentialId,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt || null,
    deviceType: record.deviceType,
    backedUp: record.backedUp,
  };
}

export { cleanupExpiredPasskeyChallenges };
export function cleanupExpiredPasskeyStepUpTokens(): void {
  const now = Date.now();
  for (const [token, data] of passkeyStepUpTokens.entries()) {
    if (data.expiresAt < now) {
      passkeyStepUpTokens.delete(token);
    }
  }
}

export function consumePasskeyStepUpToken(
  userId: string,
  token: string,
): boolean {
  const record = passkeyStepUpTokens.get(token);
  if (!record) {
    return false;
  }

  passkeyStepUpTokens.delete(token);
  if (record.expiresAt < Date.now()) {
    return false;
  }

  return record.userId === userId;
}

export const handleGetPasskeyStatus: RequestHandler = async (req, res) => {
  try {
    const session = await getAuthenticatedSession(req);
    if (!session) {
      return res.status(401).json({ error: "Invalid or expired session" });
    }

    const credential = await getPasskeyCredentialByUserId(session.userId);
    return res.status(200).json(buildStatusResponse(credential));
  } catch (error) {
    console.error("[PASSKEYS] Failed to load status:", error);
    return res.status(500).json({ error: "Failed to load passkey status" });
  }
};

export const handleBeginPasskeyRegistration: RequestHandler = async (
  req,
  res,
) => {
  try {
    const session = await getAuthenticatedSession(req);
    if (!session) {
      return res.status(401).json({ error: "Invalid or expired session" });
    }

    const passphraseVerified = await requireVerifiedPassphrase(
      session.userId,
      req.body || {},
    );
    if (!passphraseVerified) {
      return res.status(403).json({ error: "Invalid recovery passphrase" });
    }

    const account = await getUserAccount(session.userId);
    if (!account) {
      return res.status(404).json({ error: "User not found" });
    }

    const profile = await getUserProfile(session.userId);
    const existingCredential = await getPasskeyCredentialByUserId(session.userId);

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: getPrimaryRpId(req),
      userName: account.username || session.userId,
      userDisplayName:
        profile?.displayName || account.username || `Voltex ${session.userId}`,
      userID: new Uint8Array(Buffer.from(session.userId, "utf8")),
      timeout: PASSKEY_TIMEOUT_MS,
      attestationType: "none",
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
      excludeCredentials: existingCredential
        ? [
            {
              id: existingCredential.credentialId,
              transports:
                (existingCredential.transports ||
                  []) as AuthenticatorTransportFuture[],
            },
          ]
        : [],
      preferredAuthenticatorType:
        normalizePreferredAuthenticatorType(req.body?.preferredAuthenticatorType) ||
        "localDevice",
      supportedAlgorithmIDs: [-8, -7, -257],
    });

    const flowId = crypto.randomBytes(24).toString("base64url");
    await savePasskeyChallenge({
      flowId,
      challenge: options.challenge,
      purpose: "registration",
      userId: session.userId,
      expiresAt: Date.now() + PASSKEY_CHALLENGE_TTL_MS,
      createdAt: Date.now(),
    });

    return res.status(200).json({
      flowId,
      options,
      status: buildStatusResponse(existingCredential),
    });
  } catch (error) {
    console.error("[PASSKEYS] Failed to begin registration:", error);
    return res
      .status(500)
      .json({ error: "Failed to start passkey registration" });
  }
};

export const handleVerifyPasskeyRegistration: RequestHandler = async (
  req,
  res,
) => {
  try {
    const session = await getAuthenticatedSession(req);
    if (!session) {
      return res.status(401).json({ error: "Invalid or expired session" });
    }

    const flowId = typeof req.body?.flowId === "string" ? req.body.flowId : "";
    const response = req.body?.response;
    if (!flowId || !response) {
      return res.status(400).json({ error: "flowId and response are required" });
    }

    const flow = await getPasskeyChallenge(flowId);
    if (!flow || flow.purpose !== "registration" || flow.userId !== session.userId) {
      return res.status(400).json({ error: "Passkey registration session not found" });
    }

    await deletePasskeyChallenge(flowId);

    if (flow.expiresAt < Date.now()) {
      return res.status(400).json({ error: "Passkey registration session expired" });
    }

    const verification: VerifiedRegistrationResponse =
      await verifyRegistrationResponse({
        response,
        expectedChallenge: flow.challenge,
        expectedOrigin: getExpectedOrigins(req),
        expectedRPID: getExpectedRpIds(req),
        requireUserVerification: true,
      });

    if (!verification.verified) {
      return res.status(403).json({ error: "Passkey registration could not be verified" });
    }

    const account = await getUserAccount(session.userId);
    if (!account) {
      return res.status(404).json({ error: "User not found" });
    }

    await savePasskeyCredential({
      userId: session.userId,
      credentialId: verification.registrationInfo.credential.id,
      publicKey: Buffer.from(
        verification.registrationInfo.credential.publicKey,
      ).toString("base64url"),
      counter: verification.registrationInfo.credential.counter,
      transports: verification.registrationInfo.credential.transports || [],
      deviceType: verification.registrationInfo.credentialDeviceType,
      backedUp: verification.registrationInfo.credentialBackedUp,
      aaguid: verification.registrationInfo.aaguid,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastUsedAt: null,
    });

    return res.status(200).json({
      success: true,
      status: buildStatusResponse(
        await getPasskeyCredentialByUserId(session.userId),
      ),
      username: account.username || null,
    });
  } catch (error) {
    console.error("[PASSKEYS] Failed to verify registration:", error);
    return res
      .status(500)
      .json({ error: "Failed to verify passkey registration" });
  }
};

export const handleBeginPasskeyAuthentication: RequestHandler = async (
  req,
  res,
) => {
  try {
    const requestedUserId =
      typeof req.body?.userId === "string" && req.body.userId.trim()
        ? req.body.userId.trim()
        : "";
    const requestedCredential = requestedUserId
      ? await getPasskeyCredentialByUserId(requestedUserId)
      : null;

    const options = await generateAuthenticationOptions({
      rpID: getPrimaryRpId(req),
      timeout: PASSKEY_TIMEOUT_MS,
      userVerification: "required",
      allowCredentials: requestedCredential
        ? [
            {
              id: requestedCredential.credentialId,
              transports:
                (requestedCredential.transports ||
                  []) as AuthenticatorTransportFuture[],
            },
          ]
        : undefined,
    });

    const flowId = crypto.randomBytes(24).toString("base64url");
    await savePasskeyChallenge({
      flowId,
      challenge: options.challenge,
      purpose: "authentication",
      userId: requestedUserId || null,
      expiresAt: Date.now() + PASSKEY_CHALLENGE_TTL_MS,
      createdAt: Date.now(),
    });

    return res.status(200).json({
      flowId,
      options,
    });
  } catch (error) {
    console.error("[PASSKEYS] Failed to begin authentication:", error);
    return res
      .status(500)
      .json({ error: "Failed to start passkey authentication" });
  }
};

export const handleBeginPasskeyStepUp: RequestHandler = async (req, res) => {
  try {
    const session = await getAuthenticatedSession(req);
    if (!session) {
      return res.status(401).json({ error: "Invalid or expired session" });
    }

    const credential = await getPasskeyCredentialByUserId(session.userId);
    if (!credential) {
      return res.status(404).json({ error: "Passkey is not enabled" });
    }

    const options = await generateAuthenticationOptions({
      rpID: getPrimaryRpId(req),
      timeout: PASSKEY_TIMEOUT_MS,
      userVerification: "required",
      allowCredentials: [
        {
          id: credential.credentialId,
          transports:
            (credential.transports || []) as AuthenticatorTransportFuture[],
        },
      ],
    });

    const flowId = crypto.randomBytes(24).toString("base64url");
    await savePasskeyChallenge({
      flowId,
      challenge: options.challenge,
      purpose: "step-up",
      userId: session.userId,
      expiresAt: Date.now() + PASSKEY_CHALLENGE_TTL_MS,
      createdAt: Date.now(),
    });

    return res.status(200).json({
      flowId,
      options,
    });
  } catch (error) {
    console.error("[PASSKEYS] Failed to begin step-up authentication:", error);
    return res.status(500).json({ error: "Failed to start passkey verification" });
  }
};

export const handleVerifyPasskeyAuthentication: RequestHandler = async (
  req,
  res,
) => {
  try {
    const flowId = typeof req.body?.flowId === "string" ? req.body.flowId : "";
    const response = req.body?.response;
    if (!flowId || !response) {
      return res.status(400).json({ error: "flowId and response are required" });
    }

    const flow = await getPasskeyChallenge(flowId);
    if (!flow || flow.purpose !== "authentication") {
      return res.status(400).json({ error: "Passkey sign-in session not found" });
    }

    await deletePasskeyChallenge(flowId);

    if (flow.expiresAt < Date.now()) {
      return res.status(400).json({ error: "Passkey sign-in session expired" });
    }

    const credentialId =
      typeof response?.id === "string" ? response.id : "";
    if (!credentialId) {
      return res.status(400).json({ error: "Credential ID is required" });
    }

    const storedCredential = await getPasskeyCredentialByCredentialId(credentialId);
    if (!storedCredential) {
      return res.status(404).json({ error: "Passkey is not registered" });
    }

    if (flow.userId && flow.userId !== storedCredential.userId) {
      return res.status(403).json({ error: "Passkey does not match this account" });
    }

    const verification: VerifiedAuthenticationResponse =
      await verifyAuthenticationResponse({
        response,
        expectedChallenge: flow.challenge,
        expectedOrigin: getExpectedOrigins(req),
        expectedRPID: getExpectedRpIds(req),
        credential: toWebAuthnCredential(storedCredential),
        requireUserVerification: true,
      });

    if (!verification.verified) {
      return res.status(403).json({ error: "Passkey sign-in could not be verified" });
    }

    const userId = storedCredential.userId;
    const account = await getUserAccount(userId);
    if (!account) {
      return res.status(404).json({ error: "User not found" });
    }

    const signInGuard = await enforcePreAuthAccessGuards({
      req,
      userId,
      action: "signin",
      username: account.username,
    });
    if ("status" in signInGuard) {
      return res.status(signInGuard.status).json(signInGuard.body);
    }

    await savePasskeyCredential({
      ...storedCredential,
      counter: verification.authenticationInfo.newCounter,
      transports: storedCredential.transports || [],
      deviceType: verification.authenticationInfo.credentialDeviceType,
      backedUp: verification.authenticationInfo.credentialBackedUp,
      updatedAt: Date.now(),
      lastUsedAt: Date.now(),
    });

    const sessionData = await createAuthenticatedSession({
      userId,
      publicKey: account.publicKey,
      signPublicKey: account.signPublicKey,
      req,
    });

    await logAuthSuccess({
      userId,
      username: account.username,
      req,
      action: "signin-success",
    });

    return res.status(200).json({
      success: true,
      sessionToken: sessionData.sessionToken,
      userId,
      publicKey: account.publicKey,
      signPublicKey: account.signPublicKey || null,
      username: account.username || null,
      expiresAt: sessionData.expiresAt,
      passkey: buildStatusResponse(await getPasskeyCredentialByUserId(userId)),
    });
  } catch (error) {
    console.error("[PASSKEYS] Failed to verify authentication:", error);
    return res
      .status(500)
      .json({ error: "Failed to verify passkey authentication" });
  }
};

export const handleVerifyPasskeyStepUp: RequestHandler = async (req, res) => {
  try {
    const session = await getAuthenticatedSession(req);
    if (!session) {
      return res.status(401).json({ error: "Invalid or expired session" });
    }

    const flowId = typeof req.body?.flowId === "string" ? req.body.flowId : "";
    const response = req.body?.response;
    if (!flowId || !response) {
      return res.status(400).json({ error: "flowId and response are required" });
    }

    const flow = await getPasskeyChallenge(flowId);
    if (
      !flow ||
      flow.purpose !== "step-up" ||
      flow.userId !== session.userId
    ) {
      return res.status(400).json({ error: "Passkey verification session not found" });
    }

    await deletePasskeyChallenge(flowId);
    if (flow.expiresAt < Date.now()) {
      return res.status(400).json({ error: "Passkey verification session expired" });
    }

    const credentialId = typeof response?.id === "string" ? response.id : "";
    if (!credentialId) {
      return res.status(400).json({ error: "Credential ID is required" });
    }

    const storedCredential = await getPasskeyCredentialByCredentialId(credentialId);
    if (!storedCredential || storedCredential.userId !== session.userId) {
      return res.status(403).json({ error: "Passkey does not match this account" });
    }

    const verification: VerifiedAuthenticationResponse =
      await verifyAuthenticationResponse({
        response,
        expectedChallenge: flow.challenge,
        expectedOrigin: getExpectedOrigins(req),
        expectedRPID: getExpectedRpIds(req),
        credential: toWebAuthnCredential(storedCredential),
        requireUserVerification: true,
      });

    if (!verification.verified) {
      return res.status(403).json({ error: "Passkey verification could not be verified" });
    }

    await savePasskeyCredential({
      ...storedCredential,
      counter: verification.authenticationInfo.newCounter,
      transports: storedCredential.transports || [],
      deviceType: verification.authenticationInfo.credentialDeviceType,
      backedUp: verification.authenticationInfo.credentialBackedUp,
      updatedAt: Date.now(),
      lastUsedAt: Date.now(),
    });

    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + PASSKEY_STEP_UP_TTL_MS;
    passkeyStepUpTokens.set(token, {
      userId: session.userId,
      expiresAt,
    });

    return res.status(200).json({
      success: true,
      verificationToken: token,
      expiresAt,
    });
  } catch (error) {
    console.error("[PASSKEYS] Failed to verify step-up authentication:", error);
    return res.status(500).json({ error: "Failed to verify passkey" });
  }
};

export const handleDeletePasskey: RequestHandler = async (req, res) => {
  try {
    const session = await getAuthenticatedSession(req);
    if (!session) {
      return res.status(401).json({ error: "Invalid or expired session" });
    }

    const passphraseVerified = await requireVerifiedPassphrase(
      session.userId,
      req.body || {},
    );
    if (!passphraseVerified) {
      return res.status(403).json({ error: "Invalid recovery passphrase" });
    }

    await deletePasskeyCredentialForUser(session.userId);

    return res.status(200).json({
      success: true,
      status: buildStatusResponse(null),
    });
  } catch (error) {
    console.error("[PASSKEYS] Failed to delete passkey:", error);
    return res.status(500).json({ error: "Failed to delete passkey" });
  }
};
