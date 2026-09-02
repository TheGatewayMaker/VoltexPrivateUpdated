# Android integration specification

This is the authoritative contract for building a native client that interoperates with
Voltex. Where this document and anything in `docs/legacy/` disagree, this document is
correct. Where this document and the code disagree, the code is correct and this
document is a bug — please report it.

Reference implementation: `client/lib/crypto.ts`, `client/lib/passphrase.ts`,
`client/lib/mediaCrypto.ts`, `client/lib/useWebSocket.ts`. Server routes are all
registered in `server/index.ts`.

## 0. Non-negotiables

An account **is** its keypair. There is no password on the server that grants access to
messages, and no server-side key can decrypt them. Consequences:

- If the client loses the private key and the recovery passphrase, that account's history
  is gone. No support path exists. Design your key storage accordingly.
- Every byte layout below must match exactly. Encryption that is "equivalent but
  different" produces messages the web client cannot open, and vice versa.

## 1. Encoding conventions

- All binary values crossing the wire are **standard base64** (with `+`, `/`, `=`
  padding). Not base64url.
- The recovery verifier is the exception: **lowercase hex**, not base64.
- Timestamps are integer **milliseconds** since the Unix epoch.
- Message plaintext is **UTF-8** before encryption.
- All request and response bodies are JSON unless stated otherwise.

## 2. Identity

### 2.1 Key generation

```
boxKeyPair    = crypto_box_keypair()                    // X25519, 32-byte keys
signKeyPair   = crypto_sign_seed_keypair(boxSecretKey)  // Ed25519, seed = the 32-byte
                                                        // X25519 SECRET key
```

The signing keypair is **derived from the encryption secret key**, it is not independent.
This is unusual; reproduce it exactly or signatures will not verify. See
`client/lib/crypto.ts:40-59`.

You therefore hold four values, all base64:
`publicKey` (32 B), `privateKey` (32 B), `signPublicKey` (32 B), `signPrivateKey` (64 B).

### 2.2 User id

```
userId = hex(SHA-256(publicKeyBytes))[0..16]   // first 16 hex characters, 64 bits
```

Lowercase hex, truncated to 16 characters. The server derives the same value and rejects
a mismatch, so this must be byte-exact. See `client/lib/crypto.ts:65-78`.

### 2.3 Recovery passphrase

24 words drawn from the **BIP-39 English wordlist** (2048 words), each index chosen from
a cryptographically secure 16-bit random value modulo 2048.

Before any cryptographic use, normalise it: `trim()`, lowercase, collapse internal
whitespace runs to a single space (`client/lib/passphrase.ts:55-57`). Skipping this makes
recovery fail on trivial input differences.

## 3. Registration

`POST /api/auth/register`

```json
{
  "publicKey": "base64",
  "signPublicKey": "base64",
  "username": "alphanumeric_and_underscore",
  "recoveryVerifier": "hex",
  "recoverySalt": "base64",
  "recoveryIterations": 210000
}
```

Returns `201`. Usernames match `^[a-zA-Z0-9_]+$` and are reserved case-insensitively.
Check availability first with `POST /api/auth/username-availability {"username": "..."}`.

The recovery verifier is derived from the passphrase — it is a password-equivalent that
the server stores, and it is **not** the key that unwraps your private key:

```
recoveryVerifier = hex(PBKDF2-HMAC-SHA256(
    password   = normalisedPassphrase,
    salt       = recoverySalt (16 random bytes, sent base64),
    iterations = 210000,
    dkLen      = 32))
```

## 4. Sign-in

Challenge/response over the signing key. Two calls:

```
POST /api/auth/challenge   { "userId": "...", "publicKey": "base64" }
  -> { "challenge": "base64-random-32-bytes", ... }
```

```
POST /api/auth/verify      { "userId", "challenge", "signature", "publicKey" }
  -> { "sessionToken": "...", ... }
```

The signature is Ed25519 **detached** over the UTF-8 bytes of the challenge *string as
received* (do not base64-decode it first), signed with `signPrivateKey`, sent base64.
See `client/lib/crypto.ts:102-110`.

Challenges are single-use and expire after 5 minutes.

## 5. Sessions

