import { Request, RequestHandler } from "express";
import {
  AdminUserBaseStatusFilter,
  AppealType,
  banUser,
  createAdminSession,
  createAppeal,
  getConfiguredAdminProfileCount,
  getAdminOverviewMetrics,
  getClientIp,
  getLatestKnownUserIp,
  getUserAdminDetailsByUsername,
  isUserBanned,
  listActiveAdminSessions,
  listAppeals,
  listAdminUsersPage,
  listBannedUsers,
  removeAdminSession,
  resolveAppeal,
  unbanUser,
  validateAdminSession,
} from "../lib/admin-panel-store";
import { revokeAllSessionsForUser } from "./auth";
import { disconnectUserConnections } from "../lib/messaging";

interface AdminLoginAttemptState {
  failures: number;
  firstFailureAt: number;
  blockedUntil: number;
}

const adminLoginAttempts = new Map<string, AdminLoginAttemptState>();
const ADMIN_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const ADMIN_LOGIN_BASE_BLOCK_MS = 5 * 60 * 1000;
const ADMIN_LOGIN_MAX_BLOCK_MS = 60 * 60 * 1000;
const ADMIN_LOGIN_FAILURE_THRESHOLD = 5;

function getAdminLoginKey(req: Request, email: string, username: string): string {
  const ip = getClientIp(req) || "unknown";
  return [
    ip,
    email.trim().toLowerCase(),
    username.trim().toLowerCase(),
  ].join("|");
}

function cleanupExpiredAdminLoginAttempts(nowTs: number): void {
  for (const [key, value] of adminLoginAttempts.entries()) {
    const staleByWindow = nowTs - value.firstFailureAt > ADMIN_LOGIN_WINDOW_MS;
    const staleByBlock = value.blockedUntil > 0 && nowTs > value.blockedUntil;
    if (staleByWindow && staleByBlock) {
      adminLoginAttempts.delete(key);
    }
  }
}

function getRemainingLockoutMs(state: AdminLoginAttemptState, nowTs: number): number {
  if (state.blockedUntil <= nowTs) {
    return 0;
  }
  return state.blockedUntil - nowTs;
}

function registerAdminLoginFailure(key: string, nowTs: number): AdminLoginAttemptState {
  const existing = adminLoginAttempts.get(key);
  const inWindow =
    existing && nowTs - existing.firstFailureAt <= ADMIN_LOGIN_WINDOW_MS;

  const failures = inWindow ? existing!.failures + 1 : 1;
  const firstFailureAt = inWindow ? existing!.firstFailureAt : nowTs;
  let blockedUntil = 0;

  if (failures >= ADMIN_LOGIN_FAILURE_THRESHOLD) {
    const blockMultiplier = Math.max(1, failures - ADMIN_LOGIN_FAILURE_THRESHOLD + 1);
    const blockMs = Math.min(
      ADMIN_LOGIN_MAX_BLOCK_MS,
      ADMIN_LOGIN_BASE_BLOCK_MS * blockMultiplier,
    );
    blockedUntil = nowTs + blockMs;
  }

  const nextState: AdminLoginAttemptState = {
    failures,
    firstFailureAt,
    blockedUntil,
  };
  adminLoginAttempts.set(key, nextState);
  return nextState;
}

function clearAdminLoginFailureState(key: string): void {
  adminLoginAttempts.delete(key);
}

function getAdminSessionToken(req: Request): string {
  const header = req.headers["x-admin-session"];
  if (typeof header === "string" && header.trim()) {
    return header.trim();
  }
  return "";
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function isReasonableEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function getUserBaseStatusFilter(
  value: string,
): AdminUserBaseStatusFilter {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "active" ||
    normalized === "inactive" ||
    normalized === "banned" ||
    normalized === "ip-restricted"
  ) {
    return normalized;
  }
  return "all";
}

export const requireAdminPanelSession: RequestHandler = async (req, res, next) => {
  try {
    const token = getAdminSessionToken(req);
    if (!token) {
      return res.status(401).json({ error: "Admin authentication required" });
    }

    const result = await validateAdminSession(token);
    if (!result.ok) {
      return res.status(401).json({ error: "Admin session expired" });
    }

    (req as any).adminUser = { username: result.username || "admin" };
    next();
  } catch (error) {
    console.error("[ADMIN-PANEL] Failed to validate admin session:", error);
    return res.status(500).json({ error: "Failed to validate admin session" });
  }
};

