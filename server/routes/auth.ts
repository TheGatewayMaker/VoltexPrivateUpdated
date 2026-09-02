import { RequestHandler } from "express";
import crypto from "crypto";
import {
  verifySignedChallenge,
  deriveUserIdFromPublicKey,
  generateChallenge,
  isChallengeExpired,
  isValidPublicKey,
  isValidSignature,
} from "../lib/crypto";
import {
  saveUserAccount,
  getUserAccount,
  saveRecoverySecret,
  getRecoverySecret,
  checkUsernameAvailability,
  reserveUsername,
  saveEncryptedKeypair,
  getEncryptedKeypair,
  saveSession,
  listSessionsForUser,
  getSessionData,
  deleteSessionData,
  deleteSessionBySessionId,
  deleteSessionsForUser,
  deleteSessionsForUserDevice,
} from "../lib/auth-store";
import {
  UserAccount,
  AuthChallenge,
  AuthResponse,
  SessionData,
  UserDeviceRecord,
} from "@shared/crypto";
import { extractBearerToken, issueWebSocketTicket } from "../lib/auth";
import { getPasskeyCredentialByUserId } from "../lib/passkey-store";
import {
  enforcePreAuthAccessGuards,
  isUserBanned,
  logAuthSuccess,
} from "../lib/admin-panel-store";
import {
  normalizeUsernameForLookup,
  resolveDiscoverableUserIdByUsername,
} from "../lib/username-discovery";
import {
  getUserDevice,
  listUserDevices,
  revokeUserDevice,
  saveUserDevice,
  touchUserDeviceActivity,
} from "../lib/device-store";

// In-memory storage for challenges and sessions (temporary during request)
const challenges = new Map<string, AuthChallenge>();
const sessions = new Map<string, SessionData>();
const recoveryTickets = new Map<
  string,
  {
    userId: string;
    expiresAt: number;
  }
>();
const sessionPersistWriteAt = new Map<string, number>();
const SESSION_ACTIVITY_FLUSH_INTERVAL_MS = 60_000;
const sessionConnectionCounts = new Map<string, number>();

function hashSessionToken(sessionToken: string): string {
  return crypto.createHash("sha256").update(sessionToken).digest("hex");
}

function createDeviceId(): string {
  return crypto.randomBytes(12).toString("hex");
}

function normalizeAppKind(value: unknown): SessionData["appKind"] {
  if (value === "android" || value === "ios" || value === "desktop") {
    return value;
  }
  return "web";
}

function normalizeClientHint(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  return value.replace(/^"+|"+$/g, "").trim() || undefined;
}

function inferDeviceAndPlatform(
  userAgent: string | undefined,
  platformHint: string | undefined,
  modelHint: string | undefined,
): { deviceName?: string; platform?: string } {
  const ua = (userAgent || "").toLowerCase();
  const platform = platformHint || (() => {
    if (ua.includes("android")) return "Android";
    if (ua.includes("iphone") || ua.includes("ipad") || ua.includes("ios")) {
      return "iOS";
    }
    if (ua.includes("mac os x") || ua.includes("macintosh")) return "macOS";
    if (ua.includes("windows")) return "Windows";
    if (ua.includes("linux")) return "Linux";
    return "Unknown";
  })();

  const browser = (() => {
    if (ua.includes("edg/")) return "Edge";
    if (ua.includes("chrome/") && !ua.includes("edg/")) return "Chrome";
    if (ua.includes("firefox/")) return "Firefox";
    if (ua.includes("safari/") && !ua.includes("chrome/")) return "Safari";
    return "Browser";
  })();

  if (modelHint) {
    return {
      platform,
      deviceName: `${modelHint} • ${browser}`,
    };
  }

  if (platform === "iOS") {
    if (ua.includes("ipad")) {
      return { platform, deviceName: `iPad • ${browser}` };
    }
    return { platform, deviceName: `iPhone • ${browser}` };
  }

  if (platform === "Android") {
    return { platform, deviceName: `Android Device • ${browser}` };
  }

  if (platform === "macOS") {
    return { platform, deviceName: `Mac • ${browser}` };
  }

  if (platform === "Windows") {
    return { platform, deviceName: `Windows PC • ${browser}` };
  }

  if (platform === "Linux") {
    return { platform, deviceName: `Linux Device • ${browser}` };
  }

  return { platform, deviceName: `Unknown Device • ${browser}` };
}

function extractSessionClientMetadata(
  req: Parameters<RequestHandler>[0] | undefined,
): Pick<SessionData, "userAgent" | "deviceName" | "platform" | "ipAddress" | "appKind"> {
  if (!req) {
    return {};
  }

  const userAgent =
    typeof req.headers["user-agent"] === "string"
      ? req.headers["user-agent"].slice(0, 512)
      : undefined;
  const platformHint = normalizeClientHint(req.headers["sec-ch-ua-platform"]);
  const modelHint = normalizeClientHint(req.headers["sec-ch-ua-model"]);
  const inferred = inferDeviceAndPlatform(userAgent, platformHint, modelHint);

  return {
    userAgent,
    deviceName: inferred.deviceName,
    platform: inferred.platform,
    appKind: normalizeAppKind(req.headers["x-voltex-app-kind"]),
    ipAddress: typeof req.ip === "string" ? req.ip.slice(0, 120) : undefined,
  };
}

export function resetAuthRuntimeState(): void {
  challenges.clear();
  sessions.clear();
  recoveryTickets.clear();
  sessionPersistWriteAt.clear();
  sessionConnectionCounts.clear();
}

