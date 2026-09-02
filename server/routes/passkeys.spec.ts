import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import { EventEmitter } from "events";
import { createRequest, createResponse } from "node-mocks-http";

const generateRegistrationOptions = vi.fn();
const verifyRegistrationResponse = vi.fn();
const generateAuthenticationOptions = vi.fn();
const verifyAuthenticationResponse = vi.fn();

vi.mock("@simplewebauthn/server", () => ({
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
}));

const testStorageDir = "server/test-data-passkeys";
const recoveryVerifier =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

async function invokeHandler(
  handler: any,
  options: {
    method?: "GET" | "POST" | "DELETE";
    url?: string;
    body?: any;
    headers?: Record<string, string>;
  } = {},
) {
  const req = createRequest({
    method: options.method || "GET",
    url: options.url || "/",
    headers: options.headers || {},
    body: options.body,
  });
  const res = createResponse({ eventEmitter: EventEmitter });

  await new Promise<void>((resolve, reject) => {
    res.on("finish", () => resolve());
    res.on("end", () => resolve());
    handler(req, res, (error: unknown) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });

  return {
    status: res.statusCode,
    data: (() => {
      const raw = res._getData();
      return typeof raw === "string" && raw.length > 0 ? JSON.parse(raw) : raw;
    })(),
  };
}

describe("passkey routes", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    process.env.NODE_ENV = "test";
    process.env.ENABLE_POSTGRES_STORAGE = "false";
    process.env.ENABLE_R2_BACKUP = "false";
    process.env.LOCAL_STORAGE_DIR = testStorageDir;
    process.env.PUBLIC_APP_ORIGIN = "https://voltex.test";
    process.env.ALLOWED_ORIGINS = "https://voltex.test";
    delete process.env.PASSKEY_RP_ID;

    await fs
      .rm(path.resolve(testStorageDir), { recursive: true, force: true })
      .catch(() => undefined);
  });

  it("supports passkey creation, persisted status, authentication, and deletion", async () => {
    const authStore = await import("../lib/auth-store");
    const authRoutes = await import("./auth");
    const passkeyRoutes = await import("./passkeys");
    const passkeyStore = await import("../lib/passkey-store");

    await authStore.saveUserAccount("user-1", {
      userId: "user-1",
      publicKey: "box-public-key",
      signPublicKey: "sign-public-key",
      username: "alice",
      createdAt: Date.now(),
    });
    await authStore.saveRecoverySecret("user-1", {
      verifier: recoveryVerifier,
    });

    const initialSession = await authRoutes.createAuthenticatedSession({
      userId: "user-1",
      publicKey: "box-public-key",
      signPublicKey: "sign-public-key",
    });

    generateRegistrationOptions.mockResolvedValue({
      challenge: "registration-challenge",
      rp: { name: "Voltex", id: "voltex.test" },
      user: { id: "dXNlci0x", name: "alice", displayName: "alice" },
    });

    const beginRegistration = await invokeHandler(
      passkeyRoutes.handleBeginPasskeyRegistration,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${initialSession.sessionToken}`,
          Host: "voltex.test",
        },
        body: {
          recoveryVerifier,
          preferredAuthenticatorType: "remoteDevice",
        },
      },
    );

    expect(beginRegistration.status).toBe(200);
    expect(beginRegistration.data.flowId).toBeTruthy();

    verifyRegistrationResponse.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: {
          id: "cred-1",
          publicKey: new Uint8Array([1, 2, 3, 4]),
          counter: 0,
          transports: ["hybrid", "internal"],
        },
        credentialDeviceType: "multiDevice",
        credentialBackedUp: true,
        aaguid: "aaguid-1",
      },
    });

    const verifyRegistration = await invokeHandler(
      passkeyRoutes.handleVerifyPasskeyRegistration,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${initialSession.sessionToken}`,
          Host: "voltex.test",
        },
        body: {
          flowId: beginRegistration.data.flowId,
          response: { id: "cred-1" },
        },
      },
    );

    expect(verifyRegistration.status).toBe(200);
    expect(verifyRegistration.data.status.enabled).toBe(true);

    const storedCredential = await passkeyStore.getPasskeyCredentialByUserId(
      "user-1",
    );
    expect(storedCredential?.credentialId).toBe("cred-1");

    vi.resetModules();
    const reloadedPasskeyStore = await import("../lib/passkey-store");
    const persistedCredential =
      await reloadedPasskeyStore.getPasskeyCredentialByUserId("user-1");
    expect(persistedCredential?.credentialId).toBe("cred-1");

    generateAuthenticationOptions.mockResolvedValue({
      challenge: "authentication-challenge",
      rpId: "voltex.test",
    });

    const beginAuthentication = await invokeHandler(
      passkeyRoutes.handleBeginPasskeyAuthentication,
      {
        method: "POST",
        headers: {
          Host: "voltex.test",
        },
      },
    );

    expect(beginAuthentication.status).toBe(200);
    expect(beginAuthentication.data.flowId).toBeTruthy();

    verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: {
        credentialID: "cred-1",
        newCounter: 7,
        userVerified: true,
        credentialDeviceType: "multiDevice",
        credentialBackedUp: true,
        origin: "https://voltex.test",
        rpID: "voltex.test",
      },
    });

    const verifyAuthentication = await invokeHandler(
      passkeyRoutes.handleVerifyPasskeyAuthentication,
      {
        method: "POST",
        headers: {
          Host: "voltex.test",
        },
        body: {
          flowId: beginAuthentication.data.flowId,
          response: { id: "cred-1" },
        },
      },
    );

    expect(verifyAuthentication.status).toBe(200);
    expect(verifyAuthentication.data.userId).toBe("user-1");
    expect(typeof verifyAuthentication.data.sessionToken).toBe("string");

    const updatedCredential = await reloadedPasskeyStore.getPasskeyCredentialByUserId(
      "user-1",
    );
    expect(updatedCredential?.counter).toBe(7);
    expect(updatedCredential?.lastUsedAt).toBeTypeOf("number");

    const deleteResponse = await invokeHandler(passkeyRoutes.handleDeletePasskey, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${verifyAuthentication.data.sessionToken}`,
        Host: "voltex.test",
      },
      body: {
        recoveryVerifier,
      },
    });

    expect(deleteResponse.status).toBe(200);
    expect(deleteResponse.data.status.enabled).toBe(false);
    expect(
      await reloadedPasskeyStore.getPasskeyCredentialByUserId("user-1"),
    ).toBeNull();
  });
});
