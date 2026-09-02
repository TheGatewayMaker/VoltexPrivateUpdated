import { beforeEach, describe, expect, it, vi } from "vitest";

const getUnreadUndeliveredCount = vi.fn();
const getUserProfile = vi.fn();
const getUserAccount = vi.fn();
const getQueuedDirectMessageCount = vi.fn();

const readFile = vi.fn();
const mkdir = vi.fn();
const writeFile = vi.fn();

vi.mock("./db-messages", () => ({
  getUnreadUndeliveredCount,
}));

vi.mock("./profile-store", () => ({
  getUserProfile,
}));

vi.mock("./auth-store", () => ({
  getUserAccount,
}));

vi.mock("./messaging", () => ({
  getQueuedDirectMessageCount,
}));

vi.mock("fs/promises", () => ({
  default: {
    readFile,
    mkdir,
    writeFile,
  },
}));

describe("maybeSendUnreadDirectMessageNotification", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    process.env.RESEND_API_KEY = "test-resend-key";
    process.env.RESEND_FROM_EMAIL = "no-reply@voltex.test";
    process.env.PUBLIC_APP_ORIGIN = "https://voltex.test";

    readFile.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    mkdir.mockResolvedValue(undefined);
    writeFile.mockResolvedValue(undefined);

    getUserProfile.mockResolvedValue({
      notifications: true,
      notificationEmail: "recipient@example.com",
    });
    getUserAccount.mockResolvedValue({ username: "senderUser" });
    getQueuedDirectMessageCount.mockReturnValue(0);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "email_123" }), { status: 200 })),
    );
  });

  it("sends at threshold 3 from database unread-undelivered count", async () => {
    getUnreadUndeliveredCount.mockResolvedValue(3);

    const { maybeSendUnreadDirectMessageNotification } = await import("./email-notifications");
    await maybeSendUnreadDirectMessageNotification({
      senderId: "sender-1",
      recipientId: "recipient-1",
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(getUnreadUndeliveredCount).toHaveBeenCalledWith("sender-1", "recipient-1");
  });

  it("uses queued-message fallback count when database count is 0", async () => {
    getUnreadUndeliveredCount.mockResolvedValue(0);
    getQueuedDirectMessageCount.mockReturnValue(3);

    const { maybeSendUnreadDirectMessageNotification } = await import("./email-notifications");
    await maybeSendUnreadDirectMessageNotification({
      senderId: "sender-1",
      recipientId: "recipient-1",
    });

    expect(getQueuedDirectMessageCount).toHaveBeenCalledWith("sender-1", "recipient-1");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not send when notifications are disabled", async () => {
    getUserProfile.mockResolvedValue({
      notifications: false,
      notificationEmail: "recipient@example.com",
    });
    getUnreadUndeliveredCount.mockResolvedValue(9);
    getQueuedDirectMessageCount.mockReturnValue(9);

    const { maybeSendUnreadDirectMessageNotification } = await import("./email-notifications");
    await maybeSendUnreadDirectMessageNotification({
      senderId: "sender-1",
      recipientId: "recipient-1",
    });

    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends once per threshold level", async () => {
    getUnreadUndeliveredCount.mockResolvedValue(3);

    const { maybeSendUnreadDirectMessageNotification } = await import("./email-notifications");
    await maybeSendUnreadDirectMessageNotification({
      senderId: "sender-1",
      recipientId: "recipient-1",
    });
    await maybeSendUnreadDirectMessageNotification({
      senderId: "sender-1",
      recipientId: "recipient-1",
    });

    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
