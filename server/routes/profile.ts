import { RequestHandler } from "express";
import { getSessionFromToken } from "./auth";
import { getUserAccount } from "../lib/auth-store";
import {
  saveUserProfile,
  getUserProfile,
  isUsernameDiscoveryEnabled,
  setUsernameDiscoveryEnabled,
  UserProfileRecord,
} from "../lib/profile-store";
import {
  deleteAvatarObject,
  getAvatarObject,
  uploadAvatarObject,
} from "../lib/avatar-storage";
import {
  asyncLimiters,
  createMemoryCache,
  isOverloadedError,
} from "../lib/load-control";
import {
  normalizeUsernameForLookup,
  resolveDiscoverableUserIdByUsername,
} from "../lib/username-discovery";

const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
const DISPLAY_NAME_MAX_LENGTH = 25;
const publicProfileCache = createMemoryCache<any>({
  ttlMs: 15_000,
  maxEntries: 500,
});
const avatarResponseCache = createMemoryCache<{
  body: Buffer;
  contentType: string;
  etag?: string;
  lastModified?: Date;
}>({
  ttlMs: 30_000,
  maxEntries: 32,
});

function getAvatarUrl(
  profile: UserProfileRecord | null,
  username?: string | null,
): string | null {
  if (!profile?.avatar || !username) {
    return null;
  }

  const version = profile.updatedAt || profile.createdAt || Date.now();
  return `/api/profile/avatar/by-username/${encodeURIComponent(username)}?v=${version}`;
}

function normalizeUsername(value: unknown): string {
  return normalizeUsernameForLookup(value);
}

function getPublicProfileCacheKey(userId: string): string {
  return `public-profile:${userId}`;
}

function getAvatarCacheKey(key: string): string {
  return `avatar:${key}`;
}

function invalidateProfileCaches(userId: string, avatarKey?: string | null): void {
  publicProfileCache.delete(getPublicProfileCacheKey(userId));

  if (avatarKey) {
    avatarResponseCache.delete(getAvatarCacheKey(avatarKey));
  }
}

/**
 * GET /api/profile/me
 * Get current user's profile information
 */
export const handleGetProfile: RequestHandler = async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const sessionToken =
      typeof authHeader === "string"
        ? authHeader.replace("Bearer ", "")
        : undefined;

    if (!sessionToken) {
      return res.status(401).json({ error: "No session token provided" });
    }

    const session = await getSessionFromToken(sessionToken);
    if (!session) {
      return res.status(401).json({ error: "Invalid or expired session" });
    }

    // Get profile from R2
    const profile = await getUserProfile(session.userId);
    const account = await getUserAccount(session.userId);

    if (!profile) {
      // Return basic profile if not found in R2
      return res.status(200).json({
        userId: session.userId,
        publicKey: session.publicKey,
        displayName: "User",
        username: account?.username || null,
        avatar: null,
        notifications: false,
        notificationEmail: null,
        usernameDiscoveryEnabled: true,
        createdAt: Date.now(),
      });
    }

    return res.status(200).json({
      userId: session.userId,
      ...profile,
      username: account?.username || null,
      avatar: getAvatarUrl(profile, account?.username),
      notificationEmail: profile.notificationEmail || null,
      usernameDiscoveryEnabled: isUsernameDiscoveryEnabled(profile),
    });
  } catch (error) {
    console.error("Get profile error:", error);
    return res.status(500).json({ error: "Failed to retrieve profile" });
  }
};

/**
 * PUT /api/profile/me
 * Update user profile information
 */
