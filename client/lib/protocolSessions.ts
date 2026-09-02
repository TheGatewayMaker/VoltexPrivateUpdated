import nacl from "tweetnacl";
import type {
  DirectMessageV2Envelope,
  SupportedProtocolMessageVersion,
} from "@shared/crypto";
import { base64ToBytes, bytesToBase64, getStoredKeyPair } from "./crypto";
import * as browserStorage from "./browserStorage";
import {
  consumeProtocolBundleForUsernameDevice,
  getLocalProtocolDeviceState,
  getProtocolBundlesForUsername,
  type ConsumedProtocolBundleResponse,
  type LocalProtocolDeviceState,
} from "./protocol";

const PROTOCOL_SESSION_STORE_KEY = "protocol_session_store";
const PROTOCOL_SESSION_STORE_VERSION = 1;

type SessionKeyType = "signed_prekey" | "one_time_prekey";

export interface ProtocolSessionRecord {
  sessionId: string;
  version: number;
  localDeviceId: string;
  remoteUserId?: string;
  remoteUsername: string;
  remoteDeviceId: string;
  remoteIdentityKey: string;
  remoteSigningKey: string;
  sharedKey: string;
  sessionKeyType: SessionKeyType;
  sessionKeyId: number;
  supportedMessageVersions: SupportedProtocolMessageVersion[];
  establishedAt: number;
  updatedAt: number;
}

interface ProtocolSessionStore {
  version: number;
  sessions: ProtocolSessionRecord[];
}

export interface EstablishedProtocolSession extends ProtocolSessionRecord {
  localDeviceState: LocalProtocolDeviceState;
}

export interface ProtocolEnvelopePayload {
  content: string;
  senderUserId: string;
  senderDeviceId: string;
  recipientUserId: string;
  recipientDeviceId: string;
  messageType: "text" | "image" | "gif" | "sticker" | "system";
  clientTimestamp: number;
  clientMessageId?: string;
}

function sessionId(username: string, deviceId: string): string {
  return `${username.trim().toLowerCase()}:${deviceId.trim()}`;
}

function parseProtocolSessionStore(
  value: string | null,
): ProtocolSessionStore {
  if (!value) {
    return {
      version: PROTOCOL_SESSION_STORE_VERSION,
      sessions: [],
    };
  }

  try {
    const parsed = JSON.parse(value) as ProtocolSessionStore;
    if (!parsed || !Array.isArray(parsed.sessions)) {
      throw new Error("Invalid protocol session store");
    }

    return {
      version:
        typeof parsed.version === "number" ? parsed.version : PROTOCOL_SESSION_STORE_VERSION,
      sessions: parsed.sessions.filter(
        (entry): entry is ProtocolSessionRecord =>
          !!entry &&
          typeof entry.sessionId === "string" &&
          typeof entry.localDeviceId === "string" &&
          typeof entry.remoteUsername === "string" &&
          typeof entry.remoteDeviceId === "string" &&
          typeof entry.remoteIdentityKey === "string" &&
          typeof entry.remoteSigningKey === "string" &&
          typeof entry.sharedKey === "string" &&
          (entry.sessionKeyType === "signed_prekey" ||
            entry.sessionKeyType === "one_time_prekey") &&
          typeof entry.sessionKeyId === "number" &&
          Array.isArray(entry.supportedMessageVersions),
      ),
    };
  } catch (error) {
    console.error("Failed to parse protocol session store:", error);
    return {
      version: PROTOCOL_SESSION_STORE_VERSION,
      sessions: [],
    };
  }
}

async function loadProtocolSessionStore(): Promise<ProtocolSessionStore> {
  await browserStorage.initBrowserStorage();
  return parseProtocolSessionStore(
    browserStorage.getItem(PROTOCOL_SESSION_STORE_KEY),
  );
}

async function saveProtocolSessionStore(store: ProtocolSessionStore): Promise<void> {
  await browserStorage.setItem(
    PROTOCOL_SESSION_STORE_KEY,
    JSON.stringify({
      version: PROTOCOL_SESSION_STORE_VERSION,
      sessions: store.sessions,
    }),
  );
}

