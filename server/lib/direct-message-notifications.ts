import { maybeSendUnreadDirectMessageNotification } from "./email-notifications";

export async function processDirectMessageEmailNotification(params: {
  senderId: string;
  recipientId: string;
  delivered: boolean;
  recipientWasConnected: boolean;
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
}
