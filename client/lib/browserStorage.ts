const DB_NAME = "voltex-browser-store";
const VALUE_STORE = "kv";
const VAULT_STORE = "vault";
const VAULT_KEY_ID = "master";
const FALLBACK_PREFIX = "voltex_fallback:";
const SENSITIVE_KEYS = new Set([
  "session_token",
  "crypto_keypair",
  "crypto_mnemonic",
  "protocol_device_state",
  "protocol_session_store",
]);

type StoredValue =
  | string
  | {
      version: 2;
      iv: string;
      ciphertext: string;
    };

const cache = new Map<string, string>();
let initialized = false;
let initPromise: Promise<void> | null = null;
const OPEN_DATABASE_TIMEOUT_MS = 1500;

function canUseLocalStorage(): boolean {
  return typeof window !== "undefined" && "localStorage" in window;
}

function getFallbackKey(key: string): string {
  return `${FALLBACK_PREFIX}${key}`;
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key);
}

function readFallbackValue(key: string): string | null {
  if (!canUseLocalStorage()) {
    return null;
  }

  try {
    return window.localStorage.getItem(getFallbackKey(key));
  } catch (error) {
    console.error(`Failed to read localStorage fallback for ${key}:`, error);
    return null;
  }
}

function writeFallbackValue(key: string, value: string): void {
  if (isSensitiveKey(key)) {
    return;
  }

  if (!canUseLocalStorage()) {
    return;
  }

  try {
    window.localStorage.setItem(getFallbackKey(key), value);
  } catch (error) {
    console.error(`Failed to write localStorage fallback for ${key}:`, error);
  }
}

function removeFallbackValue(key: string): void {
  if (!canUseLocalStorage()) {
    return;
  }

  try {
    window.localStorage.removeItem(getFallbackKey(key));
  } catch (error) {
    console.error(`Failed to remove localStorage fallback for ${key}:`, error);
  }
}

function clearFallbackValues(): void {
  if (!canUseLocalStorage()) {
    return;
  }

  try {
    const keysToRemove: string[] = [];
    for (let index = 0; index < window.localStorage.length; index++) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(FALLBACK_PREFIX)) {
        keysToRemove.push(key);
      }
    }

    keysToRemove.forEach((key) => window.localStorage.removeItem(key));
  } catch (error) {
    console.error("Failed to clear localStorage fallback values:", error);
  }
}

function canUseIndexedDb(): boolean {
  return typeof window !== "undefined" && "indexedDB" in window;
}

function canUseWebCrypto(): boolean {
  return typeof globalThis !== "undefined" && !!globalThis.crypto?.subtle;
}

function utf8Encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function utf8Decode(value: ArrayBuffer): string {
  return new TextDecoder().decode(value);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
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

function openDatabase(): Promise<IDBDatabase | null> {
  if (!canUseIndexedDb() || !canUseWebCrypto()) {
    return Promise.resolve(null);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let request: IDBOpenDBRequest;

    try {
      request = window.indexedDB.open(DB_NAME, 2);
    } catch (error) {
      reject(error);
      return;
    }

    const finish = (
      callback: (value?: IDBDatabase | Error) => void,
      value?: IDBDatabase | Error,
    ) => {
      if (settled) {
        return;
      }

      settled = true;
      window.clearTimeout(timeoutId);
      callback(value);
    };

    const timeoutId = window.setTimeout(() => {
      finish((error) =>
        reject(
          error instanceof Error
            ? error
            : new Error("Timed out opening IndexedDB"),
        ),
      );
    }, OPEN_DATABASE_TIMEOUT_MS);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(VALUE_STORE)) {
        db.createObjectStore(VALUE_STORE);
      }

      if (!db.objectStoreNames.contains(VAULT_STORE)) {
        db.createObjectStore(VAULT_STORE);
      }
    };

    request.onsuccess = () => finish((db) => resolve((db as IDBDatabase) || null), request.result);
    request.onerror = () =>
      finish((error) =>
        reject(error instanceof Error ? error : new Error("Failed to open IndexedDB")),
        request.error || new Error("Failed to open IndexedDB"),
      );
    request.onblocked = () =>
      finish((error) =>
        reject(
          error instanceof Error
            ? error
            : new Error("IndexedDB is blocked by another tab"),
        ),
        new Error("IndexedDB is blocked by another tab"),
      );
  });
}