Send `Authorization: Bearer <sessionToken>` on every authenticated request. There are no
cookies. Tokens last 24 hours with no sliding renewal — expect a re-authentication path.

- `GET /api/auth/verify-session` → 200 if still valid, 401 otherwise.
- `POST /api/auth/logout` revokes the current token.
- `GET /api/auth/sessions` lists the account's sessions; the response field is `devices`.

Store the token in Android Keystore-backed storage, never in plain `SharedPreferences`.

## 6. Key backup and recovery

At signup the client wraps its own keypair with a passphrase-derived key and uploads the
ciphertext, so a new device can recover it:

```
wrapKey        = PBKDF2-HMAC-SHA256(normalisedPassphrase, salt=16 random bytes,
                                    iterations=100000, dkLen=32)
plaintext      = JSON {publicKeyBase64, privateKeyBase64,
                       signPublicKeyBase64, signPrivateKeyBase64}
encryptedData  = AES-256-GCM(plaintext, key=wrapKey, iv=12 random bytes)
```

Note the iteration count differs from the recovery verifier (100 000 here, 210 000 there).
Both are as-implemented; do not "harmonise" them or existing accounts break.

`POST /api/auth/save-encrypted-keypair { userId, encryptedData, salt, iv }` (authenticated).

Recovery on a new device:

1. `GET /api/auth/recovery-params/by-username/:username` → `{ salt, iterations }`
2. Derive the verifier (§3) and `POST /api/auth/recover { userId, recoveryVerifier }`
   → `{ publicKey, recoveryToken }`. The token is single-use and expires in 5 minutes.
3. `GET /api/auth/encrypted-keypair/by-username/:username` with header
   `X-Recovery-Token: <recoveryToken>` → `{ encryptedData, salt, iv }`
4. Unwrap locally with the passphrase.

The server never sees the passphrase or the unwrapped key.

## 7. Direct messages

### 7.1 The envelope

Every message on the wire has this shape:

```json
{
  "nonce": "base64 24 bytes",
  "ciphertext": "base64",
  "signature": "base64 64 bytes",
  "senderId": "16 hex chars",
  "recipientId": "16 hex chars",
  "timestamp": 1788321344056
}
```

### 7.2 Encrypting

```
nonce      = 24 random bytes
ciphertext = crypto_box(plaintextUtf8, nonce, recipientPublicKey, senderPrivateKey)
signature  = crypto_sign_detached(nonce || ciphertext, senderSignPrivateKey)
```

`crypto_box` is X25519 key agreement with XSalsa20-Poly1305 — libsodium's
`crypto_box_easy`. The signature covers the concatenation `nonce || ciphertext` and
**nothing else**; read §7.6 before assuming that is sufficient.

Fetch the recipient's keys with
`GET /api/auth/public-key/by-username/:username` → `{ publicKey, signPublicKey }`.
Resolve a username to a user id with `GET /api/users/resolve/:username` (authenticated).

### 7.3 Decrypting

Verify first, then open. Fail closed — if verification fails, discard; do not display.

```
ok        = crypto_sign_verify_detached(signature, nonce || ciphertext, senderSignPublicKey)
plaintext = crypto_box_open(ciphertext, nonce, senderPublicKey, recipientPrivateKey)
```

Because `crypto_box` is Diffie-Hellman based, the **sender** can also open messages it
sent, using the recipient's public key and its own private key. That is how the web
client shows sent history. There is no separate self-copy.

### 7.4 Sending

Preferred path is the WebSocket (§8). HTTP fallback:

`POST /api/messages/send` with the envelope as the body, authenticated.
Returns `{ persisted: true, messageId, timestamp }`. **The server overwrites
`timestamp`** with its own value — use the returned one, not the one you sent.

The server rejects the message if `senderId` is not the authenticated user, or if the
signature does not verify against the account's stored signing key. Client-supplied
timestamps more than 24 hours from server time are rejected.

### 7.5 Reading, receipts and deletion

| Action | Request |
|---|---|
| History | `GET /api/messages/conversation/by-username/:username?limit=50&offset=0&anchor=latest` |
| Conversation list | `GET /api/messages/conversations` → entries keyed by `username`, with `unread` and `lastMessage` |
| Mark read | `PUT /api/messages/conversations/by-username/:username/read` |
| Delete one message | `DELETE /api/messages/message` body `{ messageId, recipientId, scope }` |
| Delete conversation | `DELETE /api/messages/conversation/by-username/:username` |

