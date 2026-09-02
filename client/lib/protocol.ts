import nacl from "tweetnacl";
import { base64ToBytes, bytesToBase64 } from "./crypto";
import * as browserStorage from "./browserStorage";
import type { PublishedDeviceBundle, SupportedProtocolMessageVersion } from "@shared/crypto";

interface ProtocolBundleInput {
  deviceId?: string;
  identityKey: string;
  signingPublicKey: string;
  signingPrivateKey: string;
}

export const CURRENT_PROTOCOL_REGISTRATION_VERSION = 2;
export const SUPPORTED_MESSAGE_VERSIONS = ["v1", "v2"] as const;
const DEVICE_ID_STORAGE_KEY = "protocol_device_id";
const DEVICE_STATE_STORAGE_KEY = "protocol_device_state";
const MIN_ONE_TIME_PREKEY_POOL = 6;

export interface LocalProtocolPreKey {
  keyId: number;
  publicKey: string;
  privateKey: string;
}

export interface LocalProtocolSignedPreKey extends LocalProtocolPreKey {
  signature: string;
}

export interface LocalProtocolDeviceState {
  version: number;
  deviceId: string;
  identityKey: string;
  signingPublicKey: string;
  signedPreKey: LocalProtocolSignedPreKey;
  oneTimePreKeys: LocalProtocolPreKey[];
  supportedMessageVersions: SupportedProtocolMessageVersion[];
  createdAt: number;
  updatedAt: number;
}

interface ProtocolBundleResponse extends PublishedDeviceBundle {
  signingKey: string;
  oneTimePreKeyCount?: number;
}

export interface ConsumedProtocolBundleResponse extends ProtocolBundleResponse {
  oneTimePreKey?: {
    keyId: number;
    publicKey: string;
  } | null;
  remainingOneTimePreKeys?: number;
}

interface ProtocolBundlesResponse {
  userId: string;
  bundles: ProtocolBundleResponse[];
}

function randomKeyId(): number {
  return Math.floor(Math.random() * 2_000_000_000);
}

function randomDeviceId(): string {
  return nacl.randomBytes(12).reduce(
    (result, byte) => result + byte.toString(16).padStart(2, "0"),
    "",
  );
}

async function getOrCreateDeviceId(explicitDeviceId?: string): Promise<string> {
  if (explicitDeviceId && explicitDeviceId.trim()) {
    return explicitDeviceId.trim();
  }

  const existing = browserStorage.getItem(DEVICE_ID_STORAGE_KEY);
  if (existing && existing.trim()) {
    return existing.trim();
  }

  const created = randomDeviceId();
  await browserStorage.setItem(DEVICE_ID_STORAGE_KEY, created);
  return created;
}

function signPreKey(publicKey: string, signingPrivateKey: string): string {
  const signature = nacl.sign.detached(
    base64ToBytes(publicKey),
    base64ToBytes(signingPrivateKey),
  );
  return bytesToBase64(signature);
}

function normalizeSupportedMessageVersions(
  versions: unknown,
): SupportedProtocolMessageVersion[] {
  if (!Array.isArray(versions)) {
    return ["v1"];
  }

  const supported = versions.filter(
    (value): value is SupportedProtocolMessageVersion =>
      value === "v1" || value === "v2",
  );

  if (supported.length === 0) {
    return ["v1"];
  }

  return Array.from(new Set(supported));
}

function createPreKeyPair(): LocalProtocolPreKey {
  const pair = nacl.box.keyPair();
  return {
    keyId: randomKeyId(),
    publicKey: bytesToBase64(pair.publicKey),
    privateKey: bytesToBase64(pair.secretKey),
  };
}

function createLocalProtocolDeviceState(
  deviceId: string,
  identityKey: string,
  signingPublicKey: string,
  signingPrivateKey: string,
): LocalProtocolDeviceState {
  const signedPreKeyPair = createPreKeyPair();
  const signedPreKey: LocalProtocolSignedPreKey = {
    ...signedPreKeyPair,
    signature: signPreKey(signedPreKeyPair.publicKey, signingPrivateKey),
  };
  const oneTimePreKeys = Array.from({ length: 12 }, () => createPreKeyPair());
  const now = Date.now();

  return {
    version: CURRENT_PROTOCOL_REGISTRATION_VERSION,
    deviceId,
    identityKey,
    signingPublicKey,
    signedPreKey,
    oneTimePreKeys,
    supportedMessageVersions: [...SUPPORTED_MESSAGE_VERSIONS],
    createdAt: now,
    updatedAt: now,
  };
}