function verifySignedPreKey(bundle: ConsumedProtocolBundleResponse): boolean {
  try {
    return nacl.sign.detached.verify(
      base64ToBytes(bundle.signedPreKey.publicKey),
      base64ToBytes(bundle.signedPreKey.signature),
      base64ToBytes(bundle.signingKey),
    );
  } catch (error) {
    console.error("Failed to verify signed prekey:", error);
    return false;
  }
}

function chooseRemoteSessionKey(bundle: ConsumedProtocolBundleResponse): {
  keyType: SessionKeyType;
  keyId: number;
  publicKey: string;
} {
  if (bundle.oneTimePreKey) {
    return {
      keyType: "one_time_prekey",
      keyId: bundle.oneTimePreKey.keyId,
      publicKey: bundle.oneTimePreKey.publicKey,
    };
  }

  return {
    keyType: "signed_prekey",
    keyId: bundle.signedPreKey.keyId,
    publicKey: bundle.signedPreKey.publicKey,
  };
}

function deriveSharedKey(
  localPrivateKeyBase64: string,
  remotePublicKeyBase64: string,
): string {
  const sharedKey = nacl.box.before(
    base64ToBytes(remotePublicKeyBase64),
    base64ToBytes(localPrivateKeyBase64),
  );
  return bytesToBase64(sharedKey);
}

function normalizeVersions(
  versions: unknown,
): SupportedProtocolMessageVersion[] {
  if (!Array.isArray(versions)) {
    return ["v1"];
  }

  const filtered = versions.filter(
    (entry): entry is SupportedProtocolMessageVersion =>
      entry === "v1" || entry === "v2",
  );
  return filtered.length > 0 ? Array.from(new Set(filtered)) : ["v1"];
}

export async function listProtocolSessions(): Promise<ProtocolSessionRecord[]> {
  const store = await loadProtocolSessionStore();
  return [...store.sessions].sort((left, right) => right.updatedAt - left.updatedAt);
}

export async function getProtocolSession(
  username: string,
  deviceId: string,
): Promise<ProtocolSessionRecord | null> {
  const store = await loadProtocolSessionStore();
  const targetSessionId = sessionId(username, deviceId);
  return store.sessions.find((entry) => entry.sessionId === targetSessionId) || null;
}

export async function establishProtocolSessionForDevice(
  username: string,
  deviceId: string,
  sessionToken?: string,
): Promise<EstablishedProtocolSession> {
  const localDeviceState = await getLocalProtocolDeviceState();
  const keyPair = getStoredKeyPair();

  if (!localDeviceState || !keyPair) {
    throw new Error("Local protocol identity is not available");
  }

  const existing = await getProtocolSession(username, deviceId);
  if (existing) {
    return {
      ...existing,
      localDeviceState,
    };
  }

  const remoteBundle = await consumeProtocolBundleForUsernameDevice(
    username,
    deviceId,
    sessionToken,
  );
  if (!remoteBundle) {
    throw new Error("Remote protocol bundle is unavailable");
  }

  if (!verifySignedPreKey(remoteBundle)) {
    throw new Error("Remote protocol bundle failed signed prekey verification");
  }

  const selectedRemoteKey = chooseRemoteSessionKey(remoteBundle);
  const now = Date.now();
  const nextSession: ProtocolSessionRecord = {
    sessionId: sessionId(username, deviceId),
    version: PROTOCOL_SESSION_STORE_VERSION,
    localDeviceId: localDeviceState.deviceId,
    remoteUserId: remoteBundle.userId,
    remoteUsername: username.trim(),
    remoteDeviceId: remoteBundle.deviceId,
    remoteIdentityKey: remoteBundle.identityKey,
    remoteSigningKey: remoteBundle.signingKey,
    sharedKey: deriveSharedKey(
      keyPair.privateKeyBase64,
      selectedRemoteKey.publicKey,
    ),
    sessionKeyType: selectedRemoteKey.keyType,
    sessionKeyId: selectedRemoteKey.keyId,
    supportedMessageVersions: normalizeVersions(
      remoteBundle.supportedMessageVersions,
    ),
    establishedAt: now,
    updatedAt: now,
  };

  const store = await loadProtocolSessionStore();
  const filtered = store.sessions.filter(
    (entry) => entry.sessionId !== nextSession.sessionId,
  );
  filtered.push(nextSession);
  await saveProtocolSessionStore({
    version: PROTOCOL_SESSION_STORE_VERSION,
    sessions: filtered,
  });

  return {
    ...nextSession,
    localDeviceState,
  };
}

