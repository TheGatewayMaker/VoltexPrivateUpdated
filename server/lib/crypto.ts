import nacl from "tweetnacl";
import { EncryptedMessage } from "@shared/crypto";

// Utility functions for encoding/decoding
function utf8Encode(str: string): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(str);
}

function utf8Decode(bytes: Uint8Array): string {
  const decoder = new TextDecoder();
  return decoder.decode(bytes);
}

/**
 * Verify a signed challenge from client
 * This is the core authentication mechanism
 */
export function verifySignedChallenge(
  challenge: string,
  signature: string,
  publicKeyBase64: string,
): boolean {
  try {
    const publicKeyBytes = base64ToBytes(publicKeyBase64);
    const challengeBytes = utf8Encode(challenge);
    const signatureBytes = base64ToBytes(signature);

    return nacl.sign.detached.verify(
      challengeBytes,
      signatureBytes,
      publicKeyBytes,
    );
  } catch (error) {
    console.error("Signature verification error:", error);
    return false;
  }
}

/**
 * Verify an encrypted message format and structure
 * Does not decrypt - just validates format
 * CRITICAL: Now requires signature field for authenticity
 */
export function validateEncryptedMessage(
  message: any,
): message is EncryptedMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    typeof message.nonce === "string" &&
    typeof message.ciphertext === "string" &&
    typeof message.signature === "string" && // REQUIRED: signature for authenticity
    typeof message.senderId === "string" &&
    typeof message.recipientId === "string" &&
    typeof message.timestamp === "number"
  );
}

/**
 * Derive user ID from public key
 * Same algorithm as client-side for consistency
 */
export async function deriveUserIdFromPublicKey(
  publicKeyBase64: string,
): Promise<string> {
  const publicKeyBytes = base64ToBytes(publicKeyBase64);

  // Use Node.js crypto for hashing on server
  const crypto = await import("crypto");
  const hash = crypto.createHash("sha256");
  hash.update(Buffer.from(publicKeyBytes));
  const hashHex = hash.digest("hex");

  return hashHex.substring(0, 16);
}

/**
 * Generate a random challenge for client to sign
 */
export function generateChallenge(length: number = 32): string {
  const randomBytes = nacl.randomBytes(length);
  return bytesToBase64(randomBytes);
}

/**
 * Check if a challenge has expired
 */
export function isChallengeExpired(
  issuedAt: number,
  expiryMs: number = 5 * 60 * 1000,
): boolean {
  return Date.now() - issuedAt > expiryMs;
}

/**
 * Utility: Convert bytes to base64 string
 */
export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/**
 * Utility: Convert base64 string to bytes
 */
export function base64ToBytes(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, "base64"));
}

/**
 * Validate public key format (should be 32 bytes when decoded)
 */
export function isValidPublicKey(publicKeyBase64: string): boolean {
  try {
    const publicKeyBytes = base64ToBytes(publicKeyBase64);
    // NaCl public keys are 32 bytes
    return publicKeyBytes.length === 32;
  } catch {
    return false;
  }
}

/**
 * Validate signature format (should be 64 bytes when decoded)
 */
export function isValidSignature(signatureBase64: string): boolean {
  try {
    const signatureBytes = base64ToBytes(signatureBase64);
    // NaCl signatures are 64 bytes
    return signatureBytes.length === 64;
  } catch {
    return false;
  }
}

/**
 * Verify an encrypted message signature
 * Ensures message authenticity using sender's public key
 */
export function verifyMessageSignature(
  message: EncryptedMessage,
  senderPublicKeyBase64: string,
): boolean {
  try {
    // The message signature is over the concatenation of:
    // nonce (as raw bytes) || ciphertext (as raw bytes)
    // This matches the client-side signing in signMessage()
    const nonceBytes = base64ToBytes(message.nonce);
    const ciphertextBytes = base64ToBytes(message.ciphertext);

    const messageToVerify = new Uint8Array(
      nonceBytes.length + ciphertextBytes.length,
    );
    messageToVerify.set(nonceBytes);
    messageToVerify.set(ciphertextBytes, nonceBytes.length);

    const publicKeyBytes = base64ToBytes(senderPublicKeyBase64);
    const signatureBytes = base64ToBytes(message.signature);

    return nacl.sign.detached.verify(
      messageToVerify,
      signatureBytes,
      publicKeyBytes,
    );
  } catch (error) {
    console.error("Message signature verification error:", error);
    return false;
  }
}
