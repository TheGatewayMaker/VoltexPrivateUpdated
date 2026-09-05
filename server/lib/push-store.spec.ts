import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "fs/promises";
import path from "path";

const testStorageDir = "server/test-data-push";

let store: typeof import("./push-store");

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.ENABLE_POSTGRES_STORAGE = "false";
  process.env.LOCAL_STORAGE_DIR = testStorageDir;

  await fs
    .rm(path.resolve(testStorageDir), { recursive: true, force: true })
    .catch(() => undefined);

  store = await import("./push-store");
});

afterAll(async () => {
  await fs
    .rm(path.resolve(testStorageDir), { recursive: true, force: true })
    .catch(() => undefined);
});

describe("push-store", () => {
  it("assigns a fresh random topic and keeps it stable across re-registration", async () => {
    const first = await store.savePushRegistration({
      userId: "user-1",
      deviceId: "device-1",
    });

    expect(first.topic).toMatch(/^[0-9a-f]{32}$/);
    expect(first.topic).not.toContain("user-1");
    expect(first.topic).not.toContain("device-1");

    const second = await store.savePushRegistration({
      userId: "user-1",
      deviceId: "device-1",
    });
    expect(second.topic).toBe(first.topic);
    expect(second.createdAt).toBe(first.createdAt);
  });

  it("gives different devices different topics and lists them per user", async () => {
    await store.savePushRegistration({ userId: "user-2", deviceId: "device-a" });
    await store.savePushRegistration({ userId: "user-2", deviceId: "device-b" });

    const registrations = await store.getPushRegistrationsForUser("user-2");
    expect(registrations).toHaveLength(2);
    const topics = new Set(registrations.map((entry) => entry.topic));
    expect(topics.size).toBe(2);
  });

  it("returns an empty list for a user with no registrations", async () => {
    expect(await store.getPushRegistrationsForUser("nobody")).toEqual([]);
  });

  it("accepts a caller-supplied topic, for UnifiedPush endpoints", async () => {
    const supplied = "0123456789abcdef0123456789abcdef";
    const saved = await store.savePushRegistration({
      userId: "user-3",
      deviceId: "device-1",
      topic: supplied,
    });
    expect(saved.topic).toBe(supplied);
  });

  it("deletes a registration and reports whether one existed", async () => {
    await store.savePushRegistration({ userId: "user-4", deviceId: "device-1" });

    expect(await store.deletePushRegistration("user-4", "device-1")).toBe(true);
    expect(await store.deletePushRegistration("user-4", "device-1")).toBe(false);
    expect(await store.getPushRegistrationsForUser("user-4")).toEqual([]);
  });

  it("removes a registration by topic when the transport reports it is gone", async () => {
    const saved = await store.savePushRegistration({
      userId: "user-5",
      deviceId: "device-1",
    });

    await store.deletePushRegistrationByTopic(saved.topic);
    expect(await store.getPushRegistrationsForUser("user-5")).toEqual([]);
  });

  it("records the last wake-up time without moving it backwards", async () => {
    await store.savePushRegistration({ userId: "user-6", deviceId: "device-1" });

    await store.touchPushRegistrationWake("user-6", "device-1", 2000);
    await store.touchPushRegistrationWake("user-6", "device-1", 1000);

    const [registration] = await store.getPushRegistrationsForUser("user-6");
    expect(registration.lastWakeAt).toBe(2000);
  });

  it("silently tolerates removing a device that was never registered", async () => {
    await expect(
      store.deletePushRegistrationsForDevice("user-7", "device-unknown"),
    ).resolves.toBeUndefined();
  });
});