export const handleUpdateProfile: RequestHandler = async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const sessionToken =
      typeof authHeader === "string"
        ? authHeader.replace("Bearer ", "")
        : undefined;

    if (!sessionToken) {
      return res.status(401).json({ error: "No session token provided" });
    }

    const session = await getSessionFromToken(sessionToken);
    if (!session) {
      return res.status(401).json({ error: "Invalid or expired session" });
    }
    const account = await getUserAccount(session.userId);

    const { displayName, bio, notificationEmail } = req.body;

    // Validate input
    if (displayName && typeof displayName !== "string") {
      return res.status(400).json({ error: "Invalid displayName" });
    }

    if (bio && typeof bio !== "string") {
      return res.status(400).json({ error: "Invalid bio" });
    }

    if (
      notificationEmail !== undefined &&
      notificationEmail !== null &&
      typeof notificationEmail !== "string"
    ) {
      return res.status(400).json({ error: "Invalid notification email" });
    }

    const normalizedNotificationEmail =
      typeof notificationEmail === "string"
        ? notificationEmail.trim().toLowerCase()
        : "";

    if (
      normalizedNotificationEmail &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedNotificationEmail)
    ) {
      return res.status(400).json({ error: "Invalid notification email" });
    }

    const normalizedDisplayName =
      typeof displayName === "string" ? displayName.trim() : undefined;

    if (
      typeof normalizedDisplayName === "string" &&
      normalizedDisplayName.length > DISPLAY_NAME_MAX_LENGTH
    ) {
      return res.status(400).json({
        error: `Display name must be ${DISPLAY_NAME_MAX_LENGTH} characters or fewer`,
      });
    }

    // Get existing profile
    let profile = await getUserProfile(session.userId);
    if (!profile) {
      profile = {
        userId: session.userId,
        createdAt: Date.now(),
      };
    }

    // Update profile fields
    if (typeof normalizedDisplayName === "string") {
      if (normalizedDisplayName.length > 0) {
        profile.displayName = normalizedDisplayName;
      } else {
        delete profile.displayName;
      }
    }
    if (bio !== undefined) profile.bio = bio;
    if (notificationEmail !== undefined) {
      profile.notificationEmail = normalizedNotificationEmail || null;
    }
    // Save to R2
    await saveUserProfile(session.userId, profile);
    invalidateProfileCaches(session.userId, profile.avatar);

    return res.status(200).json({
      message: "Profile updated successfully",
      profile: {
        ...profile,
        username: account?.username || null,
        avatar: getAvatarUrl(profile, account?.username),
      },
    });
  } catch (error) {
    console.error("Update profile error:", error);
    return res.status(500).json({ error: "Failed to update profile" });
  }
};

/**
 * GET /api/profile/:userId
 * Get public profile information for another user
 * Public endpoint - anyone can request this
 */
export const handleGetPublicProfile: RequestHandler = async (req, res) => {
  try {
    const requestedUserId =
      typeof req.params.userId === "string" ? req.params.userId.trim() : "";
    const requestedUsername = normalizeUsername(req.params.username);
    const authHeader =
      typeof req.headers.authorization === "string"
        ? req.headers.authorization
        : undefined;
    const sessionToken = authHeader?.replace("Bearer ", "");
    const session = sessionToken ? await getSessionFromToken(sessionToken) : null;

    let userId = requestedUserId;
    if (!userId && requestedUsername) {
      const resolvedUserId = await resolveDiscoverableUserIdByUsername({
        username: requestedUsername,
        requesterUserId: session?.userId,
      });
      if (!resolvedUserId) {
        return res.status(404).json({ error: "User not found" });
      }
      userId = resolvedUserId;
    }

    if (!userId) {
      return res.status(400).json({ error: "Invalid account reference" });
    }

    // Get both profile and account to include username
    const profile = await getUserProfile(userId);
    const account = await getUserAccount(userId);

    const cachedProfile = publicProfileCache.get(getPublicProfileCacheKey(userId));
    if (cachedProfile) {
      return res.status(200).json(cachedProfile);
    }

    if (!profile && !account) {
      return res.status(200).json({
        displayName: "User",
        bio: "",
        avatar: null,
        username: null,
        createdAt: null,
      });
    }

    // Only return public fields
    const responseBody = {
      displayName: profile?.displayName || "User",
      bio: profile?.bio || "",
      avatar: getAvatarUrl(profile, account?.username),
      username: account?.username || null,
      createdAt: profile?.createdAt || account?.createdAt || null,
      showTimestamps: profile?.showTimestamps ?? true,
    };

    publicProfileCache.set(getPublicProfileCacheKey(userId), responseBody);

    return res.status(200).json(responseBody);
  } catch (error) {
    console.error("Get public profile error:", error);
    return res.status(500).json({ error: "Failed to retrieve profile" });
  }
};

