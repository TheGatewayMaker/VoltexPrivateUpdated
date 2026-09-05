# Voltex: Session-Style Cryptographic Messaging System

## Overview

This document describes the implementation of a Session-style cryptographic key pair system for end-to-end encrypted messaging. The system uses asymmetric cryptography (NaCl/libsodium) for key exchange and message encryption, challenge-response authentication for secure login, and mnemonic recovery phrases for account recovery.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        User's Device                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────────────────┐        ┌──────────────────────┐  │
│  │   Browser/React Client   │        │  Local Storage       │  │
│  │                          │        │  ─────────────────  │  │
│  │ • Key Generation         │◄──────►│ • Private Key       │  │
│  │ • Key Management         │        │ • Public Key        │  │
│  │ • Challenge Signing      │        │ • Session Token     │  │
│  │ • Message Encryption     │        │ • Mnemonic Phrase   │  │
│  │ • Message Decryption     │        │                     │  │
│  │ • WebSocket Client       │        └──────────────────────┘  │
│  │                          │                                  │
│  └──────────────┬───────────┘                                  │
│                 │                                              │
└─────────────────┼──────────────────────────────────────────────┘
                  │ HTTPS + WSS
                  │
┌─────────────────┼──────────────────────────────────────────────┐
│                 │         Server (Express + WebSocket)         │
│                 ▼                                              │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │              Authentication Routes                       │ │
│  ├──────────────────────────────────────────────────────────┤ │
│  │ POST /api/auth/register                                  │ │
│  │   └─> Store user public key in database                 │ │
│  │                                                          │ │
│  │ POST /api/auth/challenge                                │ │
│  │   └─> Generate random challenge for client to sign      │ │
│  │                                                          │ │
│  │ POST /api/auth/verify                                   │ │
│  │   └─> Verify signed challenge                           │ │
│  │   └─> Create session token if valid                     │ │
│  │                                                          │ │
│  │ GET /api/auth/public-key/:userId                        │ │
│  │   └─> Return user's public key for encryption           │ │
│  │                                                          │ │
│  │ POST /api/auth/logout                                   │ │
│  │   └─> Invalidate session token                          │ │
│  │                                                          │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                               │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │     WebSocket Message Relay (WSS)                        │ │
│  ├──────────────────────────────────────────────────────────┤ │
│  │ • Authenticate users by session token                    │ │
│  │ • Relay encrypted messages between users                 │ │
│  │ • Queue messages for offline users                       │ │
│  │ • Validate message format                                │ │
│  │ • Never decrypt messages (server blind)                  │ │
│  │                                                          │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                               │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │     In-Memory Database (In Production: PostgreSQL)       │ │
│  ├──────────────────────────────────────────────────────────┤ │
│  │ • Users table (userId, publicKey, createdAt)            │ │
│  │ • Sessions table (sessionToken, userId, expiresAt)      │ │
│  │ • Challenges table (challenge, userId, expiresAt)       │ │
│  │ • Message queue (for offline delivery)                   │ │
│  │                                                          │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

## Core Components

### 1. Client-Side Cryptography (`client/lib/crypto.ts`)

#### Key Generation

```typescript
const keyPair = generateKeyPair();
// Returns:
// {
//   publicKey: Uint8Array (32 bytes)
//   privateKey: Uint8Array (64 bytes - Ed25519)
//   publicKeyBase64: string
//   privateKeyBase64: string
// }
```

**Algorithm**: NaCl Box (Curve25519 + Salsa20 + Poly1305)

#### User ID Derivation

```typescript
const userId = await deriveUserIdFromPublicKey(publicKeyBase64);
// SHA-256 hash of public key, truncated to first 16 characters
// Example: "a1b2c3d4e5f6g7h8"
```

**Purpose**: Create a unique, deterministic identifier from the public key

#### Mnemonic Recovery Phrase

```typescript
const mnemonic = generateMnemonicPhrase();
// Returns: 24-word BIP39 mnemonic phrase
// Can be used to restore account on other devices
```

#### Message Encryption

```typescript
const encrypted = encryptMessage(
  "Hello, World!",
  recipientPublicKeyBase64,
  senderPrivateKeyBase64,
);
// Returns: { nonce, ciphertext, senderId, recipientId, timestamp }
```