async function getVaultKey(db: IDBDatabase): Promise<CryptoKey> {
  if (!canUseWebCrypto()) {
    throw new Error("Web Crypto is unavailable");
  }

  const existingKey = await new Promise<CryptoKey | null>((resolve, reject) => {
    const tx = db.transaction(VAULT_STORE, "readonly");
    const request = tx.objectStore(VAULT_STORE).get(VAULT_KEY_ID);
    request.onsuccess = () => resolve((request.result as CryptoKey | undefined) || null);
    request.onerror = () =>
      reject(request.error || new Error("Failed to read vault key"));
  });

  if (existingKey) {
    return existingKey;
  }

  const newKey = await crypto.subtle.generateKey(
    {
      name: "AES-GCM",
      length: 256,
    },
    false,
    ["encrypt", "decrypt"],
  );

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(VAULT_STORE, "readwrite");
    tx.objectStore(VAULT_STORE).put(newKey, VAULT_KEY_ID);
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(tx.error || new Error("Failed to persist vault key"));
  });

  return newKey;
}

async function encryptValue(
  db: IDBDatabase,
  value: string,
): Promise<Exclude<StoredValue, string>> {
  if (!canUseWebCrypto()) {
    throw new Error("Web Crypto is unavailable");
  }

  const key = await getVaultKey(db);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    toArrayBuffer(utf8Encode(value)),
  );

  return {
    version: 2,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

async function decryptValue(db: IDBDatabase, value: StoredValue): Promise<string> {
  if (typeof value === "string") {
    return value;
  }

  if (!canUseWebCrypto()) {
    throw new Error("Web Crypto is unavailable");
  }

  const key = await getVaultKey(db);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(base64ToBytes(value.iv)),
    },
    key,
    toArrayBuffer(base64ToBytes(value.ciphertext)),
  );

  return utf8Decode(plaintext);
}

export async function initBrowserStorage(): Promise<void> {
  if (initialized) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      cache.clear();

      if (canUseLocalStorage()) {
        try {
          for (let index = 0; index < window.localStorage.length; index++) {
            const storageKey = window.localStorage.key(index);
            if (!storageKey?.startsWith(FALLBACK_PREFIX)) {
              continue;
            }

            const key = storageKey.slice(FALLBACK_PREFIX.length);
            const value = window.localStorage.getItem(storageKey);
              if (value !== null && !isSensitiveKey(key)) {
                cache.set(key, value);
              }
            }
        } catch (error) {
          console.error("Failed to preload localStorage fallback values:", error);
        }
      }

      let db: IDBDatabase | null = null;
      try {
        db = await openDatabase();
      } catch (error) {
        console.error("Failed to initialize IndexedDB browser storage:", error);
        return;
      }

      if (!db) {
        return;
      }

      let entries: Array<{ key: string; value: StoredValue }> = [];
      try {
        entries = await new Promise<Array<{ key: string; value: StoredValue }>>(
          (resolve, reject) => {
            const collected: Array<{ key: string; value: StoredValue }> = [];
            const tx = db.transaction(VALUE_STORE, "readonly");
            const store = tx.objectStore(VALUE_STORE);
            const request = store.openCursor();

            request.onsuccess = () => {
              const cursor = request.result;
              if (!cursor) return;

              collected.push({
                key: String(cursor.key),
                value: cursor.value as StoredValue,
              });
              cursor.continue();
            };

            request.onerror = () =>
              reject(request.error || new Error("Failed to read IndexedDB"));
            tx.oncomplete = () => resolve(collected);
            tx.onerror = () =>
              reject(tx.error || new Error("IndexedDB transaction failed"));
          },
        );
      } catch (error) {
        console.error("Failed to enumerate IndexedDB browser storage:", error);
        db.close();
        return;
      }

      for (const entry of entries) {
        try {
          const value = await decryptValue(db, entry.value);
          cache.set(entry.key, value);
          writeFallbackValue(entry.key, value);
        } catch (error) {
          console.error(
            `Failed to decrypt browser storage item ${entry.key}:`,
            error,
          );
          const fallbackValue = readFallbackValue(entry.key);
          if (fallbackValue !== null) {
            cache.set(entry.key, fallbackValue);
            removeFallbackValue(entry.key);
          }
        }
      }

      // Migrate any previously mirrored sensitive values out of localStorage.
      if (canUseLocalStorage()) {
        for (const key of SENSITIVE_KEYS) {
          if (cache.has(key)) {
            removeFallbackValue(key);
            continue;
          }

          const fallbackValue = readFallbackValue(key);
          if (fallbackValue === null) {
            continue;
          }

          cache.set(key, fallbackValue);
          removeFallbackValue(key);

          try {
            const encryptedValue = await encryptValue(db, fallbackValue);
            await new Promise<void>((resolve, reject) => {
              const tx = db.transaction(VALUE_STORE, "readwrite");
              tx.objectStore(VALUE_STORE).put(encryptedValue, key);
              tx.oncomplete = () => resolve();
              tx.onerror = () =>
                reject(tx.error || new Error("Failed to migrate sensitive value"));
            });
          } catch (error) {
            console.error(`Failed to migrate sensitive browser storage item ${key}:`, error);
          }
        }
      }

      db.close();
    } finally {
      initialized = true;
      initPromise = null;
    }
  })();

  return initPromise;
}

