# Android integration specification

This is the authoritative contract for building a native client that interoperates with
Voltex. Where this document and anything in `docs/legacy/` disagree, this document is
correct. Where this document and the code disagree, the code is correct and this
document is a bug — please report it.

Reference implementation: `client/lib/crypto.ts`, `client/lib/passphrase.ts`,
`client/lib/mediaCrypto.ts`, `client/lib/useWebSocket.ts`. Server routes are all
registered in `server/index.ts`.

The target client is **Flutter/Dart**. Sections 1–13 are platform-neutral protocol;
§14 covers Dart packages, §15 covers interface parity with the web app, and §16 lists
hardening requirements.

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

## 14. Flutter package choices

The client is being built in Flutter/Dart. Do not hand-roll any primitive below.

| Need | Package | Notes |
|---|---|---|
| `crypto_box`, `crypto_sign_detached`, `crypto_sign_seed_keypair` | `sodium_libs` (+ `sodium`) | Real libsodium via FFI. First choice — same library the web client's `tweetnacl` is compatible with. |
| Pure-Dart fallback | `pinenacl` | Provides `Box`, `SigningKey`, `VerifyKey`. Use only if bundling native libsodium is blocked; verify against the web client before committing to it. |
| AES-256-GCM, PBKDF2-HMAC-SHA256 | `cryptography` | Needed for the keypair wrapping (§6) and media (§10). `Pbkdf2(macAlgorithm: Hmac.sha256())`. |
| SHA-256 | `crypto` | For the user id derivation (§2.2). |
| BIP-39 wordlist | `bip39` | You need the English list only, and index selection must be CSPRNG-driven, not `Random()`. |
| Key storage at rest | `flutter_secure_storage` | Android Keystore / iOS Keychain backed. See the warning below. |
| HTTP | `dio` or `http` | `dio` if you want interceptors for the 401 → re-auth and 429 → backoff paths. |
| WebSocket | `web_socket_channel` | Handles the `?ticket=` query-string flow and exposes close codes, which you need (§8). |
| State | `riverpod` or `bloc` | Team preference. The web client uses React state plus TanStack Query; nothing about the protocol depends on this. |

**Key storage warning.** libsodium needs the raw 32-byte secret at runtime, so you cannot
store the identity key *as* a Keystore key. Store the raw bytes in
`flutter_secure_storage` (which wraps them with a Keystore-held key), read them only when
needed, and avoid holding them in long-lived Dart objects. Set
`android:allowBackup="false"` so key material is never included in device backups.

## 15. Interface and product parity

The Flutter app should feel like the same product, not a different app against the same
API. Read the web pages under `client/pages/` for behaviour; the tokens below come from
`client/global.css`.

### 15.1 Screens to build

| Web route | Component | Purpose |
|---|---|---|
| `/signup` | `SignUp.tsx` | Key generation, 24-word passphrase presentation and confirmation, username choice |
| `/signin` | `SignIn.tsx` | Challenge/response sign-in, optional passkey step |
| `/recover` | `Recover.tsx` | Passphrase recovery on a new device |
| `/conversations` | `Conversations.tsx` | Conversation list with unread counts and last message |
| `/chat/:id` | `Chat.tsx` | 1:1 thread: send, receive, receipts, delete, images, GIFs |
| `/groups/:id` | `GroupChat.tsx` | Group thread, member list, admin actions, pinned message |
| `/group-invites/:inviteId` | `GroupInvite.tsx` | Accept or decline an invitation |
| `/:username/profile` | `PublicProfile.tsx` | Someone else's profile, block/unblock |
| `/account` | `Account.tsx` | Own profile, avatar, sessions and devices, passkeys |
| `/settings` | `Settings.tsx` | Preferences, discoverability, notifications |
| `/about-v0lt3x` | `AboutVoltex.tsx` | About and privacy explanation |

The admin console (`AdminDashboard.tsx`) is **web only**. Do not port it.

### 15.2 Design tokens

Dark theme only — the web app ships no light theme. HSL values are canonical in
`client/global.css`; hex is provided for Flutter's `Color(0xFF……)`.