function parseLocalProtocolDeviceState(
  value: string | null,
): LocalProtocolDeviceState | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as LocalProtocolDeviceState;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.deviceId !== "string" ||
      typeof parsed.identityKey !== "string" ||
      typeof parsed.signingPublicKey !== "string" ||
      !parsed.signedPreKey ||
      typeof parsed.signedPreKey.keyId !== "number" ||
      typeof parsed.signedPreKey.publicKey !== "string" ||
      typeof parsed.signedPreKey.privateKey !== "string" ||
      typeof parsed.signedPreKey.signature !== "string" ||
      !Array.isArray(parsed.oneTimePreKeys)
    ) {
      return null;
    }

    return {
      ...parsed,
      supportedMessageVersions: normalizeSupportedMessageVersions(
        parsed.supportedMessageVersions,
      ),
      oneTimePreKeys: parsed.oneTimePreKeys.filter(
        (entry): entry is LocalProtocolPreKey =>
          !!entry &&
          typeof entry.keyId === "number" &&
          typeof entry.publicKey === "string" &&
          typeof entry.privateKey === "string",
      ),
    };
  } catch (error) {
    console.error("Failed to parse local protocol device state:", error);
    return null;
  }
}

async function loadLocalProtocolDeviceState(): Promise<LocalProtocolDeviceState | null> {
  await browserStorage.initBrowserStorage();
  return parseLocalProtocolDeviceState(
    browserStorage.getItem(DEVICE_STATE_STORAGE_KEY),
  );
}

async function saveLocalProtocolDeviceState(
  state: LocalProtocolDeviceState,
): Promise<void> {
  await browserStorage.setItem(DEVICE_STATE_STORAGE_KEY, JSON.stringify(state));
}

async function getOrCreateLocalProtocolDeviceState(
  input: ProtocolBundleInput,
): Promise<LocalProtocolDeviceState> {
  const deviceId = await getOrCreateDeviceId(input.deviceId);
  const existing = await loadLocalProtocolDeviceState();

  if (
    existing &&
    existing.deviceId === deviceId &&
    existing.identityKey === input.identityKey &&
    existing.signingPublicKey === input.signingPublicKey &&
    existing.oneTimePreKeys.length >= MIN_ONE_TIME_PREKEY_POOL
  ) {
    return existing;
  }

  const nextState = createLocalProtocolDeviceState(
    deviceId,
    input.identityKey,
    input.signingPublicKey,
    input.signingPrivateKey,
  );
  await saveLocalProtocolDeviceState(nextState);
  return nextState;
}

function getHighestSharedMessageVersion(
  localVersions: SupportedProtocolMessageVersion[],
  remoteVersions: SupportedProtocolMessageVersion[],
): SupportedProtocolMessageVersion {
  if (localVersions.includes("v2") && remoteVersions.includes("v2")) {
    return "v2";
  }

  return "v1";
}

async function fetchProtocolBundle(
  path: string,
  sessionToken?: string,
): Promise<ProtocolBundleResponse | null> {
  const response = await fetch(path, {
    headers: sessionToken
      ? {
          Authorization: `Bearer ${sessionToken}`,
        }
      : undefined,
  });

  if (!response.ok) {
    return null;
  }

  const bundle = (await response.json()) as ProtocolBundleResponse;
  return {
    ...bundle,
    supportedMessageVersions: normalizeSupportedMessageVersions(
      bundle.supportedMessageVersions,
    ),
    registrationVersion:
      typeof bundle.registrationVersion === "number" &&
      Number.isInteger(bundle.registrationVersion) &&
      bundle.registrationVersion >= 1
        ? bundle.registrationVersion
        : 1,
  };
}

async function fetchConsumedProtocolBundle(
  path: string,
  sessionToken?: string,
): Promise<ConsumedProtocolBundleResponse | null> {
  const response = await fetch(path, {
    method: "POST",
    headers: sessionToken
      ? {
          Authorization: `Bearer ${sessionToken}`,
        }
      : undefined,
  });

  if (!response.ok) {
    return null;
  }

  const bundle = (await response.json()) as ConsumedProtocolBundleResponse;
  return {
    ...bundle,
    supportedMessageVersions: normalizeSupportedMessageVersions(
      bundle.supportedMessageVersions,
    ),
    registrationVersion:
      typeof bundle.registrationVersion === "number" &&
      Number.isInteger(bundle.registrationVersion) &&
      bundle.registrationVersion >= 1
        ? bundle.registrationVersion
        : 1,
  };
}