`scope` is `"self"` or `"everyone"`; only the original sender may use `"everyone"`, and
the server silently downgrades other callers to `"self"`.

### 7.6 What the signature does not cover — read this before designing

`senderId`, `recipientId`, `timestamp` and group id are **outside** both the signature
and the AEAD. A stored ciphertext can therefore be replayed into a different context and
still verify. This is a real, reproducible defect described in `KNOWN_ISSUES.md` §1.

If you intend to fix it — and you should — the fix changes the wire format and both
clients must ship together. Coordinate before you build. Do not silently add context
binding on Android only; the web client will reject every message you send.

## 8. WebSocket

Connections are ticket-authenticated. The session token is never sent in the URL.

1. `POST /api/auth/ws-ticket` (authenticated) → `{ ticket }`. Single-use, 60-second life.
2. Connect to `wss://<host>/ws?ticket=<ticket>`. Send an `Origin` header matching an
   allowed origin.

An invalid or reused ticket completes the handshake and then closes with code **4002**;
a missing ticket closes with **4001**. Treat any close in the 4000 range as
"re-authenticate", not "retry immediately".

Frames the client sends:

```json
{ "type": "message", "id": "<your-client-id>", "data": { ...envelope... } }
```

Frames the server sends:

| `type` | Meaning |
|---|---|
| `message` | Incoming message. `data` is an envelope plus `id` (server message id). |
| `message-ack` | Your send succeeded. Carries your `messageId`, plus `serverMessageId`, `timestamp`, `delivered`. |
| `error` | Rejected. Carries `error`, your `messageId`, sometimes `code` and `retryAfter`. |

On connect, any messages queued while offline are pushed immediately as `message` frames.
Deduplicate on `serverMessageId`; the web client's weaker `timestamp-senderId` key is not
something to copy.

`delivered: false` means stored but the recipient was offline — it is not a failure.

## 9. Groups

There is no group key. The sender encrypts the message **once per member** and uploads a
map of envelopes. Cost is O(members) per message; plan your UI around that.

| Action | Request |
|---|---|
| Create | `POST /api/groups { name, bio, avatar?, requestId }` |
| Read group | `GET /api/groups/:groupId` → members with `status` of `active`/`left`/`removed` |
| Invite | `POST /api/groups/:groupId/invites { username }` |
| Accept / decline | `POST /api/group-invites/:inviteId/accept` or `/decline` |
| List conversations | `GET /api/groups/conversations` |
| Send | `POST /api/groups/:groupId/messages` (below) |
| History | `GET /api/groups/:groupId/messages` |
| Mark read | `PUT /api/groups/:groupId/read` |
| Remove member | `DELETE /api/groups/:groupId/members/:userId` (admins) |
| Leave | `POST /api/groups/:groupId/leave` |

Send body:

```json
{
  "timestamp": 1788321344056,
  "envelopes": {
    "<memberUserId>": {
      "nonce": "base64",
      "ciphertext": "base64",
      "signature": "base64",
      "recipientId": "<memberUserId>",
      "timestamp": 1788321344056
    }
  }
}
```

Include an envelope for **every active member, including yourself** — that is how your own
copy of the message exists. The server rejects the send if any active member is missing.
Removed members are excluded, which is what stops them reading new traffic.

`GET .../messages` returns only the caller's own envelope per message, already flattened
into envelope shape. Set `recipientId` to your own user id before decrypting, and verify
against the **sender's** signing key.

## 10. Images and media

Media is separately encrypted, and the media key travels inside the encrypted message
body — so the server stores an opaque blob and never has the key.

Upload:

```
mediaKey  = 32 random bytes
iv        = 12 random bytes
body      = AES-256-GCM(fileBytes, mediaKey, iv)

POST /api/media/images/direct/by-username/:username
POST /api/media/images/groups/:groupId
  Content-Type: application/octet-stream
  Authorization: Bearer <token>
  X-Voltex-Media-Encryption: aes-gcm-v1
  X-Voltex-Original-Content-Type: image/jpeg
  X-Image-Width / X-Image-Height: optional integers
  <body = ciphertext>
-> { mediaId, mimeType, size, width?, height? }
```