export async function reinitializeBrowserStorage(): Promise<void> {
  initialized = false;
  initPromise = null;
  cache.clear();
  return initBrowserStorage();
}

export async function waitForItem(
  key: string,
  options?: {
    timeoutMs?: number;
    retryIntervalMs?: number;
  },
): Promise<string | null> {
  const timeoutMs = options?.timeoutMs ?? 2500;
  const retryIntervalMs = options?.retryIntervalMs ?? 200;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;

  while (true) {
    if (attempt === 0) {
      await initBrowserStorage();
    } else if (isSensitiveKey(key)) {
      await reinitializeBrowserStorage();
    }

    const value = getItem(key);
    if (value !== null) {
      return value;
    }

    if (Date.now() >= deadline) {
      return null;
    }

    attempt += 1;
    await new Promise((resolve) => window.setTimeout(resolve, retryIntervalMs));
  }
}

export function getItem(key: string): string | null {
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const fallbackValue = readFallbackValue(key);
  if (fallbackValue !== null) {
    cache.set(key, fallbackValue);
    if (isSensitiveKey(key)) {
      removeFallbackValue(key);
    }
    return fallbackValue;
  }

  return null;
}

export async function setItem(key: string, value: string): Promise<void> {
  await initBrowserStorage();
  cache.set(key, value);
  writeFallbackValue(key, value);

  const db = await openDatabase();
  if (!db) return;

  const encryptedValue = await encryptValue(db, value);

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(VALUE_STORE, "readwrite");
    tx.objectStore(VALUE_STORE).put(encryptedValue, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(tx.error || new Error("Failed to write IndexedDB value"));
  });

  db.close();
}

export async function removeItem(key: string): Promise<void> {
  await initBrowserStorage();
  cache.delete(key);
  removeFallbackValue(key);

  const db = await openDatabase();
  if (!db) return;

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(VALUE_STORE, "readwrite");
    tx.objectStore(VALUE_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(tx.error || new Error("Failed to delete IndexedDB value"));
  });

  db.close();
}

export async function clear(): Promise<void> {
  await initBrowserStorage();
  cache.clear();
  clearFallbackValues();

  const db = await openDatabase();
  if (!db) return;

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([VALUE_STORE, VAULT_STORE], "readwrite");
    tx.objectStore(VALUE_STORE).clear();
    tx.objectStore(VAULT_STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(tx.error || new Error("Failed to clear IndexedDB store"));
  });

  db.close();
}
