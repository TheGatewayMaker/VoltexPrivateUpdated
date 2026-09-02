import nacl from "tweetnacl";
import mnemonicWords from "bip39/src/wordlists/english.json";
import {
  CryptoKeyPair,
  EncryptedMessage,
  DecryptedMessage,
  MnemonicData,
} from "@shared/crypto";
import { getServerTime } from "./serverTime";
import * as browserStorage from "./browserStorage";

// Full BIP39 English word list for mnemonic generation (2048 words)
// This provides significantly more entropy and variety compared to the previous limited list
// Users now get much better uniqueness for their recovery passphrases
const MNEMONIC_WORDS = mnemonicWords as string[];

// Utility functions for encoding/decoding
function utf8Encode(str: string): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(str);
}

function utf8Decode(bytes: Uint8Array): string {
  const decoder = new TextDecoder();
  return decoder.decode(bytes);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

/**
 * Generate a new cryptographic key pair for encryption and signing
 * Uses box keys for encryption and derives sign keys from the box secret
 * Returns both raw Uint8Array and base64-encoded versions
 */
export function generateKeyPair(): CryptoKeyPair {
  // Generate box key pair for encryption (Curve25519)
  const boxKeypair = nacl.box.keyPair();

  // For signing, we use the box secret key to seed a sign key pair
  // This ensures we have proper keys for both encryption and signing
  const signKeypair = nacl.sign.keyPair.fromSeed(
    boxKeypair.secretKey.slice(0, 32),
  );

  return {
    publicKey: boxKeypair.publicKey,
    privateKey: boxKeypair.secretKey,
    publicKeyBase64: bytesToBase64(boxKeypair.publicKey),
    privateKeyBase64: bytesToBase64(boxKeypair.secretKey),
    // Store sign keys for signing operations
    signPublicKeyBase64: bytesToBase64(signKeypair.publicKey),
    signPrivateKeyBase64: bytesToBase64(signKeypair.secretKey),
  };
}

/**
 * Derive a unique user ID from a public key
 * Uses SHA-256 hash of the public key
 */
export async function deriveUserIdFromPublicKey(
  publicKeyBase64: string,
): Promise<string> {
  const publicKeyBytes = base64ToBytes(publicKeyBase64);
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    toArrayBuffer(publicKeyBytes),
  );
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hashHex.substring(0, 16); // Use first 16 chars for user ID
}

/**
 * Generate a simple mnemonic recovery phrase
 * Generates 24 random words from a predefined word list
 * Can be used to restore the account on other devices
 */
export function generateMnemonicPhrase(): MnemonicData {
  const randomWordIndexes = new Uint16Array(24);
  crypto.getRandomValues(randomWordIndexes);

  return {
    mnemonic: Array.from(randomWordIndexes, (value) => {
      const wordIndex = value % MNEMONIC_WORDS.length;
      return MNEMONIC_WORDS[wordIndex];
    }).join(" "),
    seed: "", // Not needed for basic recovery
  };
}

/**
 * Sign a challenge message with the private key
 * Used for authentication
 */
export function signChallenge(
  challenge: string,
  privateKeyBase64: string,
): string {
  const privateKeyBytes = base64ToBytes(privateKeyBase64);
  const challengeBytes = utf8Encode(challenge);
  const signature = nacl.sign.detached(challengeBytes, privateKeyBytes);
  return bytesToBase64(signature);
}

/**
 * Verify a signed challenge
 * Server-side verification of client signatures
 */
export function verifyChallenge(
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
  } catch {
    return false;
  }
}

/**
 * Sign a message for authenticity verification
 * Uses sender's private key to create a detached signature
 * The signature covers: nonce + ciphertext (the encrypted payload)
 */
function signMessage(
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  senderPrivateKeyBase64: string,
): string {
  const senderPrivateKey = base64ToBytes(senderPrivateKeyBase64);

  // Create a deterministic message to sign: nonce + ciphertext
  // This ensures we're signing the actual encrypted data
  const messageToSign = new Uint8Array(nonce.length + ciphertext.length);
  messageToSign.set(nonce);
  messageToSign.set(ciphertext, nonce.length);

  // Sign using NaCl sign.detached (not box - we use sign keys for authenticity)
  const signature = nacl.sign.detached(messageToSign, senderPrivateKey);
  return bytesToBase64(signature);
}

/**
 * Encrypt a message for a recipient
 * Uses recipient's public key for encryption (Curve25519)
 * Signs the encrypted message with sender's signing key (Ed25519)
 * Returns encrypted message with nonce and signature
 */