Accepted source types are JPEG, PNG, WebP and AVIF; the limit is 12 MB before encryption.

Then send a normal message (§7) whose **plaintext** is:

```
VOLTEX_IMAGE::{"type":"image","provider":"voltex-media","mediaId":"...",
"mimeType":"image/jpeg","width":1024,"height":768,"size":123456,
"encryption":{"version":"aes-gcm-v1","key":"base64","iv":"base64",
"originalContentType":"image/jpeg"}}
```

The literal prefix is `VOLTEX_IMAGE::` followed by compact JSON. Receivers detect the
prefix, parse the payload, fetch `GET /api/media/images/:mediaId` (authenticated; only
conversation participants or group members are allowed), then AES-GCM-decrypt with the
key and iv from the payload.

GIFs and stickers come from a proxied third-party catalogue: `GET /api/klipy/gifs/search`,
`/api/klipy/gifs/trending`, `/api/klipy/stickers/*`, all requiring a session. Assets are
fetched through `GET /api/klipy/asset` and are **not** end-to-end encrypted — only the
reference travels inside the encrypted body.

## 11. Other endpoints you will need

| Purpose | Request |
|---|---|
| Own profile | `GET /api/profile/me`, `PUT /api/profile/me` |
| Someone's profile | `GET /api/profile/by-username/:username` |
| Avatar | `POST /api/profile/avatar` (raw JPEG/PNG, 5 MB), `DELETE /api/profile/avatar`, `GET /api/profile/avatar/by-username/:username` |
| Settings | `POST /api/profile/settings` |
| User search | `POST /api/users/search { query }` |
| Blocking | `POST` / `DELETE /api/blocks/by-username/:username`, `GET /api/blocks/status/by-username/:username` |
| Server time | `GET /api/auth/server-time` |

Avatars are **not** end-to-end encrypted; they are stored as ordinary objects.

Sending to someone who has blocked you returns an error with `code: "DIRECT_MESSAGE_BLOCKED"`.

## 12. Request rules and failure modes

**Origin header.** `POST`, `PUT`, `PATCH` and `DELETE` are rejected with `403 Untrusted
origin` if an `Origin` header is present and not in the server's allowed list. Native
Android clients that send no `Origin` are permitted — but if you do send one, it must be
allowed. Ask the operator to add your value rather than omitting it inconsistently.

**Rate limits.** Per identity and per path, in a 1-minute window: authentication
endpoints 5, user search 20, profile updates 10, message send 100, group mutations and
blocks 30. Over the limit returns `429` with `retryAfter` in seconds. Back off; do not
retry tightly.

**Overload.** Under load the server may return `503` with `retryAfter`. Treat as
transient.

**Clock skew.** Message timestamps outside ±24 h of server time are rejected. Sync
against `GET /api/auth/server-time` rather than trusting the device clock.

## 13. Verifying your implementation

Do this before writing any UI. It takes an afternoon and saves weeks.

1. Generate a keypair in your Android code and in the web client. Confirm the derived
   `userId` matches for the same public key.
2. Register from Android, then sign in as that user in the web client using the same
   recovery passphrase, and confirm the keypair unwraps.
3. Send a message web → Android and Android → web. Both must decrypt.
4. Repeat for a group with three members, and for an encrypted image.
5. Tamper with one ciphertext byte and confirm your client refuses it.

`server/integration.spec.ts` and the crypto reference in `client/lib/crypto.ts` are the
best oracles. `pnpm test` runs the suite against an isolated store.

## 14. Suggested Android libraries

- **libsodium** via `lazysodium-android` for `crypto_box`, `crypto_sign` and
  `crypto_sign_seed_keypair`. Do not hand-roll X25519 or Ed25519.
- **javax.crypto** for AES-256-GCM and PBKDF2-HMAC-SHA256 — both are in the platform.
- **Android Keystore** for wrapping the private key at rest. The key material itself must
  remain extractable by your code (you need the raw bytes for libsodium), so wrap it with
  a Keystore-held AES key rather than trying to store it as a Keystore key directly.
- **OkHttp** for HTTP and WebSocket; it handles the ticket-in-query-string flow fine.