export async function ensureProtocolBundleRegistered(
  sessionToken: string,
  input: ProtocolBundleInput,
): Promise<void> {
  const localState = await getOrCreateLocalProtocolDeviceState(input);

  await fetch("/api/protocol/register-device", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sessionToken}`,
    },
    body: JSON.stringify({
      deviceId: localState.deviceId,
      identityKey: localState.identityKey,
      signingKey: input.signingPublicKey,
      signedPreKey: {
        keyId: localState.signedPreKey.keyId,
        publicKey: localState.signedPreKey.publicKey,
        signature: localState.signedPreKey.signature,
      },
      oneTimePreKeys: localState.oneTimePreKeys.map(({ keyId, publicKey }) => ({
        keyId,
        publicKey,
      })),
      registrationVersion: localState.version,
      supportedMessageVersions: localState.supportedMessageVersions,
    }),
  });

  await saveLocalProtocolDeviceState({
    ...localState,
    updatedAt: Date.now(),
  });
}

export async function getLocalProtocolDeviceState(): Promise<LocalProtocolDeviceState | null> {
  return loadLocalProtocolDeviceState();
}

export async function getNegotiatedMessageVersionForUsername(
  username: string,
  sessionToken?: string,
): Promise<SupportedProtocolMessageVersion> {
  const localState = await loadLocalProtocolDeviceState();
  if (!localState) {
    return "v1";
  }

  const normalizedUsername = username.trim();
  if (!normalizedUsername) {
    return "v1";
  }

  const remoteBundle = await fetchProtocolBundle(
    `/api/protocol/bundle/by-username/${encodeURIComponent(normalizedUsername)}`,
    sessionToken,
  );
  if (!remoteBundle) {
    return "v1";
  }

  return getHighestSharedMessageVersion(
    localState.supportedMessageVersions,
    remoteBundle.supportedMessageVersions || ["v1"],
  );
}

export async function getProtocolBundlesForUsername(
  username: string,
  sessionToken?: string,
): Promise<ProtocolBundleResponse[]> {
  const normalizedUsername = username.trim();
  if (!normalizedUsername) {
    return [];
  }

  const response = await fetch(
    `/api/protocol/bundles/by-username/${encodeURIComponent(normalizedUsername)}`,
    {
      headers: sessionToken
        ? {
            Authorization: `Bearer ${sessionToken}`,
          }
        : undefined,
    },
  );

  if (!response.ok) {
    return [];
  }

  const payload = (await response.json()) as ProtocolBundlesResponse;
  const bundles = Array.isArray(payload.bundles) ? payload.bundles : [];
  return bundles.map((bundle) => ({
    ...bundle,
    supportedMessageVersions: normalizeSupportedMessageVersions(
      bundle.supportedMessageVersions,
    ),
    registrationVersion:
      typeof bundle.registrationVersion === "number" &&
      Number.isInteger(bundle.registrationVersion) &&
      bundle.registrationVersion >= 1
        ? bundle.registrationVersion
        : 1,
  }));
}

export async function getNegotiatedMessageVersionForUserId(
  userId: string,
  sessionToken?: string,
): Promise<SupportedProtocolMessageVersion> {
  const localState = await loadLocalProtocolDeviceState();
  if (!localState) {
    return "v1";
  }

  const normalizedUserId = userId.trim();
  if (!normalizedUserId) {
    return "v1";
  }

  const remoteBundle = await fetchProtocolBundle(
    `/api/protocol/bundle/${encodeURIComponent(normalizedUserId)}`,
    sessionToken,
  );
  if (!remoteBundle) {
    return "v1";
  }

  return getHighestSharedMessageVersion(
    localState.supportedMessageVersions,
    remoteBundle.supportedMessageVersions || ["v1"],
  );
}

export async function consumeProtocolBundleForUsernameDevice(
  username: string,
  deviceId: string,
  sessionToken?: string,
): Promise<ConsumedProtocolBundleResponse | null> {
  const normalizedUsername = username.trim();
  const normalizedDeviceId = deviceId.trim();
  if (!normalizedUsername || !normalizedDeviceId) {
    return null;
  }

  return fetchConsumedProtocolBundle(
    `/api/protocol/consume/by-username/${encodeURIComponent(normalizedUsername)}/${encodeURIComponent(normalizedDeviceId)}`,
    sessionToken,
  );
}