**Algorithm**: NaCl Box

- Generates random 24-byte nonce
- Encrypts message using recipient's public key and sender's private key
- Server never receives plaintext

#### Signature & Verification

```typescript
// Sign a challenge (client-side)
const signature = signChallenge(challengeString, privateKeyBase64);

// Verify signature (server-side)
const isValid = verifyChallenge(
  challengeString,
  signatureBase64,
  publicKeyBase64,
);
```

**Algorithm**: Ed25519 (NaCl sign)

### 2. Server-Side Verification (`server/lib/crypto.ts`)

All cryptographic operations are non-reversible verification:

- Signature verification (no decryption)
- Key format validation
- Challenge expiration checking
- Hash-based user ID derivation

**Important**: Server NEVER stores or processes private keys

### 3. Authentication Flow

#### Step 1: Account Registration

```
Client                              Server
  │                                  │
  ├─ Generate key pair locally      │
  │  (stays on device)              │
  │                                  │
  ├─ POST /api/auth/register        │
  │  {publicKey: "..."}             │
  │                                  │
  │                                  ├─ Derive userId from publicKey
  │                                  ├─ Check if user exists
  │                                  ├─ Store user record
  │                                  │
  │  ◄─ {userId, success}           │
  │                                  │
  └─ Store keys locally             │
     (localStorage/IndexedDB)        │
```

#### Step 2: Challenge-Response Authentication

```
Client                              Server
  │                                  │
  ├─ User enters their userId       │
  │                                  │
  ├─ POST /api/auth/challenge       │
  │  {userId, publicKey}            │
  │                                  │
  │                                  ├─ Verify userId matches publicKey
  │                                  ├─ Generate random challenge
  │                                  ├─ Store challenge with 5min expiry
  │                                  │
  │  ◄─ {challenge, expiresAt}      │
  │                                  │
  ├─ Sign challenge with            │
  │  private key locally            │
  │  (never sent to server)          │
  │                                  │
  ├─ POST /api/auth/verify          │
  │  {userId, challenge, signature} │
  │                                  │
  │                                  ├─ Verify signature with publicKey
  │                                  ├─ Verify challenge not expired
  │                                  ├─ Create session (24h duration)
  │                                  │
  │  ◄─ {sessionToken, expiresAt}   │
  │                                  │
  └─ Store session token            │
     (connect WebSocket)             │
```

**Security Properties**:

- Server never sees private key
- Challenge is single-use (expires in 5 minutes)
- Signature proves possession of private key
- Session tokens are opaque, server-side validated

### 4. Message Encryption & Relay

#### Sending a Message

```
Sender (Alice)                      Server                  Receiver (Bob)
  │                                  │                       │
  ├─ Get Bob's public key           │                       │
  │  from /api/auth/public-key/bob  │                       │
  │                                  ├─ Return Bob's pubkey  │
  │                                  │◄─────────────────────┤
  │◄─ Bob's public key              │                       │
  │                                  │                       │
  ├─ Encrypt message with:          │                       │
  │  • Bob's public key             │                       │
  │  • Alice's private key          │                       │
  │  • Random nonce                 │                       │
  │                                  │                       │
  ├─ Send encrypted message via WSS │                       │
  │  {nonce, ciphertext, senderId,  │                       │
  │   recipientId, timestamp}        │                       │
  │                                  ├─ Relay to Bob        │
  │                                  │  (never decrypts)     │
  │                                  ├──────────────────────►│
  │                                  │                       │ Decrypt with:
  │                                  │                       │ • Alice's pubkey
  │                                  │                       │ • Bob's privkey
  │                                  │                       │ • Nonce
  │                                  │                       │
  │                                  │  ◄──────────────────┤│ Plaintext received
```

**Key Points**:

- Messages are encrypted before leaving client
- Server is "blind relay" - never sees plaintext
- Uses authenticated encryption (Poly1305)
- Nonce ensures even identical messages encrypt differently

### 5. WebSocket Real-Time Messaging

```typescript
// Client connects after authentication
ws = new WebSocket(`wss://server/ws?token=${sessionToken}`);

// Server validates session token
// Registers user connection
registerUserConnection(userId, ws);

