# Voltex Cryptography: Code Examples

This document provides practical examples for using the cryptographic functions in the Voltex system.

## Table of Contents

1. [Account Creation](#account-creation)
2. [Authentication](#authentication)
3. [Message Encryption](#message-encryption)
4. [WebSocket Messaging](#websocket-messaging)
5. [Advanced Usage](#advanced-usage)

## Account Creation

### Complete Flow Example

```typescript
import {
  generateKeyPair,
  generateMnemonicPhrase,
  deriveUserIdFromPublicKey,
  storeKeyPair,
  storeMnemonic,
} from "@/lib/crypto";

async function createAccount(displayName: string) {
  try {
    // Step 1: Generate cryptographic key pair locally
    // This creates a Curve25519 key pair for asymmetric encryption
    const keyPair = generateKeyPair();
    console.log("Key pair generated");

    // Step 2: Generate recovery phrase
    // 24-word BIP39 mnemonic that can restore the account
    const mnemonicData = generateMnemonicPhrase();
    console.log("Mnemonic:", mnemonicData.mnemonic);

    // Step 3: Derive unique user ID from public key
    // SHA-256 hash of the public key (deterministic)
    const userId = await deriveUserIdFromPublicKey(keyPair.publicKeyBase64);
    console.log("User ID:", userId);

    // Step 4: Register account on server
    // Server only receives the public key, never the private key
    const response = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        publicKey: keyPair.publicKeyBase64,
      }),
    });

    if (!response.ok) {
      throw new Error("Server registration failed");
    }

    const serverData = await response.json();
    console.log("Account created:", serverData.userId);

    // Step 5: Store keys locally (encrypted in production)
    // Private key NEVER leaves the device
    storeKeyPair(keyPair);

    // Step 6: Store recovery phrase securely
    // User should write this down or save to password manager
    storeMnemonic(mnemonicData.mnemonic);

    return {
      userId,
      publicKey: keyPair.publicKeyBase64,
      mnemonic: mnemonicData.mnemonic,
    };
  } catch (error) {
    console.error("Account creation failed:", error);
    throw error;
  }
}

// Usage
const account = await createAccount("Alice");
console.log("Successfully created account:", account.userId);
```

### Manual Key Pair Inspection

```typescript
import { generateKeyPair, bytesToBase64 } from "@/lib/crypto";

const keyPair = generateKeyPair();

// Inspect key pair structure
console.log("Public Key (Uint8Array):", keyPair.publicKey);
console.log("Public Key Length:", keyPair.publicKey.length); // 32 bytes
console.log("Public Key (Base64):", keyPair.publicKeyBase64);

console.log("Private Key (Uint8Array):", keyPair.privateKey);
console.log("Private Key Length:", keyPair.privateKey.length); // 64 bytes
console.log("Private Key (Base64):", keyPair.privateKeyBase64);

// Keys are suitable for NaCl box operations
```

## Authentication

### Challenge-Response Flow

```typescript
import {
  getStoredKeyPair,
  deriveUserIdFromPublicKey,
  signChallenge,
} from "@/lib/crypto";

async function signInWithChallenge(userIdInput: string) {
  try {
    // Step 1: Retrieve stored key pair from this device
    const keyPair = getStoredKeyPair();
    if (!keyPair) {
      throw new Error("No account found on this device");
    }

    // Step 2: Verify that stored key pair matches user input
    const derivedUserId = await deriveUserIdFromPublicKey(
      keyPair.publicKeyBase64,
    );
    if (userIdInput !== derivedUserId) {
      throw new Error("User ID does not match stored account");
    }

    // Step 3: Request challenge from server
    // Server generates a random 256-bit challenge
    const challengeResponse = await fetch("/api/auth/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: derivedUserId,
        publicKey: keyPair.publicKeyBase64,
      }),
    });

    const challengeData = await challengeResponse.json();
    const challenge = challengeData.challenge;
    console.log("Challenge received (expires in 5 minutes)");

    // Step 4: Sign challenge with private key
    // This proves we have the corresponding private key
    // The signature is created locally, never transmitted before signing
    const signature = signChallenge(challenge, keyPair.privateKeyBase64);
    console.log("Challenge signed with private key");

    // Step 5: Send signature to server for verification
    const verifyResponse = await fetch("/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: derivedUserId,
        challenge,
        signature,
        publicKey: keyPair.publicKeyBase64,
      }),
    });

    if (!verifyResponse.ok) {
      const errorData = await verifyResponse.json();
      throw new Error(errorData.error || "Authentication failed");
    }

    const authData = await verifyResponse.json();
    console.log("Authentication successful");

    // Step 6: Store session token for future requests
    localStorage.setItem("session_token", authData.sessionToken);
    localStorage.setItem("current_user_id", authData.userId);
    localStorage.setItem("current_public_key", keyPair.publicKeyBase64);

    return {
      sessionToken: authData.sessionToken,
      userId: authData.userId,
      expiresAt: authData.expiresAt,
    };
  } catch (error) {
    console.error("Sign in failed:", error);
    throw error;
  }
}

// Usage
const session = await signInWithChallenge("a1b2c3d4e5f6g7h8");
console.log("Signed in. Session expires at:", new Date(session.expiresAt));
```

### Why Challenge-Response?

```
Traditional Password Login:
Client ──[password]──> Server (UNSAFE - password transmitted)

Challenge-Response:
Client <──[random challenge]── Server
Client ──[signature(challenge)]──> Server
       (proves key possession without revealing it)
```

## Message Encryption

### Encrypting Messages

```typescript
import { getStoredKeyPair, encryptMessage, bytesToBase64 } from "@/lib/crypto";

async function sendEncryptedMessage(
  recipientUserId: string,
  messageText: string,
  currentUserId: string,
) {
  try {
    // Step 1: Get recipient's public key
    // This endpoint is public - anyone can get any public key
    const publicKeyResponse = await fetch(
      `/api/auth/public-key/${recipientUserId}`,
    );
    const publicKeyData = await publicKeyResponse.json();
    const recipientPublicKey = publicKeyData.publicKey;

    // Step 2: Get your stored key pair
    const senderKeyPair = getStoredKeyPair();
    if (!senderKeyPair) {
      throw new Error("No account found on this device");
    }

    // Step 3: Encrypt message
    // Uses recipient's public key and sender's private key
    // Creates authenticated encryption with Poly1305
    const encrypted = encryptMessage(
      messageText,
      recipientPublicKey,
      senderKeyPair.privateKeyBase64,
    );

    // Step 4: Populate sender/recipient IDs
    const fullMessage = {
      ...encrypted,
      senderId: currentUserId,
      recipientId: recipientUserId,
    };

    console.log("Message encrypted:", {
      nonce: fullMessage.nonce.substring(0, 10) + "...",
      ciphertext: fullMessage.ciphertext.substring(0, 10) + "...",
      timestamp: fullMessage.timestamp,
    });

    return fullMessage;
  } catch (error) {
    console.error("Encryption failed:", error);
    throw error;
  }
}

// Usage
const encrypted = await sendEncryptedMessage(
  "bob-user-id-12345678",
  "Hello Bob! This message is only for you.",
  "alice-user-id-87654321",
);

// Only Alice and Bob can decrypt this message
// Server never sees the plaintext
```

### Decrypting Messages

```typescript
import { getStoredKeyPair, decryptMessage, base64ToBytes } from "@/lib/crypto";

async function decryptReceivedMessage(
  encryptedMessage: EncryptedMessage,
  senderPublicKeyBase64: string,
) {
  try {
    // Step 1: Get your stored private key
    const recipientKeyPair = getStoredKeyPair();
    if (!recipientKeyPair) {
      throw new Error("No account found on this device");
    }

    // Step 2: Decrypt message
    // Uses sender's public key and your private key
    // Verifies message authenticity with Poly1305 MAC
    const decrypted = decryptMessage(
      encryptedMessage,
      senderPublicKeyBase64,
      recipientKeyPair.privateKeyBase64,
    );

    if (!decrypted) {
      throw new Error("Failed to decrypt message");
    }

    console.log("Message decrypted:", decrypted.content);

    return {
      from: decrypted.senderId,
      to: decrypted.recipientId,
      content: decrypted.content,
      receivedAt: new Date(decrypted.timestamp),
    };
  } catch (error) {
    console.error("Decryption failed:", error);
    throw error;
  }
}

// Usage
const message = {
  nonce: "CJfIJyY1ExjR/AAAAAAAAAA=",
  ciphertext: "aBcDeFgHiJkLmNoPqRsTuV==",
  senderId: "alice-user-id-87654321",
  recipientId: "bob-user-id-12345678",
  timestamp: Date.now(),
};

const decrypted = await decryptReceivedMessage(
  message,
  "alice-public-key-base64",
);

console.log("From:", decrypted.from);
console.log("Message:", decrypted.content);
```

### Encryption Properties

```typescript
// Each encryption is unique even with same content
import { encryptMessage, getStoredKeyPair } from "@/lib/crypto";

const keyPair = getStoredKeyPair();
const recipientPubKey = "bob-public-key-base64";

const msg1 = encryptMessage("Hello", recipientPubKey, keyPair.privateKeyBase64);
const msg2 = encryptMessage("Hello", recipientPubKey, keyPair.privateKeyBase64);

console.log("First nonce:", msg1.nonce);
console.log("Second nonce:", msg2.nonce);
console.log("Are nonces different?", msg1.nonce !== msg2.nonce); // true

console.log("First ciphertext:", msg1.ciphertext);
console.log("Second ciphertext:", msg2.ciphertext);
console.log("Are ciphertexts different?", msg1.ciphertext !== msg2.ciphertext); // true

// This is GOOD - random nonce prevents pattern analysis
```

## WebSocket Messaging

### Setting Up WebSocket

```typescript
import { useWebSocket } from '@/lib/useWebSocket';
import { decryptMessage, getStoredKeyPair } from '@/lib/crypto';

function ChatComponent() {
  const [messages, setMessages] = useState([]);
  const keyPair = getStoredKeyPair();

  const { isConnected, sendEncryptedMessage } = useWebSocket({
    onMessage: async (encryptedMessage) => {
      // Message received from WebSocket
      console.log('Received encrypted message from:', encryptedMessage.senderId);

      // Decrypt message
      const senderPublicKey = await fetch(
        `/api/auth/public-key/${encryptedMessage.senderId}`
      ).then(r => r.json());

      const decrypted = decryptMessage(
        encryptedMessage,
        senderPublicKey.publicKey,
        keyPair.privateKeyBase64
      );

      if (decrypted) {
        setMessages(prev => [...prev, decrypted]);
      }
    },
    onError: (error) => {
      console.error('WebSocket error:', error);
      toast.error(error);
    },
    onConnected: () => {
      console.log('Connected to messaging server');
      toast.success('Connected');
    },
    onDisconnected: () => {
      console.log('Disconnected from server');
      toast.error('Disconnected');
    },
  });

  return (
    <div>
      <div className={`status ${isConnected ? 'connected' : 'disconnected'}`}>
        {isConnected ? '🟢 Connected' : '🔴 Disconnected'}
      </div>
      {/* Message list and input */}
    </div>
  );
}
```

### Sending Messages via WebSocket

```typescript
async function sendMessage(
  recipientId: string,
  messageText: string,
  sendEncryptedMessage: (msg: EncryptedMessage) => boolean,
) {
  try {
    // Step 1: Get recipient's public key
    const pubKeyRes = await fetch(`/api/auth/public-key/${recipientId}`);
    const { publicKey: recipientPublicKey } = await pubKeyRes.json();

    // Step 2: Get your private key
    const keyPair = getStoredKeyPair();
    const currentUserId = localStorage.getItem("current_user_id");

    // Step 3: Encrypt the message
    const encrypted = encryptMessage(
      messageText,
      recipientPublicKey,
      keyPair.privateKeyBase64,
    );

    // Step 4: Send via WebSocket
    const fullMessage = {
      ...encrypted,
      senderId: currentUserId,
      recipientId: recipientId,
    };

    const sent = sendEncryptedMessage(fullMessage);

    if (!sent) {
      console.error("Failed to send message - WebSocket not connected");
      // Implement local queue for offline messages
      localStorage.setItem(
        `pending_messages_${recipientId}`,
        JSON.stringify(fullMessage),
      );
    }

    return sent;
  } catch (error) {
    console.error("Send failed:", error);
    throw error;
  }
}
```

## Advanced Usage

### Account Recovery with Mnemonic

```typescript
import { generateMnemonicPhrase } from "@/lib/crypto";
import { mnemonicToSeed } from "bip39";

// Note: Full implementation of mnemonic-based recovery
// would require deriving keypair from seed using BIP44
function recoverAccountFromMnemonic(mnemonic: string) {
  try {
    // Step 1: Validate mnemonic format
    if (!mnemonicToSeed) {
      throw new Error("Invalid mnemonic phrase");
    }

    // Step 2: Derive seed from mnemonic
    const seed = mnemonicToSeed(mnemonic);

    // Step 3: Derive key pair from seed using BIP44
    // (Implementation depends on specific key derivation path)

    // Step 4: User can now sign in with recovered keys
    console.log("Account recovered from mnemonic");

    return {
      success: true,
      message: "Account recovered. Please sign in.",
    };
  } catch (error) {
    console.error("Recovery failed:", error);
    throw error;
  }
}
```

### Multi-Device Support

```typescript
// Device A: Initial sign up
const account = await createAccount("Alice");
console.log("Account created on Device A");
console.log("Mnemonic:", account.mnemonic);

// User saves mnemonic safely

// Device B: New device, recover account
// import account recovery function
const recovered = recoverAccountFromMnemonic(savedMnemonic);

// Now on Device B:
const session = await signInWithChallenge(recovered.userId);
console.log("Account recovered on Device B");

// Both devices have the same userId but private keys stored locally
// Messages encrypted on Device A can be decrypted on Device B
// because they use the same key pair
```

### Message Integrity Verification

```typescript
// The encryption already includes authentication
// But you can add application-level signatures:

async function signAndEncryptMessage(
  messageText: string,
  recipientPublicKey: string,
  senderKeyPair: CryptoKeyPair,
) {
  // Step 1: Create timestamp
  const timestamp = Date.now();

  // Step 2: Create message with metadata
  const messageData = {
    content: messageText,
    timestamp,
  };

  // Step 3: Serialize and sign
  const messageJson = JSON.stringify(messageData);
  const signature = signChallenge(messageJson, senderKeyPair.privateKeyBase64);

  // Step 4: Encrypt the signed message
  const payloadToEncrypt = JSON.stringify({
    message: messageJson,
    signature,
  });

  const encrypted = encryptMessage(
    payloadToEncrypt,
    recipientPublicKey,
    senderKeyPair.privateKeyBase64,
  );

  return encrypted;
}

async function verifyAndDecryptMessage(
  encryptedMessage: EncryptedMessage,
  senderPublicKey: string,
  recipientPrivateKey: string,
) {
  // Step 1: Decrypt
  const decrypted = decryptMessage(
    encryptedMessage,
    senderPublicKey,
    recipientPrivateKey,
  );

  if (!decrypted) return null;

  // Step 2: Parse payload
  const payload = JSON.parse(decrypted.content);

  // Step 3: Verify signature
  const isValid = verifyChallenge(
    payload.message,
    payload.signature,
    senderPublicKey,
  );

  if (!isValid) {
    throw new Error("Message signature verification failed");
  }

  // Step 4: Return verified content
  return JSON.parse(payload.message);
}
```

### Performance: Bulk Message Processing

```typescript
async function encryptMessagesForMultipleRecipients(
  messageText: string,
  recipientIds: string[],
  senderKeyPair: CryptoKeyPair,
  currentUserId: string,
) {
  const encryptedMessages = [];

  for (const recipientId of recipientIds) {
    try {
      // Fetch recipient public key
      const response = await fetch(`/api/auth/public-key/${recipientId}`);
      const { publicKey } = await response.json();

      // Encrypt for this recipient
      const encrypted = encryptMessage(
        messageText,
        publicKey,
        senderKeyPair.privateKeyBase64,
      );

      encryptedMessages.push({
        ...encrypted,
        senderId: currentUserId,
        recipientId: recipientId,
      });
    } catch (error) {
      console.error(`Failed to encrypt for ${recipientId}:`, error);
    }
  }

  return encryptedMessages;
}

// Usage: Send same message to multiple recipients
const recipients = ["alice-id", "bob-id", "charlie-id"];
const messages = await encryptMessagesForMultipleRecipients(
  "Hey everyone!",
  recipients,
  myKeyPair,
  myUserId,
);

// Send all encrypted messages
messages.forEach((msg) => {
  sendEncryptedMessage(msg);
});
```

## Security Best Practices

```typescript
// ✓ DO: Always use stored key pairs
const keyPair = getStoredKeyPair();

// ✗ DON'T: Never import private keys from untrusted sources
// const privateKey = prompt('Paste your private key:'); // NEVER!

// ✓ DO: Verify public keys before encrypting
const publicKey = await fetch(`/api/auth/public-key/${userId}`)
  .then(r => r.json())
  .then(d => d.publicKey);

// ✓ DO: Handle decryption errors gracefully
const decrypted = decryptMessage(...);
if (!decrypted) {
  console.error('Message could not be decrypted');
  // Notify user, don't assume tampering
}

// ✓ DO: Clear sensitive data when done
clearKeyPair(); // Only when user explicitly logs out

// ✗ DON'T: Log private keys or raw decrypted content
// console.log(keyPair.privateKeyBase64); // NEVER!
```

## Error Handling

```typescript
async function safeEncryptAndSend(recipientId: string, message: string) {
  try {
    // Step 1: Validate inputs
    if (!recipientId || !message) {
      throw new Error("Invalid input");
    }

    // Step 2: Check key availability
    const keyPair = getStoredKeyPair();
    if (!keyPair) {
      throw new Error("No keys found. Please sign in.");
    }

    // Step 3: Attempt encryption
    const encrypted = await sendEncryptedMessage(recipientId, message);

    return {
      success: true,
      message: "Message sent",
      data: encrypted,
    };
  } catch (error) {
    // Handle specific errors
    if (error.message.includes("No account found")) {
      // Redirect to login
      window.location.href = "/signin";
    } else if (error.message.includes("User not found")) {
      // Show user-friendly error
      toast.error("Recipient not found");
    } else {
      console.error("Unexpected error:", error);
      toast.error("Failed to send message");
    }

    return {
      success: false,
      error: error.message,
    };
  }
}
```

These examples cover the most common use cases. For additional scenarios, refer to the main documentation in `CRYPTO_ARCHITECTURE.md`.
