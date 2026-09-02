import { RequestHandler } from "express";
import crypto from "crypto";

/**
 * Rate limiting configuration for different endpoints
 * Inspired by modern messaging apps (WhatsApp, Telegram)
 */
interface RateLimitConfig {
  windowMs: number; // Time window in milliseconds
  maxRequests: number; // Max requests per window
  message?: string;
}

interface UserRateLimitData {
  count: number;
  resetTime: number;
}

function getForwardedIp(req: any): string {
  const cfConnectingIp =
    typeof req.headers["cf-connecting-ip"] === "string"
      ? req.headers["cf-connecting-ip"].trim()
      : "";
  if (cfConnectingIp) {
    return cfConnectingIp;
  }

  const xRealIp =
    typeof req.headers["x-real-ip"] === "string"
      ? req.headers["x-real-ip"].trim()
      : "";
  if (xRealIp) {
    return xRealIp;
  }

  const forwardedFor =
    typeof req.headers["x-forwarded-for"] === "string"
      ? req.headers["x-forwarded-for"].split(",")[0]?.trim()
      : "";
  if (forwardedFor) {
    return forwardedFor;
  }

  return "";
}

// Store rate limit data per user
const userRateLimits = new Map<string, Map<string, UserRateLimitData>>();

/**
 * Get user identifier from request
 */
function getUserIdentifier(req: any): string {
  const authHeader =
    typeof req.headers.authorization === "string"
      ? req.headers.authorization
      : "";
  const forwardedIp = getForwardedIp(req);
  const ip =
    forwardedIp ||
    req.ip ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    "unknown";

  const rawIdentifier = authHeader
    ? `auth:${authHeader}`
    : `ip:${String(ip)}`;

  return crypto.createHash("sha256").update(rawIdentifier).digest("hex");
}

/**
 * Create a rate limit middleware for an endpoint
 * Uses sliding window algorithm optimized for messaging apps
 */
export function createRateLimiter(config: RateLimitConfig): RequestHandler {
  return (req, res, next) => {
    const userId = getUserIdentifier(req);
    const endpoint = req.path;
    const key = `${userId}:${endpoint}`;

    // Get or initialize rate limit data for this user+endpoint
    if (!userRateLimits.has(userId)) {
      userRateLimits.set(userId, new Map());
    }

    const userLimits = userRateLimits.get(userId)!;
    const now = Date.now();
    let limitData = userLimits.get(endpoint);

    // Reset if window has passed
    if (!limitData || now > limitData.resetTime) {
      limitData = {
        count: 0,
        resetTime: now + config.windowMs,
      };
      userLimits.set(endpoint, limitData);
    }

    limitData.count++;

    // Set rate limit headers
    const timeRemaining = Math.max(0, limitData.resetTime - now);
    res.set("X-RateLimit-Limit", config.maxRequests.toString());
    res.set(
      "X-RateLimit-Remaining",
      Math.max(0, config.maxRequests - limitData.count).toString(),
    );
    res.set("X-RateLimit-Reset", limitData.resetTime.toString());

    // Check if limit exceeded
    if (limitData.count > config.maxRequests) {
      return res.status(429).json({
        error: config.message || "Too many requests, please try again later",
        retryAfter: Math.ceil(timeRemaining / 1000),
      });
    }

    next();
  };
}

/**
 * Cleanup old rate limit data periodically
 * Prevents memory from growing unbounded
 */
export function startRateLimitCleanup(): void {
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    let totalCleaned = 0;

    // Clean up expired entries
    for (const [userId, endpoints] of userRateLimits.entries()) {
      for (const [endpoint, data] of endpoints.entries()) {
        if (now > data.resetTime) {
          endpoints.delete(endpoint);
          totalCleaned++;
        }
      }

      // Remove empty user entries
      if (endpoints.size === 0) {
        userRateLimits.delete(userId);
      }
    }

    if (totalCleaned > 0) {
      console.log(`[Rate Limit] Cleaned up ${totalCleaned} expired entries`);
    }
  }, 60000); // Cleanup every minute

  cleanupInterval.unref?.();
}

/**
 * Rate limiting presets for common endpoints
 * These are tuned for a competitive messaging app experience
 */
export const RATE_LIMITS = {
  // Message sending: 100 messages per minute (burst-friendly for modern apps)
  MESSAGE_SEND: {
    windowMs: 60000, // 1 minute
    maxRequests: 100,
    message: "Too many messages, please slow down",
  },

  // Getting conversations: 30 requests per minute
  CONVERSATION_GET: {
    windowMs: 60000,
    maxRequests: 30,
    message: "Too many requests, please slow down",
  },

  // User search: 20 requests per minute
  USER_SEARCH: {
    windowMs: 60000,
    maxRequests: 20,
    message: "Too many search requests, please slow down",
  },

  // Authentication: 5 attempts per minute (security critical)
  AUTH: {
    windowMs: 60000,
    maxRequests: 5,
    message: "Too many authentication attempts, please try again later",
  },

  // Username availability checks happen during typing and need a higher ceiling.
  USERNAME_CHECK: {
    windowMs: 60000,
    maxRequests: 30,
    message: "Too many username checks, please wait a moment and try again",
  },

  // Profile updates: 10 per minute
  PROFILE_UPDATE: {
    windowMs: 60000,
    maxRequests: 10,
    message: "Too many profile updates, please slow down",
  },

  // File uploads (avatars): 10 per minute
  FILE_UPLOAD: {
    windowMs: 60000,
    maxRequests: 10,
    message: "Too many uploads, please slow down",
  },

  // Block/unblock actions: prevent abuse while preserving UX.
  BLOCK_MUTATION: {
    windowMs: 60000,
    maxRequests: 30,
    message: "Too many block actions, please slow down",
  },

  // Public appeal submissions should be constrained to reduce spam.
  APPEAL_CREATE: {
    windowMs: 10 * 60 * 1000,
    maxRequests: 6,
    message: "Too many appeal submissions, please try again later",
  },

  // Sensitive admin moderation operations.
  ADMIN_MODERATION: {
    windowMs: 60000,
    maxRequests: 40,
    message: "Too many admin moderation requests",
  },

  // Admin panel sign-in should be significantly stricter than general auth.
  ADMIN_LOGIN: {
    windowMs: 5 * 60 * 1000,
    maxRequests: 8,
    message: "Too many admin login attempts, please try again later",
  },

  GROUP_MUTATION: {
    windowMs: 60000,
    maxRequests: 25,
    message: "Too many group updates, please slow down",
  },
};

export default {
  createRateLimiter,
  startRateLimitCleanup,
  RATE_LIMITS,
};
