import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getPushRegistrationsForUser = vi.fn();
const deletePushRegistrationByTopic = vi.fn();
const touchPushRegistrationWake = vi.fn();

vi.mock("./push-store", () => ({
  getPushRegistrationsForUser,
  deletePushRegistrationByTopic,
  touchPushRegistrationWake,
}));

const BASE_URL = "https://push.voltexchat.online";
const TOKEN = "test-publish-token";

let fetchMock: ReturnType<typeof vi.fn>;
const originalFetch = globalThis.fetch;

function registration(overrides: Partial<{ userId: string; deviceId: string; topic: string }> = {}) {
  return {
    userId: overrides.userId ?? "recipient-1",
    deviceId: overrides.deviceId ?? "device-a",
    topic: overrides.topic ?? "9f2c4b7a1d0e5638ac91bd7042e6f315",
    createdAt: 1700000000000,
  };
}

async function loadModule() {
  return import("./push-notifications");
}

beforeEach(() => {
  getPushRegistrationsForUser.mockReset();
  deletePushRegistrationByTopic.mockReset();
  touchPushRegistrationWake.mockReset();
  touchPushRegistrationWake.mockResolvedValue(undefined);
  deletePushRegistrationByTopic.mockResolvedValue(undefined);

  process.env.NTFY_BASE_URL = BASE_URL;
  process.env.NTFY_PUBLISH_TOKEN = TOKEN;
  delete process.env.NTFY_INTERNAL_URL;
  process.env.PUSH_WAKEUP_COALESCE_MS = "15000";

  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("sendWakeup", () => {
  it("publishes one contentless wake-up per registered device", async () => {
    const { sendWakeup, WAKEUP_BODY } = await loadModule();
    getPushRegistrationsForUser.mockResolvedValue([
      registration({ userId: "u-multi", deviceId: "d-1", topic: "aaaa1111bbbb2222cccc3333dddd4444" }),
      registration({ userId: "u-multi", deviceId: "d-2", topic: "eeee5555ffff6666aaaa7777bbbb8888" }),
    ]);

    await sendWakeup("u-multi");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [firstUrl, firstInit] = fetchMock.mock.calls[0];
    expect(firstUrl).toBe(`${BASE_URL}/aaaa1111bbbb2222cccc3333dddd4444?up=1`);
    expect(firstInit.method).toBe("POST");
    expect(firstInit.body).toBe(WAKEUP_BODY);
    expect(firstInit.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(firstInit.headers.Cache).toBe("no");
    expect(firstInit.headers.Firebase).toBe("no");
    expect(touchPushRegistrationWake).toHaveBeenCalledTimes(2);
  });

  it("never wakes the device that sent the message", async () => {
    const { sendWakeup } = await loadModule();
    getPushRegistrationsForUser.mockResolvedValue([
      registration({ userId: "u-exclude", deviceId: "sender-device", topic: "1111111122222222333333334444aaaa" }),
      registration({ userId: "u-exclude", deviceId: "other-device", topic: "5555555566666666777777778888bbbb" }),
    ]);

    await sendWakeup("u-exclude", { excludeDeviceId: "sender-device" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${BASE_URL}/5555555566666666777777778888bbbb?up=1`,
    );
  });

  it("coalesces a burst into one wake-up per device", async () => {
    const { sendWakeup } = await loadModule();
    getPushRegistrationsForUser.mockResolvedValue([
      registration({ userId: "u-burst", deviceId: "d-burst", topic: "99998888777766665555444433332222" }),
    ]);

    for (let i = 0; i < 10; i++) {
      await sendWakeup("u-burst");
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("removes a registration the transport no longer accepts", async () => {
    const { sendWakeup } = await loadModule();
    for (const status of [404, 410]) {
      fetchMock.mockResolvedValueOnce({ ok: false, status });
      getPushRegistrationsForUser.mockResolvedValue([
        registration({
          userId: `u-gone-${status}`,
          deviceId: `d-gone-${status}`,
          topic: `topic${status}0000000000000000000000`,
        }),
      ]);

      await sendWakeup(`u-gone-${status}`);
    }

    expect(deletePushRegistrationByTopic).toHaveBeenCalledTimes(2);
    expect(touchPushRegistrationWake).not.toHaveBeenCalled();
  });

  it("attempts a failed publish exactly once and never throws", async () => {
    const { sendWakeup } = await loadModule();
    fetchMock.mockRejectedValue(new Error("network down"));
    getPushRegistrationsForUser.mockResolvedValue([
      registration({ userId: "u-fail", deviceId: "d-fail", topic: "abcdabcdabcdabcdabcdabcdabcdabcd" }),
    ]);

    await expect(sendWakeup("u-fail")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(deletePushRegistrationByTopic).not.toHaveBeenCalled();
  });

  it("does nothing when the push transport is not configured", async () => {
    delete process.env.NTFY_PUBLISH_TOKEN;
    const { sendWakeup, isPushConfigured } = await loadModule();

    expect(isPushConfigured()).toBe(false);
    await sendWakeup("u-unconfigured");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(getPushRegistrationsForUser).not.toHaveBeenCalled();
  });
});

/**
 * This is the feature's contract, and it mirrors the equivalent assertion in the
 * Android client. A wake-up may imply "reconnect and fetch" and nothing else. If
 * this test ever needs relaxing, the design has regressed.
 */
describe("wake-up payload leaks nothing (feature contract)", () => {
  it("contains no sender id, username, display name, group name, ciphertext or message id", async () => {
    const { sendWakeup } = await loadModule();

    const secrets = {
      senderId: "16747cc4d81019a6",
      recipientId: "5e22f26d0dc34fe5",
      username: "alice_secret",
      displayName: "Alice Example",
      groupId: "a21a1e4f-f3ae-490d-b7a0-5720a80fab22",
      groupName: "Family Group",
      ciphertext: "2LjoG3SnBk0bH8stOUnsOJxiATMhMz0gsK0wb64mU9n1yg==",
      messageId: "15070b5d-ee8c-407c-9c3e-2ed3a6767ea2",
    };

    const topic = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
    getPushRegistrationsForUser.mockResolvedValue([
      registration({
        userId: secrets.recipientId,
        deviceId: "contract-device",
        topic,
      }),
    ]);

    await sendWakeup(secrets.recipientId, { excludeDeviceId: undefined });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];

    // Everything the transport can observe: the URL, the headers and the body.
    const observable = JSON.stringify({
      url,
      headers: init.headers,
      body: init.body,
      method: init.method,
    });

    for (const [label, value] of Object.entries(secrets)) {
      expect(
        observable.includes(value),
        `wake-up must not disclose ${label}`,
      ).toBe(false);
    }

    // An unread count cannot be substring-tested - a bare digit occurs inside a
    // random hex topic by chance - so it is excluded structurally instead: the
    // body is a fixed constant and the header set is exactly this allowlist, so
    // there is nowhere for a count to live.
    expect(init.body).toBe("1");
    expect(Object.keys(init.headers).sort()).toEqual([
      "Authorization",
      "Cache",
      "Content-Type",
      "Firebase",
    ]);
    expect(url).toBe(`${BASE_URL}/${topic}?up=1`);
    expect(new URL(url).pathname.split("/").filter(Boolean)).toHaveLength(1);

    // No title, tags, priority or click-through: any of those could carry meaning.
    const headerNames = Object.keys(init.headers).map((name) =>
      name.toLowerCase(),
    );
    for (const forbidden of [
      "title",
      "x-title",
      "tags",
      "x-tags",
      "priority",
      "x-priority",
      "click",
      "x-click",
      "actions",
      "x-actions",
      "markdown",
    ]) {
      expect(headerNames).not.toContain(forbidden);
    }
  });

  it("assigns topics that are not derived from the account or device", async () => {
    // importActual so this checks the real generator, not the mock above.
    const { generatePushTopic } = await vi.importActual<
      typeof import("./push-store")
    >("./push-store");

    const first = generatePushTopic();
    const second = generatePushTopic();

    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(second).toMatch(/^[0-9a-f]{32}$/);
    expect(first).not.toBe(second);
    expect(first).not.toContain("16747cc4d81019a6");
  });
});