export const handleAdminPanelLogin: RequestHandler = async (req, res) => {
  try {
    const email = typeof req.body?.email === "string" ? req.body.email : "";
    const username =
      typeof req.body?.username === "string" ? req.body.username : "";
    const password =
      typeof req.body?.password === "string" ? req.body.password : "";
    if (
      email.length > 320 ||
      username.length > 80 ||
      password.length > 1024 ||
      !email.trim() ||
      !username.trim() ||
      !password
    ) {
      return res.status(401).json({ error: "Invalid admin credentials" });
    }
    const key = getAdminLoginKey(req, email, username);
    const nowTs = Date.now();

    cleanupExpiredAdminLoginAttempts(nowTs);
    const existingState = adminLoginAttempts.get(key);
    if (existingState) {
      const lockoutMs = getRemainingLockoutMs(existingState, nowTs);
      if (lockoutMs > 0) {
        return res.status(429).json({
          error: "Too many authentication attempts. Please try again later.",
          retryAfter: Math.ceil(lockoutMs / 1000),
        });
      }
    }

    const result = await createAdminSession({
      email,
      username,
      password,
    });

    if (!result.ok || !result.token) {
      const state = registerAdminLoginFailure(key, nowTs);
      const lockoutMs = getRemainingLockoutMs(state, nowTs);
      if (lockoutMs > 0) {
        return res.status(429).json({
          error: "Too many authentication attempts. Please try again later.",
          retryAfter: Math.ceil(lockoutMs / 1000),
        });
      }
      return res.status(401).json({ error: "Invalid admin credentials" });
    }
    clearAdminLoginFailureState(key);

    return res.status(200).json({
      token: result.token,
      username: result.username || "admin",
      expiresInMs: 8 * 60 * 60 * 1000,
    });
  } catch (error) {
    console.error("[ADMIN-PANEL] Login error:", error);
    return res.status(500).json({ error: "Failed to login" });
  }
};

export const handleAdminPanelLogout: RequestHandler = async (req, res) => {
  try {
    const token = getAdminSessionToken(req);
    if (token) {
      await removeAdminSession(token);
    }
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("[ADMIN-PANEL] Logout error:", error);
    return res.status(500).json({ error: "Failed to logout" });
  }
};

export const handleAdminPanelMe: RequestHandler = async (req, res) => {
  const adminUser = (req as any).adminUser;
  const [activeSessions, configuredAdminCount] = await Promise.all([
    listActiveAdminSessions(),
    getConfiguredAdminProfileCount(),
  ]);
  return res.status(200).json({
    authenticated: true,
    username: adminUser?.username || "admin",
    adminAccess: {
      configuredAdminCount,
      activeSessionCount: activeSessions.length,
      activeSessions,
    },
  });
};

export const handleAdminPanelOverview: RequestHandler = async (req, res) => {
  try {
    const [metrics, bannedUsers, appeals, activeSessions, configuredAdminCount] =
      await Promise.all([
        getAdminOverviewMetrics(),
        listBannedUsers(),
        listAppeals(),
        listActiveAdminSessions(),
        getConfiguredAdminProfileCount(),
      ]);
    return res.status(200).json({
      metrics,
      bannedUsers,
      appeals,
      adminAccess: {
        configuredAdminCount,
        activeSessionCount: activeSessions.length,
        activeSessions,
      },
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error("[ADMIN-PANEL] Overview error:", error);
    return res.status(500).json({ error: "Failed to load overview" });
  }
};

export const handleAdminPanelUserSearch: RequestHandler = async (req, res) => {
  try {
    const username =
      typeof req.query?.username === "string" ? req.query.username : "";
    if (!username.trim()) {
      return res.status(400).json({ error: "username query is required" });
    }

    const result = await getUserAdminDetailsByUsername(username);
    if (!result) {
      return res.status(404).json({ error: "User not found" });
    }
    const banState = await isUserBanned(result.userId);

    return res.status(200).json({
      user: {
        ...result,
        banned: banState.banned,
        banReason: banState.reason || null,
        ipRestricted: banState.ipRestricted,
      },
    });
  } catch (error) {
    console.error("[ADMIN-PANEL] User search error:", error);
    return res.status(500).json({ error: "Failed to search user" });
  }
};

export const handleAdminPanelListUsers: RequestHandler = async (req, res) => {
  try {
    const rawPage =
      typeof req.query?.page === "string" ? Number.parseInt(req.query.page, 10) : 1;
    const rawPageSize =
      typeof req.query?.pageSize === "string"
        ? Number.parseInt(req.query.pageSize, 10)
        : 25;
    const rawStatus =
      typeof req.query?.status === "string" ? req.query.status : "all";

    const result = await listAdminUsersPage({
      page: Number.isFinite(rawPage) ? rawPage : 1,
      pageSize: Number.isFinite(rawPageSize) ? rawPageSize : 25,
      status: getUserBaseStatusFilter(rawStatus),
    });

    return res.status(200).json(result);
  } catch (error) {
    console.error("[ADMIN-PANEL] List users error:", error);
    return res.status(500).json({ error: "Failed to load users" });
  }
};

export const handleAdminPanelBanUser: RequestHandler = async (req, res) => {
  try {
    const userId = typeof req.params?.userId === "string" ? req.params.userId : "";
    const reason =
      typeof req.body?.reason === "string" && req.body.reason.trim()
        ? req.body.reason.trim()
        : "Violation of terms of service";
    const ipRestricted = req.body?.ipRestricted === true;

    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }
    if (reason.length > 280) {
      return res.status(400).json({ error: "reason must be at most 280 characters" });
    }

    const latestKnownIp = await getLatestKnownUserIp(userId);
    const adminUser = (req as any).adminUser;
    await banUser({
      userId,
      reason,
      ipRestricted,
      latestKnownIp,
      bannedBy: adminUser?.username || "admin",
    });
    await revokeAllSessionsForUser(userId);
    disconnectUserConnections(userId);

    return res.status(200).json({
      success: true,
      userId,
      ipRestricted,
      latestKnownIp,
    });
  } catch (error) {
    console.error("[ADMIN-PANEL] Ban user error:", error);
    return res.status(500).json({ error: "Failed to ban user" });
  }
};

export const handleAdminPanelUnbanUser: RequestHandler = async (req, res) => {
  try {
    const userId = typeof req.params?.userId === "string" ? req.params.userId : "";
    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }
    const adminUser = (req as any).adminUser;
    await unbanUser({
      userId,
      reviewedBy: adminUser?.username || "admin",
    });

    return res.status(200).json({
      success: true,
      userId,
    });
  } catch (error) {
    console.error("[ADMIN-PANEL] Unban user error:", error);
    return res.status(500).json({ error: "Failed to unban user" });
  }
};