// Message format
{
  type: "message",
  id: "unique-msg-id",
  data: {
    nonce: "base64-encoded",
    ciphertext: "base64-encoded",
    senderId: "alice-user-id",
    recipientId: "bob-user-id",
    timestamp: 1234567890
  }
}

// Server responses
{ type: "message-ack", messageId, delivered: true }
{ type: "error", error: "Invalid message format" }
```

**Offline Message Queue**:

- If recipient is offline, message is queued
- Max 1000 messages per user
- Delivered when user reconnects
- Prevents unbounded memory usage

## File Organization

### Client-Side Structure

```
client/
├── lib/
│   ├── crypto.ts                 # All cryptographic functions
│   └── useWebSocket.ts           # WebSocket connection hook
├── pages/
│   ├── SignUp.tsx                # Account creation with key generation
│   ├── SignIn.tsx                # Challenge-response authentication
│   ├── Conversations.tsx         # Message list and WebSocket setup
│   └── Chat.tsx                  # Message sending/receiving (to implement)
└── components/
    └── Layout.tsx                # Navigation and layout

shared/
└── crypto.ts                     # Shared types (used by client & server)
```

### Server-Side Structure

```
server/
├── index.ts                      # Express app + WebSocket setup
├── lib/
│   ├── crypto.ts                 # Server-side verification functions
│   └── messaging.ts              # WebSocket connection management
├── routes/
│   ├── auth.ts                   # Authentication endpoints
│   └── demo.ts                   # Demo endpoint
```

## Deployment Guide

### Development Setup

```bash
# Install dependencies
pnpm install

# Run dev server
pnpm dev

# Run tests
pnpm test

# Type check
pnpm typecheck
```

### Production Build

```bash
# Build client and server
pnpm build

