import { Request, RequestHandler } from "express";
import crypto from "crypto";
import { SessionData } from "@shared/crypto";

export interface RequestWithSession extends Request {
  session?: SessionData;
}

const wsTickets = new Map<
  string,
  {
    sessionToken: string;
    userId: string;
    expiresAt: number;
  }
>();

function timingSafeEqualString(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);

  if (expectedBuffer.length === 0 || expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function getBearerToken(
  authorizationHeader: unknown,
): string | undefined {
  if (typeof authorizationHeader !== "string") {
    return undefined;
  }

  if (!authorizationHeader.startsWith("Bearer ")) {
    return undefined;
  }

  const token = authorizationHeader.slice("Bearer ".length).trim();
  return token.length > 0 ? token : undefined;
}

export function extractBearerToken(req: {
  headers: { authorization?: unknown };
}): string | undefined {
  return getBearerToken(req.headers.authorization);
}

export const requireAuthenticatedSession: RequestHandler = async (
  req,
  res,
  next,
) => {
  try {
    const { getSessionFromToken } = await import("../routes/auth");
    const sessionToken = extractBearerToken(req);
    if (!sessionToken) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const session = await getSessionFromToken(sessionToken);
    if (!session) {
      return res.status(401).json({ error: "Invalid or expired session" });
    }

    (req as RequestWithSession).session = session;
    next();
  } catch (error) {
    console.error("Session authentication error:", error);
    return res.status(500).json({ error: "Failed to validate session" });
  }
};

export const requireAdminAccess: RequestHandler = (req, res, next) => {
  const configuredToken = process.env.ADMIN_API_TOKEN;
  if (!configuredToken) {
    return res.status(503).json({
      error: "Admin endpoints are disabled",
    });
  }

  const providedToken = req.headers["x-admin-token"];
  if (typeof providedToken !== "string") {
    return res.status(401).json({ error: "Admin authentication required" });
  }

  if (!timingSafeEqualString(configuredToken, providedToken)) {
    return res.status(403).json({ error: "Invalid admin token" });
  }

  next();
};

export function issueWebSocketTicket(
  sessionToken: string,
  userId: string,
  ttlMs: number = 60_000,
): { ticket: string; expiresAt: number } {
  const ticket = crypto.randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + ttlMs;

  wsTickets.set(ticket, {
    sessionToken,
    userId,
    expiresAt,
  });

  return { ticket, expiresAt };
}

export function consumeWebSocketTicket(
  ticket: string,
): { sessionToken: string; userId: string } | null {
  const data = wsTickets.get(ticket);
  if (!data) {
    return null;
  }

  wsTickets.delete(ticket);

  if (data.expiresAt < Date.now()) {
    return null;
  }

  return {
    sessionToken: data.sessionToken,
    userId: data.userId,
  };
}

export function cleanupExpiredWebSocketTickets(): void {
  const now = Date.now();
  for (const [ticket, data] of wsTickets.entries()) {
    if (data.expiresAt < now) {
      wsTickets.delete(ticket);
    }
  }
}