export async function establishProtocolSessionsForUsername(
  username: string,
  sessionToken?: string,
): Promise<EstablishedProtocolSession[]> {
  const bundles = await getProtocolBundlesForUsername(username, sessionToken);
  const sessions: EstablishedProtocolSession[] = [];

  for (const bundle of bundles) {
    try {
      sessions.push(
        await establishProtocolSessionForDevice(
          username,
          bundle.deviceId,
          sessionToken,
        ),
      );
    } catch (error) {
      console.error(
        `Failed to establish protocol session for ${username}/${bundle.deviceId}:`,
        error,
      );
    }
  }

  return sessions;
}

export function encryptProtocolEnvelope(
  session: EstablishedProtocolSession | ProtocolSessionRecord,
  payload: ProtocolEnvelopePayload,
  senderSignPrivateKeyBase64: string,
): DirectMessageV2Envelope {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const messageBytes = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = nacl.secretbox(
    messageBytes,
    nonce,
    base64ToBytes(session.sharedKey),
  );

  const signature = nacl.sign.detached(
    new Uint8Array([...nonce, ...ciphertext]),
    base64ToBytes(senderSignPrivateKeyBase64),
  );

  return {
    targetUserId: payload.recipientUserId,
    targetDeviceId: payload.recipientDeviceId,
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(ciphertext),
    signature: bytesToBase64(signature),
    sessionKeyType: session.sessionKeyType,
    sessionKeyId: session.sessionKeyId,
    envelopeVersion: "v2",
  };
}

function findLocalPreKeyForEnvelope(
  localDeviceState: LocalProtocolDeviceState,
  envelope: Pick<DirectMessageV2Envelope, "sessionKeyType" | "sessionKeyId">,
): string {
  if (envelope.sessionKeyType === "one_time_prekey") {
    const oneTimePreKey = localDeviceState.oneTimePreKeys.find(
      (entry) => entry.keyId === envelope.sessionKeyId,
    );
    if (!oneTimePreKey) {
      throw new Error("Matching local one-time prekey not found for envelope");
    }
    return oneTimePreKey.privateKey;
  }

  if (
    envelope.sessionKeyType === "signed_prekey" &&
    envelope.sessionKeyId === localDeviceState.signedPreKey.keyId
  ) {
    return localDeviceState.signedPreKey.privateKey;
  }

  throw new Error("Matching local prekey metadata not found for envelope");
}

export async function decryptProtocolEnvelope(
  envelope: DirectMessageV2Envelope,
  senderIdentityKey: string,
): Promise<ProtocolEnvelopePayload> {
  const localDeviceState = await getLocalProtocolDeviceState();
  if (!localDeviceState) {
    throw new Error("Local protocol identity is not available");
  }

  const localPreKeyPrivate = findLocalPreKeyForEnvelope(
    localDeviceState,
    envelope,
  );
  const sharedKey = nacl.box.before(
    base64ToBytes(senderIdentityKey),
    base64ToBytes(localPreKeyPrivate),
  );
  const nonce = base64ToBytes(envelope.nonce);
  const ciphertext = base64ToBytes(envelope.ciphertext);
  const plaintext = nacl.secretbox.open(ciphertext, nonce, sharedKey);

  if (!plaintext) {
    throw new Error("Failed to decrypt protocol envelope");
  }

  const decoded = JSON.parse(new TextDecoder().decode(plaintext)) as ProtocolEnvelopePayload;
  return decoded;
}