export function cleanupExpiredAuthArtifacts(): void {
  const now = Date.now();

  for (const [challenge, data] of challenges.entries()) {
    if (data.expiresAt < now) {
      challenges.delete(challenge);
    }
  }

  for (const [token, data] of recoveryTickets.entries()) {
    if (data.expiresAt < now) {
      recoveryTickets.delete(token);
    }
  }

  for (const [token, persistedAt] of sessionPersistWriteAt.entries()) {
    if (persistedAt + 12 * 60 * 60 * 1000 < now) {
      sessionPersistWriteAt.delete(token);
    }
  }

  for (const [token] of sessionConnectionCounts.entries()) {
    if (!sessions.has(token)) {
      sessionConnectionCounts.delete(token);
    }
  }
}

async function touchSessionActivity(
  sessionToken: string,
  session: SessionData,
): Promise<void> {
  const now = Date.now();
  session.lastSeenAt = now;

  const lastWriteAt = sessionPersistWriteAt.get(sessionToken) || 0;
  if (now - lastWriteAt < SESSION_ACTIVITY_FLUSH_INTERVAL_MS) {
    return;
  }

  sessionPersistWriteAt.set(sessionToken, now);
  try {
    await saveSession(sessionToken, session);
  } catch (error) {
    console.error(
      `[AUTH] Failed to persist activity for ${sessionToken.substring(0, 8)}...`,
      error,
    );
  }
}

export function markSessionConnectionState(
  sessionToken: string,
  state: "connected" | "disconnected",
): void {
  if (state === "connected") {
    const currentCount = sessionConnectionCounts.get(sessionToken) || 0;
    sessionConnectionCounts.set(sessionToken, currentCount + 1);
    return;
  }

  const currentCount = sessionConnectionCounts.get(sessionToken) || 0;
  const nextCount = currentCount - 1;
  if (nextCount > 0) {
    sessionConnectionCounts.set(sessionToken, nextCount);
  } else {
    sessionConnectionCounts.delete(sessionToken);
  }
}

export async function recordSessionActivity(
  sessionToken: string,
): Promise<void> {
  const session = sessions.get(sessionToken);
  if (session) {
    await touchSessionActivity(sessionToken, session);
    return;
  }

  const restoredSession = await getSessionFromToken(sessionToken);
  if (!restoredSession) {
    return;
  }
  await touchSessionActivity(sessionToken, restoredSession);
}

