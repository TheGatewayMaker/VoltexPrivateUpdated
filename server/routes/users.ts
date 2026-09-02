import { RequestHandler } from "express";
import { getUserAccount, searchUsernames } from "../lib/auth-store";
import {
  getUserProfile,
  UserProfileRecord,
} from "../lib/profile-store";
import { getSessionFromToken } from "./auth";
import { createMemoryCache } from "../lib/load-control";
import {
  normalizeUsernameForLookup,
  resolveDiscoverableUserIdByUsername,
} from "../lib/username-discovery";

const usernameLookupCache = createMemoryCache<{
  username: string;
  displayName: string;
  bio: string;
  avatar: string | null;
}>({
  ttlMs: 15_000,
  maxEntries: 500,
});

function normalizeUsernameQuery(value: string): string {
  return normalizeUsernameForLookup(value);
}

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

async function getUsernameLookupResult(
  normalizedUsername: string,
  requesterUserId?: string,
) {
  const userId = await resolveDiscoverableUserIdByUsername({
    username: normalizedUsername,
    requesterUserId,
  });
  if (!userId) {
    return null;
  }

  const cached = usernameLookupCache.get(normalizedUsername);
  if (cached) {
    return cached;
  }

  const profile = await getUserProfile(userId);
  const account = await getUserAccount(userId);

  if (!account) {
    return null;
  }

  const result = {
    username: account.username || normalizedUsername,
    displayName: profile?.displayName || "User",
    bio: profile?.bio || "",
    avatar: getAvatarUrl(profile, account.username),
  };

  usernameLookupCache.set(normalizedUsername, result);
  return result;
}

/**
 * POST /api/users/search
 * Search for users by username (supports partial username matching)
 * Returns public profile information for username-based discovery
 */
export const handleSearchUsers: RequestHandler = async (req, res) => {
  try {
    const { query } = req.body;

    if (!query || typeof query !== "string") {
      return res.status(400).json({ error: "Search query is required" });
    }

    const searchQuery = normalizeUsernameQuery(query);

    if (searchQuery.length < 1) {
      return res.status(400).json({ error: "Search query is too short" });
    }

    if (searchQuery.length > 30) {
      return res.status(400).json({ error: "Search query is too long" });
    }

    // Require authentication to reduce user enumeration.
    const authHeader = req.headers.authorization;
    const sessionToken =
      typeof authHeader === "string"
        ? authHeader.replace("Bearer ", "")
        : undefined;
    if (!sessionToken) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const session = await getSessionFromToken(sessionToken);
    if (!session) {
      return res.status(401).json({ error: "Invalid or expired session" });
    }

    const matches = await searchUsernames(searchQuery, 8);
    const results = (
      await Promise.all(
        matches.map(async (match) => {
          if (match.userId === session.userId) {
            return null;
          }
          return getUsernameLookupResult(match.username, session.userId);
        }),
      )
    ).filter(Boolean);

    return res.status(200).json({
      results,
      query: searchQuery,
      count: results.length,
    });
  } catch (error) {
    console.error("User search error:", error);
    return res.status(500).json({ error: "Failed to search users" });
  }
};

/**
 * GET /api/users/by-username/:username
 * Get user profile by username
 * Returns public profile information
 */
export const handleGetUserByUsername: RequestHandler = async (req, res) => {
  try {
    const username =
      typeof req.params.username === "string" ? req.params.username : "";
    const normalizedUsername = normalizeUsernameQuery(username);

    if (!normalizedUsername) {
      return res.status(400).json({ error: "Username is required" });
    }

    let requesterUserId: string | undefined;
    const authHeader =
      typeof req.headers.authorization === "string"
        ? req.headers.authorization
        : undefined;
    const sessionToken = authHeader?.replace("Bearer ", "");
    if (sessionToken) {
      const session = await getSessionFromToken(sessionToken);
      requesterUserId = session?.userId;
    }

    const result = await getUsernameLookupResult(
      normalizedUsername,
      requesterUserId,
    );
    if (!result) {
      return res.status(404).json({ error: "User not found" });
    }

    return res.status(200).json(result);
  } catch (error) {
    console.error("Get user by username error:", error);
    return res.status(500).json({ error: "Failed to retrieve user" });
  }
};

export const handleResolveUserByUsername: RequestHandler = async (req, res) => {
  try {
    const username =
      typeof req.params.username === "string" ? req.params.username : "";
    const normalizedUsername = normalizeUsernameQuery(username);

    if (!normalizedUsername) {
      return res.status(400).json({ error: "Username is required" });
    }

    const authHeader =
      typeof req.headers.authorization === "string"
        ? req.headers.authorization
        : undefined;
    const sessionToken = authHeader?.replace("Bearer ", "");

    if (!sessionToken) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const session = await getSessionFromToken(sessionToken);
    if (!session) {
      return res.status(401).json({ error: "Invalid or expired session" });
    }

    const userId = await resolveDiscoverableUserIdByUsername({
      username: normalizedUsername,
      requesterUserId: session.userId,
    });
    if (!userId) {
      return res.status(404).json({ error: "User not found" });
    }

    const result = await getUsernameLookupResult(
      normalizedUsername,
      session.userId,
    );

    return res.status(200).json({
      userId,
      username: result?.username || normalizedUsername,
      displayName: result?.displayName || "User",
      bio: result?.bio || "",
      avatar: result?.avatar || null,
    });
  } catch (error) {
    console.error("Resolve user by username error:", error);
    return res.status(500).json({ error: "Failed to resolve user" });
  }
};
