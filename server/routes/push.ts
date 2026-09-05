import { RequestHandler } from "express";
import { extractBearerToken } from "../lib/auth";
import { getSessionFromToken } from "./auth";
import {
  deletePushRegistration,
  savePushRegistration,
} from "../lib/push-store";
import {
  extractTopicFromEndpoint,
  getPushPublicBaseUrl,
  getPushSubscribeToken,
  isPushConfigured,
} from "../lib/push-notifications";

async function requireSession(req: Parameters<RequestHandler>[0]) {
  const sessionToken = extractBearerToken(req);
  if (!sessionToken) {
    throw new Error("Authentication required");
  }

  const session = await getSessionFromToken(sessionToken);
  if (!session) {
    throw new Error("Invalid or expired session");
  }

  if (!session.deviceId) {
    throw new Error("Current session is missing a device binding");
  }

  return session;
}

function statusForError(message: string): number {
  if (
    message === "Authentication required" ||
    message === "Invalid or expired session"
  ) {
    return 401;
  }
  return 400;
}

/**
 * POST /api/push/register
 *
 * Binds a wake-up topic to the calling session's device. The device id is taken
 * from the session, never from the request body, so a caller cannot register on
 * behalf of another device.
 */
export const handleRegisterPushDevice: RequestHandler = async (req, res) => {
  try {
    const session = await requireSession(req);

    if (!isPushConfigured()) {
      return res
        .status(503)
        .json({ error: "Push wake-ups are not configured on this server" });
    }

    const rawEndpoint =
      typeof req.body?.endpoint === "string" ? req.body.endpoint.trim() : "";

    let topic: string | undefined;
    if (rawEndpoint) {
      const extracted = extractTopicFromEndpoint(rawEndpoint);
      if (!extracted) {
        return res.status(400).json({
          error:
            "endpoint must be a UnifiedPush endpoint on this server's push host",
        });
      }
      topic = extracted;
    }

    const registration = await savePushRegistration({
      userId: session.userId,
      deviceId: session.deviceId!,
      topic,
    });

    const baseUrl = getPushPublicBaseUrl();
    return res.status(200).json({
      success: true,
      deviceId: registration.deviceId,
      topic: registration.topic,
      baseUrl,
      endpoint: `${baseUrl}/${registration.topic}`,
      subscribeToken: getPushSubscribeToken(),
      createdAt: registration.createdAt,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to register for push";
    if (statusForError(message) === 401) {
      return res.status(401).json({ error: message });
    }
    console.error("[PUSH] Failed to register push device:", error);
    return res.status(500).json({ error: "Failed to register for push" });
  }
};

/**
 * DELETE /api/push/register
 *
 * Removes the wake-up registration for the calling session's device.
 */
export const handleUnregisterPushDevice: RequestHandler = async (req, res) => {
  try {
    const session = await requireSession(req);
    const removed = await deletePushRegistration(
      session.userId,
      session.deviceId!,
    );
    return res.status(200).json({ success: true, removed });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to unregister push";
    if (statusForError(message) === 401) {
      return res.status(401).json({ error: message });
    }
    console.error("[PUSH] Failed to unregister push device:", error);
    return res.status(500).json({ error: "Failed to unregister push" });
  }
};