| Token | HSL | Hex |
|---|---|---|
| background | `184 44% 5%` | `#071212` |
| foreground (primary text) | `164 48% 94%` | `#E8F7F3` |
| card / surface | `181 36% 12%` | `#14292A` |
| popover | `181 38% 11%` | `#112627` |
| primary (brand accent) | `168 63% 47%` | `#2CC3A5` |
| primary foreground | `185 45% 6%` | `#081516` |
| secondary | `182 28% 18%` | `#213A3B` |
| muted | `183 24% 14%` | `#1B2B2C` |
| muted foreground (secondary text) | `165 18% 72%` | `#ABC4BE` |
| accent | `178 34% 22%` | `#254B4A` |
| destructive | `0 76% 54%` | `#E33131` |
| border | `180 24% 29%` | `#385C5C` |
| input | `181 32% 12%` | `#152828` |
| focus ring | `168 72% 73%` | `#89ECD8` |

Typography, via `google_fonts`: **Manrope** for body, **Montserrat** for headings (the web
client uses heavy weights with tight negative letter spacing, roughly `-0.04em` to
`-0.06em`), **IBM Plex Mono** for identifiers, ids and fingerprints.

Shape: base radius is `1rem`, but surfaces are deliberately rounder than default —
cards and panels use 22–28 px, pills and badges are fully rounded. Elevation is done with
large soft shadows plus a 1 px inner highlight, not Material elevation. Prefer flat
translucent surfaces over Material 3 defaults, and set the app bar and system nav bar to
the background colour with light icons.

### 15.3 Behaviour to match

Optimistic send with a pending state, then reconcile against the server ACK and its
authoritative timestamp. Per-message states of sending, sent, delivered and seen. Typing
and presence come from the WebSocket connection state, not a separate API. Unread counts
clear on opening a thread via the mark-read endpoint. Deletion offers "for me" and, for
your own messages, "for everyone". Image messages render inline from the decrypted blob
with a blurred placeholder while decrypting. Long-press opens the message actions the web
client exposes on hover. Offline sends queue locally and flush on reconnect — the web
client does this and users expect it.

## 16. Hardening requirements

The brief was "better and non-hackable". Nothing is unhackable, and any claim otherwise in
a security review is a red flag. What is achievable is that a compromise of the server, the
network, or a stolen locked device does not yield message plaintext. Treat the following as
acceptance criteria, not suggestions.

**Fix what the web client got wrong.** Two items in `KNOWN_ISSUES.md` are worth solving in
this app: implement key fingerprint verification (§3 there) so users can compare a safety
number out of band and the server cannot substitute keys undetected; and be ready to
implement context binding in the signed payload (§1 there) as a coordinated change with
the web client.

**Transport.** Certificate pinning against the production leaf or intermediate, with a
documented rotation plan and a backup pin — an unpinned pin-less client is trivially
MITM-able on a hostile network, and a badly pinned one bricks itself on renewal. Reject
plaintext HTTP entirely (`android:usesCleartextTraffic="false"`).

**At rest.** Identity key and session token in `flutter_secure_storage` only. Optional
biometric gate before the key is readable. Local message cache encrypted with a key held
in the Keystore, not plaintext SQLite. `allowBackup="false"`, and exclude app data from
cloud backup.

**On screen.** `FLAG_SECURE` on chat screens to block screenshots and exclude content from
the recents thumbnail. Clear the clipboard after a timeout when a user copies a passphrase.
Never render the passphrase in a screenshot-able flow without an explicit warning.

**In the binary.** R8 with obfuscation enabled for release builds, `--split-debug-info`,
and no debug symbols shipped. Strip all logging in release — no plaintext bodies, no keys,
no tokens, not even truncated. Verify with a release build and `logcat` before shipping.

**Integrity.** Play Integrity API attestation if you need server-side assurance; root and
emulator detection as signals, never as the only defence. Do not ship a client that trusts
its own environment.

**Process.** Dependency pinning with a lockfile committed, `dart pub outdated` in CI, and
a third-party audit of the crypto layer before launch. The crypto layer should be a small,
isolated, heavily unit-tested module with test vectors captured from the web client, so a
reviewer can check it in an afternoon.