# Start production server
pnpm start
```

### VPS Deployment (Self-Hosted)

#### Prerequisites

- Node.js 18+
- PostgreSQL (for persistent storage)
- HTTPS certificate (Let's Encrypt recommended)
- Firewall with port 80/443 open

#### Steps

1. **Clone and setup**

```bash
git clone <repo>
cd voltex
pnpm install
pnpm build
```

2. **Configure environment**

```bash
# .env.production
DATABASE_URL=postgres://user:pass@localhost:5432/voltex
NODE_ENV=production
LOG_LEVEL=info
```

3. **Setup PostgreSQL**

```sql
-- Create tables
CREATE TABLE users (
  user_id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE sessions (
  session_token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id),
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE message_queue (
  id SERIAL PRIMARY KEY,
  recipient_id TEXT NOT NULL REFERENCES users(user_id),
  message JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_message_queue_recipient
  ON message_queue(recipient_id);
```

4. **Setup SSL/TLS**

```bash
# Using Let's Encrypt
certbot certonly --standalone -d yourdomain.com
```

5. **Run with PM2**

```bash
npm install -g pm2

pm2 start "pnpm start" --name voltex
pm2 save
pm2 startup
```

6. **Nginx Reverse Proxy**

```nginx
server {
    listen 443 ssl http2;
    server_name yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Cloud Deployment

#### Netlify

```bash
# Configure netlify.toml
[build]
command = "pnpm build"
functions = "dist/server"
publish = "dist/spa"

# Deploy
netlify deploy --prod
```

#### Vercel

```bash
# Configure vercel.json
{
  "buildCommand": "pnpm build",
  "outputDirectory": "dist/spa",
  "serverlessFunctionRegion": "us-east-1"
}

# Deploy
vercel deploy --prod
```

## Security Considerations

### Private Key Security

**Current Implementation**: localStorage with base64 encoding

- ✓ Keys never leave device
- ✓ Keys never sent to server
- ⚠️ Not encrypted at rest (browser can access)

**Production Recommendations**:

1. **IndexedDB with Encryption**

```typescript
// Use @noble/hashes for PBKDF2
const encrypted = encrypt(privateKey, userPassword);
localStorage.setItem("encrypted_key", encrypted);
```

2. **Hardware Security Module (HSM)**

- Integrate with cloud HSM providers
- AWS CloudHSM, Azure Key Vault, etc.

3. **Web Cryptography API**

```typescript
// Use native browser encryption
const key = await window.crypto.subtle.importKey(...);
```

### Message Security

✓ **Authenticated Encryption**: Poly1305 MAC prevents tampering
✓ **Perfect Forward Secrecy**: Each message uses unique nonce
✓ **Replay Attack Prevention**: Challenge-response with nonce
✓ **Server Blindness**: Server cannot decrypt messages

### Session Security

✓ **Session Tokens**: Cryptographically random (nacl.randomBytes)
✓ **Expiration**: 24-hour token lifetime
✓ **HTTPS-Only**: Secure flag on cookies
✓ **CORS Protection**: Proper origin validation

### Database Security (Production)

- [ ] Use parameterized queries to prevent SQL injection
- [ ] Encrypt database at rest
- [ ] Enable database audit logging
- [ ] Regular backups with encryption
- [ ] Principle of least privilege for DB users

## Expanding the System

### Adding Group Messaging

```typescript
// For group chats, send multiple encrypted copies
interface GroupMessage {
  groupId: string;
  recipients: string[]; // List of user IDs
  encryptedMessages: EncryptedMessage[];
}

// Client encrypts message for each recipient separately
recipients.forEach((userId) => {
  const encrypted = encryptMessage(content, userPublicKey, senderPrivateKey);
  group.encryptedMessages.push(encrypted);
});
```

### Adding File Sharing

```typescript
// Encrypt file before upload
const encryptedFile = await encryptFile(file, recipientPublicKey);
const formData = new FormData();
formData.append("file", encryptedFile);
fetch("/api/upload", { method: "POST", body: formData });
```

### Adding Message Reactions

```typescript
interface MessageReaction {
  messageId: string;
  emoji: string;
  senderId: string;
  encrypted: boolean; // Always false for reactions
}
```

### Adding Read Receipts

```typescript
interface ReadReceipt {
  messageId: string;
  readAt: number;
  senderId: string;
}

// Send as WebSocket message (unencrypted - metadata only)
ws.send(
  JSON.stringify({
    type: "read-receipt",
    data: receipt,
  }),
);
```

## Performance Optimization

### Message Batching

```typescript
// Instead of sending 100 messages per message
// Batch sends:
const batch = messages.slice(0, 100);
await fetch("/api/batch-send", {
  method: "POST",
  body: JSON.stringify({ messages: batch }),
});
```

### Connection Pooling

```typescript
// PostgreSQL connection pooling
const pool = new Pool({
  max: 20,
  min: 5,
  idle: 10000,
});
```

### Caching

```typescript
// Cache public keys in memory (with TTL)
const publicKeyCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCachedPublicKey(userId: string) {
  const cached = publicKeyCache.get(userId);
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    return cached.key;
  }
  return null;
}
```

## Testing

### Unit Tests

```bash
pnpm test
```

### Integration Tests

```typescript
// Test account creation
const keyPair = generateKeyPair();
const response = await fetch("/api/auth/register", {
  method: "POST",
  body: JSON.stringify({ publicKey: keyPair.publicKeyBase64 }),
});
const userId = (await response.json()).userId;

// Test authentication
const challenge = await getChallenge(userId);
const signature = signChallenge(challenge, keyPair.privateKeyBase64);
const session = await verifyChallenge(userId, challenge, signature);
```

### End-to-End Tests

```typescript
// Test message encryption and relay
const alice = createTestUser();
const bob = createTestUser();

const message = encryptMessage("Hello Bob", bob.publicKey, alice.privateKey);

const decrypted = decryptMessage(message, alice.publicKey, bob.privateKey);
expect(decrypted.content).toBe("Hello Bob");
```

## Troubleshooting

### WebSocket Connection Fails

- Check server is listening on correct port
- Verify SSL/TLS certificate is valid
- Check firewall allows WebSocket (port 443 for WSS)
- Verify session token is valid and not expired

### Messages Not Encrypting/Decrypting

- Verify key pair format is correct (base64)
- Check nonce is 24 bytes (after base64 decode)
- Verify both users have correct public/private keys
- Check timestamp is reasonable

### Performance Issues

- Check database query performance
- Monitor message queue size
- Verify connection pooling is working
- Check for memory leaks in Node process

## References

- [NaCl Cryptography](https://nacl.cr.yp.to/)
- [TweetNaCl.js](https://tweetnacl.js.org/)
- [BIP39 Mnemonics](https://github.com/trezor/python-mnemonic)
- [Session Messenger](https://getsession.org/)
- [WebSocket API](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket)
