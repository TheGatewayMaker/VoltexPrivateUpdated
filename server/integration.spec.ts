import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "fs/promises";
import path from "path";
import { EventEmitter } from "events";
import { createRequest, createResponse } from "node-mocks-http";
import {
  generateKeyPair,
  deriveUserIdFromPublicKey,
  signChallenge,
  encryptMessage,
  decryptMessage,
} from "../client/lib/crypto";
import {
  deriveEncryptionKey,
  encryptKeypair,
  decryptKeypair,
  generateSalt,
  generateRecoverySalt,
  deriveRecoveryVerifier,
} from "../client/lib/passphrase";

interface TestAccount {
  userId: string;
  username: string;
  passphrase: string;
  sessionToken: string;
  keyPair: ReturnType<typeof generateKeyPair>;
  publicKey: string;
  signPublicKey: string;
}

class MockSocket extends EventEmitter {
  readyState = 1;
  sent: any[] = [];

  send(payload: string) {
    const parsed = JSON.parse(payload);
    this.sent.push(parsed);
    this.emit("message", parsed);
  }

  close() {
    this.readyState = 3;
  }

  waitForMessage(): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timed out waiting for queued/live message")),
        5000,
      );
      this.once("message", (payload) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });
  }
}

const testStorageDir = "server/test-data-integration";
let app: any;
let serverModule: any;
let authModule: any;
let messagingModule: any;
let cloudBackupModule: any;
let conversationHistoryModule: any;

async function bootServer() {
  const created = await serverModule.createServer();
  app = created.app;
}

async function restartServer() {
  authModule.resetAuthRuntimeState();
  messagingModule.resetMessagingRuntimeState();
  cloudBackupModule.resetCloudBackupRuntimeState();
  conversationHistoryModule.clearAll();
  await bootServer();
}

async function createAccount(
  username: string,
  passphrase: string,
): Promise<TestAccount> {
  const keyPair = generateKeyPair();
  const userId = await deriveUserIdFromPublicKey(keyPair.publicKeyBase64);
  const recoverySalt = generateRecoverySalt();
  const recoveryVerifier = await deriveRecoveryVerifier(passphrase, recoverySalt);

  const register = await invokeApp("POST", "/api/auth/register", {
    publicKey: keyPair.publicKeyBase64,
    signPublicKey: keyPair.signPublicKeyBase64,
    username,
    recoveryVerifier,
    recoverySalt,
    recoveryIterations: 210000,
  });
  expect(register.status).toBe(201);

  const challenge = await invokeApp("POST", "/api/auth/challenge", {
    userId,
    publicKey: keyPair.publicKeyBase64,
  });
  expect(challenge.status).toBe(200);

  const signature = signChallenge(
    challenge.data.challenge,
    keyPair.signPrivateKeyBase64!,
  );

  const verify = await invokeApp("POST", "/api/auth/verify", {
    userId,
    challenge: challenge.data.challenge,
    signature,
    publicKey: keyPair.publicKeyBase64,
  });
  expect(verify.status).toBe(200);

  const salt = generateSalt();
  const encryptionKey = await deriveEncryptionKey(passphrase, salt);
  const encryptedKeypair = await encryptKeypair(keyPair, encryptionKey);

  const saveKeypair = await invokeApp(
    "POST",
    "/api/auth/save-encrypted-keypair",
    {
      userId,
      encryptedData: encryptedKeypair.encryptedData,
      salt,
      iv: encryptedKeypair.iv,
    },
    {
      Authorization: `Bearer ${verify.data.sessionToken}`,
    },
  );
  expect(saveKeypair.status).toBe(200);

  return {
    userId,
    username,
    passphrase,
    sessionToken: verify.data.sessionToken,
    keyPair,
    publicKey: keyPair.publicKeyBase64,
    signPublicKey: keyPair.signPublicKeyBase64!,
  };
}

