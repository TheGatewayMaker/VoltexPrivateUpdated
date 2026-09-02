export const ENCRYPTED_MEDIA_VERSION = "aes-gcm-v1";

export interface EncryptedMediaDescriptor {
  version: typeof ENCRYPTED_MEDIA_VERSION;
  key: string;
  iv: string;
  originalContentType: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

export function supportsEncryptedMedia(): boolean {
  return typeof globalThis !== "undefined" && !!globalThis.crypto?.subtle;
}

export async function encryptMediaFile(file: File): Promise<{
  encryptedBytes: Uint8Array;
  encryption: EncryptedMediaDescriptor;
}> {
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    await file.arrayBuffer(),
  );
  const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", key));

  return {
    encryptedBytes: new Uint8Array(encrypted),
    encryption: {
      version: ENCRYPTED_MEDIA_VERSION,
      key: bytesToBase64(rawKey),
      iv: bytesToBase64(iv),
      originalContentType: file.type,
    },
  };
}

export async function decryptMediaBlob(
  encryptedBytes: ArrayBuffer,
  encryption: EncryptedMediaDescriptor,
): Promise<Blob> {
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(base64ToBytes(encryption.key)),
    "AES-GCM",
    false,
    ["decrypt"],
  );
  const decrypted = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(base64ToBytes(encryption.iv)),
    },
    key,
    encryptedBytes,
  );

  return new Blob([decrypted], { type: encryption.originalContentType });
}
