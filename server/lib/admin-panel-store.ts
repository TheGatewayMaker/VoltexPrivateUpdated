import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { Request } from "express";
import { storageRoot } from "./storage-paths";
import { listAllGroups } from "./group-store";
import { getDatabaseStats, isDatabaseConnected } from "./db-messages";
import { query, queryOne } from "./db";
import { getConnectedUserCount, getQueueStats } from "./messaging";
import { getPasskeyCredentialByUserId } from "./passkey-store";

const ADMIN_ROOT = path.join(storageRoot, "voltex-system", "admin-panel");
const STATE_PATH = path.join(ADMIN_ROOT, "state.json");
const SESSIONS_PATH = path.join(ADMIN_ROOT, "sessions.json");
const CREDENTIALS_PATH = path.join(ADMIN_ROOT, "credentials.json");
const EMAIL_LOG_PATH = path.join(storageRoot, "voltex-system", "email-notification-events.json");

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_IP_LOGS_PER_USER = 200;
const MAX_GLOBAL_IP_LOGS = 5000;

export type AppealStatus = "pending" | "approved" | "rejected";
export type AppealType = "banned-user" | "ip-restricted";

export interface AppealRecord {
  id: string;
  type: AppealType;
  userId?: string;
  ipAddress?: string;
  contactEmail: string;
  message: string;
  createdAt: number;
  status: AppealStatus;
  reviewedAt?: number;
  reviewedBy?: string;
}

interface UserBanRecord {
  userId: string;
  banned: boolean;
  ipRestricted: boolean;
  reason: string;
  bannedAt: number;
  bannedBy: string;
  updatedAt: number;
}

interface IpRestrictionRecord {
  ipAddress: string;
  reason: string;
  addedAt: number;
  addedBy: string;
  active: boolean;
  updatedAt: number;
}

export type AdminUserBaseStatusFilter =
  | "all"
  | "active"
  | "inactive"
  | "banned"
  | "ip-restricted";

export interface AdminUserBaseListItem {
  userId: string;
  username: string;
  createdAt: number;
  notificationEmail: string | null;
  activeSessionCount: number;
  lastSeenAt: number | null;
  banned: boolean;
  ipRestricted: boolean;
}

export interface AdminUserBaseListResult {
  users: AdminUserBaseListItem[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  status: AdminUserBaseStatusFilter;
}

interface IpLogRecord {
  userId?: string;
  username?: string;
  ipAddress: string;
  action:
    | "register-attempt"
    | "register-success"
    | "signin-attempt"
    | "signin-success"
    | "signin-blocked"
    | "register-blocked";
  createdAt: number;
}

interface AdminPanelState {
  userBans: Record<string, UserBanRecord>;
  ipRestrictions: Record<string, IpRestrictionRecord>;
  appeals: Record<string, AppealRecord>;
  userIpLogs: Record<string, IpLogRecord[]>;
  globalIpLogs: IpLogRecord[];
}

interface AdminSessionRecord {
  tokenHash: string;
  username: string;
  createdAt: number;
  expiresAt: number;
}

interface AdminSessionsState {
  sessions: Record<string, AdminSessionRecord>;
}

let stateCache: AdminPanelState | null = null;
let sessionsCache: AdminSessionsState | null = null;
let stateWriteChain: Promise<void> = Promise.resolve();
let sessionWriteChain: Promise<void> = Promise.resolve();
let didWarnMissingAdminConfig = false;

function now(): number {
  return Date.now();
}

function randomId(bytes: number = 16): string {
  return crypto.randomBytes(bytes).toString("hex");
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

interface AdminPanelCredentials {
  email: string;
  username: string;
  password: string;
  passwordHash: string;
  passwordPepper: string;
  source: "env" | "file";
}

type AdminCredentialsInput =
  | Partial<AdminPanelCredentials>
  | {
      admins?: Array<Partial<AdminPanelCredentials>>;
    };

function hasAdminCredentialProfiles(
  value: AdminCredentialsInput,
): value is { admins?: Array<Partial<AdminPanelCredentials>> } {
  return "admins" in value;
}

function isCredentialProfile(
  value: AdminCredentialsInput,
): value is Partial<AdminPanelCredentials> {
  return !hasAdminCredentialProfiles(value);
}

function sanitizeCredentialValue(raw: string | undefined): string {
  const value = (raw || "").trim();
  if (!value) {
    return "";
  }

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith("`") && value.endsWith("`"))
  ) {
    return value.slice(1, -1).trim();
  }

  return value;
}