export const handleAdminPanelListAppeals: RequestHandler = async (req, res) => {
  try {
    const appeals = await listAppeals();
    return res.status(200).json({ appeals });
  } catch (error) {
    console.error("[ADMIN-PANEL] List appeals error:", error);
    return res.status(500).json({ error: "Failed to load appeals" });
  }
};

export const handleAdminPanelResolveAppeal: RequestHandler = async (req, res) => {
  try {
    const appealId =
      typeof req.params?.appealId === "string" ? req.params.appealId : "";
    const action = typeof req.body?.action === "string" ? req.body.action : "";
    if (!appealId || (action !== "approve" && action !== "keep-banned")) {
      return res.status(400).json({
        error: "appealId and valid action are required",
      });
    }

    const adminUser = (req as any).adminUser;
    const result = await resolveAppeal({
      appealId,
      approved: action === "approve",
      reviewedBy: adminUser?.username || "admin",
    });

    if (!result.ok) {
      return res.status(404).json({ error: result.error || "Appeal not found" });
    }

    if (action === "approve" && result.appeal?.userId) {
      await revokeAllSessionsForUser(result.appeal.userId);
    }

    return res.status(200).json({
      success: true,
      appeal: result.appeal,
    });
  } catch (error) {
    console.error("[ADMIN-PANEL] Resolve appeal error:", error);
    return res.status(500).json({ error: "Failed to resolve appeal" });
  }
};

export const handleCreateAppeal: RequestHandler = async (req, res) => {
  try {
    const type = req.body?.type as AppealType;
    const userId = typeof req.body?.userId === "string" ? req.body.userId : "";
    const contactEmail = normalizeEmail(
      typeof req.body?.contactEmail === "string" ? req.body.contactEmail : "",
    );
    const message =
      typeof req.body?.message === "string" ? req.body.message.trim() : "";
    const ipAddress = getClientIp(req);

    if (type !== "banned-user" && type !== "ip-restricted") {
      return res.status(400).json({ error: "Invalid appeal type" });
    }
    if (!contactEmail) {
      return res.status(400).json({ error: "contactEmail is required" });
    }
    if (!isReasonableEmail(contactEmail)) {
      return res.status(400).json({ error: "Invalid contactEmail" });
    }
    if (!message) {
      return res.status(400).json({ error: "message is required" });
    }
    if (message.length > 2000) {
      return res.status(400).json({ error: "message is too long" });
    }

    const appeal = await createAppeal({
      type,
      userId: userId || undefined,
      ipAddress,
      contactEmail,
      message,
    });

    return res.status(201).json({
      success: true,
      appealId: appeal.id,
    });
  } catch (error) {
    console.error("[ADMIN-PANEL] Create appeal error:", error);
    return res.status(500).json({ error: "Failed to submit appeal" });
  }
};
