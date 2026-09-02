import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dotenvCandidates = [
  path.resolve(__dirname, "../.env.local"),
  path.resolve(__dirname, "../../.env.local"),
  path.resolve(__dirname, "../.env"),
  path.resolve(__dirname, "../../.env"),
];
const dotenvPaths = dotenvCandidates.filter((candidate) => fs.existsSync(candidate));

for (const dotenvPath of dotenvPaths) {
  dotenv.config({
    path: dotenvPath,
    override: true,
  });
}

import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import { v4 as uuidv4 } from "uuid";
import { handleDemo } from "./routes/demo";
import {
  handleRegister,
  handleGetChallenge,
  handleVerifyChallenge,
  handleVerifySession,
  handleGetPublicKey,
  handleLogout,
  handleListAccountSessions,
  handleRevokeAccountSession,
  handleRecoverAccount,
  handleCheckUsernameAvailability,
  handleSaveEncryptedKeypair,
  handleGetEncryptedKeypair,
  handleGetRecoveryParams,
  handleGetServerTime,
  handleCreateWebSocketTicket,
  handleListDevices,
  handleRevokeDevice,
  getSessionFromToken,
  markSessionConnectionState,
  recordSessionActivity,
} from "./routes/auth";
import {
  handleSendMessage,
  handleGetConversation,
  handleGetConversations,
  handleDeleteConversation,
  handleDeleteMessage,
  handleMarkConversationAsRead,
} from "./routes/messages";
import {
  handleGetConversationV2,
  handleMarkConversationAsReadV2,
  handleSendMessageV2,
} from "./routes/messages-v2";
import {
  handleGetProfile,
  handleUpdateProfile,
  handleGetPublicProfile,
  handleUploadAvatar,
  handleDeleteAvatar,
  handleGetAvatar,
  handleUpdateSettings,
} from "./routes/profile";
import {
  handleSearchUsers,
  handleGetUserByUsername,
  handleResolveUserByUsername,
} from "./routes/users";
import {
  handleBlockUserByUsername,
  handleGetDirectBlockStatusByUsername,
  handleUnblockUserByUsername,
} from "./routes/blocks";
import {
  handleAcceptInvite,
  handleCreateGroup,
  handleDeleteGroup,
  handleDeclineInvite,
  handleDeleteGroupMessage,
  handleGetGroup,
  handleGetGroupMessages,
  handleGetInvite,
  handleInviteToGroup,
  handleLeaveGroup,
  handleListGroupConversations,
  handleMarkGroupRead,
  handlePinGroupMessage,
  handleRemoveGroupMember,
  handleSendGroupMessage,
  handleUpdateGroup,
  handleUpdateGroupAdmin,
} from "./routes/groups";
import {
  handleHealthCheck,
  handleArchivalStatus,
  handleDatabaseStats,
  handleRunArchival,
  handleArchivalConfig,
  handleR2Diagnostics,
  handleSystemStats,
} from "./routes/admin";
import {
  handleAdminPanelLogin,
  handleAdminPanelLogout,
  handleAdminPanelMe,
  handleAdminPanelOverview,
  handleAdminPanelListUsers,
  handleAdminPanelUserSearch,
  handleAdminPanelBanUser,
  handleAdminPanelUnbanUser,
  handleAdminPanelListAppeals,
  handleAdminPanelResolveAppeal,
  handleCreateAppeal,
  requireAdminPanelSession,
} from "./routes/admin-panel";
import {
  registerUserConnection,
  unregisterUserConnection,
  deliverMessage,
  isUserConnected,
  getQueuedMessages,
  queueMessage,
  getQueueStats,
  initializeMessagingPersistence,
} from "./lib/messaging";
import { validateEncryptedMessage, verifyMessageSignature } from "./lib/crypto";
import { saveMessageWithMetadata } from "./lib/r2-storage";
import { getUserAccount } from "./lib/auth-store";
import { EncryptedMessage } from "@shared/crypto";
import { getConversationKey, storeMessage } from "./lib/conversation-history";
import { storeMessageInDB, isDatabaseConnected } from "./lib/db-messages";
import { initializeDatabase } from "./lib/db";
import { startArchivalJob } from "./lib/archival-job";
import { initializeCloudBackupSync } from "./lib/cloud-backup";
import { initializeDataMaintenance } from "./lib/data-maintenance";
import { processDirectMessageEmailNotification } from "./lib/direct-message-notifications";
import { isDirectMessageBlocked } from "./lib/block-store";
import {
  createRateLimiter,
  startRateLimitCleanup,
  RATE_LIMITS,
} from "./lib/rate-limit";
import { asyncLimiters, isOverloadedError, requestGates } from "./lib/load-control";
import { cleanupMessagesAfterPersist } from "./lib/conversation-history";
import {
  requireAdminAccess,
  consumeWebSocketTicket,
  cleanupExpiredWebSocketTickets,
} from "./lib/auth";
import {
  applySecurityHeaders,
  createCorsOptions,
  disableApiCaching,
  requireTrustedOrigin,
  requireTrustedOriginStrict,
} from "./lib/security";
import { cleanupExpiredAuthArtifacts } from "./routes/auth";
import {
  handleConsumeProtocolBundle,
  handleConsumeProtocolDeviceBundle,
  handleGetProtocolBundle,
  handleGetProtocolBundles,
  handleRegisterDeviceBundle,
} from "./routes/protocol";
import {
  cleanupExpiredPasskeyChallenges,
  cleanupExpiredPasskeyStepUpTokens,
  handleBeginPasskeyStepUp,
  handleBeginPasskeyAuthentication,
  handleBeginPasskeyRegistration,
  handleDeletePasskey,
  handleGetPasskeyStatus,
  handleVerifyPasskeyStepUp,
  handleVerifyPasskeyAuthentication,
  handleVerifyPasskeyRegistration,
} from "./routes/passkeys";
import {
  handleSearchKlipyGifs,
  handleTrendingKlipyGifs,
  handleKlipyAssetProxy,
  handleSearchKlipyStickers,
  handleTrendingKlipyStickers,
} from "./routes/klipy";
import {
  handleGetImageMedia,
  handleUploadDirectImage,
  handleUploadGroupImage,
} from "./routes/media";
import {
  handleCompleteDeviceLink,
  handleInitializeHistoryKey,
  handleListWrappedHistoryKeys,
  handleStartDeviceLink,
} from "./routes/devices";
import {
  handleAdminPanelBackupStatus,
  handleAdminPanelInspectRestorePoint,
  handleAdminPanelRestorePointDetail,
} from "./routes/backups";