function getEnvAdminPanelCredentials(): AdminPanelCredentials {
  return {
    email: sanitizeCredentialValue(process.env.ADMIN_PANEL_EMAIL),
    username: sanitizeCredentialValue(process.env.ADMIN_PANEL_USERNAME),
    password: sanitizeCredentialValue(process.env.ADMIN_PANEL_PASSWORD),
    passwordHash: sanitizeCredentialValue(
      process.env.ADMIN_PANEL_PASSWORD_HASH,
    ).toLowerCase(),
    passwordPepper: sanitizeCredentialValue(process.env.ADMIN_PANEL_PASSWORD_PEPPER),
    source: "env",
  };
}

function normalizeCredentialProfile(
  raw: Partial<AdminPanelCredentials> | undefined,
  source: "env" | "file",
): AdminPanelCredentials {
  const parsed = raw || {};
  return {
    email: sanitizeCredentialValue(parsed.email),
    username: sanitizeCredentialValue(parsed.username),
    password: sanitizeCredentialValue(parsed.password),
    passwordHash: sanitizeCredentialValue(parsed.passwordHash).toLowerCase(),
    passwordPepper: sanitizeCredentialValue(parsed.passwordPepper),
    source,
  };
}

async function getFileAdminPanelCredentials(): Promise<AdminPanelCredentials[]> {
  try {
    const raw = await fs.readFile(CREDENTIALS_PATH, "utf8");
    const parsed = safeJsonParse<AdminCredentialsInput | AdminCredentialsInput[]>(
      raw,
      {},
    );

    if (Array.isArray(parsed)) {
      return parsed
        .filter(isCredentialProfile)
        .map((profile) => normalizeCredentialProfile(profile, "file"));
    }

    if (hasAdminCredentialProfiles(parsed) && Array.isArray(parsed.admins)) {
      return parsed.admins.map((profile) =>
        normalizeCredentialProfile(profile, "file"),
      );
    }

    return isCredentialProfile(parsed)
      ? [normalizeCredentialProfile(parsed, "file")]
      : [];
  } catch {
    return [];
  }
}

function credentialsFingerprint(config: AdminPanelCredentials): string {
  return [
    normalizeEmail(config.email),
    normalizeUsername(config.username),
    config.passwordHash,
    config.passwordPepper,
    config.password,
  ].join("|");
}

async function getAdminPanelCredentialProfiles(): Promise<AdminPanelCredentials[]> {
  const profiles: AdminPanelCredentials[] = [];
  const envCredentials = getEnvAdminPanelCredentials();
  profiles.push(envCredentials);

  const fileCredentials = await getFileAdminPanelCredentials();
  profiles.push(...fileCredentials);

  const deduped = new Map<string, AdminPanelCredentials>();
  for (const profile of profiles) {
    deduped.set(credentialsFingerprint(profile), profile);
  }
  return Array.from(deduped.values());
}

function hashPassword(input: string, pepper: string): string {
  return crypto
    .createHash("sha256")
    .update(`${pepper}:${input}`)
    .digest("hex");
}