/**
 * POST /api/profile/avatar
 * Upload user avatar to R2
 */
export const handleUploadAvatar: RequestHandler = async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const sessionToken =
      typeof authHeader === "string"
        ? authHeader.replace("Bearer ", "")
        : undefined;

    if (!sessionToken) {
      return res.status(401).json({ error: "No session token provided" });
    }

    const session = await getSessionFromToken(sessionToken);
    if (!session) {
      return res.status(401).json({ error: "Invalid or expired session" });
    }
    const account = await getUserAccount(session.userId);

    const contentType = req.headers["content-type"];
    if (contentType !== "image/jpeg" && contentType !== "image/png") {
      return res.status(400).json({ error: "Only JPG, JPEG, and PNG files are allowed" });
    }

    const avatarBuffer = Buffer.isBuffer(req.body) ? req.body : null;
    if (!avatarBuffer || avatarBuffer.length === 0) {
      return res.status(400).json({ error: "Avatar image is required" });
    }

    if (avatarBuffer.length > AVATAR_MAX_BYTES) {
      return res.status(400).json({ error: "Avatar image exceeds the 5MB limit" });
    }

    // Get existing profile
    let profile = await getUserProfile(session.userId);
    if (!profile) {
      profile = {
        userId: session.userId,
        createdAt: Date.now(),
      };
    }

    const previousAvatarKey = profile.avatar || null;

    try {
      profile.avatar = await asyncLimiters.avatarMutation.run(() =>
        uploadAvatarObject({
          userId: session.userId,
          contentType,
          buffer: avatarBuffer,
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

    // Save to R2
    await saveUserProfile(session.userId, profile);
    invalidateProfileCaches(session.userId, previousAvatarKey);
    invalidateProfileCaches(session.userId, profile.avatar);

    return res.status(200).json({
      message: "Avatar updated successfully",
      profile: {
        ...profile,
        username: account?.username || null,
        avatar: getAvatarUrl(profile, account?.username),
      },
    });
  } catch (error) {
    console.error("Upload avatar error:", error);
    return res.status(500).json({ error: "Failed to upload avatar" });
  }
};

/**
 * DELETE /api/profile/avatar
 * Remove current user's avatar
 */
export const handleDeleteAvatar: RequestHandler = async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const sessionToken =
      typeof authHeader === "string"
        ? authHeader.replace("Bearer ", "")
        : undefined;

    if (!sessionToken) {
      return res.status(401).json({ error: "No session token provided" });
    }

    const session = await getSessionFromToken(sessionToken);
    if (!session) {
      return res.status(401).json({ error: "Invalid or expired session" });
    }

    const profile = await getUserProfile(session.userId);
    if (!profile?.avatar) {
      return res.status(200).json({
        message: "Avatar removed",
        profile: profile
          ? {
              ...profile,
              avatar: null,
            }
          : null,
      });
    }

    try {
      await asyncLimiters.avatarMutation.run(() =>
        deleteAvatarObject(profile.avatar),
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

    const deletedAvatarKey = profile.avatar;
    profile.avatar = null;
    await saveUserProfile(session.userId, profile);
    invalidateProfileCaches(session.userId, deletedAvatarKey);

    return res.status(200).json({
      message: "Avatar removed",
      profile: {
        ...profile,
        avatar: null,
      },
    });
  } catch (error) {
    console.error("Delete avatar error:", error);
    return res.status(500).json({ error: "Failed to remove avatar" });
  }
};

/**
 * GET /api/profile/avatar/by-username/:username
 * Stream avatar image from private R2 storage without exposing internal user IDs
 */
export const handleGetAvatar: RequestHandler = async (req, res) => {
  try {
    const username =
      typeof req.params.username === "string" ? req.params.username.trim() : "";

    if (!username) {
      return res.status(400).json({ error: "Invalid username" });
    }

    const authHeader =
      typeof req.headers.authorization === "string"
        ? req.headers.authorization
        : undefined;
    const sessionToken = authHeader?.replace("Bearer ", "");
    const session = sessionToken ? await getSessionFromToken(sessionToken) : null;

    const userId = await resolveDiscoverableUserIdByUsername({
      username,
      requesterUserId: session?.userId,
    });
    if (!userId) {
      return res.status(404).end();
    }

    const profile = await getUserProfile(userId);
    if (!profile?.avatar) {
      return res.status(404).end();
    }

    const avatarCacheKey = getAvatarCacheKey(profile.avatar);
    let avatarObject = avatarResponseCache.get(avatarCacheKey);

    if (!avatarObject) {
      avatarObject = await getAvatarObject(profile.avatar);
      if (avatarObject && avatarObject.body.length <= 512 * 1024) {
        avatarResponseCache.set(avatarCacheKey, avatarObject);
      }
    }

    if (!avatarObject) {
      return res.status(404).end();
    }

    if (
      avatarObject.etag &&
      req.headers["if-none-match"] === avatarObject.etag
    ) {
      res.setHeader("ETag", avatarObject.etag);
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      return res.status(304).end();
    }

    res.removeHeader("Pragma");
    res.removeHeader("Expires");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("Content-Type", avatarObject.contentType);
    res.setHeader("Content-Length", String(avatarObject.body.length));
    if (avatarObject.etag) {
      res.setHeader("ETag", avatarObject.etag);
    }
    if (avatarObject.lastModified) {
      res.setHeader("Last-Modified", avatarObject.lastModified.toUTCString());
    }

    return res.status(200).send(avatarObject.body);
  } catch (error) {
    console.error("Get avatar error:", error);
    return res.status(500).end();
  }
};

/**
 * POST /api/profile/settings
 * Update user settings/preferences
 */
export const handleUpdateSettings: RequestHandler = async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const sessionToken =
      typeof authHeader === "string"
        ? authHeader.replace("Bearer ", "")
        : undefined;

    if (!sessionToken) {
      return res.status(401).json({ error: "No session token provided" });
    }

    const session = await getSessionFromToken(sessionToken);
    if (!session) {
      return res.status(401).json({ error: "Invalid or expired session" });
    }

    const {
      notifications,
      notificationEmail,
      showTimestamps,
      usernameDiscoveryEnabled,
    } = req.body;

    if (
      notifications !== undefined &&
      typeof notifications !== "boolean"
    ) {
      return res.status(400).json({ error: "Invalid notifications setting" });
    }

    if (
      notificationEmail !== undefined &&
      notificationEmail !== null &&
      typeof notificationEmail !== "string"
    ) {
      return res.status(400).json({ error: "Invalid notification email" });
    }

    if (
      usernameDiscoveryEnabled !== undefined &&
      typeof usernameDiscoveryEnabled !== "boolean"
    ) {
      return res.status(400).json({
        error: "Invalid username discovery setting",
      });
    }

    // Get existing profile
    let profile = await getUserProfile(session.userId);
    if (!profile) {
      profile = {
        userId: session.userId,
        createdAt: Date.now(),
      };
    }

    const normalizedNotificationEmail =
      typeof notificationEmail === "string"
        ? notificationEmail.trim().toLowerCase()
        : profile.notificationEmail?.trim().toLowerCase() || "";

    if (
      notifications === true &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedNotificationEmail)
    ) {
      return res.status(400).json({
        error: "A valid email address is required when notifications are enabled",
      });
    }

    // Update settings
    if (notifications !== undefined) profile.notifications = notifications;
    if (notificationEmail !== undefined) {
      profile.notificationEmail = normalizedNotificationEmail || null;
    }
    if (showTimestamps !== undefined) profile.showTimestamps = showTimestamps;
    if (usernameDiscoveryEnabled !== undefined) {
      setUsernameDiscoveryEnabled(profile, usernameDiscoveryEnabled);
    }

    // Save to R2
    await saveUserProfile(session.userId, profile);
    invalidateProfileCaches(session.userId, profile.avatar);

    return res.status(200).json({
      message: "Settings updated successfully",
      profile: {
        ...profile,
        usernameDiscoveryEnabled: isUsernameDiscoveryEnabled(profile),
      },
    });
  } catch (error) {
    console.error("Update settings error:", error);
    return res.status(500).json({ error: "Failed to update settings" });
  }
};
