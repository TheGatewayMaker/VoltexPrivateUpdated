import { beforeEach, describe, expect, it, vi } from "vitest";

const maybeSendUnreadDirectMessageNotification = vi.fn();

vi.mock("./email-notifications", () => ({
  maybeSendUnreadDirectMessageNotification,
}));

describe("processDirectMessageEmailNotification", () => {
  beforeEach(() => {
    maybeSendUnreadDirectMessageNotification.mockReset();
  });

  it("triggers email processing for offline undelivered messages", async () => {
    const { processDirectMessageEmailNotification } = await import(
      "./direct-message-notifications"
    );

    await processDirectMessageEmailNotification({
      senderId: "sender-1",
      recipientId: "recipient-1",
      delivered: false,
      recipientWasConnected: false,
    });

    expect(maybeSendUnreadDirectMessageNotification).toHaveBeenCalledWith({
      senderId: "sender-1",
      recipientId: "recipient-1",
    });
  });

  it("still processes email checks when delivery failed despite connected status", async () => {
    const { processDirectMessageEmailNotification } = await import(
      "./direct-message-notifications"
    );

    await processDirectMessageEmailNotification({
      senderId: "sender-1",
      recipientId: "recipient-1",
      delivered: false,
      recipientWasConnected: true,
    });

    expect(maybeSendUnreadDirectMessageNotification).toHaveBeenCalledWith({
      senderId: "sender-1",
      recipientId: "recipient-1",
    });
  });

  it("skips email processing when the message was delivered live", async () => {
    const { processDirectMessageEmailNotification } = await import(
      "./direct-message-notifications"
    );

    await processDirectMessageEmailNotification({
      senderId: "sender-1",
      recipientId: "recipient-1",
      delivered: true,
      recipientWasConnected: false,
    });

    expect(maybeSendUnreadDirectMessageNotification).not.toHaveBeenCalled();
  });
});