export function encryptMessage(
  message: string,
  recipientPublicKeyBase64: string,
  senderPrivateKeyBase64: string,
  senderSignPrivateKeyBase64?: string,
): EncryptedMessage {
  const recipientPublicKey = base64ToBytes(recipientPublicKeyBase64);
  const senderPrivateKey = base64ToBytes(senderPrivateKeyBase64);

  // Validate key sizes before encryption
  if (recipientPublicKey.length !== 32) {
    throw new Error(
      `Invalid recipient public key size: ${recipientPublicKey.length} bytes (expected 32). Make sure you have the correct public key for the recipient.`,
    );
  }

  if (senderPrivateKey.length !== 32) {
    // This likely means the keypair was corrupted during storage
    console.error("Invalid sender private key size - keypair corrupted", {
      actualSize: senderPrivateKey.length,
      base64Length: senderPrivateKeyBase64.length,
    });
    throw new Error(
      `Your encryption keys appear to be corrupted (${senderPrivateKey.length} bytes instead of 32). Please sign out and sign back in to restore your keys.`,
    );
  }

  const messageBytes = utf8Encode(message);
  const nonce = nacl.randomBytes(nacl.box.nonceLength);

  const ciphertext = nacl.box(
    messageBytes,
    nonce,
    recipientPublicKey,
    senderPrivateKey,
  );

  // Sign the encrypted payload for authenticity
  // Ensure we have a proper signing key (64 bytes for Ed25519)
  let signKeyToUse: string;

  if (senderSignPrivateKeyBase64) {
    // Use provided signing key
    signKeyToUse = senderSignPrivateKeyBase64;
  } else {
    // Derive signing key from encryption private key (same way as generateKeyPair)
    // This is a fallback for keypairs that don't have signPrivateKeyBase64 stored
    const encryptionKeyBytes = base64ToBytes(senderPrivateKeyBase64);
    const derivedSignKeypair = nacl.sign.keyPair.fromSeed(
      encryptionKeyBytes.slice(0, 32),
    );
    signKeyToUse = bytesToBase64(derivedSignKeypair.secretKey);
  }

  const signature = signMessage(nonce, ciphertext, signKeyToUse);

  // Note: You'll need to add senderId and recipientId in the calling code
  return {
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(ciphertext),
    signature,
    senderId: "",
    recipientId: "",
    timestamp: getServerTime(),
  };
}

/**
 * Verify message signature for authenticity
 * Uses sender's public key to verify the signature covers the encrypted payload
 */
function verifyMessageSignature(
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  signature: string,
  senderPublicKeyBase64: string,
): boolean {
  try {
    const senderPublicKey = base64ToBytes(senderPublicKeyBase64);
    const signatureBytes = base64ToBytes(signature);

    // Reconstruct the message that was signed: nonce + ciphertext
    const messageToVerify = new Uint8Array(nonce.length + ciphertext.length);
    messageToVerify.set(nonce);
    messageToVerify.set(ciphertext, nonce.length);

    // Verify the signature
    return nacl.sign.detached.verify(
      messageToVerify,
      signatureBytes,
      senderPublicKey,
    );
  } catch (error) {
    console.error("Signature verification error:", error);
    return false;
  }
}

/**
 * Decrypt a message encrypted for you
 * Uses sender's box public key and your private key for decryption
 * Uses sender's sign public key for signature verification
 * Also verifies the message signature for authenticity
 */
export function decryptMessage(
  encrypted: EncryptedMessage,
  senderBoxPublicKeyBase64: string,
  recipientPrivateKeyBase64: string,
  senderSignPublicKeyBase64?: string,
): DecryptedMessage | null {
  try {
    const senderBoxPublicKey = base64ToBytes(senderBoxPublicKeyBase64);
    const recipientPrivateKey = base64ToBytes(recipientPrivateKeyBase64);
    const nonce = base64ToBytes(encrypted.nonce);
    const ciphertext = base64ToBytes(encrypted.ciphertext);

    // Use sign public key for signature verification
    // If not provided, fall back to box public key (for backwards compatibility)
    const keyForVerification =
      senderSignPublicKeyBase64 || senderBoxPublicKeyBase64;

    // First, verify the signature to ensure message authenticity
    if (
      !verifyMessageSignature(
        nonce,
        ciphertext,
        encrypted.signature,
        keyForVerification,
      )
    ) {
      console.error(
        "Message signature verification failed - message may be forged or corrupted",
      );
      return null;
    }

    // Signature verified - now decrypt the message
    const messageBytes = nacl.box.open(
      ciphertext,
      nonce,
      senderBoxPublicKey,
      recipientPrivateKey,
    );

    if (!messageBytes) {
      console.error("Failed to decrypt message - wrong decryption key");
      return null;
    }

    const content = utf8Decode(messageBytes);

    return {
      senderId: encrypted.senderId,
      recipientId: encrypted.recipientId,
      content,
      timestamp: encrypted.timestamp,
    };
  } catch (error) {
    console.error("Decryption error:", error);
    return null;
  }
}