function safeEqualHex(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(actual, "hex");

  if (expectedBuffer.length === 0 || expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

export async function verifyRecoveryProofForUser(
  userId: string,
  input: {
    passphraseHash?: unknown;
    recoveryVerifier?: unknown;
  },
): Promise<boolean> {
  const recoveryData = await getRecoverySecret(userId);
  if (!recoveryData) {
    return false;
  }

  if (recoveryData.verifier) {
    return (
      typeof input.recoveryVerifier === "string" &&
      safeEqualHex(recoveryData.verifier, input.recoveryVerifier)
    );
  }

  if (recoveryData.legacyHash) {
    return (
      typeof input.passphraseHash === "string" &&
      recoveryData.legacyHash === input.passphraseHash
    );
  }

  return false;
}

export async function createAuthenticatedSession(input: {
  userId: string;
  publicKey: string;
  signPublicKey?: string;
  req?: Parameters<RequestHandler>[0];
  deviceId?: string;
  createdByDeviceId?: string;
}): Promise<SessionData> {
  const sessionToken = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  const expiresAt = now + 24 * 60 * 60 * 1000;
  const metadata = extractSessionClientMetadata(input.req);
  const deviceId = input.deviceId || createDeviceId();

  const sessionData: SessionData = {
    userId: input.userId,
    publicKey: input.publicKey,
    signPublicKey: input.signPublicKey,
    deviceId,
    sessionToken,
    expiresAt,
    createdAt: now,
    lastSeenAt: now,
    userAgent: metadata.userAgent,
    deviceName: metadata.deviceName,
    platform: metadata.platform,
    appKind: metadata.appKind,
    ipAddress: metadata.ipAddress,
  };

  sessions.set(sessionToken, sessionData);

  const existingDevice = await getUserDevice(input.userId, deviceId);
  const nextDevice: UserDeviceRecord = {
    userId: input.userId,
    deviceId,
    deviceName: metadata.deviceName || existingDevice?.deviceName,
    platform: metadata.platform || existingDevice?.platform,
    appKind: metadata.appKind || existingDevice?.appKind || "web",
    status: "active",
    linkedAt: existingDevice?.linkedAt || now,
    revokedAt: undefined,
    lastSeenAt: now,
    createdByDeviceId: existingDevice?.createdByDeviceId || input.createdByDeviceId,
  };
  await saveUserDevice(nextDevice);

  try {
    await saveSession(sessionToken, sessionData);
    console.log(
      `[AUTH] ✓ Session ${sessionToken.substring(0, 8)}... saved to local storage for persistence`,
    );
  } catch (storageError) {
    const errorMsg =
      storageError instanceof Error
        ? storageError.message
        : String(storageError);
    console.error(
      `[AUTH] ✗ CRITICAL: Failed to save session to local storage: ${errorMsg}`,
    );
    console.error(`[AUTH] Session will be lost on server restart!`, {
      error: errorMsg,
    });
  }

  return sessionData;
}

async function ensureSessionDeviceBinding(session: SessionData): Promise<SessionData> {
  if (session.deviceId) {
    return session;
  }

  const now = Date.now();
  const deviceId = createDeviceId();
  const boundSession: SessionData = {
    ...session,
    deviceId,
  };

  await saveUserDevice({
    userId: session.userId,
    deviceId,
    deviceName: session.deviceName,
    platform: session.platform,
    appKind: session.appKind || "web",
    status: "active",
    linkedAt: session.createdAt || now,
    lastSeenAt: session.lastSeenAt || now,
  });
  await saveSession(session.sessionToken, boundSession);
  sessions.set(session.sessionToken, boundSession);
  return boundSession;
}

function normalizeUsername(value: unknown): string {
  return normalizeUsernameForLookup(value);
}

async function resolveAccountIdentifier(input: {
  userId?: unknown;
  username?: unknown;
  requesterUserId?: string;
}): Promise<{ userId: string; account: UserAccount } | null> {
  const normalizedUsername = normalizeUsername(input.username);
  let userId =
    typeof input.userId === "string" && input.userId.trim()
      ? input.userId.trim()
      : "";

  if (!userId && normalizedUsername) {
    const resolvedUserId = await resolveDiscoverableUserIdByUsername({
      username: normalizedUsername,
      requesterUserId: input.requesterUserId,
    });
    if (!resolvedUserId) {
      return null;
    }
    userId = resolvedUserId;
  }

  if (!userId) {
    return null;
  }

  const account = await getUserAccount(userId);
  if (!account) {
    return null;
  }

  return { userId, account };
}

/**
 * POST /api/auth/username-availability
 * Check if a username is available
 */
export const handleCheckUsernameAvailability: RequestHandler = async (
  req,
  res,
) => {
  try {
    const { username } = req.body;

    if (!username || typeof username !== "string") {
      return res.status(400).json({ error: "Username is required" });
    }

    // Validate username format
    if (username.length < 3 || username.length > 30) {
      return res.status(400).json({
        error: "Username must be between 3 and 30 characters",
      });
    }

    // Check if username contains only alphanumeric and underscores
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return res.status(400).json({
        error: "Username can only contain letters, numbers, and underscores",
      });
    }

    const isAvailable = await checkUsernameAvailability(username);

    return res.status(200).json({
      available: isAvailable,
      username: username.toLowerCase(),
    });
  } catch (error) {
    console.error("Username availability check error:", error);
    return res
      .status(500)
      .json({ error: "Failed to check username availability" });
  }
};

/**
 * POST /api/auth/register
 * Create a new account with public key and store in R2
 */
export const handleRegister: RequestHandler = async (req, res) => {
  try {
    const {
      publicKey,
      signPublicKey,
      passphraseHash,
      recoveryVerifier,
      recoverySalt,
      recoveryIterations,
      username,
    } = req.body;

    if (!publicKey || typeof publicKey !== "string") {
      return res.status(400).json({ error: "Public key is required" });
    }

    const registerGuard = await enforcePreAuthAccessGuards({
      req,
      action: "register",
      username,
    });
    if ("status" in registerGuard) {
      return res.status(registerGuard.status).json(registerGuard.body);
    }

    if (
      (!passphraseHash || typeof passphraseHash !== "string") &&
      (!recoveryVerifier || typeof recoveryVerifier !== "string")
    ) {
      return res.status(400).json({ error: "Recovery verifier is required" });
    }

    if (recoveryVerifier) {
      if (
        typeof recoverySalt !== "string" ||
        recoverySalt.length < 16 ||
        typeof recoveryIterations !== "number" ||
        !Number.isInteger(recoveryIterations) ||
        recoveryIterations < 100000
      ) {
        return res.status(400).json({
          error: "Invalid recovery verifier configuration",
        });
      }
    }

    if (username) {
      if (typeof username !== "string") {
        return res.status(400).json({ error: "Invalid username" });
      }

      // Validate username format
      if (username.length < 3 || username.length > 30) {
        return res.status(400).json({
          error: "Username must be between 3 and 30 characters",
        });
      }

      if (!/^[a-zA-Z0-9_]+$/.test(username)) {
        return res.status(400).json({
          error: "Username can only contain letters, numbers, and underscores",
        });
      }

      // Check if username is available
      const isAvailable = await checkUsernameAvailability(username);
      if (!isAvailable) {
        return res.status(409).json({
          error: "The Username is not Available, Please try another",
        });
      }
    }

    if (!isValidPublicKey(publicKey)) {
      return res.status(400).json({ error: "Invalid public key format" });
    }

    // Validate signing public key if provided
    if (signPublicKey && typeof signPublicKey === "string") {
      if (!isValidPublicKey(signPublicKey)) {
        return res
          .status(400)
          .json({ error: "Invalid signing public key format" });
      }
    }

    // Derive user ID from public key
    const userId = await deriveUserIdFromPublicKey(publicKey);

    // Check if user already exists in R2
    const existingUser = await getUserAccount(userId);
    if (existingUser) {
      return res.status(409).json({ error: "User already registered" });
    }

    // Create new user account
    const userAccount: UserAccount = {
      userId,
      publicKey,
      signPublicKey: signPublicKey || undefined, // Store the sign public key if provided
      username: username ? username.toLowerCase() : undefined,
      createdAt: Date.now(),
    };

    // Store account in R2
    await saveUserAccount(userId, userAccount);

    // Reserve username if provided
    if (username) {
      await reserveUsername(username, userId);
    }

    await saveRecoverySecret(userId, {
      verifier:
        typeof recoveryVerifier === "string" ? recoveryVerifier : undefined,
      salt: typeof recoverySalt === "string" ? recoverySalt : undefined,
      iterations:
        typeof recoveryIterations === "number"
          ? recoveryIterations
          : undefined,
      legacyHash: typeof passphraseHash === "string" ? passphraseHash : undefined,
    });

    console.log(`User ${userId} registered and stored in R2`);
    await logAuthSuccess({
      userId,
      username: username ? username.toLowerCase() : undefined,
      req,
      action: "register-success",
    });

    return res.status(201).json({
      userId,
      username: username ? username.toLowerCase() : undefined,
      message: "Account created successfully",
    });
  } catch (error) {
    console.error("Registration error:", error);
    return res.status(500).json({ error: "Registration failed" });
  }
};

/**
 * POST /api/auth/challenge
 * Generate a challenge for the user to sign
 */
export const handleGetChallenge: RequestHandler = async (req, res) => {
  try {
    const { userId, publicKey } = req.body;

    if (!userId || !publicKey) {
      return res
        .status(400)
        .json({ error: "userId and publicKey are required" });
    }

    if (!isValidPublicKey(publicKey)) {
      return res.status(400).json({ error: "Invalid public key format" });
    }

    // Verify that the provided userId matches the public key
    const derivedUserId = await deriveUserIdFromPublicKey(publicKey);
    if (userId !== derivedUserId) {
      return res
        .status(403)
        .json({ error: "Public key does not match userId" });
    }

    // Check if user exists in R2
    const userAccount = await getUserAccount(userId);
    if (!userAccount) {
      return res.status(404).json({ error: "User not found" });
    }

    // Generate challenge
    const challenge = generateChallenge();
    const timestamp = Date.now();
    const expiresAt = timestamp + 5 * 60 * 1000; // 5 minutes

    const authChallenge: AuthChallenge = {
      userId,
      challenge,
      timestamp,
      expiresAt,
    };

    challenges.set(challenge, authChallenge);

    return res.status(200).json({
      challenge,
      expiresAt,
    });
  } catch (error) {
    console.error("Challenge generation error:", error);
    return res.status(500).json({ error: "Failed to generate challenge" });
  }
};

/**
 * POST /api/auth/verify
 * Verify the signed challenge and create a session
 */
export const handleVerifyChallenge: RequestHandler = async (req, res) => {
  try {
    const { userId, challenge, signature, publicKey } =
      req.body as AuthResponse & { challenge: string };

    if (!userId || !challenge || !signature || !publicKey) {
      return res.status(400).json({
        error: "userId, challenge, signature, and publicKey are required",
      });
    }

    if (!isValidPublicKey(publicKey)) {
      return res.status(400).json({ error: "Invalid public key format" });
    }

    if (!isValidSignature(signature)) {
      return res.status(400).json({ error: "Invalid signature format" });
    }

    const signInGuard = await enforcePreAuthAccessGuards({
      req,
      userId,
      action: "signin",
    });
    if ("status" in signInGuard) {
      return res.status(signInGuard.status).json(signInGuard.body);
    }

    // Retrieve challenge
    const authChallenge = challenges.get(challenge);
    if (!authChallenge) {
      return res.status(400).json({ error: "Challenge not found" });
    }

    // Check challenge expiration
    if (isChallengeExpired(authChallenge.timestamp)) {
      challenges.delete(challenge);
      return res.status(400).json({ error: "Challenge expired" });
    }

    // Verify userId matches challenge
    if (userId !== authChallenge.userId) {
      return res.status(403).json({ error: "userId does not match challenge" });
    }

    // Verify user exists in R2
    const userAccount = await getUserAccount(userId);
    if (!userAccount) {
      return res.status(404).json({ error: "User not found" });
    }

    // Verify public key matches stored user
    if (userAccount.publicKey !== publicKey) {
      return res
        .status(403)
        .json({ error: "Public key does not match registered user" });
    }

    // Verify the signature using the signing public key
    // The client signs with the signing private key (Ed25519), so we verify with the signing public key
    const signPublicKeyToUse = userAccount.signPublicKey || publicKey;
    const isSignatureValid = verifySignedChallenge(
      challenge,
      signature,
      signPublicKeyToUse,
    );
    if (!isSignatureValid) {
      return res.status(403).json({ error: "Invalid signature" });
    }

    // Clean up used challenge
    challenges.delete(challenge);

    const sessionData = await createAuthenticatedSession({
      userId,
      publicKey,
      signPublicKey: userAccount.signPublicKey,
      req,
      deviceId:
        typeof req.body?.deviceId === "string" && req.body.deviceId.trim()
          ? req.body.deviceId.trim()
          : undefined,
    });

    await logAuthSuccess({
      userId,
      username: userAccount.username,
      req,
      action: "signin-success",
    });

    return res.status(200).json({
      sessionToken: sessionData.sessionToken,
      userId,
      expiresAt: sessionData.expiresAt,
      message: "Authentication successful",
    });
  } catch (error) {
    console.error("Challenge verification error:", error);
    return res.status(500).json({ error: "Verification failed" });
  }
};

/**
 * GET /api/auth/verify-session
 * Verify a session token
 */
export const handleVerifySession: RequestHandler = async (req, res) => {
  try {
    const sessionToken = req.headers.authorization?.replace("Bearer ", "");

    if (!sessionToken) {
      return res.status(401).json({ error: "No session token provided" });
    }

    const session = await getSessionFromToken(sessionToken);
    if (!session) {
      return res.status(401).json({ error: "Invalid session" });
    }

    return res.status(200).json({
      userId: session.userId,
      deviceId: session.deviceId,
      publicKey: session.publicKey,
      expiresAt: session.expiresAt,
    });
  } catch (error) {
    console.error("Session verification error:", error);
    return res.status(500).json({ error: "Verification failed" });
  }
};

/**
 * GET /api/auth/public-key/:userId
 * Get a user's public key for encryption
 * Public endpoint - anyone can request this
 */
export const handleGetPublicKey: RequestHandler = async (req, res) => {
  try {
    let requesterUserId: string | undefined;
    const sessionToken = extractBearerToken(req);
    if (sessionToken) {
      const session = await getSessionFromToken(sessionToken);
      requesterUserId = session?.userId;
    }

    const resolved = await resolveAccountIdentifier({
      userId: req.params.userId,
      username: req.params.username,
      requesterUserId,
    });
    if (!resolved) {
      return res.status(404).json({ error: "User not found" });
    }

    return res.status(200).json({
      publicKey: resolved.account.publicKey,
      signPublicKey: resolved.account.signPublicKey,
    });
  } catch (error) {
    console.error("Get public key error:", error);
    return res.status(500).json({ error: "Failed to retrieve public key" });
  }
};

/**
 * POST /api/auth/recover
 * Recover account using passphrase hash
 */
export const handleRecoverAccount: RequestHandler = async (req, res) => {
  try {
    const { passphraseHash, recoveryVerifier, username } = req.body;

    if (
      (!passphraseHash || typeof passphraseHash !== "string") &&
      (!recoveryVerifier || typeof recoveryVerifier !== "string")
    ) {
      return res.status(400).json({ error: "Recovery proof is required" });
    }

    const resolved = await resolveAccountIdentifier({
      userId: req.body?.userId,
      username,
    });
    if (!resolved) {
      return res.status(404).json({ error: "Account not found" });
    }
    const { userId, account: userAccount } = resolved;

    // Get passphrase recovery data
    const recoveryData = await getRecoverySecret(userId);
    if (!recoveryData) {
      return res.status(404).json({ error: "Account not found" });
    }

    const validRecoveryProof = await verifyRecoveryProofForUser(userId, {
      passphraseHash,
      recoveryVerifier,
    });
    if (!validRecoveryProof) {
      return res.status(403).json({ error: "Invalid passphrase" });
    }
    // Return public key for the user to generate a challenge
    const recoveryToken = crypto.randomBytes(32).toString("base64url");
    recoveryTickets.set(recoveryToken, {
      userId,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    return res.status(200).json({
      publicKey: userAccount.publicKey,
      recoveryToken,
      message:
        "Account recovered successfully. Please sign the challenge to complete authentication.",
    });
  } catch (error) {
    console.error("Account recovery error:", error);
    return res.status(500).json({ error: "Account recovery failed" });
  }
};

export const handleGetRecoveryParams: RequestHandler = async (req, res) => {
  try {
    const resolved = await resolveAccountIdentifier({
      userId: req.params.userId,
      username: req.params.username,
    });
    if (!resolved) {
      return res.status(404).json({ error: "User not found" });
    }
    const { userId } = resolved;

    const recovery = await getRecoverySecret(userId);
    if (!recovery) {
      return res.status(404).json({ error: "Recovery not configured" });
    }

    return res.status(200).json({
      version: recovery.verifier ? 2 : 1,
      salt: recovery.salt || null,
      iterations: recovery.iterations || null,
    });
  } catch (error) {
    console.error("Recovery params error:", error);
    return res.status(500).json({ error: "Failed to fetch recovery params" });
  }
};

/**
 * POST /api/auth/save-encrypted-keypair
 * Save encrypted keypair to R2 for cross-device recovery
 * Client encrypts the keypair before sending, server stores ciphertext only
 */
export const handleSaveEncryptedKeypair: RequestHandler = async (req, res) => {
  try {
    const {
      userId: requestedUserId,
      encryptedData,
      salt,
      iv,
    } = req.body;
    const sessionToken = extractBearerToken(req);

    if (typeof encryptedData !== "string") {
      return res.status(400).json({ error: "Invalid encryptedData" });
    }

    if (typeof salt !== "string") {
      return res.status(400).json({ error: "Invalid salt" });
    }

    if (typeof iv !== "string") {
      return res.status(400).json({ error: "Invalid iv" });
    }

    if (!sessionToken) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const session = await getSessionFromToken(sessionToken);
    if (!session) {
      return res.status(401).json({ error: "Invalid or expired session" });
    }

    const userId =
      typeof requestedUserId === "string" && requestedUserId.trim()
        ? requestedUserId.trim()
        : session.userId;

    if (session.userId !== userId) {
      return res.status(403).json({
        error: "You can only store encrypted keys for your own account",
      });
    }

    // Verify user exists
    const userAccount = await getUserAccount(userId);
    if (!userAccount) {
      return res.status(404).json({ error: "User not found" });
    }

    // Save encrypted keypair to R2
    await saveEncryptedKeypair(userId, encryptedData, salt, iv);

    return res.status(200).json({
      message: "Encrypted keypair saved successfully",
    });
  } catch (error) {
    console.error("Save encrypted keypair error:", error);
    return res.status(500).json({ error: "Failed to save encrypted keypair" });
  }
};

/**
 * GET /api/auth/encrypted-keypair/:userId
 * Get encrypted keypair from R2 for cross-device recovery
 * Server returns ciphertext only (client decrypts locally)
 */
export const handleGetEncryptedKeypair: RequestHandler = async (req, res) => {
  try {
    const sessionToken = extractBearerToken(req);
    const session = sessionToken ? await getSessionFromToken(sessionToken) : null;

    const resolved = await resolveAccountIdentifier({
      userId: req.params.userId,
      username: req.params.username,
      requesterUserId: session?.userId,
    });
    if (!resolved) {
      return res.status(404).json({ error: "User not found" });
    }
    const { userId } = resolved;

    const recoveryToken = req.headers["x-recovery-token"];
    let authorized = false;

    if (session?.userId === userId) {
      authorized = true;
    }

    if (!authorized && typeof recoveryToken === "string") {
      const recoverySession = recoveryTickets.get(recoveryToken);
      if (
        recoverySession &&
        recoverySession.userId === userId &&
        recoverySession.expiresAt >= Date.now()
      ) {
        authorized = true;
        recoveryTickets.delete(recoveryToken);
      }
    }

    if (!authorized) {
      return res.status(401).json({
        error: "Recovery authorization required",
      });
    }

    // Get encrypted keypair from R2
    const encryptedKeypair = await getEncryptedKeypair(userId);
    if (!encryptedKeypair) {
      return res.status(404).json({ error: "Encrypted keypair not found" });
    }

    return res.status(200).json({
      ...encryptedKeypair,
    });
  } catch (error) {
    console.error("Get encrypted keypair error:", error);
    return res
      .status(500)
      .json({ error: "Failed to retrieve encrypted keypair" });
  }
};

/**
 * POST /api/auth/logout
 * Invalidate a session
 */
export const handleLogout: RequestHandler = async (req, res) => {
  try {
    const sessionToken = extractBearerToken(req);

    if (!sessionToken) {
      return res.status(400).json({ error: "No session token provided" });
    }

    // Delete from in-memory cache
    sessions.delete(sessionToken);
    sessionPersistWriteAt.delete(sessionToken);
    sessionConnectionCounts.delete(sessionToken);

    // Also delete from R2
    try {
      await deleteSessionData(sessionToken);
      console.log(`Session ${sessionToken} deleted from R2`);
    } catch (error) {
      console.error("Failed to delete session from R2:", error);
      // Continue anyway - session is removed from memory
    }

    return res.status(200).json({ message: "Logged out successfully" });
  } catch (error) {
    console.error("Logout error:", error);
    return res.status(500).json({ error: "Logout failed" });
  }
};

/**
 * Utility: Get session from token
 * Used by other routes to verify authentication
 * Checks in-memory first, then falls back to R2 for persistence
 */
export async function getSessionFromToken(
  sessionToken: string,
): Promise<SessionData | null> {
  // First check in-memory cache
  const cachedSession = sessions.get(sessionToken);
  if (cachedSession) {
    // Check if expired
    if (cachedSession.expiresAt < Date.now()) {
      console.log(
        `[AUTH] Session ${sessionToken.substring(0, 8)}... expired (cached)`,
      );
      sessions.delete(sessionToken);
      sessionPersistWriteAt.delete(sessionToken);
      sessionConnectionCounts.delete(sessionToken);
      return null;
    }

    const banState = await isUserBanned(cachedSession.userId);
    if (banState.banned) {
      sessions.delete(sessionToken);
      sessionPersistWriteAt.delete(sessionToken);
      sessionConnectionCounts.delete(sessionToken);
      await deleteSessionData(sessionToken).catch(() => undefined);
      return null;
    }
    if (cachedSession.deviceId) {
      const device = await getUserDevice(cachedSession.userId, cachedSession.deviceId);
      if (device && device.status === "revoked") {
        sessions.delete(sessionToken);
        sessionPersistWriteAt.delete(sessionToken);
        sessionConnectionCounts.delete(sessionToken);
        await deleteSessionData(sessionToken).catch(() => undefined);
        return null;
      }
    }
    const normalizedSession = await ensureSessionDeviceBinding(cachedSession);
    await touchSessionActivity(sessionToken, normalizedSession);
    if (normalizedSession.deviceId) {
      await touchUserDeviceActivity(
        normalizedSession.userId,
        normalizedSession.deviceId,
        normalizedSession.lastSeenAt || Date.now(),
      ).catch(() => undefined);
    }
    return normalizedSession;
  }

  // If not in memory, try R2 (for persistence across server restarts)
  try {
    const sessionData = await getSessionData(sessionToken);
    if (!sessionData) {
      console.warn(
        `[AUTH] Session ${sessionToken.substring(0, 8)}... not found in R2`,
      );
      return null;
    }

    // Check if expired
    if (sessionData.expiresAt < Date.now()) {
      console.log(
        `[AUTH] Session ${sessionToken.substring(0, 8)}... expired (from R2)`,
      );
      // Clean up expired session from R2
      try {
        await deleteSessionData(sessionToken);
      } catch (error) {
        console.error("Failed to delete expired session from local storage:", error);
      }
      sessionPersistWriteAt.delete(sessionToken);
      sessionConnectionCounts.delete(sessionToken);
      return null;
    }

    const banState = await isUserBanned(sessionData.userId);
    if (banState.banned) {
      await deleteSessionData(sessionToken).catch(() => undefined);
      sessionPersistWriteAt.delete(sessionToken);
      sessionConnectionCounts.delete(sessionToken);
      return null;
    }
    if (sessionData.deviceId) {
      const device = await getUserDevice(sessionData.userId, sessionData.deviceId);
      if (device && device.status === "revoked") {
        await deleteSessionData(sessionToken).catch(() => undefined);
        sessionPersistWriteAt.delete(sessionToken);
        sessionConnectionCounts.delete(sessionToken);
        return null;
      }
    }

    // Restore to in-memory cache for faster subsequent lookups
    sessions.set(sessionToken, sessionData);
    const normalizedSession = await ensureSessionDeviceBinding(sessionData);
    await touchSessionActivity(sessionToken, normalizedSession);
    if (normalizedSession.deviceId) {
      await touchUserDeviceActivity(
        normalizedSession.userId,
        normalizedSession.deviceId,
        normalizedSession.lastSeenAt || Date.now(),
      ).catch(() => undefined);
    }
    console.log(
      `[AUTH] Session ${sessionToken.substring(0, 8)}... restored from local storage`,
    );
    return normalizedSession;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(
      `[AUTH] ✗ CRITICAL: Failed to retrieve session from local storage: ${errorMsg}`,
    );
    console.error(`[AUTH] Debug info:`, { error: errorMsg });
    return null;
  }
}

export async function revokeAllSessionsForUser(userId: string): Promise<void> {
  for (const [token, session] of sessions.entries()) {
    if (session.userId === userId) {
      sessions.delete(token);
      sessionPersistWriteAt.delete(token);
      sessionConnectionCounts.delete(token);
    }
  }

  await deleteSessionsForUser(userId).catch((error) => {
    console.error(`[AUTH] Failed to revoke persistent sessions for ${userId}:`, error);
  });
}

export async function revokeSessionForUserBySessionId(
  userId: string,
  sessionId: string,
): Promise<boolean> {
  let removedInMemory = false;

  for (const [token, session] of sessions.entries()) {
    if (session.userId !== userId) {
      continue;
    }

    if (hashSessionToken(token) === sessionId) {
      sessions.delete(token);
      sessionPersistWriteAt.delete(token);
      sessionConnectionCounts.delete(token);
      removedInMemory = true;
    }
  }

  const removedPersisted = await deleteSessionBySessionId(
    userId,
    sessionId,
  ).catch((error) => {
    console.error(
      `[AUTH] Failed to remove persisted session ${sessionId} for ${userId}:`,
      error,
    );
    return false;
  });

  return removedInMemory || removedPersisted;
}

export const handleListAccountSessions: RequestHandler = async (req, res) => {
  try {
    const sessionToken = extractBearerToken(req);
    if (!sessionToken) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const session = await getSessionFromToken(sessionToken);
    if (!session) {
      return res.status(401).json({ error: "Invalid or expired session" });
    }

    const currentSessionId = hashSessionToken(sessionToken);
    const records = await listSessionsForUser(session.userId);
    const now = Date.now();
    const onlineSessionIds = new Set<string>();
    const runtimeLastSeenBySessionId = new Map<string, number>();
    for (const [token, count] of sessionConnectionCounts.entries()) {
      if (count > 0) {
        onlineSessionIds.add(hashSessionToken(token));
      }
    }
    for (const [token, runtimeSession] of sessions.entries()) {
      if (runtimeSession.userId !== session.userId) {
        continue;
      }
      const sessionId = hashSessionToken(token);
      runtimeLastSeenBySessionId.set(
        sessionId,
        typeof runtimeSession.lastSeenAt === "number"
          ? runtimeSession.lastSeenAt
          : runtimeSession.createdAt || now,
      );
    }

    const devices = records
      .filter((record) => record.expiresAt >= now)
      .map((record) => ({
        sessionId: record.sessionId,
        deviceId: record.deviceId,
        current: record.sessionId === currentSessionId,
        online: onlineSessionIds.has(record.sessionId),
        deviceName: record.deviceName || "Unknown Device",
        platform: record.platform || "Unknown",
        loginAt: record.createdAt,
        lastActiveAt:
          runtimeLastSeenBySessionId.get(record.sessionId) ||
          record.lastSeenAt ||
          record.createdAt,
        expiresAt: record.expiresAt,
      }))
      .sort((a, b) => {
        if (a.online !== b.online) {
          return a.online ? -1 : 1;
        }
        return b.lastActiveAt - a.lastActiveAt;
      });

    return res.status(200).json({
      currentSessionId,
      devices,
    });
  } catch (error) {
    console.error("List account sessions error:", error);
    return res.status(500).json({ error: "Failed to load logged-in devices" });
  }
};

export const handleListDevices: RequestHandler = async (req, res) => {
  try {
    const sessionToken = extractBearerToken(req);
    if (!sessionToken) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const session = await getSessionFromToken(sessionToken);
    if (!session) {
      return res.status(401).json({ error: "Invalid or expired session" });
    }

    const [devices, sessionRecords] = await Promise.all([
      listUserDevices(session.userId),
      listSessionsForUser(session.userId),
    ]);
    const now = Date.now();
    const sessionsByDeviceId = new Map<string, typeof sessionRecords>();

    for (const record of sessionRecords) {
      if (!record.deviceId || record.expiresAt < now) {
        continue;
      }
      const existing = sessionsByDeviceId.get(record.deviceId) || [];
      existing.push(record);
      sessionsByDeviceId.set(record.deviceId, existing);
    }

    const onlineSessionIds = new Set<string>();
    for (const [token, count] of sessionConnectionCounts.entries()) {
      if (count > 0) {
        onlineSessionIds.add(hashSessionToken(token));
      }
    }

    const currentDeviceId = session.deviceId;
    const result = devices
      .filter((device) => device.status !== "revoked")
      .map((device) => {
        const deviceSessions = sessionsByDeviceId.get(device.deviceId) || [];
        const online = deviceSessions.some((entry) =>
          onlineSessionIds.has(entry.sessionId),
        );
        const latestSession = [...deviceSessions].sort(
          (left, right) =>
            (right.lastSeenAt || right.createdAt) -
            (left.lastSeenAt || left.createdAt),
        )[0];

        return {
          deviceId: device.deviceId,
          current: currentDeviceId === device.deviceId,
          online,
          deviceName: device.deviceName || latestSession?.deviceName || "Unknown Device",
          platform: device.platform || latestSession?.platform || "Unknown",
          appKind: device.appKind || latestSession?.appKind || "web",
          linkedAt: device.linkedAt,
          lastActiveAt:
            device.lastSeenAt ||
            latestSession?.lastSeenAt ||
            latestSession?.createdAt ||
            device.linkedAt,
          sessionCount: deviceSessions.length,
        };
      })
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);

    return res.status(200).json({
      currentDeviceId,
      devices: result,
    });
  } catch (error) {
    console.error("List devices error:", error);
    return res.status(500).json({ error: "Failed to load devices" });
  }
};

export const handleRevokeDevice: RequestHandler = async (req, res) => {
  try {
    const sessionToken = extractBearerToken(req);
    if (!sessionToken) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const session = await getSessionFromToken(sessionToken);
    if (!session) {
      return res.status(401).json({ error: "Invalid or expired session" });
    }

    const targetDeviceId =
      typeof req.params.deviceId === "string" ? req.params.deviceId.trim() : "";
    if (!targetDeviceId) {
      return res.status(400).json({ error: "Invalid device identifier" });
    }

    const passphraseVerified = await verifyRecoveryProofForUser(
      session.userId,
      req.body || {},
    );
    if (!passphraseVerified) {
      return res.status(403).json({ error: "Invalid recovery passphrase" });
    }

    const passkeyCredential = await getPasskeyCredentialByUserId(session.userId);
    if (passkeyCredential) {
      const passkeyStepUpToken =
        typeof req.body?.passkeyStepUpToken === "string"
          ? req.body.passkeyStepUpToken
          : "";

      if (!passkeyStepUpToken) {
        return res.status(403).json({
          error: "Passkey verification is required before revoking this device",
        });
      }

      const { consumePasskeyStepUpToken } = await import("./passkeys");
      const validStepUp = consumePasskeyStepUpToken(
        session.userId,
        passkeyStepUpToken,
      );
      if (!validStepUp) {
        return res.status(403).json({
          error: "Passkey verification expired or invalid. Verify again.",
        });
      }
    }

    const revoked = await revokeUserDevice(session.userId, targetDeviceId);
    if (!revoked) {
      return res.status(404).json({ error: "Device not found" });
    }

    await deleteSessionsForUserDevice(session.userId, targetDeviceId);

    for (const [token, runtimeSession] of sessions.entries()) {
      if (
        runtimeSession.userId === session.userId &&
        runtimeSession.deviceId === targetDeviceId
      ) {
        sessions.delete(token);
        sessionPersistWriteAt.delete(token);
        sessionConnectionCounts.delete(token);
      }
    }

    return res.status(200).json({
      success: true,
      deviceId: targetDeviceId,
      revokedCurrentDevice: session.deviceId === targetDeviceId,
    });
  } catch (error) {
    console.error("Revoke device error:", error);
    return res.status(500).json({ error: "Failed to revoke device" });
  }
};

export const handleRevokeAccountSession: RequestHandler = async (req, res) => {
  try {
    const sessionToken = extractBearerToken(req);
    if (!sessionToken) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const session = await getSessionFromToken(sessionToken);
    if (!session) {
      return res.status(401).json({ error: "Invalid or expired session" });
    }

    const targetSessionId =
      typeof req.params.sessionId === "string"
        ? req.params.sessionId.trim().toLowerCase()
        : "";

    if (!/^[a-f0-9]{64}$/.test(targetSessionId)) {
      return res.status(400).json({ error: "Invalid session identifier" });
    }

    const passphraseVerified = await verifyRecoveryProofForUser(
      session.userId,
      req.body || {},
    );
    if (!passphraseVerified) {
      return res.status(403).json({ error: "Invalid recovery passphrase" });
    }

    const passkeyCredential = await getPasskeyCredentialByUserId(session.userId);
    if (passkeyCredential) {
      const passkeyStepUpToken =
        typeof req.body?.passkeyStepUpToken === "string"
          ? req.body.passkeyStepUpToken
          : "";

      if (!passkeyStepUpToken) {
        return res.status(403).json({
          error: "Passkey verification is required before logging out this device",
        });
      }

      const { consumePasskeyStepUpToken } = await import("./passkeys");
      const validStepUp = consumePasskeyStepUpToken(
        session.userId,
        passkeyStepUpToken,
      );
      if (!validStepUp) {
        return res.status(403).json({
          error: "Passkey verification expired or invalid. Verify again.",
        });
      }
    }

    const revoked = await revokeSessionForUserBySessionId(
      session.userId,
      targetSessionId,
    );
    if (!revoked) {
      return res.status(404).json({ error: "Device session not found" });
    }

    return res.status(200).json({
      success: true,
      revokedCurrentSession: targetSessionId === hashSessionToken(sessionToken),
      sessionId: targetSessionId,
    });
  } catch (error) {
    console.error("Revoke account session error:", error);
    return res.status(500).json({ error: "Failed to revoke device session" });
  }
};

export const handleCreateWebSocketTicket: RequestHandler = async (req, res) => {
  try {
    const sessionToken = extractBearerToken(req);
    if (!sessionToken) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const session = await getSessionFromToken(sessionToken);
    if (!session) {
      return res.status(401).json({ error: "Invalid or expired session" });
    }

    const { ticket, expiresAt } = issueWebSocketTicket(
      sessionToken,
      session.userId,
    );

    return res.status(200).json({
      ticket,
      expiresAt,
    });
  } catch (error) {
    console.error("WebSocket ticket error:", error);
    return res.status(500).json({ error: "Failed to create WebSocket ticket" });
  }
};

/**
 * GET /api/auth/server-time
 * Return current server timestamp for client-server time synchronization
 */
export const handleGetServerTime: RequestHandler = (req, res) => {
  try {
    res.status(200).json({
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error("Error getting server time:", error);
    res.status(500).json({ error: "Failed to get server time" });
  }
};