function hashToken(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function getConfiguredPasswordHashes(config: AdminPanelCredentials): string[] {
  const hashes = new Set<string>();
  if (config.passwordHash) {
    hashes.add(config.passwordHash);
  }

  if (config.password) {
    hashes.add(hashPassword(config.password, config.passwordPepper));
  }

  return Array.from(hashes);
}

function isAdminPanelConfigured(config: AdminPanelCredentials): boolean {
  return (
    config.email.length > 0 &&
    config.username.length > 0 &&
    getConfiguredPasswordHashes(config).length > 0
  );
}

function timingSafeEqualString(expected: string, actual: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  if (a.length === 0 || a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    const parsed = JSON.parse(raw) as T;
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

async function ensureAdminDir(): Promise<void> {
  await fs.mkdir(ADMIN_ROOT, { recursive: true });
}

async function loadState(): Promise<AdminPanelState> {
  if (stateCache) {
    return stateCache;
  }

  await ensureAdminDir();
  try {
    const raw = await fs.readFile(STATE_PATH, "utf8");
    const parsed = safeJsonParse<AdminPanelState>(raw, {
      userBans: {},
      ipRestrictions: {},
      appeals: {},
      userIpLogs: {},
      globalIpLogs: [],
    });

    stateCache = {
      userBans: parsed.userBans || {},
      ipRestrictions: parsed.ipRestrictions || {},
      appeals: parsed.appeals || {},
      userIpLogs: parsed.userIpLogs || {},
      globalIpLogs: Array.isArray(parsed.globalIpLogs) ? parsed.globalIpLogs : [],
    };
  } catch {
    stateCache = {
      userBans: {},
      ipRestrictions: {},
      appeals: {},
      userIpLogs: {},
      globalIpLogs: [],
    };
  }

  return stateCache;
}

async function persistState(nextState: AdminPanelState): Promise<void> {
  await ensureAdminDir();
  await fs.writeFile(STATE_PATH, JSON.stringify(nextState, null, 2), "utf8");
}

function enqueueStateWrite(
  updater: (state: AdminPanelState) => void | Promise<void>,
): Promise<void> {
  stateWriteChain = stateWriteChain
    .catch(() => undefined)
    .then(async () => {
      const state = await loadState();
      await updater(state);
      await persistState(state);
    })
    .catch((error) => {
      console.error("[ADMIN-PANEL] Failed to persist state:", error);
    });

  return stateWriteChain;
}

async function loadSessions(): Promise<AdminSessionsState> {
  if (sessionsCache) {
    return sessionsCache;
  }

  await ensureAdminDir();
  try {
    const raw = await fs.readFile(SESSIONS_PATH, "utf8");
    const parsed = safeJsonParse<AdminSessionsState>(raw, {
      sessions: {},
    });
    sessionsCache = {
      sessions: parsed.sessions || {},
    };
  } catch {
    sessionsCache = { sessions: {} };
  }

  return sessionsCache;
}

async function persistSessions(next: AdminSessionsState): Promise<void> {
  await ensureAdminDir();
  await fs.writeFile(SESSIONS_PATH, JSON.stringify(next, null, 2), "utf8");
}

function enqueueSessionWrite(
  updater: (state: AdminSessionsState) => void | Promise<void>,
): Promise<void> {
  sessionWriteChain = sessionWriteChain
    .catch(() => undefined)
    .then(async () => {
      const state = await loadSessions();
      await updater(state);
      await persistSessions(state);
    })
    .catch((error) => {
      console.error("[ADMIN-PANEL] Failed to persist sessions:", error);
    });
  return sessionWriteChain;
}

export function getClientIp(req: Request): string {
  const forwarded =
    typeof req.headers["x-forwarded-for"] === "string"
      ? req.headers["x-forwarded-for"]
      : Array.isArray(req.headers["x-forwarded-for"])
        ? req.headers["x-forwarded-for"][0]
        : "";
  const ip = forwarded.split(",")[0]?.trim() || req.ip || "unknown";
  return ip.replace(/^::ffff:/, "");
}

export async function createAdminSession(input: {
  email: string;
  username: string;
  password: string;
}): Promise<{ ok: boolean; token?: string; username?: string; error?: string }> {
  const profiles = await getAdminPanelCredentialProfiles();
  const configuredProfiles = profiles.filter((profile) =>
    isAdminPanelConfigured(profile),
  );
  if (configuredProfiles.length === 0) {
    if (!didWarnMissingAdminConfig) {
      didWarnMissingAdminConfig = true;
      console.error(
        "[ADMIN-PANEL] Admin panel credentials are not configured in environment or credentials file",
      );
    }
    return { ok: false, error: "Invalid admin credentials" };
  }

  let matchedProfile: AdminPanelCredentials | null = null;
  for (const profile of configuredProfiles) {
    const expectedPasswordHashes = new Set(getConfiguredPasswordHashes(profile));
    const providedPasswordHash = hashPassword(
      input.password || "",
      profile.passwordPepper,
    );
    const emailValid = timingSafeEqualString(
      normalizeEmail(profile.email),
      normalizeEmail(input.email || ""),
    );
    const usernameValid = timingSafeEqualString(
      normalizeUsername(profile.username),
      normalizeUsername(input.username || ""),
    );
    const passwordValid = Array.from(expectedPasswordHashes).some((expectedHash) =>
      timingSafeEqualString(expectedHash, providedPasswordHash),
    );

    if (emailValid && usernameValid && passwordValid) {
      matchedProfile = profile;
      break;
    }
  }

  if (!matchedProfile) {
    console.warn("[ADMIN-PANEL] Login rejected: credential mismatch", {
      configuredProfiles: configuredProfiles.map((profile) => profile.source),
      configuredCount: configuredProfiles.length,
    });
    return { ok: false, error: "Invalid admin credentials" };
  }

  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const createdAt = now();
  const expiresAt = createdAt + SESSION_TTL_MS;

  await enqueueSessionWrite((state) => {
    for (const [key, session] of Object.entries(state.sessions)) {
      if (session.expiresAt < createdAt) {
        delete state.sessions[key];
      }
    }

    state.sessions[tokenHash] = {
      tokenHash,
      username: matchedProfile.username,
      createdAt,
      expiresAt,
    };
  });

  return { ok: true, token, username: matchedProfile.username };
}

export async function validateAdminSession(
  token: string,
): Promise<{ ok: boolean; username?: string }> {
  if (!token) {
    return { ok: false };
  }

  const state = await loadSessions();
  const tokenHash = hashToken(token);
  let entry = state.sessions[tokenHash];

  if (!entry) {
    const legacyEntry = state.sessions[token];
    if (legacyEntry) {
      entry = {
        ...legacyEntry,
        tokenHash,
      };
      await enqueueSessionWrite((next) => {
        delete next.sessions[token];
        next.sessions[tokenHash] = entry!;
      });
    }
  }

  if (!entry) {
    return { ok: false };
  }

  if (entry.expiresAt < now()) {
    await enqueueSessionWrite((next) => {
      delete next.sessions[tokenHash];
      delete next.sessions[token];
    });
    return { ok: false };
  }

  return { ok: true, username: entry.username };
}

export async function removeAdminSession(token: string): Promise<void> {
  if (!token) {
    return;
  }
  const tokenHash = hashToken(token);
  await enqueueSessionWrite((state) => {
    delete state.sessions[tokenHash];
    delete state.sessions[token];
  });
}

export interface ActiveAdminSessionSummary {
  username: string;
  createdAt: number;
  expiresAt: number;
}

export async function listActiveAdminSessions(): Promise<ActiveAdminSessionSummary[]> {
  const state = await loadSessions();
  const nowTs = now();
  let hasExpired = false;

  const activeSessions = Object.values(state.sessions)
    .filter((session) => {
      const active = session.expiresAt > nowTs;
      if (!active) {
        hasExpired = true;
      }
      return active;
    })
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((session) => ({
      username: session.username,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
    }));

  if (hasExpired) {
    await enqueueSessionWrite((next) => {
      for (const [key, session] of Object.entries(next.sessions)) {
        if (session.expiresAt <= nowTs) {
          delete next.sessions[key];
        }
      }
    });
  }

  return activeSessions;
}

export async function getConfiguredAdminProfileCount(): Promise<number> {
  const profiles = await getAdminPanelCredentialProfiles();
  return profiles.filter((profile) => isAdminPanelConfigured(profile)).length;
}

export async function logUserIpEvent(input: {
  userId?: string;
  username?: string;
  ipAddress: string;
  action: IpLogRecord["action"];
}): Promise<void> {
  const entry: IpLogRecord = {
    userId: input.userId,
    username: input.username,
    ipAddress: input.ipAddress,
    action: input.action,
    createdAt: now(),
  };

  await enqueueStateWrite((state) => {
    state.globalIpLogs.push(entry);
    if (state.globalIpLogs.length > MAX_GLOBAL_IP_LOGS) {
      state.globalIpLogs.splice(0, state.globalIpLogs.length - MAX_GLOBAL_IP_LOGS);
    }

    if (input.userId) {
      const existing = state.userIpLogs[input.userId] || [];
      existing.push(entry);
      if (existing.length > MAX_IP_LOGS_PER_USER) {
        existing.splice(0, existing.length - MAX_IP_LOGS_PER_USER);
      }
      state.userIpLogs[input.userId] = existing;
    }
  });
}

export async function getUserIpLogs(userId: string): Promise<IpLogRecord[]> {
  const state = await loadState();
  const logs = state.userIpLogs[userId] || [];
  return [...logs].sort((a, b) => b.createdAt - a.createdAt);
}

export async function getLatestKnownUserIp(userId: string): Promise<string | null> {
  const logs = await getUserIpLogs(userId);
  return logs[0]?.ipAddress || null;
}

export async function isUserBanned(
  userId: string,
): Promise<{ banned: boolean; ipRestricted: boolean; reason?: string }> {
  const state = await loadState();
  const row = state.userBans[userId];
  if (!row || !row.banned) {
    return { banned: false, ipRestricted: false };
  }
  return {
    banned: true,
    ipRestricted: row.ipRestricted,
    reason: row.reason,
  };
}

export async function isIpRestricted(ipAddress: string): Promise<boolean> {
  const state = await loadState();
  const row = state.ipRestrictions[ipAddress];
  return Boolean(row?.active);
}

export async function banUser(input: {
  userId: string;
  reason: string;
  bannedBy: string;
  ipRestricted: boolean;
  latestKnownIp?: string | null;
}): Promise<void> {
  await enqueueStateWrite((state) => {
    const ts = now();
    state.userBans[input.userId] = {
      userId: input.userId,
      banned: true,
      ipRestricted: input.ipRestricted,
      reason: input.reason.trim() || "Violation of terms of service",
      bannedAt: ts,
      bannedBy: input.bannedBy,
      updatedAt: ts,
    };

    if (input.ipRestricted && input.latestKnownIp) {
      state.ipRestrictions[input.latestKnownIp] = {
        ipAddress: input.latestKnownIp,
        reason: input.reason.trim() || "Violation of terms of service",
        addedAt: ts,
        addedBy: input.bannedBy,
        active: true,
        updatedAt: ts,
      };
    }
  });
}

export async function unbanUser(input: {
  userId: string;
  reviewedBy: string;
}): Promise<void> {
  await enqueueStateWrite((state) => {
    const row = state.userBans[input.userId];
    if (!row) {
      return;
    }
    row.banned = false;
    row.updatedAt = now();
    row.bannedBy = input.reviewedBy;
    row.ipRestricted = false;
  });
}

export async function createAppeal(input: {
  type: AppealType;
  userId?: string;
  ipAddress?: string;
  contactEmail: string;
  message: string;
}): Promise<AppealRecord> {
  const appeal: AppealRecord = {
    id: randomId(14),
    type: input.type,
    userId: input.userId,
    ipAddress: input.ipAddress,
    contactEmail: normalizeEmail(input.contactEmail),
    message: input.message.trim(),
    createdAt: now(),
    status: "pending",
  };

  await enqueueStateWrite((state) => {
    state.appeals[appeal.id] = appeal;
  });

  return appeal;
}

export async function listAppeals(): Promise<AppealRecord[]> {
  const state = await loadState();
  return Object.values(state.appeals).sort((a, b) => b.createdAt - a.createdAt);
}

export async function resolveAppeal(input: {
  appealId: string;
  approved: boolean;
  reviewedBy: string;
}): Promise<{ ok: boolean; appeal?: AppealRecord; error?: string }> {
  const state = await loadState();
  const appeal = state.appeals[input.appealId];
  if (!appeal) {
    return { ok: false, error: "Appeal not found" };
  }

  const status: AppealStatus = input.approved ? "approved" : "rejected";
  await enqueueStateWrite((next) => {
    const row = next.appeals[input.appealId];
    if (!row) {
      return;
    }
    row.status = status;
    row.reviewedAt = now();
    row.reviewedBy = input.reviewedBy;
  });

  const updated = (await loadState()).appeals[input.appealId];
  if (input.approved && updated?.userId) {
    await unbanUser({
      userId: updated.userId,
      reviewedBy: input.reviewedBy,
    });
  }

  return { ok: true, appeal: updated };
}

export async function listBannedUsers(): Promise<UserBanRecord[]> {
  const state = await loadState();
  return Object.values(state.userBans)
    .filter((row) => row.banned)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function listAdminUsersPage(input: {
  page: number;
  pageSize: number;
  status: AdminUserBaseStatusFilter;
}): Promise<AdminUserBaseListResult> {
  const safePage = Number.isFinite(input.page) && input.page > 0 ? Math.floor(input.page) : 1;
  const safePageSize =
    Number.isFinite(input.pageSize) && input.pageSize > 0
      ? Math.min(100, Math.max(10, Math.floor(input.pageSize)))
      : 25;
  const nowTs = now();
  const state = await loadState();

  let allUsers: AdminUserBaseListItem[] = [];

  if (isDatabaseConnected()) {
    const rows =
      (await query<{
        user_id: string;
        username: string | null;
        created_at: number;
        notification_email: string | null;
        active_session_count: string | number | null;
        last_seen_at: string | number | null;
      }>(
        `SELECT ua.user_id,
                ua.username,
                ua.created_at,
                up.notification_email,
                COALESCE(sess.active_session_count, 0) AS active_session_count,
                sess.last_seen_at
         FROM user_accounts ua
         LEFT JOIN user_profiles up
           ON up.user_id = ua.user_id
         LEFT JOIN (
           SELECT user_id,
                  COUNT(*) FILTER (WHERE expires_at > $1) AS active_session_count,
                  MAX(last_seen_at) AS last_seen_at
           FROM auth_sessions
           GROUP BY user_id
         ) sess
           ON sess.user_id = ua.user_id
         ORDER BY ua.created_at DESC;`,
        [nowTs],
      )) || [];

    allUsers = rows.map((row) => {
      const banState = state.userBans[row.user_id];
      const activeSessionCount = Number.parseInt(
        String(row.active_session_count || 0),
        10,
      );
      const lastSeenRaw = row.last_seen_at;
      const lastSeenParsed =
        lastSeenRaw === null || lastSeenRaw === undefined
          ? null
          : Number.parseInt(String(lastSeenRaw), 10);

      return {
        userId: row.user_id,
        username: (row.username || "").toLowerCase(),
        createdAt: Number.parseInt(String(row.created_at || 0), 10) || 0,
        notificationEmail: row.notification_email || null,
        activeSessionCount: Number.isFinite(activeSessionCount) ? activeSessionCount : 0,
        lastSeenAt:
          lastSeenParsed && Number.isFinite(lastSeenParsed) ? lastSeenParsed : null,
        banned: Boolean(banState?.banned),
        ipRestricted: Boolean(banState?.banned && banState?.ipRestricted),
      };
    });
  } else {
    const accountsRoot = path.join(storageRoot, "voltex-users", "accounts");
    const profilesRoot = path.join(storageRoot, "voltex-users", "profiles");
    const sessionsRoot = path.join(storageRoot, "voltex-users", "sessions");
    const sessionStats = new Map<
      string,
      {
        activeSessionCount: number;
        lastSeenAt: number | null;
      }
    >();

    try {
      const sessionEntries = await fs.readdir(sessionsRoot);
      for (const entry of sessionEntries) {
        if (!entry.endsWith(".json")) continue;
        try {
          const raw = await fs.readFile(path.join(sessionsRoot, entry), "utf8");
          const session = safeJsonParse<{
            userId?: string;
            expiresAt?: number;
            lastSeenAt?: number;
            createdAt?: number;
          }>(raw, {});
          const userId = session.userId?.trim();
          if (!userId) continue;

          const existing = sessionStats.get(userId) || {
            activeSessionCount: 0,
            lastSeenAt: null,
          };
          const expiresAt =
            typeof session.expiresAt === "number" ? session.expiresAt : 0;
          const lastSeenAt =
            typeof session.lastSeenAt === "number"
              ? session.lastSeenAt
              : typeof session.createdAt === "number"
                ? session.createdAt
                : null;
          if (expiresAt > nowTs) {
            existing.activeSessionCount += 1;
          }
          if (
            typeof lastSeenAt === "number" &&
            Number.isFinite(lastSeenAt) &&
            (!existing.lastSeenAt || lastSeenAt > existing.lastSeenAt)
          ) {
            existing.lastSeenAt = lastSeenAt;
          }
          sessionStats.set(userId, existing);
        } catch {
          // Ignore invalid session file.
        }
      }
    } catch {
      // Ignore missing sessions directory.
    }

    let accountEntries: string[] = [];
    try {
      accountEntries = await fs.readdir(accountsRoot);
    } catch {
      accountEntries = [];
    }

    const users = await Promise.all(
      accountEntries
        .filter((entry) => entry.endsWith(".json"))
        .map(async (entry): Promise<AdminUserBaseListItem | null> => {
          const filePath = path.join(accountsRoot, entry);
          try {
            const raw = await fs.readFile(filePath, "utf8");
            const account = safeJsonParse<{
              userId?: string;
              username?: string;
              createdAt?: number;
            }>(raw, {});
            const userId = (account.userId || entry.replace(/\.json$/i, "")).trim();
            if (!userId) return null;

            let notificationEmail: string | null = null;
            try {
              const profileRaw = await fs.readFile(
                path.join(profilesRoot, `${userId}.json`),
                "utf8",
              );
              const profile = safeJsonParse<{ notificationEmail?: string }>(
                profileRaw,
                {},
              );
              notificationEmail = profile.notificationEmail?.trim() || null;
            } catch {
              notificationEmail = null;
            }

            const stats = sessionStats.get(userId) || {
              activeSessionCount: 0,
              lastSeenAt: null,
            };
            const banState = state.userBans[userId];

            return {
              userId,
              username: (account.username || "").toLowerCase(),
              createdAt:
                typeof account.createdAt === "number"
                  ? account.createdAt
                  : 0,
              notificationEmail,
              activeSessionCount: stats.activeSessionCount,
              lastSeenAt: stats.lastSeenAt,
              banned: Boolean(banState?.banned),
              ipRestricted: Boolean(banState?.banned && banState?.ipRestricted),
            };
          } catch {
            return null;
          }
        }),
    );

    allUsers = users
      .filter((row): row is AdminUserBaseListItem => Boolean(row))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  const filteredUsers = allUsers.filter((user) => {
    if (input.status === "all") return true;
    if (input.status === "active") {
      return !user.banned && user.activeSessionCount > 0;
    }
    if (input.status === "inactive") {
      return !user.banned && user.activeSessionCount === 0;
    }
    if (input.status === "banned") {
      return user.banned;
    }
    if (input.status === "ip-restricted") {
      return user.banned && user.ipRestricted;
    }
    return true;
  });

  const totalCount = filteredUsers.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / safePageSize));
  const page = Math.min(safePage, totalPages);
  const start = (page - 1) * safePageSize;
  const users = filteredUsers.slice(start, start + safePageSize);

  return {
    users,
    page,
    pageSize: safePageSize,
    totalCount,
    totalPages,
    status: input.status,
  };
}

export async function recordEmailNotificationEvent(input: {
  senderId: string;
  recipientId: string;
  recipientEmail: string;
  threshold: number;
}): Promise<void> {
  await ensureAdminDir();
  const ts = now();
  const entry = {
    id: randomId(12),
    senderId: input.senderId,
    recipientId: input.recipientId,
    recipientEmail: normalizeEmail(input.recipientEmail),
    threshold: input.threshold,
    createdAt: ts,
  };

  let events: any[] = [];
  try {
    const raw = await fs.readFile(EMAIL_LOG_PATH, "utf8");
    const parsed = safeJsonParse<any[]>(raw, []);
    events = Array.isArray(parsed) ? parsed : [];
  } catch {
    events = [];
  }

  events.push(entry);
  if (events.length > 10000) {
    events.splice(0, events.length - 10000);
  }
  await fs.mkdir(path.dirname(EMAIL_LOG_PATH), { recursive: true });
  await fs.writeFile(EMAIL_LOG_PATH, JSON.stringify(events, null, 2), "utf8");
}

async function getEmailNotificationSentCount(): Promise<number> {
  try {
    const raw = await fs.readFile(EMAIL_LOG_PATH, "utf8");
    const entries = safeJsonParse<any[]>(raw, []);
    return Array.isArray(entries) ? entries.length : 0;
  } catch {
    return 0;
  }
}

async function getTotalUsersCount(): Promise<number> {
  if (isDatabaseConnected()) {
    const result = await queryOne<{ count: string }>(
      `SELECT COUNT(*) AS count FROM user_accounts;`,
    );
    return result?.count ? Number.parseInt(result.count, 10) || 0 : 0;
  }

  const accountsRoot = path.join(storageRoot, "voltex-users", "accounts");
  try {
    const entries = await fs.readdir(accountsRoot);
    return entries.filter((entry) => entry.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

async function getRegisteredEmailsCount(): Promise<number> {
  if (isDatabaseConnected()) {
    const result = await queryOne<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM user_profiles
       WHERE notification_email IS NOT NULL
         AND LENGTH(TRIM(notification_email)) > 0;`,
    );
    return result?.count ? Number.parseInt(result.count, 10) || 0 : 0;
  }

  const profileRoot = path.join(storageRoot, "voltex-users", "profiles");
  try {
    const entries = await fs.readdir(profileRoot);
    let count = 0;
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const raw = await fs.readFile(path.join(profileRoot, entry), "utf8");
      const profile = safeJsonParse<{ notificationEmail?: string }>(raw, {});
      if (typeof profile.notificationEmail === "string" && profile.notificationEmail.trim()) {
        count += 1;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

async function getTotalDirectConversationCountForUser(userId: string): Promise<number> {
  if (isDatabaseConnected()) {
    const result = await queryOne<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM conversations
       WHERE user_id = $1;`,
      [userId],
    );
    return result?.count ? Number.parseInt(result.count, 10) || 0 : 0;
  }

  const conversationsRoot = path.join(storageRoot, "voltex-messages", "conversations");
  try {
    const entries = await fs.readdir(conversationsRoot);
    let count = 0;
    for (const entry of entries) {
      const decoded = decodeURIComponent(entry);
      const [a, b] = decoded.split(":");
      if (a === userId || b === userId) {
        count += 1;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

export async function getUserAdminDetailsByUsername(
  username: string,
): Promise<{
  userId: string;
  username: string;
  createdAt: number;
  totalGroupCount: number;
  totalIndividualChatCount: number;
  notificationEmail: string | null;
  latestIpAddress: string | null;
  ipLogs: IpLogRecord[];
  passkeyEnabled: boolean;
  passkeyCreatedAt: number | null;
  passkeyLastUsedAt: number | null;
} | null> {
  const normalizedUsername = username.trim().toLowerCase().replace(/^@+/, "");
  if (!normalizedUsername) {
    return null;
  }

  let account:
    | { user_id: string; username: string; created_at: number }
    | undefined
    | null = null;
  if (isDatabaseConnected()) {
    account = await queryOne<{
      user_id: string;
      username: string;
      created_at: number;
    }>(
      `SELECT user_id, username, created_at
       FROM user_accounts
       WHERE username = $1
       LIMIT 1;`,
      [normalizedUsername],
    );
  } else {
    const usernamePath = path.join(
      storageRoot,
      "voltex-users",
      "usernames",
      `${normalizedUsername}.json`,
    );
    try {
      const raw = await fs.readFile(usernamePath, "utf8");
      const data = safeJsonParse<{ userId?: string }>(raw, {});
      if (data.userId) {
        const accountPath = path.join(
          storageRoot,
          "voltex-users",
          "accounts",
          `${data.userId}.json`,
        );
        const accountRaw = await fs.readFile(accountPath, "utf8");
        const accountData = safeJsonParse<{ createdAt?: number }>(accountRaw, {});
        account = {
          user_id: data.userId,
          username: normalizedUsername,
          created_at: Number(accountData.createdAt || 0),
        };
      }
    } catch {
      account = null;
    }
  }

  if (!account?.user_id) {
    return null;
  }

  const groups = await listAllGroups();
  const totalGroupCount = groups.filter((group) =>
    group.members.some(
      (member) => member.userId === account?.user_id && member.status === "active",
    ),
  ).length;
  const totalIndividualChatCount = await getTotalDirectConversationCountForUser(
    account.user_id,
  );

  let notificationEmail: string | null = null;
  if (isDatabaseConnected()) {
    const profile = await queryOne<{ notification_email: string | null }>(
      `SELECT notification_email FROM user_profiles WHERE user_id = $1 LIMIT 1;`,
      [account.user_id],
    );
    notificationEmail = profile?.notification_email || null;
  } else {
    try {
      const profileRaw = await fs.readFile(
        path.join(storageRoot, "voltex-users", "profiles", `${account.user_id}.json`),
        "utf8",
      );
      const profile = safeJsonParse<{ notificationEmail?: string }>(profileRaw, {});
      notificationEmail = profile.notificationEmail || null;
    } catch {
      notificationEmail = null;
    }
  }

  const ipLogs = await getUserIpLogs(account.user_id);
  const latestIpAddress = ipLogs[0]?.ipAddress || null;
  const passkey = await getPasskeyCredentialByUserId(account.user_id);

  return {
    userId: account.user_id,
    username: account.username,
    createdAt: Number(account.created_at || 0),
    totalGroupCount,
    totalIndividualChatCount,
    notificationEmail,
    latestIpAddress,
    ipLogs,
    passkeyEnabled: !!passkey,
    passkeyCreatedAt: passkey?.createdAt || null,
    passkeyLastUsedAt: passkey?.lastUsedAt || null,
  };
}

export async function getAdminOverviewMetrics(): Promise<{
  totalUsers: number;
  totalGroups: number;
  totalEmailNotificationsSent: number;
  totalRegisteredEmails: number;
  connectedUsers: number;
  queuedMessages: number;
  usersWithQueuedMessages: number;
  totalMessages: number;
  activeMessages: number;
  archivedMessages: number;
  bannedUsers: number;
  pendingAppeals: number;
}> {
  const [totalUsers, groups, totalEmailNotificationsSent, totalRegisteredEmails] =
    await Promise.all([
      getTotalUsersCount(),
      listAllGroups(),
      getEmailNotificationSentCount(),
      getRegisteredEmailsCount(),
    ]);

  const queueStats = getQueueStats();
  const connectedUsers = getConnectedUserCount();
  const dbStats = isDatabaseConnected()
    ? await getDatabaseStats()
    : { total: 0, active: 0, archived: 0 };
  const bannedUsersCount = (await listBannedUsers()).length;
  const pendingAppeals = (await listAppeals()).filter(
    (appeal) => appeal.status === "pending",
  ).length;

  return {
    totalUsers,
    totalGroups: groups.length,
    totalEmailNotificationsSent,
    totalRegisteredEmails,
    connectedUsers,
    queuedMessages: queueStats.totalQueuedMessages,
    usersWithQueuedMessages: queueStats.usersWithQueuedMessages,
    totalMessages: dbStats.total,
    activeMessages: dbStats.active,
    archivedMessages: dbStats.archived,
    bannedUsers: bannedUsersCount,
    pendingAppeals,
  };
}

export async function enforcePreAuthAccessGuards(input: {
  userId?: string;
  req: Request;
  action: "signin" | "register";
  username?: string;
}): Promise<
  | { ok: true }
  | {
      ok: false;
      status: number;
      body: Record<string, unknown>;
    }
> {
  const ipAddress = getClientIp(input.req);
  const userId = input.userId?.trim() || "";
  const username = input.username?.trim().toLowerCase() || "";

  if (input.action === "register") {
    await logUserIpEvent({
      userId: undefined,
      username: username || undefined,
      ipAddress,
      action: "register-attempt",
    });

    const blockedByIp = await isIpRestricted(ipAddress);
    if (blockedByIp) {
      await logUserIpEvent({
        userId: undefined,
        username: username || undefined,
        ipAddress,
        action: "register-blocked",
      });
      return {
        ok: false,
        status: 403,
        body: {
          error: "This IP address has been permanently restricted from Voltex",
          code: "IP_RESTRICTED",
          appealType: "ip-restricted",
        },
      };
    }

    return { ok: true };
  }

  if (input.action === "signin") {
    await logUserIpEvent({
      userId: userId || undefined,
      username: username || undefined,
      ipAddress,
      action: "signin-attempt",
    });
  }

  if (userId) {
    const banState = await isUserBanned(userId);
    if (banState.banned) {
      await logUserIpEvent({
        userId,
        username: username || undefined,
        ipAddress,
        action: "signin-blocked",
      });
      return {
        ok: false,
        status: 403,
        body: {
          error:
            "Your account has been banned for violating the terms of service.",
          code: "ACCOUNT_BANNED",
          appealType: "banned-user",
          reason: banState.reason || "Violation of terms of service",
        },
      };
    }
  }

  return { ok: true };
}

export async function logAuthSuccess(input: {
  userId: string;
  username?: string;
  req: Request;
  action: "signin-success" | "register-success";
}): Promise<void> {
  await logUserIpEvent({
    userId: input.userId,
    username: input.username,
    ipAddress: getClientIp(input.req),
    action: input.action,
  });
}