// WebSocket server instance (shared across all connections)
let wssInstance: WebSocketServer | null = null;

export async function createServer(): Promise<{
  app: any;
  wss: WebSocketServer;
}> {
  const app = express();
  app.disable("x-powered-by");
  app.set(
    "trust proxy",
    process.env.TRUST_PROXY || "loopback, linklocal, uniquelocal",
  );

  const primaryAppOrigin =
    process.env.PUBLIC_APP_ORIGIN || "https://voltexchat.online";
  const legacyRedirectHosts = new Set(["voltex.g2k.site", "www.voltex.g2k.site"]);

  app.use((req, res, next) => {
    const hostHeader = req.headers.host;
    if (!hostHeader || typeof hostHeader !== "string") {
      next();
      return;
    }

    const requestHost = hostHeader.split(":")[0]?.toLowerCase();
    if (!requestHost || !legacyRedirectHosts.has(requestHost)) {
      next();
      return;
    }

    try {
      const target = new URL(req.originalUrl || "/", primaryAppOrigin);
      res.redirect(308, target.toString());
      return;
    } catch {
      next();
    }
  });

  // Initialize database
  try {
    await initializeDatabase();

    // Start archival job if database is connected
    if (
      isDatabaseConnected() &&
      process.env.ENABLE_MESSAGE_ARCHIVAL === "true"
    ) {
      const archivalConfig = {
        intervalMs: parseInt(process.env.ARCHIVAL_INTERVAL_MS || "7200000"), // 2 hours
        messageAgeMs: parseInt(process.env.MESSAGE_AGE_MS || "7200000"), // 2 hours old
        batchSize: parseInt(process.env.ARCHIVAL_BATCH_SIZE || "1000"),
        deleteAfterArchival: process.env.DELETE_AFTER_ARCHIVAL !== "false",
        deleteGraceMs: parseInt(process.env.DELETE_GRACE_MS || "0"),
      };

      startArchivalJob(archivalConfig);
      console.log("Message archival job started");
    } else if (isDatabaseConnected()) {
      console.log("Message archival job disabled");
    }
  } catch (error) {
    console.warn("Database initialization failed:", error);
    console.log("Falling back to in-memory storage");
  }

  await initializeMessagingPersistence();
  await initializeCloudBackupSync();
  await initializeDataMaintenance();

  // Middleware
  app.use(applySecurityHeaders);
  app.use(
    cors((req, callback) => {
      callback(null, createCorsOptions(req));
    }),
  );
  app.use("/api", disableApiCaching);
  app.use(requireTrustedOrigin);
  app.use(express.json({ limit: "256kb" }));
  app.use(express.urlencoded({ extended: true, limit: "256kb" }));
  app.get(
    "/api/profile/avatar/by-username/:username",
    requestGates.avatarRead,
    handleGetAvatar,
  );

  // Start rate limit cleanup background job
  startRateLimitCleanup();
  const wsTicketCleanupInterval = setInterval(
    cleanupExpiredWebSocketTickets,
    60_000,
  );
  wsTicketCleanupInterval.unref?.();
  const authArtifactsCleanupInterval = setInterval(
    cleanupExpiredAuthArtifacts,
    60_000,
  );
  authArtifactsCleanupInterval.unref?.();
  const passkeyChallengeCleanupInterval = setInterval(() => {
    void cleanupExpiredPasskeyChallenges().catch((error) => {
      console.error("Passkey challenge cleanup failed:", error);
    });
    cleanupExpiredPasskeyStepUpTokens();
  }, 60_000);
  passkeyChallengeCleanupInterval.unref?.();

  // Example API routes
  app.get("/api/ping", (_req, res) => {
    const ping = process.env.PING_MESSAGE ?? "ping";
    res.json({ message: ping });
  });

  app.get("/api/demo", handleDemo);

  // Authentication routes
  app.post(
    "/api/auth/register",
    createRateLimiter(RATE_LIMITS.AUTH),
    handleRegister,
  );
  app.post(
    "/api/auth/challenge",
    createRateLimiter(RATE_LIMITS.AUTH),
    handleGetChallenge,
  );
  app.post(
    "/api/auth/verify",
    createRateLimiter(RATE_LIMITS.AUTH),
    handleVerifyChallenge,
  );
  app.get("/api/auth/verify-session", handleVerifySession);
  app.get("/api/auth/public-key/by-user-id/:userId", handleGetPublicKey);
  app.get("/api/auth/public-key/by-username/:username", handleGetPublicKey);
  app.get("/api/auth/recovery-params/by-user-id/:userId", handleGetRecoveryParams);
  app.get(
    "/api/auth/recovery-params/by-username/:username",
    handleGetRecoveryParams,
  );
  app.get("/api/auth/server-time", handleGetServerTime);
  app.post(
    "/api/auth/ws-ticket",
    createRateLimiter(RATE_LIMITS.AUTH),
    handleCreateWebSocketTicket,
  );
  app.post(
    "/api/auth/recover",
    createRateLimiter(RATE_LIMITS.AUTH),
    handleRecoverAccount,
  );
  app.post("/api/auth/logout", createRateLimiter(RATE_LIMITS.AUTH), handleLogout);
  app.get("/api/auth/sessions", handleListAccountSessions);
  app.post(
    "/api/auth/sessions/:sessionId/revoke",
    createRateLimiter(RATE_LIMITS.AUTH),
    handleRevokeAccountSession,
  );
  app.get("/api/devices", handleListDevices);
  app.post(
    "/api/devices/link/start",
    createRateLimiter(RATE_LIMITS.AUTH),
    handleStartDeviceLink,
  );
  app.post(
    "/api/devices/link/complete",
    createRateLimiter(RATE_LIMITS.AUTH),
    handleCompleteDeviceLink,
  );
  app.delete(
    "/api/devices/:deviceId",
    createRateLimiter(RATE_LIMITS.AUTH),
    handleRevokeDevice,
  );
  app.get("/api/devices/history-keys", handleListWrappedHistoryKeys);
  app.post(
    "/api/devices/history-keys/init",
    createRateLimiter(RATE_LIMITS.AUTH),
    handleInitializeHistoryKey,
  );
  app.get("/api/auth/passkeys/status", handleGetPasskeyStatus);
  app.post(
    "/api/auth/passkeys/register/options",
    createRateLimiter(RATE_LIMITS.AUTH),
    createRateLimiter(RATE_LIMITS.PROFILE_UPDATE),
    handleBeginPasskeyRegistration,
  );
  app.post(
    "/api/auth/passkeys/register/verify",
    createRateLimiter(RATE_LIMITS.AUTH),
    createRateLimiter(RATE_LIMITS.PROFILE_UPDATE),
    handleVerifyPasskeyRegistration,
  );
  app.post(
    "/api/auth/passkeys/authenticate/options",
    createRateLimiter(RATE_LIMITS.AUTH),
    handleBeginPasskeyAuthentication,
  );
  app.post(
    "/api/auth/passkeys/authenticate/verify",
    createRateLimiter(RATE_LIMITS.AUTH),
    handleVerifyPasskeyAuthentication,
  );
  app.post(
    "/api/auth/passkeys/step-up/options",
    createRateLimiter(RATE_LIMITS.AUTH),
    handleBeginPasskeyStepUp,
  );
  app.post(
    "/api/auth/passkeys/step-up/verify",
    createRateLimiter(RATE_LIMITS.AUTH),
    handleVerifyPasskeyStepUp,
  );
  app.delete(
    "/api/auth/passkeys",
    createRateLimiter(RATE_LIMITS.AUTH),
    createRateLimiter(RATE_LIMITS.PROFILE_UPDATE),
    handleDeletePasskey,
  );
  app.post(
    "/api/auth/username-availability",
    createRateLimiter(RATE_LIMITS.USERNAME_CHECK),
    handleCheckUsernameAvailability,
  );
  app.post(
    "/api/auth/save-encrypted-keypair",
    createRateLimiter(RATE_LIMITS.AUTH),
    createRateLimiter(RATE_LIMITS.PROFILE_UPDATE),
    handleSaveEncryptedKeypair,
  );
  app.get(
    "/api/auth/encrypted-keypair/by-user-id/:userId",
    handleGetEncryptedKeypair,
  );
  app.get(
    "/api/auth/encrypted-keypair/by-username/:username",
    handleGetEncryptedKeypair,
  );
  app.post(
    "/api/protocol/register-device",
    createRateLimiter(RATE_LIMITS.AUTH),
    handleRegisterDeviceBundle,
  );
  app.get("/api/protocol/bundles/:userId", handleGetProtocolBundles);
  app.get(
    "/api/protocol/bundles/by-username/:username",
    handleGetProtocolBundles,
  );
  app.get("/api/protocol/bundle/:userId", handleGetProtocolBundle);
  app.get("/api/protocol/bundle/by-username/:username", handleGetProtocolBundle);
  app.post(
    "/api/protocol/consume/:userId",
    createRateLimiter(RATE_LIMITS.AUTH),
    handleConsumeProtocolBundle,
  );
  app.post(
    "/api/protocol/consume/:userId/:deviceId",
    createRateLimiter(RATE_LIMITS.AUTH),
    handleConsumeProtocolDeviceBundle,
  );
  app.post(
    "/api/protocol/consume/by-username/:username",
    createRateLimiter(RATE_LIMITS.AUTH),
    handleConsumeProtocolBundle,
  );
  app.post(
    "/api/protocol/consume/by-username/:username/:deviceId",
    createRateLimiter(RATE_LIMITS.AUTH),
    handleConsumeProtocolDeviceBundle,
  );

  // Message routes
  app.post(
    "/api/messages/send",
    requestGates.messageSend,
    createRateLimiter(RATE_LIMITS.MESSAGE_SEND),
    handleSendMessage,
  );
  app.post(
    "/api/messages/v2/send",
    requestGates.messageSend,
    createRateLimiter(RATE_LIMITS.MESSAGE_SEND),
    handleSendMessageV2,
  );
  app.get(
    "/api/messages/conversation/by-username/:username",
    requestGates.conversationRead,
    createRateLimiter(RATE_LIMITS.CONVERSATION_GET),
    handleGetConversation,
  );
  app.get(
    "/api/messages/v2/conversation/by-username/:username",
    requestGates.conversationRead,
    createRateLimiter(RATE_LIMITS.CONVERSATION_GET),
    handleGetConversationV2,
  );
  app.get(
    "/api/messages/conversations",
    requestGates.conversationRead,
    createRateLimiter(RATE_LIMITS.CONVERSATION_GET),
    handleGetConversations,
  );
  app.delete(
    "/api/messages/conversation/by-username/:username",
    createRateLimiter(RATE_LIMITS.CONVERSATION_GET),
    handleDeleteConversation,
  );
  app.put(
    "/api/messages/conversations/by-username/:username/read",
    createRateLimiter(RATE_LIMITS.CONVERSATION_GET),
    handleMarkConversationAsRead,
  );
  app.put(
    "/api/messages/v2/conversations/by-username/:username/read",
    createRateLimiter(RATE_LIMITS.CONVERSATION_GET),
    handleMarkConversationAsReadV2,
  );

  app.post("/api/groups", createRateLimiter(RATE_LIMITS.GROUP_MUTATION), handleCreateGroup);
  app.get(
    "/api/groups/conversations",
    createRateLimiter(RATE_LIMITS.CONVERSATION_GET),
    handleListGroupConversations,
  );
  app.get("/api/groups/:groupId", createRateLimiter(RATE_LIMITS.CONVERSATION_GET), handleGetGroup);
  app.patch("/api/groups/:groupId", createRateLimiter(RATE_LIMITS.GROUP_MUTATION), handleUpdateGroup);
  app.delete("/api/groups/:groupId", createRateLimiter(RATE_LIMITS.GROUP_MUTATION), handleDeleteGroup);
  app.get(
    "/api/groups/:groupId/messages",
    createRateLimiter(RATE_LIMITS.CONVERSATION_GET),
    handleGetGroupMessages,
  );
  app.post(
    "/api/groups/:groupId/messages",
    createRateLimiter(RATE_LIMITS.MESSAGE_SEND),
    handleSendGroupMessage,
  );
  app.post(
    "/api/groups/:groupId/pin",
    createRateLimiter(RATE_LIMITS.GROUP_MUTATION),
    handlePinGroupMessage,
  );
  app.delete(
    "/api/groups/:groupId/messages/:messageId",
    createRateLimiter(RATE_LIMITS.GROUP_MUTATION),
    handleDeleteGroupMessage,
  );
  app.put(
    "/api/groups/:groupId/read",
    createRateLimiter(RATE_LIMITS.CONVERSATION_GET),
    handleMarkGroupRead,
  );
  app.post(
    "/api/groups/:groupId/invites",
    createRateLimiter(RATE_LIMITS.GROUP_MUTATION),
    handleInviteToGroup,
  );
  app.post(
    "/api/groups/:groupId/admins",
    createRateLimiter(RATE_LIMITS.ADMIN_MODERATION),
    handleUpdateGroupAdmin,
  );
  app.delete(
    "/api/groups/:groupId/members/:userId",
    createRateLimiter(RATE_LIMITS.ADMIN_MODERATION),
    handleRemoveGroupMember,
  );
  app.post(
    "/api/groups/:groupId/leave",
    createRateLimiter(RATE_LIMITS.GROUP_MUTATION),
    handleLeaveGroup,
  );
  app.get(
    "/api/group-invites/:inviteId",
    createRateLimiter(RATE_LIMITS.CONVERSATION_GET),
    handleGetInvite,
  );
  app.post(
    "/api/group-invites/:inviteId/accept",
    createRateLimiter(RATE_LIMITS.GROUP_MUTATION),
    handleAcceptInvite,
  );
  app.post(
    "/api/group-invites/:inviteId/decline",
    createRateLimiter(RATE_LIMITS.GROUP_MUTATION),
    handleDeclineInvite,
  );
  app.delete(
    "/api/messages/message",
    createRateLimiter(RATE_LIMITS.MESSAGE_SEND),
    handleDeleteMessage,
  );
  app.get("/api/klipy/gifs/search", handleSearchKlipyGifs);
  app.get("/api/klipy/gifs/trending", handleTrendingKlipyGifs);
  app.get("/api/klipy/stickers/search", handleSearchKlipyStickers);
  app.get("/api/klipy/stickers/trending", handleTrendingKlipyStickers);
  app.get("/api/klipy/asset", handleKlipyAssetProxy);
  app.post(
    "/api/media/images/direct/by-username/:username",
    requestGates.mediaMutation,
    express.raw({
      type: [
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/avif",
        "application/octet-stream",
      ],
      limit: "13mb",
    }),
    createRateLimiter(RATE_LIMITS.FILE_UPLOAD),
    handleUploadDirectImage,
  );
  app.post(
    "/api/media/images/groups/:groupId",
    requestGates.mediaMutation,
    express.raw({
      type: [
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/avif",
        "application/octet-stream",
      ],
      limit: "13mb",
    }),
    createRateLimiter(RATE_LIMITS.FILE_UPLOAD),
    handleUploadGroupImage,
  );
  app.get(
    "/api/media/images/:mediaId",
    requestGates.mediaRead,
    handleGetImageMedia,
  );

  // Profile routes
  app.get("/api/profile/me", handleGetProfile);
  app.put(
    "/api/profile/me",
    createRateLimiter(RATE_LIMITS.PROFILE_UPDATE),
    handleUpdateProfile,
  );
  app.get(
    "/api/profile/by-username/:username",
    requestGates.profileRead,
    handleGetPublicProfile,
  );
  app.post(
    "/api/profile/avatar",
    requestGates.avatarMutation,
    express.raw({ type: ["image/jpeg", "image/png"], limit: "5mb" }),
    createRateLimiter(RATE_LIMITS.FILE_UPLOAD),
    handleUploadAvatar,
  );
  app.delete("/api/profile/avatar", requestGates.avatarMutation, handleDeleteAvatar);
  app.post(
    "/api/profile/settings",
    createRateLimiter(RATE_LIMITS.PROFILE_UPDATE),
    handleUpdateSettings,
  );

  // User search routes
  app.post(
    "/api/users/search",
    requestGates.userLookup,
    createRateLimiter(RATE_LIMITS.USER_SEARCH),
    handleSearchUsers,
  );
  app.get(
    "/api/users/by-username/:username",
    requestGates.userLookup,
    createRateLimiter(RATE_LIMITS.USER_SEARCH),
    handleGetUserByUsername,
  );
  app.get(
    "/api/users/resolve/:username",
    requestGates.userLookup,
    createRateLimiter(RATE_LIMITS.USER_SEARCH),
    handleResolveUserByUsername,
  );
  app.get(
    "/api/blocks/status/by-username/:username",
    requestGates.userLookup,
    handleGetDirectBlockStatusByUsername,
  );
  app.post(
    "/api/blocks/by-username/:username",
    requestGates.userLookup,
    createRateLimiter(RATE_LIMITS.BLOCK_MUTATION),
    handleBlockUserByUsername,
  );
  app.delete(
    "/api/blocks/by-username/:username",
    requestGates.userLookup,
    createRateLimiter(RATE_LIMITS.BLOCK_MUTATION),
    handleUnblockUserByUsername,
  );

  // Admin routes (for monitoring and testing)
  app.get("/api/admin/health", requireAdminAccess, handleHealthCheck);
  app.get(
    "/api/admin/archival-status",
    requireAdminAccess,
    handleArchivalStatus,
  );
  app.get(
    "/api/admin/database-stats",
    requireAdminAccess,
    handleDatabaseStats,
  );
  app.get(
    "/api/admin/archival-config",
    requireAdminAccess,
    handleArchivalConfig,
  );
  app.get(
    "/api/admin/r2-diagnostics",
    requireAdminAccess,
    handleR2Diagnostics,
  );
  app.get("/api/admin/system-stats", requireAdminAccess, handleSystemStats);
  app.post("/api/admin/run-archival", requireAdminAccess, handleRunArchival);

  // Admin panel auth and moderation routes
  app.use("/api/admin/panel", requireTrustedOriginStrict);
  app.post(
    "/api/admin/panel/login",
    createRateLimiter(RATE_LIMITS.ADMIN_LOGIN),
    handleAdminPanelLogin,
  );
  app.post(
    "/api/admin/panel/logout",
    requireAdminPanelSession,
    createRateLimiter(RATE_LIMITS.ADMIN_LOGIN),
    handleAdminPanelLogout,
  );
  app.get("/api/admin/panel/me", requireAdminPanelSession, handleAdminPanelMe);
  app.get(
    "/api/admin/panel/overview",
    requireAdminPanelSession,
    createRateLimiter(RATE_LIMITS.ADMIN_MODERATION),
    handleAdminPanelOverview,
  );
  app.get(
    "/api/admin/panel/users",
    requireAdminPanelSession,
    createRateLimiter(RATE_LIMITS.ADMIN_MODERATION),
    handleAdminPanelListUsers,
  );
  app.get(
    "/api/admin/panel/users/search",
    requireAdminPanelSession,
    createRateLimiter(RATE_LIMITS.ADMIN_MODERATION),
    handleAdminPanelUserSearch,
  );
  app.post(
    "/api/admin/panel/users/:userId/ban",
    requireAdminPanelSession,
    createRateLimiter(RATE_LIMITS.ADMIN_MODERATION),
    handleAdminPanelBanUser,
  );
  app.post(
    "/api/admin/panel/users/:userId/unban",
    requireAdminPanelSession,
    createRateLimiter(RATE_LIMITS.ADMIN_MODERATION),
    handleAdminPanelUnbanUser,
  );
  app.get(
    "/api/admin/panel/appeals",
    requireAdminPanelSession,
    createRateLimiter(RATE_LIMITS.ADMIN_MODERATION),
    handleAdminPanelListAppeals,
  );
  app.post(
    "/api/admin/panel/appeals/:appealId/resolve",
    requireAdminPanelSession,
    createRateLimiter(RATE_LIMITS.ADMIN_MODERATION),
    handleAdminPanelResolveAppeal,
  );
  app.post(
    "/api/admin/panel/appeals",
    createRateLimiter(RATE_LIMITS.APPEAL_CREATE),
    handleCreateAppeal,
  );

  // Backup visibility. Read-only by design: these endpoints report on the
  // backup service and never change which store the app reads or writes.
  app.get(
    "/api/admin/panel/backups",
    requireAdminPanelSession,
    createRateLimiter(RATE_LIMITS.ADMIN_MODERATION),
    handleAdminPanelBackupStatus,
  );
  app.post(
    "/api/admin/panel/backups/inspect",
    requireAdminPanelSession,
    createRateLimiter(RATE_LIMITS.ADMIN_MODERATION),
    handleAdminPanelInspectRestorePoint,
  );
  app.get(
    "/api/admin/panel/backups/restore-points/:restorePointId",
    requireAdminPanelSession,
    createRateLimiter(RATE_LIMITS.ADMIN_MODERATION),
    handleAdminPanelRestorePointDetail,
  );

  // Create WebSocket server if not already created
  if (!wssInstance) {
    wssInstance = new WebSocketServer({ noServer: true });

    wssInstance.on("connection", async (ws, req) => {
      const requestUrl = req.url ? new URL(req.url, "http://localhost") : null;
      const ticket = requestUrl?.searchParams.get("ticket");

      if (!ticket) {
        console.warn(`[WS] ✗ Connection rejected: No ticket provided`);
        ws.close(4001, "No authentication token");
        return;
      }

      const ticketData = consumeWebSocketTicket(ticket);
      if (!ticketData) {
        console.warn(`[WS] ✗ Connection rejected: Invalid or expired ticket`);
        ws.close(4002, "Invalid or expired connection ticket");
        return;
      }

      const token = ticketData.sessionToken;
      const session = await getSessionFromToken(token);
      if (!session) {
        console.warn(
          `[WS] ✗ Connection rejected: Invalid or expired session for token ${token.substring(0, 8)}...`,
        );
        ws.close(4002, "Invalid or expired session");
        return;
      }

      if (session.userId !== ticketData.userId) {
        console.warn(`[WS] ✗ Connection rejected: Ticket/session user mismatch`);
        ws.close(4002, "Invalid connection ticket");
        return;
      }

      const userId = session.userId;
      console.log(`User ${userId} connected via WebSocket`);

      registerUserConnection(userId, ws);
      markSessionConnectionState(token, "connected");
      void recordSessionActivity(token);
      const sessionActivityInterval = setInterval(() => {
        void recordSessionActivity(token);
      }, 20_000);
      sessionActivityInterval.unref?.();
      let connectionClosed = false;
      const closeConnectionTracking = () => {
        if (connectionClosed) {
          return;
        }
        connectionClosed = true;
        clearInterval(sessionActivityInterval);
        void recordSessionActivity(token);
        markSessionConnectionState(token, "disconnected");
      };

      // Send queued messages to the newly connected user
      const queuedMessages = getQueuedMessages(userId);
      if (queuedMessages.length > 0) {
        console.log(
          `[QUEUED-MESSAGES] Flushing ${queuedMessages.length} queued messages for ${userId}`,
        );
        const failedMessages: typeof queuedMessages = [];

        for (const message of queuedMessages) {
          try {
            ws.send(
              JSON.stringify({
                type: "message",
                data: {
                  id: message.serverMessageId,
                  nonce: message.nonce,
                  ciphertext: message.ciphertext,
                  signature: message.signature,
                  senderId: message.senderId,
                  recipientId: message.recipientId,
                  timestamp: message.timestamp,
                },
              }),
            );
            console.log(
              `[QUEUED-MESSAGES] ✓ Delivered queued message from ${message.senderId}`,
            );
          } catch (error) {
            console.error(
              `[QUEUED-MESSAGES] ✗ Error sending queued message from ${message.senderId}:`,
              error,
            );
            failedMessages.push(message);
          }
        }

        // Re-queue any messages that failed to send
        if (failedMessages.length > 0) {
          console.warn(
            `[QUEUED-MESSAGES] Re-queueing ${failedMessages.length} failed messages for retry`,
          );
          failedMessages.forEach((msg) => {
            queueMessage(msg);
          });
        }
      }

      // Handle incoming messages
      ws.on("message", async (data) => {
        try {
          void recordSessionActivity(token);
          const message = JSON.parse(data.toString());

          if (message.type === "message") {
            // Relay encrypted message
            const encryptedMessage = message.data;
            const clientMessageId = message.id; // Track the original client message ID for ACK

            console.log(
              `[WS] Received message from ${userId} to ${encryptedMessage.recipientId}, client ID: ${clientMessageId}`,
            );

            if (!validateEncryptedMessage(encryptedMessage)) {
              console.warn(`[WS] Invalid message format from ${userId}`);
              ws.send(
                JSON.stringify({
                  type: "error",
                  error: "Invalid message format",
                  messageId: clientMessageId,
                }),
              );
              return;
            }

            // CRITICAL: Verify sender matches authenticated user
            // This prevents a user from spoofing another user's ID
            if (encryptedMessage.senderId !== userId) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  error:
                    "Sender ID does not match authenticated user - spoofing attempt blocked",
                  messageId: clientMessageId,
                }),
              );
              console.warn(
                `[WS] Spoofing attempt: user ${userId} tried to send as ${encryptedMessage.senderId}`,
              );
              return;
            }

            // Verify message signature using authenticated user's sign public key
            let signPublicKeyToUse = session.signPublicKey;

            // If signPublicKey is not in session, fetch it from user account
            if (!signPublicKeyToUse) {
              try {
                const { getUserAccount } = await import("./lib/auth-store");
                const userAccount = await getUserAccount(userId);
                if (userAccount && userAccount.signPublicKey) {
                  signPublicKeyToUse = userAccount.signPublicKey;
                  console.log(
                    `[WS] Fetched sign public key from R2 for user ${userId}`,
                  );
                }
              } catch (error) {
                console.error(
                  `[WS] Failed to fetch user account for ${userId}:`,
                  error,
                );
              }
            }

            // If we still don't have a signPublicKey, we cannot verify the signature
            if (!signPublicKeyToUse) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  error:
                    "User account is missing signing key - please re-register",
                  messageId: clientMessageId,
                }),
              );
              console.warn(
                `[WS] No sign public key available for user ${userId}`,
              );
              return;
            }

            const isSignatureValid = verifyMessageSignature(
              encryptedMessage,
              signPublicKeyToUse,
            );
            if (!isSignatureValid) {
              console.warn(
                `[WS] Invalid message signature from user ${userId} - signature verification failed`,
              );
              ws.send(
                JSON.stringify({
                  type: "error",
                  error:
                    "Invalid message signature - authenticity verification failed",
                  messageId: clientMessageId,
                }),
              );
              return;
            }

            console.log(
              `[WS] Message signature verified for ${userId} -> ${encryptedMessage.recipientId}`,
            );

            // Verify recipient is specified
            if (!encryptedMessage.recipientId) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  error: "Recipient ID is required",
                  messageId: clientMessageId,
                }),
              );
              return;
            }

            const blockStatus = await isDirectMessageBlocked(
              userId,
              encryptedMessage.recipientId,
            );
            if (!blockStatus.canSend) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  error: blockStatus.blockedByMe
                    ? "You have blocked this user. Unblock them to send messages."
                    : blockStatus.blockedMe
                      ? "You have been blocked by this user. You cannot send messages."
                      : "Messaging is unavailable for this conversation.",
                  code: "DIRECT_MESSAGE_BLOCKED",
                  blockStatus,
                  messageId: clientMessageId,
                }),
              );
              return;
            }

            // Generate server timestamp NOW - this is the authoritative timestamp for the message
            // CRITICAL: Must match HTTP route behavior to ensure consistency across WebSocket and HTTP sends
            const serverTimestamp = Date.now();

            // Create message with server-generated timestamp for storage
            const messageWithServerTimestamp: EncryptedMessage = {
              ...encryptedMessage,
              timestamp: serverTimestamp,
            };

            // Generate unique message ID
            const messageId = uuidv4();

            // Store in both PostgreSQL and R2 in PARALLEL for speed
            // CRITICAL: At least one storage backend must succeed, otherwise message is lost
            let dbStorageSuccess = false;
            let r2StorageSuccess = false;
            let storageErrors: string[] = [];

            try {
              await asyncLimiters.messagePersistence.run(async () => {
                const storagePromises: Promise<any>[] = [];

                // Parallel storage in PostgreSQL (if available)
                if (isDatabaseConnected()) {
                  storagePromises.push(
                    storeMessageInDB(
                      messageId,
                      userId,
                      encryptedMessage.recipientId,
                      {
                        nonce: encryptedMessage.nonce,
                        ciphertext: encryptedMessage.ciphertext,
                        signature: encryptedMessage.signature,
                        senderId: userId,
                        recipientId: encryptedMessage.recipientId,
                        timestamp: serverTimestamp,
                      },
                    )
                      .then((success) => {
                        dbStorageSuccess = success;
                        if (success) {
                          console.log(
                            `[WS] Message ${messageId} stored in PostgreSQL with server timestamp ${serverTimestamp} for ${userId} -> ${encryptedMessage.recipientId}`,
                          );
                        }
                        return success;
                      })
                      .catch((dbError) => {
                        const dbErrorMsg =
                          dbError instanceof Error
                            ? dbError.message
                            : String(dbError);
                        console.error(
                          `[WS] Failed to store message ${messageId} in PostgreSQL:`,
                          dbErrorMsg,
                        );
                        storageErrors.push(`PostgreSQL: ${dbErrorMsg}`);
                      }),
                  );
                }

                storagePromises.push(
                  saveMessageWithMetadata(
                    messageId,
                    userId,
                    encryptedMessage.recipientId,
                    {
                      nonce: encryptedMessage.nonce,
                      ciphertext: encryptedMessage.ciphertext,
                      signature: encryptedMessage.signature,
                      timestamp: serverTimestamp,
                    },
                  )
                    .then(() => {
                      console.log(
                        `[WS] Message ${messageId} stored in R2 with server timestamp ${serverTimestamp} for ${userId} -> ${encryptedMessage.recipientId}`,
                      );
                      r2StorageSuccess = true;
                    })
                    .catch((r2Error) => {
                      const r2ErrorMsg =
                        r2Error instanceof Error
                          ? r2Error.message
                          : String(r2Error);
                      console.error(
                        `[WS] Failed to store message ${messageId} in R2:`,
                        r2ErrorMsg,
                      );
                      storageErrors.push(`R2: ${r2ErrorMsg}`);
                    }),
                );

                await Promise.all(storagePromises);
              });
            } catch (error) {
              if (isOverloadedError(error)) {
                ws.send(
                  JSON.stringify({
                    type: "error",
                    error: error.message,
                    messageId: clientMessageId,
                    retryAfter: error.retryAfterSeconds,
                  }),
                );
                return;
              }

              throw error;
            }

            // CRITICAL: Ensure message was persisted to at least one backend
            // If both storage operations failed, the message will be lost when server restarts
            // or when users leave the conversation before in-memory cache is flushed
            if (!dbStorageSuccess && !r2StorageSuccess) {
              console.error(
                `[WS] CRITICAL: Message ${messageId} failed to persist to any storage backend. Errors: ${storageErrors.join("; ")}`,
              );
              ws.send(
                JSON.stringify({
                  type: "error",
                  error: `Failed to persist message to any storage backend. Message was not saved. Details: ${storageErrors.join("; ")}`,
                  messageId: clientMessageId,
                  critical: true,
                }),
              );
              return;
            }

            // Only expose a message after at least one durable store succeeded.
            storeMessage(
              userId,
              encryptedMessage.recipientId,
              messageWithServerTimestamp,
            );
            console.log(
              `[WS] Message durably stored and cached in memory with server timestamp ${serverTimestamp} for conversation ${userId}:${encryptedMessage.recipientId}`,
            );

            // Deliver message to recipient
            const recipientWasConnected = isUserConnected(
              encryptedMessage.recipientId,
            );
            const delivered = deliverMessage({
              ...messageWithServerTimestamp,
              serverMessageId: messageId,
            });
            console.log(
              `[WS] Message delivery attempt: recipient=${encryptedMessage.recipientId}, delivered=${delivered}`,
            );
            await processDirectMessageEmailNotification({
              senderId: userId,
              recipientId: encryptedMessage.recipientId,
              delivered,
              recipientWasConnected,
            });

            // Send ACK back to sender with original client message ID and server timestamp
            ws.send(
              JSON.stringify({
                type: "message-ack",
                messageId: clientMessageId,
                delivered,
                serverMessageId: messageId,
                timestamp: serverTimestamp, // Include server timestamp so client can update message
              }),
            );
            console.log(
              `[WS] Sent ACK to ${userId}: messageId=${clientMessageId}, timestamp=${serverTimestamp}, delivered=${delivered}`,
            );
          }
        } catch (error) {
          console.error(`[WS] WebSocket message handling error:`, error);
        }
      });

      ws.on("close", () => {
        console.log(`User ${userId} disconnected`);
        unregisterUserConnection(userId, ws);
        closeConnectionTracking();
      });

      ws.on("error", (error) => {
        console.error("WebSocket error:", error);
        closeConnectionTracking();
      });
    });
  }

  return { app, wss: wssInstance };
}
