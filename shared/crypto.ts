/**
 * Shared cryptographic types between client and server
 */

export interface KeyPair {
  publicKey: string; // base64-encoded
  privateKey: string; // base64-encoded (should only exist on client)
}

export interface CryptoKeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  publicKeyBase64: string;
  privateKeyBase64: string;
  signPublicKeyBase64?: string; // For message signing/verification
  signPrivateKeyBase64?: string; // For message signing
}

export interface UserAccount {
  userId: string; // Derived from public key hash
  publicKey: string; // base64-encoded (box public key)
  signPublicKey?: string; // base64-encoded (sign public key for message authentication)
  username?: string; // Optional username for user lookup
  displayName?: string;
  bio?: string;
  createdAt: number;
  notifications?: boolean;
  privacy?: string;
  showTimestamps?: boolean; // Whether to show timestamps in messages
}

export interface AuthChallenge {
  userId: string;
  challenge: string; // base64-encoded random bytes
  timestamp: number;
  expiresAt: number;
}

export interface AuthResponse {
  userId: string;
  signature: string; // base64-encoded signed challenge
  publicKey: string; // base64-encoded
}

export interface EncryptedMessage {
  nonce: string; // base64-encoded
  ciphertext: string; // base64-encoded
  signature: string; // base64-encoded NaCl signature for authenticity
  senderId: string;
  recipientId: string;
  timestamp: number;
}

export interface DecryptedMessage {
  senderId: string;
  recipientId: string;
  content: string;
  timestamp: number;
}

export interface SessionData {
  userId: string;
  publicKey: string;
  signPublicKey?: string;
  deviceId?: string;
  sessionToken: string;
  expiresAt: number;
  createdAt?: number;
  lastSeenAt?: number;
  userAgent?: string;
  deviceName?: string;
  platform?: string;
  appKind?: "web" | "android" | "ios" | "desktop";
  ipAddress?: string;
}

export interface UserDeviceRecord {
  userId: string;
  deviceId: string;
  deviceName?: string;
  platform?: string;
  appKind?: "web" | "android" | "ios" | "desktop";
  status: "active" | "revoked" | "pending_link";
  linkedAt: number;
  revokedAt?: number;
  lastSeenAt?: number;
  createdByDeviceId?: string;
}

export interface AccountHistoryKeyRecord {
  userId: string;
  historyKeyVersion: number;
  status: "active" | "rotated" | "revoked";
  createdAt: number;
  rotatedAt?: number;
}

export interface DeviceWrappedHistoryKeyRecord {
  userId: string;
  historyKeyVersion: number;
  deviceId: string;
  wrappedKey: string;
  wrapperAlgorithm: string;
  createdAt: number;
}

export interface DeviceLinkRequestRecord {
  linkId: string;
  userId: string;
  requestedByDeviceId: string;
  challenge: string;
  status: "pending" | "completed" | "cancelled" | "expired";
  createdAt: number;
  expiresAt: number;
  completedAt?: number;
  targetDeviceId?: string;
}

export interface DirectMessageV2Envelope {
  targetUserId: string;
  targetDeviceId: string;
  nonce: string;
  ciphertext: string;
  signature: string;
  sessionKeyType?: "signed_prekey" | "one_time_prekey";
  sessionKeyId?: number;
  envelopeVersion: "v2";
}

export interface DirectMessageV2Record {
  id: string;
  conversationId: string;
  senderUserId: string;
  senderDeviceId: string;
  recipientUserId: string;
  messageType: "text" | "image" | "gif" | "sticker" | "system";
  serverTimestamp: number;
  clientTimestamp?: number;
  clientMessageId?: string;
  deletedForEveryone: boolean;
  deletedAt?: number;
  deletedByUserId?: string;
  createdAt: number;
}

export interface MnemonicData {
  mnemonic: string;
  seed: string;
}

export interface PublishedPreKey {
  keyId: number;
  publicKey: string;
}

export interface PublishedSignedPreKey extends PublishedPreKey {
  signature: string;
}

export type SupportedProtocolMessageVersion = "v1" | "v2";

export interface PublishedDeviceBundle {
  userId: string;
  deviceId: string;
  identityKey: string;
  signingKey: string;
  signedPreKey: PublishedSignedPreKey;
  oneTimePreKey?: PublishedPreKey | null;
  remainingOneTimePreKeys?: number;
  registrationVersion?: number;
  supportedMessageVersions?: SupportedProtocolMessageVersion[];
}
