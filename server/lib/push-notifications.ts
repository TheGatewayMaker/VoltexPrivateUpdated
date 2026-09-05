import {
  deletePushRegistrationByTopic,
  getPushRegistrationsForUser,
  touchPushRegistrationWake,
} from "./push-store";
import { shouldAllowCoalescedEvent } from "./rate-limit";

/**
 * Self-hosted wake-ups over UnifiedPush / ntfy.
 *
 * The published payload is a fixed opaque constant. It deliberately carries no
 * ciphertext, message id, sender id, username, display name, group id, group
 * name or unread count, and there is no per-conversation topic - the only thing
 * a wake-up may imply is "this device should reconnect and fetch". Anything
 * beyond that would hand the push transport the social graph, which is the
 * entire reason for not using FCM.
 */
export const WAKEUP_BODY = "1";

const DEFAULT_COALESCE_WINDOW_MS = 15000;
const PUBLISH_TIMEOUT_MS = 5000;

interface PushTransportConfig {
  publicBaseUrl: string;
  publishBaseUrl: string;
  token: string;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function getPushPublicBaseUrl(): string | null {
  const configured = process.env.NTFY_BASE_URL?.trim();
  return configured ? trimTrailingSlash(configured) : null;
}

/**
 * Read-only credential handed to clients so they can subscribe. The transport is
 * configured deny-all, so a topic is not readable without this token; publishing
 * requires a separate write-only token that never leaves the server.
 */
export function getPushSubscribeToken(): string | null {
  const configured = process.env.NTFY_SUBSCRIBE_TOKEN?.trim();
  return configured || null;
}

function getTransportConfig(): PushTransportConfig | null {
  const publicBaseUrl = getPushPublicBaseUrl();
  const token = process.env.NTFY_PUBLISH_TOKEN?.trim();

  if (!publicBaseUrl || !token) {
    return null;
  }

  const internal = process.env.NTFY_INTERNAL_URL?.trim();
  return {
    publicBaseUrl,
    publishBaseUrl: internal ? trimTrailingSlash(internal) : publicBaseUrl,
    token,
  };
}

export function isPushConfigured(): boolean {
  return getTransportConfig() !== null;
}

function getCoalesceWindowMs(): number {
  const raw = Number(process.env.PUSH_WAKEUP_COALESCE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_COALESCE_WINDOW_MS;
}

/**
 * Accepts a UnifiedPush endpoint supplied by a client and returns its topic, but
 * only when the endpoint belongs to the configured push host. Without this check
 * a client could make the server publish wake-ups to a third-party server, which
 * would leak the timing of a user's incoming messages off the box.
 */
export function extractTopicFromEndpoint(endpoint: string): string | null {
  const publicBaseUrl = getPushPublicBaseUrl();
  if (!publicBaseUrl) {
    return null;
  }

  let parsed: URL;
  let expected: URL;
  try {
    parsed = new URL(endpoint);
    expected = new URL(publicBaseUrl);
  } catch {
    return null;
  }

  if (parsed.protocol !== expected.protocol || parsed.host !== expected.host) {
    return null;
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length !== 1) {
    return null;
  }

  return /^[A-Za-z0-9_-]{8,64}$/.test(segments[0]) ? segments[0] : null;
}

async function publishWakeup(
  config: PushTransportConfig,
  topic: string,
): Promise<"sent" | "gone" | "failed"> {
  try {
    // up=1 marks this as a UnifiedPush message, which is the convention the
    // distributor expects and keeps ntfy from treating it as a display
    // notification of its own.
    const response = await fetch(`${config.publishBaseUrl}/${topic}?up=1`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "text/plain",
        // Never retained on the transport, and never handed to Google.
        Cache: "no",
        Firebase: "no",
      },
      body: WAKEUP_BODY,
      signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
    });

    if (response.status === 404 || response.status === 410) {
      return "gone";
    }

    if (!response.ok) {
      console.error(
        `[PUSH] Wake-up publish failed with status ${response.status}`,
      );
      return "failed";
    }

    return "sent";
  } catch (error) {
    // One attempt only. A wake-up is a hint, not a payload: if it is lost the
    // client still catches up on its next reconnect, so retrying forever would
    // add load and leak timing without adding value.
    console.error("[PUSH] Wake-up publish error:", error);
    return "failed";
  }
}

export async function sendWakeup(
  userId: string,
  options: { excludeDeviceId?: string } = {},
): Promise<void> {
  const config = getTransportConfig();
  if (!config) {
    return;
  }

  let registrations;
  try {
    registrations = await getPushRegistrationsForUser(userId);
  } catch (error) {
    console.error(
      `[PUSH] Failed to load push registrations for ${userId}:`,
      error,
    );
    return;
  }

  if (!registrations.length) {
    return;
  }

  const coalesceWindowMs = getCoalesceWindowMs();

  for (const registration of registrations) {
    if (
      options.excludeDeviceId &&
      registration.deviceId === options.excludeDeviceId
    ) {
      continue;
    }

    // One wake-up per device per window, so a burst of messages does not become
    // a burst of pushes.
    if (
      !shouldAllowCoalescedEvent(
        `push:${registration.userId}:${registration.deviceId}`,
        coalesceWindowMs,
      )
    ) {
      continue;
    }

    const outcome = await publishWakeup(config, registration.topic);

    if (outcome === "gone") {
      console.warn(
        `[PUSH] Topic no longer accepted for device ${registration.deviceId}; removing registration`,
      );
      await deletePushRegistrationByTopic(registration.topic);
      continue;
    }

    if (outcome === "sent") {
      await touchPushRegistrationWake(
        registration.userId,
        registration.deviceId,
      ).catch((error) => {
        console.error("[PUSH] Failed to record wake-up timestamp:", error);
      });
    }
  }
}