async function invokeApp(
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  body?: any,
  headers: Record<string, string> = {},
): Promise<{ status: number; data: any; headers: Record<string, any> }> {
  const req = createRequest({
    method,
    url,
    headers,
    body,
  });
  const res = createResponse({ eventEmitter: EventEmitter });

  await new Promise<void>((resolve, reject) => {
    res.on("end", () => resolve());
    res.on("finish", () => resolve());
    app(req, res, (error: unknown) => {
      if (error) {
        reject(error);
      } else if (!res.writableEnded) {
        resolve();
      }
    });
  });

  const rawData = res._getData();
  const data =
    typeof rawData === "string" && rawData.length > 0 ? JSON.parse(rawData) : rawData;

  return {
    status: res.statusCode,
    data,
    headers: res._getHeaders(),
  };
}

describe(
  "server integration",
  () => {
    beforeAll(async () => {
      process.env.NODE_ENV = "test";
      process.env.ENABLE_POSTGRES_STORAGE = "false";
      process.env.ENABLE_R2_BACKUP = "false";
      process.env.LOCAL_STORAGE_DIR = testStorageDir;
      process.env.ADMIN_API_TOKEN = "integration-admin";
      process.env.PUBLIC_APP_ORIGIN = "https://voltexchat.online";
      process.env.ALLOWED_ORIGINS = "https://voltexchat.online,https://www.voltexchat.online,https://voltex.g2k.site";

      await fs
        .rm(path.resolve(testStorageDir), { recursive: true, force: true })
        .catch(() => undefined);

      serverModule = await import("./index");
      authModule = await import("./routes/auth");
      messagingModule = await import("./lib/messaging");
      cloudBackupModule = await import("./lib/cloud-backup");
      conversationHistoryModule = await import("./lib/conversation-history");

      await bootServer();
    }, 30000);

    afterAll(async () => {
      authModule.resetAuthRuntimeState();
      messagingModule.resetMessagingRuntimeState();
      cloudBackupModule.resetCloudBackupRuntimeState();
      conversationHistoryModule.clearAll();
    });

    it("covers signup, recovery, live delivery, offline queue, restart recovery, deletion, and backup queue status", async () => {
      const alice = await createAccount(
        "alice_secure",
        "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray",
      );
      const bob = await createAccount(
        "bob_secure",
        "zulu yankee xray whiskey victor uniform tango sierra romeo quebec papa oscar november mike lima kilo juliet india hotel golf foxtrot echo delta charlie bravo",
      );

      const recoveryParams = await invokeApp(
        "GET",
        `/api/auth/recovery-params/by-user-id/${alice.userId}`,
      );
      expect(recoveryParams.status).toBe(200);

      const recoveryVerifier = await deriveRecoveryVerifier(
        alice.passphrase,
        recoveryParams.data.salt,
        recoveryParams.data.iterations || 210000,
      );
      const recovered = await invokeApp("POST", "/api/auth/recover", {
        userId: alice.userId,
        recoveryVerifier,
      });
      expect(recovered.status).toBe(200);

      const encryptedKeypair = await invokeApp(
        "GET",
        `/api/auth/encrypted-keypair/by-user-id/${alice.userId}`,
        undefined,
        {
          "X-Recovery-Token": recovered.data.recoveryToken,
        },
      );
      expect(encryptedKeypair.status).toBe(200);

      const decrypted = await decryptKeypair(
        encryptedKeypair.data.encryptedData,
        encryptedKeypair.data.iv,
        await deriveEncryptionKey(alice.passphrase, encryptedKeypair.data.salt),
      );
      expect(decrypted?.publicKeyBase64).toBe(alice.publicKey);

      const bobSocket = new MockSocket();
      messagingModule.registerUserConnection(bob.userId, bobSocket as any);

      const firstEncrypted = encryptMessage(
        "secure hello",
        bob.publicKey,
        alice.keyPair.privateKeyBase64,
        alice.keyPair.signPrivateKeyBase64,
      );
      firstEncrypted.senderId = alice.userId;
      firstEncrypted.recipientId = bob.userId;

      const liveMessagePromise = bobSocket.waitForMessage();
      const sendResponse = await invokeApp(
        "POST",
        "/api/messages/send",
        firstEncrypted,
        {
          Authorization: `Bearer ${alice.sessionToken}`,
        },
      );
      expect(sendResponse.status).toBe(200);
      expect(sendResponse.data.persisted).toBe(true);

      const liveMessage = await liveMessagePromise;
      expect(liveMessage.type).toBe("message");
      const decryptedMessage = decryptMessage(
        liveMessage.data,
        alice.publicKey,
        bob.keyPair.privateKeyBase64,
        alice.signPublicKey,
      );
      expect(decryptedMessage?.content).toBe("secure hello");

      messagingModule.unregisterUserConnection(bob.userId);

      const secondEncrypted = encryptMessage(
        "offline hello",
        bob.publicKey,
        alice.keyPair.privateKeyBase64,
        alice.keyPair.signPrivateKeyBase64,
      );
      secondEncrypted.senderId = alice.userId;
      secondEncrypted.recipientId = bob.userId;

      const offlineSend = await invokeApp(
        "POST",
        "/api/messages/send",
        secondEncrypted,
        {
          Authorization: `Bearer ${alice.sessionToken}`,
        },
      );
      expect(offlineSend.status).toBe(200);
      await messagingModule.flushMessagingPersistence();

      await restartServer();

      const verifySession = await invokeApp(
        "GET",
        "/api/auth/verify-session",
        undefined,
        {
          Authorization: `Bearer ${alice.sessionToken}`,
        },
      );
      expect(verifySession.status).toBe(200);

      const reconnectedBobSocket = new MockSocket();
      const queuedMessagePromise = reconnectedBobSocket.waitForMessage();
      messagingModule.registerUserConnection(
        bob.userId,
        reconnectedBobSocket as any,
      );
      const queuedMessage = await queuedMessagePromise;
      expect(queuedMessage.type).toBe("message");
      const decryptedQueued = decryptMessage(
        queuedMessage.data,
        alice.publicKey,
        bob.keyPair.privateKeyBase64,
        alice.signPublicKey,
      );
      expect(decryptedQueued?.content).toBe("offline hello");

      const deleteResponse = await invokeApp(
        "DELETE",
        "/api/messages/message",
        {
          messageId: offlineSend.data.messageId,
          recipientId: bob.userId,
        },
        {
          Authorization: `Bearer ${alice.sessionToken}`,
        },
      );
      expect(deleteResponse.status).toBe(200);
      expect(deleteResponse.data.scope).toBe("self");

      const aliceConversation = await invokeApp(
        "GET",
        `/api/messages/conversation/by-username/${bob.username}`,
        undefined,
        {
          Authorization: `Bearer ${alice.sessionToken}`,
        },
      );
      expect(aliceConversation.status).toBe(200);
      expect(
        aliceConversation.data.messages.some(
          (message: any) => message.id === offlineSend.data.messageId,
        ),
      ).toBe(false);

      const bobConversation = await invokeApp(
        "GET",
        `/api/messages/conversation/by-username/${alice.username}`,
        undefined,
        {
          Authorization: `Bearer ${bob.sessionToken}`,
        },
      );
      expect(bobConversation.status).toBe(200);
      expect(
        bobConversation.data.messages.some(
          (message: any) => message.id === offlineSend.data.messageId,
        ),
      ).toBe(true);

      const diagnostics = await invokeApp(
        "GET",
        "/api/admin/r2-diagnostics",
        undefined,
        {
          "x-admin-token": "integration-admin",
        },
      );
      expect(diagnostics.status).toBe(200);
      expect(diagnostics.data.r2Backup.queuedOperations).toBeGreaterThan(0);

      const health = await invokeApp("GET", "/api/admin/health", undefined, {
        "x-admin-token": "integration-admin",
      });
      expect(health.status).toBe(200);
      expect(health.data.app.publicOrigin).toBe("https://voltexchat.online");
    });

    it("stores an encrypted keypair using the authenticated session when userId is omitted", async () => {
      const account = await createAccount(
        "session_keypair_user",
        "amber birch cedar drift ember fern glacier harbor island jasmine kelp lantern meadow north olive prairie quartz river stone timber umber valley willow xenon",
      );

      const rotatedSalt = generateSalt();
      const rotatedEncryptionKey = await deriveEncryptionKey(
        account.passphrase,
        rotatedSalt,
      );
      const rotatedEncryptedKeypair = await encryptKeypair(
        account.keyPair,
        rotatedEncryptionKey,
      );

      const saveWithoutUserId = await invokeApp(
        "POST",
        "/api/auth/save-encrypted-keypair",
        {
          encryptedData: rotatedEncryptedKeypair.encryptedData,
          salt: rotatedSalt,
          iv: rotatedEncryptedKeypair.iv,
        },
        {
          Authorization: `Bearer ${account.sessionToken}`,
        },
      );
      expect(saveWithoutUserId.status).toBe(200);

      const recoveryParams = await invokeApp(
        "GET",
        `/api/auth/recovery-params/by-user-id/${account.userId}`,
      );
      expect(recoveryParams.status).toBe(200);

      const recoveryVerifier = await deriveRecoveryVerifier(
        account.passphrase,
        recoveryParams.data.salt,
        recoveryParams.data.iterations || 210000,
      );
      const recovered = await invokeApp("POST", "/api/auth/recover", {
        userId: account.userId,
        recoveryVerifier,
      });
      expect(recovered.status).toBe(200);

      const encryptedKeypair = await invokeApp(
        "GET",
        `/api/auth/encrypted-keypair/by-user-id/${account.userId}`,
        undefined,
        {
          "X-Recovery-Token": recovered.data.recoveryToken,
        },
      );
      expect(encryptedKeypair.status).toBe(200);
      expect(encryptedKeypair.data.salt).toBe(rotatedSalt);
      expect(encryptedKeypair.data.iv).toBe(rotatedEncryptedKeypair.iv);
    });

    it("lists logged-in devices and revokes a selected session with passphrase verification", async () => {
      const account = await createAccount(
        "device_history_user",
        "anvil badge cactus drift ember fossil galaxy harbor island jungle kettle lagoon magnet nectar orbit planet quartz rocket summit thunder umbra velvet willow xenial",
      );

      const secondChallenge = await invokeApp("POST", "/api/auth/challenge", {
        userId: account.userId,
        publicKey: account.publicKey,
      });
      expect(secondChallenge.status).toBe(200);

      const secondSignature = signChallenge(
        secondChallenge.data.challenge,
        account.keyPair.signPrivateKeyBase64!,
      );
      const secondVerify = await invokeApp("POST", "/api/auth/verify", {
        userId: account.userId,
        challenge: secondChallenge.data.challenge,
        signature: secondSignature,
        publicKey: account.publicKey,
      });
      expect(secondVerify.status).toBe(200);
      const secondSessionToken = secondVerify.data.sessionToken as string;

      const sessionList = await invokeApp(
        "GET",
        "/api/auth/sessions",
        undefined,
        {
          Authorization: `Bearer ${account.sessionToken}`,
        },
      );
      expect(sessionList.status).toBe(200);
      expect(Array.isArray(sessionList.data.devices)).toBe(true);
      expect(sessionList.data.devices.length).toBeGreaterThanOrEqual(2);

      const currentSessionId = sessionList.data.currentSessionId as string;
      const targetSession = (sessionList.data.devices as Array<any>).find(
        (device) => typeof device.sessionId === "string" && device.sessionId !== currentSessionId,
      );
      expect(targetSession).toBeTruthy();

      const recoveryParams = await invokeApp(
        "GET",
        `/api/auth/recovery-params/by-user-id/${account.userId}`,
      );
      expect(recoveryParams.status).toBe(200);

      const recoveryVerifier = await deriveRecoveryVerifier(
        account.passphrase,
        recoveryParams.data.salt,
        recoveryParams.data.iterations || 210000,
      );

      const revokeResponse = await invokeApp(
        "POST",
        `/api/auth/sessions/${targetSession.sessionId}/revoke`,
        {
          recoveryVerifier,
        },
        {
          Authorization: `Bearer ${account.sessionToken}`,
        },
      );
      expect(revokeResponse.status).toBe(200);

      const revokedSessionCheck = await invokeApp(
        "GET",
        "/api/auth/verify-session",
        undefined,
        {
          Authorization: `Bearer ${secondSessionToken}`,
        },
      );
      expect(revokedSessionCheck.status).toBe(401);

      const currentSessionCheck = await invokeApp(
        "GET",
        "/api/auth/verify-session",
        undefined,
        {
          Authorization: `Bearer ${account.sessionToken}`,
        },
      );
      expect(currentSessionCheck.status).toBe(200);
    });
  },
  30000,
);