/**
 * Utility: Convert bytes to base64 string
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Utility: Convert base64 string to bytes
 */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Generate a random challenge string for authentication
 */
export function generateChallenge(length: number = 32): string {
  const randomBytes = nacl.randomBytes(length);
  return bytesToBase64(randomBytes);
}

/**
 * Store cryptographic key pair in IndexedDB-backed browser storage
 */
export async function storeKeyPair(keyPair: CryptoKeyPair): Promise<void> {
  const stored = {
    publicKey: keyPair.publicKeyBase64,
    privateKey: keyPair.privateKeyBase64,
    signPublicKeyBase64: keyPair.signPublicKeyBase64,
    signPrivateKeyBase64: keyPair.signPrivateKeyBase64,
    createdAt: Date.now(),
  };
  await browserStorage.setItem("crypto_keypair", JSON.stringify(stored));
}

/**
 * Retrieve stored key pair from IndexedDB-backed browser storage
 */
export function getStoredKeyPair(): CryptoKeyPair | null {
  const stored = browserStorage.getItem("crypto_keypair");
  if (!stored) return null;

  try {
    const parsed = JSON.parse(stored);

    // Validate that privateKey is actually the box private key (32 bytes when decoded)
    const privateKeyBytes = base64ToBytes(parsed.privateKey);
    if (privateKeyBytes.length !== 32) {
      console.error(
        "Stored privateKey has invalid size:",
        privateKeyBytes.length,
        "bytes. This keypair is corrupted.",
      );
      // Clear the corrupted keypair
      clearKeyPair();
      return null;
    }

    // If signPrivateKeyBase64 is missing, derive it from the encryption private key
    // This handles keypairs created before signing keys were properly stored
    let signPrivateKeyBase64 = parsed.signPrivateKeyBase64;
    let signPublicKeyBase64 = parsed.signPublicKeyBase64;

    if (!signPrivateKeyBase64 && parsed.privateKey) {
      // Derive signing keys the same way generateKeyPair does
      const encryptionKeyBytes = base64ToBytes(parsed.privateKey);
      const derivedSignKeypair = nacl.sign.keyPair.fromSeed(
        encryptionKeyBytes.slice(0, 32),
      );
      signPrivateKeyBase64 = bytesToBase64(derivedSignKeypair.secretKey);
      signPublicKeyBase64 = bytesToBase64(derivedSignKeypair.publicKey);

      console.log("Derived missing signing keys from encryption key");
    }

    return {
      publicKey: base64ToBytes(parsed.publicKey),
      privateKey: base64ToBytes(parsed.privateKey),
      publicKeyBase64: parsed.publicKey,
      privateKeyBase64: parsed.privateKey,
      signPublicKeyBase64: signPublicKeyBase64,
      signPrivateKeyBase64: signPrivateKeyBase64,
    };
  } catch (error) {
    console.error("Error parsing stored keypair:", error);
    return null;
  }
}

export async function waitForStoredKeyPair(
  timeoutMs: number = 2500,
): Promise<CryptoKeyPair | null> {
  const stored = await browserStorage.waitForItem("crypto_keypair", {
    timeoutMs,
  });

  if (!stored) {
    return null;
  }

  return getStoredKeyPair();
}

/**
 * Delete stored key pair from browser storage
 */
export function clearKeyPair(): void {
  void browserStorage.removeItem("crypto_keypair");
}

/**
 * Store mnemonic in IndexedDB-backed browser storage.
 */
export async function storeMnemonic(mnemonic: string): Promise<void> {
  await browserStorage.setItem("crypto_mnemonic", mnemonic);
}

/**
 * Retrieve stored mnemonic
 */
export function getStoredMnemonic(): string | null {
  return browserStorage.getItem("crypto_mnemonic");
}

/**
 * Clear stored mnemonic
 */
export function clearMnemonic(): void {
  void browserStorage.removeItem("crypto_mnemonic");
}
