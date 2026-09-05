import { maybeSendUnreadDirectMessageNotification } from "./email-notifications";
import { sendWakeup } from "./push-notifications";

export async function processDirectMessageEmailNotification(params: {
  senderId: string;
  recipientId: string;
  delivered: boolean;
  recipientWasConnected: boolean;
  senderDeviceId?: string;
}): Promise<void> {
  if (params.delivered) {
    return;
  }

  if (params.recipientWasConnected) {
    console.warn(
      `[EMAIL-NOTIFY] Delivery to ${params.recipientId} failed despite active socket state; continuing offline-email evaluation.`,
    );
  }

  try {
    await maybeSendUnreadDirectMessageNotification({
      senderId: params.senderId,
      recipientId: params.recipientId,
    });
  } catch (error) {
    console.error(
      "[EMAIL-NOTIFY] Failed to process unread direct message email notification:",
      error,
    );
  }

  // Wake the recipient's registered devices so an app whose process is dead can
  // reconnect and fetch. The wake-up itself carries no information about who
  // sent what: see server/lib/push-notifications.ts.
  try {
    await sendWakeup(params.recipientId, {
      excludeDeviceId: params.senderDeviceId,
    });
  } catch (error) {
    console.error("[PUSH] Failed to send direct message wake-up:", error);
  }
}
