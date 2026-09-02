import fs from "fs/promises";
import path from "path";
import { getUnreadUndeliveredCount } from "./db-messages";
import { getUserProfile } from "./profile-store";
import { getUserAccount } from "./auth-store";
import { storageRoot } from "./storage-paths";
import { recordEmailNotificationEvent } from "./admin-panel-store";

type NotificationState = Record<
  string,
  {
    lastNotifiedCount: number;
    updatedAt: number;
  }
>;

const NOTIFICATION_STATE_PATH = path.join(
  storageRoot,
  "voltex-system",
  "message-email-notifications.json",
);
const STATE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RESEND_API_URL = "https://api.resend.com/emails";

let stateCache: NotificationState | null = null;
let stateWritePromise: Promise<void> = Promise.resolve();
let notificationWorkflowPromise: Promise<void> = Promise.resolve();

function getPairKey(senderId: string, recipientId: string): string {
  return `${senderId}:${recipientId}`;
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

async function loadState(): Promise<NotificationState> {
  if (stateCache) {
    return stateCache;
  }

  try {
    const raw = await fs.readFile(NOTIFICATION_STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as NotificationState;
    stateCache = parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    stateCache = {};
  }

  return stateCache;
}

async function persistState(state: NotificationState): Promise<void> {
  const now = Date.now();
  for (const [key, entry] of Object.entries(state)) {
    if (!entry || now - entry.updatedAt > STATE_RETENTION_MS) {
      delete state[key];
    }
  }

  await fs.mkdir(path.dirname(NOTIFICATION_STATE_PATH), { recursive: true });
  await fs.writeFile(NOTIFICATION_STATE_PATH, JSON.stringify(state, null, 2));
}

function enqueueStateWrite(
  updater: (state: NotificationState) => void | Promise<void>,
): Promise<void> {
  stateWritePromise = stateWritePromise
    .catch(() => undefined)
    .then(async () => {
      const state = await loadState();
      await updater(state);
      await persistState(state);
    })
    .catch((error) => {
      console.error("[EMAIL-NOTIFY] Failed to persist notification state:", error);
    });

  return stateWritePromise;
}

async function sendUnreadMessagesEmail(params: {
  to: string;
  unreadCount: number;
  senderUsername: string;
}): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  const fromAddress =
    process.env.RESEND_FROM_EMAIL || "noreply@voltexchat.online";
  const from = `Voltex Secure Notification <${fromAddress}>`;
  const appOrigin = process.env.PUBLIC_APP_ORIGIN || "https://voltexchat.online";

  if (!apiKey) {
    console.error(
      "[EMAIL-NOTIFY] Resend configuration missing. RESEND_API_KEY is required.",
    );
    return false;
  }

  const safeSenderUsername = params.senderUsername
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const html = `
<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Voltex Notification</title>
  </head>
  <body style="margin:0;padding:0;background-color:#0a1111;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#0a1111;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:620px;background:#ffffff;border:1px solid #e2e8f0;">
            <tr>
              <td style="padding:36px 28px 16px 28px;">
                <p style="margin:0 0 10px 0;font-size:12px;letter-spacing:1.8px;font-weight:700;text-transform:uppercase;color:#0f766e;">Voltex Secure Notification</p>
                <h1 style="margin:0;font-size:34px;line-height:1.15;font-weight:800;color:#0f172a;">You've Got ${params.unreadCount} New Messages</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:0 28px 8px 28px;">
                <p style="margin:0;font-size:16px;line-height:1.65;color:#334155;">
                  You have received new unread messages on Voltex from <strong style="color:#0f172a;">@${safeSenderUsername}</strong>.
                  Open your inbox to continue the conversation securely.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 28px 30px 28px;">
                <a href="${appOrigin}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;line-height:1;padding:14px 24px;">View Messages</a>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 28px 24px 28px;border-top:1px solid #e2e8f0;">
                <p style="margin:0;font-size:12px;line-height:1.6;color:#64748b;">
                  Please do not reply to this email as this inbox is not monitored.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`.trim();

  const payload = {
    from,
    to: [params.to],
    subject: `You've Got ${params.unreadCount} New Messages`,
    html,
    text: [
      `Voltex Secure Notification`,
      "",
      `You've Got ${params.unreadCount} New Messages`,
      "",
      `You have received new unread messages on Voltex from @${params.senderUsername}.`,
      "You can check your inbox here:",
      appOrigin,
      "",
      "Please do not reply to this email as this inbox is not monitored.",
    ].join("\n"),
  };

  let response: Response;
  try {
    response = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    throw new Error(
      `Failed to reach Resend API: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `Resend responded with ${response.status}${errorText ? `: ${errorText}` : ""}`,
    );
  }

  return true;
}

async function getQueuedUnreadFallbackCount(
  senderId: string,
  recipientId: string,
): Promise<number> {
  try {
    const messagingModule = await import("./messaging");
    return messagingModule.getQueuedDirectMessageCount(senderId, recipientId);
  } catch (error) {
    console.error(
      "[EMAIL-NOTIFY] Failed to read queued-message fallback count:",
      error,
    );
    return 0;
  }
}

export async function resetEmailNotificationCounter(params: {
  recipientId: string;
  senderId?: string;
}): Promise<void> {
  await enqueueStateWrite((state) => {
    if (params.senderId) {
      delete state[getPairKey(params.senderId, params.recipientId)];
      return;
    }

    for (const key of Object.keys(state)) {
      if (key.endsWith(`:${params.recipientId}`)) {
        delete state[key];
      }
    }
  });
}

export async function maybeSendUnreadDirectMessageNotification(params: {
  senderId: string;
  recipientId: string;
}): Promise<void> {
  notificationWorkflowPromise = notificationWorkflowPromise
    .catch(() => undefined)
    .then(async () => {
      const recipientProfile = await getUserProfile(params.recipientId);
      const notificationEmail =
        recipientProfile?.notificationEmail?.trim().toLowerCase() || "";

      if (
        recipientProfile?.notifications !== true ||
        !notificationEmail ||
        !isValidEmail(notificationEmail)
      ) {
        console.log(
          `[EMAIL-NOTIFY] Skip: recipient ${params.recipientId} is not eligible (notifications=${String(recipientProfile?.notifications)}, emailPresent=${notificationEmail.length > 0}).`,
        );
        return;
      }

      const dbUnreadUndeliveredCount = await getUnreadUndeliveredCount(
        params.senderId,
        params.recipientId,
      );
      const queuedUnreadFallbackCount = await getQueuedUnreadFallbackCount(
        params.senderId,
        params.recipientId,
      );
      const unreadUndeliveredCount = Math.max(
        dbUnreadUndeliveredCount,
        queuedUnreadFallbackCount,
      );
      const notificationThreshold = Math.floor(unreadUndeliveredCount / 3) * 3;

      if (notificationThreshold < 3) {
        console.log(
          `[EMAIL-NOTIFY] Skip: threshold not reached for ${params.senderId}:${params.recipientId} (db=${dbUnreadUndeliveredCount}, queue=${queuedUnreadFallbackCount}).`,
        );
        return;
      }

      const state = await loadState();
      const stateKey = getPairKey(params.senderId, params.recipientId);
      const lastNotifiedCount = state[stateKey]?.lastNotifiedCount ?? 0;

      if (notificationThreshold <= lastNotifiedCount) {
        console.log(
          `[EMAIL-NOTIFY] Skip: already notified up to ${lastNotifiedCount} for ${params.senderId}:${params.recipientId}.`,
        );
        return;
      }

      const senderAccount = await getUserAccount(params.senderId);
      const senderUsername = senderAccount?.username || "someone";

      await sendUnreadMessagesEmail({
        to: notificationEmail,
        unreadCount: notificationThreshold,
        senderUsername,
      });
      await recordEmailNotificationEvent({
        senderId: params.senderId,
        recipientId: params.recipientId,
        recipientEmail: notificationEmail,
        threshold: notificationThreshold,
      });
      console.log(
        `[EMAIL-NOTIFY] Sent unread-message email to ${notificationEmail} for ${params.senderId}:${params.recipientId} at threshold ${notificationThreshold}.`,
      );

      await enqueueStateWrite((nextState) => {
        nextState[stateKey] = {
          lastNotifiedCount: notificationThreshold,
          updatedAt: Date.now(),
        };
      });
    });

  return notificationWorkflowPromise;
}
