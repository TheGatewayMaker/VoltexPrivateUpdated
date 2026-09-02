# Voltex Flutter app — prompt pack for a code-generating AI

The generator cannot read the GitHub repo, so every fact it needs is inline here. Give it
**Prompt 1 first** and keep it in the conversation; prompts 2–7 build on it.

If the tool accepts one long brief, paste Prompt 1 followed by Prompt 2. If it works
better in stages, go one at a time and check the output of each before moving on.

Base URL for all requests: `https://voltexchat.online`

---

## Prompt 1 — Foundation and protocol contract

Build a native Flutter application (Android first, iOS-capable) called **Voltex**: an
end-to-end encrypted messenger. It is a second client for an existing service, so the
protocol below is fixed and cannot be redesigned. Everything binary on the wire is
standard base64 (with `+`, `/` and `=` padding — never base64url), every timestamp is
integer milliseconds, and all bodies are JSON unless stated otherwise.

### Non-negotiable premise

The server stores only ciphertext and holds no key that can read messages. An account
**is** its keypair. Reproduce the cryptography byte-for-byte or messages will arrive and
silently fail to decrypt. Isolate all of it in one module, `lib/crypto/voltex_crypto.dart`,
with unit tests using the vectors at the end of this prompt. Do not write any UI until
those tests pass.

### Identity

```
boxKeyPair  = crypto_box_keypair()                        // X25519, 32-byte keys
signKeyPair = crypto_sign_seed_keypair(boxKeyPair.secret) // Ed25519, seeded with the
                                                          // 32-byte X25519 SECRET key
userId      = hex(SHA-256(boxPublicKeyBytes)).substring(0, 16)   // lowercase, truncated
```

The signing keypair is **derived from the encryption secret key**, not generated
independently. The user id is a **truncated** 16-hex-character SHA-256. Both are unusual
and both are mandatory.

You therefore persist four base64 values: `publicKey` (32 B), `privateKey` (32 B),
`signPublicKey` (32 B), `signPrivateKey` (64 B).

### Recovery passphrase

24 words from the **BIP-39 English wordlist** (2048 words), each index from a
cryptographically secure 16-bit random value modulo 2048 — never `Random()`. Before any
cryptographic use, normalise: trim, lowercase, collapse internal whitespace runs to one
space.

Two separate PBKDF2-HMAC-SHA256 derivations exist and their iteration counts differ
deliberately. Do not unify them.

```
recoveryVerifier = hex(PBKDF2(normalisedPassphrase, salt=16 random bytes,
                             iterations=210000, dkLen=32))      // hex, not base64
wrapKey          = PBKDF2(normalisedPassphrase, salt=16 random bytes,
                             iterations=100000, dkLen=32)       // key for AES-256-GCM
```

### Message envelope

```
nonce      = 24 random bytes
ciphertext = crypto_box(utf8(plaintext), nonce, recipientPublicKey, senderPrivateKey)
signature  = crypto_sign_detached(nonce || ciphertext, senderSignPrivateKey)
```

`crypto_box` is libsodium `crypto_box_easy` (X25519 + XSalsa20-Poly1305). The signature
covers exactly `nonce || ciphertext` and nothing else. On receive, **verify first, then
decrypt, and fail closed** — never display a message whose signature does not verify.

Because `crypto_box` is Diffie-Hellman based, the sender can also open its own sent
messages using the recipient's public key with its own private key. There is no separate
self-copy.

### HTTP API — exact shapes, captured from the live server

Authenticated requests send `Authorization: Bearer <sessionToken>`. There are no cookies.

**Sign up.** `POST /api/auth/register`
```
→ {"publicKey":"b64","signPublicKey":"b64","username":"a-zA-Z0-9_","recoveryVerifier":"hex",
   "recoverySalt":"b64","recoveryIterations":210000}
← 201 {"userId":"16 hex","username":"...","message":"Account created successfully"}
```

**Username check.** `POST /api/auth/username-availability`
```
→ {"username":"..."}          ← {"available":false,"username":"..."}
```

**Sign in, step 1.** `POST /api/auth/challenge`
```
→ {"userId":"...","publicKey":"b64"}
← {"challenge":"b64","expiresAt":1788325618584}
```

**Sign in, step 2.** `POST /api/auth/verify` — signature is Ed25519 detached over the UTF-8
bytes of the challenge **string as received** (do not base64-decode it first).
```
→ {"userId":"...","challenge":"<as received>","signature":"b64","publicKey":"b64"}
← {"sessionToken":"...","userId":"...","expiresAt":1788411718711,"message":"Authentication successful"}
```

**Upload the wrapped keypair** (do this right after signup). The plaintext is JSON
`{publicKeyBase64, privateKeyBase64, signPublicKeyBase64, signPrivateKeyBase64}`, encrypted
with AES-256-GCM using `wrapKey` and a 12-byte random IV.
```
POST /api/auth/save-encrypted-keypair
→ {"userId":"...","encryptedData":"b64","salt":"b64","iv":"b64"}
← {"message":"Encrypted keypair saved successfully"}
```

**Session check.** `GET /api/auth/verify-session`
```
← {"userId":"...","deviceId":"...","publicKey":"b64","expiresAt":1788411718711}
```
401 means re-authenticate. Tokens last 24 hours with no refresh.

**Recovery on a new device.**
```
GET /api/auth/recovery-params/by-username/:username
  ← {"version":2,"salt":"b64","iterations":210000}
POST /api/auth/recover  → {"userId":"...","recoveryVerifier":"hex"}
  ← {"publicKey":"b64","recoveryToken":"...", ...}       // single-use, 5 minutes
GET /api/auth/encrypted-keypair/by-username/:username
  header X-Recovery-Token: <recoveryToken>
  ← {"encryptedData":"b64","salt":"b64","iv":"b64"}
```
Unwrap locally with the passphrase. The server never sees the passphrase or the key.

**Look up a contact.**
```
GET /api/auth/public-key/by-username/:username
  ← {"publicKey":"b64","signPublicKey":"b64"}
GET /api/users/resolve/:username                        (authenticated)
  ← {"userId":"...","username":"...","displayName":"User","bio":"","avatar":null}
POST /api/users/search  → {"query":"..."}               (authenticated)
  ← {"results":[{"username":"...","displayName":"...","bio":"","avatar":null}],"count":1}
```

**Send a message.** `POST /api/messages/send`, body is the envelope plus ids:
```
→ {"nonce":"b64","ciphertext":"b64","signature":"b64","senderId":"...","recipientId":"...",
   "timestamp":1788325320028}
← {"success":true,"messageId":"uuid","clientMessageId":"...","timestamp":1788325320047,
   "persisted":true,"delivered":false}
```
**Use the returned `timestamp`, not the one you sent** — the server overwrites it.
`delivered:false` only means the recipient was offline; the message is stored.

**Read a thread.** `GET /api/messages/conversation/by-username/:username?limit=50&offset=0&anchor=latest`
```
← {"messages":[{"id":"uuid","nonce":"b64","ciphertext":"b64","signature":"b64",
                "senderId":"...","recipientId":"...","timestamp":1788325320047}],
   "total":2,"limit":50,"offset":0,"source":"database+r2"}
```
Some entries may lack `id`, and the server can return the same message twice — this is a
known server bug. **Deduplicate on `ciphertext` when `id` is absent, and always dedupe on
`id` when present.**

**Conversation list.** `GET /api/messages/conversations`
```
← {"conversations":[{"username":"...","displayName":"User","avatar":null,
     "lastMessage":{"messageId":"uuid","senderId":"...","recipientId":"...",
                    "timestamp":...,"nonce":"b64","ciphertext":"b64","signature":"b64"},
     "timestamp":...,"unread":0}],"count":1}
```
Entries are keyed by `username`, and the unread field is `unread` (not `unreadCount`).
Decrypt `lastMessage` locally to render the preview.

**Mark read.** `PUT /api/messages/conversations/by-username/:username/read` → `{"success":true}`

**Delete.** `DELETE /api/messages/message` with `{"messageId":"uuid","recipientId":"...","scope":"self"|"everyone"}`.
`everyone` is only honoured for messages you sent. Also
`DELETE /api/messages/conversation/by-username/:username` clears a whole thread for you.

### WebSocket — preferred transport for sending and receiving

```
POST /api/auth/ws-ticket        (authenticated)
  ← {"ticket":"...","expiresAt":1788325380197}      // single-use, 60 seconds
connect  wss://voltexchat.online/ws?ticket=<ticket>
```
Fetch a fresh ticket for every connection attempt. A missing ticket closes with code
**4001**, an invalid or reused one with **4002**. Treat any 4000-range close as
"re-authenticate", not "retry immediately".

Client → server:
```json
{"type":"message","id":"<your-local-id>","data":{ ...envelope with senderId/recipientId... }}
```

Server → client:
```json
{"type":"message-ack","messageId":"<your-local-id>","delivered":false,
 "serverMessageId":"uuid","timestamp":1788325320315}
{"type":"message","data":{"id":"uuid","nonce":"b64","ciphertext":"b64","signature":"b64",
 "senderId":"...","recipientId":"...","timestamp":...}}
{"type":"error","error":"human readable","messageId":"<your-local-id>","code":"...","retryAfter":12}
```
On connect the server immediately pushes any messages queued while you were offline.
Deduplicate on `serverMessageId`. Derive online/presence state from the socket, not from a
separate API.

### Groups — no group key exists

The sender encrypts **once per active member, including itself**, and uploads a map. Cost
is O(members) per message; design the send path and UI for that.

```
POST /api/groups  → {"name":"...","bio":"...","avatar":null,"requestId":"<unique>"}
  ← {"success":true,"group":{"id":"uuid","name":"...","bio":"...","avatar":null,
       "createdBy":"...","createdAt":...,"updatedAt":...,
       "members":[{"userId":"...","role":"admin"|"member","status":"active"|"left"|"removed",
                   "joinedAt":...,"username":"...","displayName":"...","avatar":null,
                   "publicKey":"b64","signPublicKey":"b64"}]}}

POST /api/groups/:groupId/invites  → {"username":"..."}
  ← {"success":true,"invite":{"id":"uuid","groupId":"uuid","groupName":"...",
       "invitedBy":"...","inviterUsername":"...","createdAt":...}}

POST /api/group-invites/:inviteId/accept      ← {"success":true,"group":{...}}
POST /api/group-invites/:inviteId/decline
GET  /api/groups/:groupId                     ← {"group":{...}}
GET  /api/groups/conversations
  ← {"groups":[{"id":"uuid","name":"...","bio":"...","avatar":null,"timestamp":...,
       "unreadCount":0,"memberCount":2}],"invites":[]}

POST /api/groups/:groupId/messages
→ {"timestamp":1788325322957,
   "envelopes":{"<memberUserId>":{"nonce":"b64","ciphertext":"b64","signature":"b64",
                                  "recipientId":"<memberUserId>","timestamp":...}}}
  ← {"success":true,"messageId":"uuid","timestamp":...,
     "receipt":{"recipientCount":1,"deliveredCount":0,"seenCount":0,
                "deliveredToAll":false,"seenByAny":false,"seenByAll":false}}

GET  /api/groups/:groupId/messages
  ← {"messages":[{"id":"uuid","nonce":"b64","ciphertext":"b64","signature":"b64",
       "senderId":"...","recipientId":"<you>","timestamp":...}],"total":1,"group":{...}}
PUT    /api/groups/:groupId/read
DELETE /api/groups/:groupId/members/:userId      (admins only)
POST   /api/groups/:groupId/leave
DELETE /api/groups/:groupId/messages/:messageId
POST   /api/groups/:groupId/pin  → {"messageId":"uuid"}
```
Member public keys arrive inside the group object — use those, no extra lookups. The send
is rejected if any active member lacks an envelope. History returns only your own envelope
per message, already flattened; verify it against the **sender's** signing key.

### Images

The media key travels inside the encrypted message body, so the server holds an opaque blob.

```
mediaKey = 32 random bytes ; iv = 12 random bytes
body     = AES-256-GCM(fileBytes, mediaKey, iv)

POST /api/media/images/direct/by-username/:username      (or /api/media/images/groups/:groupId)
  Content-Type: application/octet-stream
  X-Voltex-Media-Encryption: aes-gcm-v1
  X-Voltex-Original-Content-Type: image/jpeg
  X-Image-Width / X-Image-Height: optional
  <raw ciphertext bytes>
  ← {"mediaId":"...","mimeType":"image/jpeg","size":123456,"width":1024,"height":768}
```

Then send a normal message whose **plaintext** is this exact string:
```
VOLTEX_IMAGE::{"type":"image","provider":"voltex-media","mediaId":"…","mimeType":"image/jpeg","width":1024,"height":768,"size":123456,"encryption":{"version":"aes-gcm-v1","key":"b64","iv":"b64","originalContentType":"image/jpeg"}}
```
Receivers detect the `VOLTEX_IMAGE::` prefix, parse the JSON, `GET /api/media/images/:mediaId`
(authenticated), then AES-GCM-decrypt with the embedded key and iv. Source types: JPEG, PNG,
WebP, AVIF; 12 MB limit before encryption.

### Other endpoints

```
GET  /api/profile/me            ← {"userId","publicKey","displayName","username","avatar",
                                   "notifications":false,"notificationEmail":null,
                                   "usernameDiscoveryEnabled":true,"createdAt":...}
PUT  /api/profile/me            → {"displayName":"...","bio":"..."}
GET  /api/profile/by-username/:username
POST /api/profile/settings
POST /api/profile/avatar        raw image/jpeg or image/png, 5 MB max
GET  /api/blocks/status/by-username/:username
  ← {"success":true,"targetUserId":"...","status":{"blockedByMe":false,"blockedMe":false,
      "isMutual":false,"canSend":true}}
POST   /api/blocks/by-username/:username        DELETE /api/blocks/by-username/:username
GET  /api/auth/sessions
  ← {"currentSessionId":"...","devices":[{"sessionId":"...","deviceId":"...","current":true,
      "online":false,"deviceName":"...","platform":"...","loginAt":...,"lastActiveAt":...,
      "expiresAt":...}]}
POST /api/auth/sessions/:sessionId/revoke       POST /api/auth/logout
GET  /api/auth/server-time      ← {"timestamp":1788325320000}
```
Avatars are **not** end-to-end encrypted. Sending to someone who blocked you returns an
error with `code:"DIRECT_MESSAGE_BLOCKED"`.

### Failure handling

Rate limits are per identity and per path in a 60-second window: auth endpoints 5, user
search 20, profile updates 10, message send 100, group mutations and blocks 30. Over the
limit is `429` with `retryAfter` seconds. Overload is `503` with `retryAfter`. Message
timestamps outside ±24 hours of server time are rejected — sync against
`GET /api/auth/server-time`, never trust the device clock.

### Packages

`sodium_libs` + `sodium` for `crypto_box`, `crypto_sign_detached`, `crypto_sign_seed_keypair`
(fall back to `pinenacl` only if bundling native libsodium is impossible). `cryptography`
for AES-256-GCM and PBKDF2-HMAC-SHA256. `crypto` for SHA-256. `bip39` for the wordlist.
`flutter_secure_storage` for the identity key and session token. `dio` for HTTP with
interceptors handling 401 and 429. `web_socket_channel` for the socket. `riverpod` for
state. `google_fonts`. `cached_network_image`. Never hand-roll X25519, Ed25519 or GCM.

**Key storage:** libsodium needs the raw 32-byte secret at runtime, so it cannot live as a
Keystore key. Store the raw bytes in `flutter_secure_storage` (which wraps them under a
Keystore key), read them only when needed, and set `android:allowBackup="false"`.

### Design system — match the existing web app exactly

Dark theme only; there is no light theme. Override Material 3 defaults rather than
accepting them.

| Purpose | Hex |
|---|---|
| Background | `#071212` |
| Card / surface | `#14292A` |
| Popover | `#112627` |
| Brand accent (primary) | `#2CC3A5` |
| On-primary | `#081516` |
| Secondary surface | `#213A3B` |
| Muted surface | `#1B2B2C` |
| Primary text | `#E8F7F3` |
| Secondary text | `#ABC4BE` |
| Accent | `#254B4A` |
| Border | `#385C5C` |
| Input background | `#152828` |
| Destructive | `#E33131` |
| Focus ring | `#89ECD8` |

Typography via `google_fonts`: **Manrope** for body, **Montserrat** for headings at heavy
weights (800–900) with tight negative letter spacing (-0.04em to -0.06em), **IBM Plex Mono**
for ids, fingerprints and message timestamps.

Shape and depth: surfaces are rounder than Material defaults — cards and panels 22–28 px,
buttons and badges fully rounded pills. Use large soft shadows with a subtle 1 px inner
top highlight instead of Material elevation. Prefer flat, slightly translucent panels over
filled Material cards. Colour the status bar and system navigation bar to the background
with light icons, and respect safe areas including display cutouts.

### Screens

Signup (key generation, 24-word passphrase display with an explicit "I have saved it"
confirmation step, username choice with live availability), Sign in, Recover account,
Conversation list (1:1 and groups merged, with unread badges and decrypted previews), Chat
thread, Group thread (member list, admin actions, pinned message), Group invite accept or
decline, Public profile (with block/unblock), Account (own profile, avatar, active
sessions and devices with revoke), Settings (display name, discoverability, notifications),
About. There is no admin console in the app — that stays web-only.

### Behaviour

Optimistic send showing a pending state, reconciled against the ACK and its authoritative
timestamp. Per-message states: sending, sent, delivered, seen. Unread counts cleared via
the mark-read endpoint when a thread opens. Delete offers "for me" and, for your own
messages, "for everyone". Images render inline from the decrypted bytes with a placeholder
while decrypting. Long-press opens message actions. Outbound sends queue locally while
offline and flush on reconnect. Never show a message that failed signature verification —
drop it and log a counter, not the content.

### Test vectors — the crypto module must reproduce these exactly

Derived from the production implementation. Fixed inputs, so your output must match
character for character.

```
Alice X25519 secret (b64) : ERERERERERERERERERERERERERERERERERERERERERE=
Alice X25519 public (b64) : e06Qm75//kTEZaIgA31gjuNYl9Me+XLwf3SJLLD3PxM=
Alice Ed25519 public (b64): 0EqyMnQrtKs6E2i9RhXk5tAiSrcaAWuvhSCjMsl3hzc=
Alice userId              : d19bf3f082782c87

Bob   X25519 secret (b64) : IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI=
Bob   X25519 public (b64) : D6poTtKIZ7l/Smot7l34zpdOdrcBjj8iocTPJnhXDyA=
Bob   Ed25519 public (b64): oJql9HpnWYAv+VX43C0qFKXJnSO+l/hkEn/5ODRVpPA=
Bob   userId              : 65cf5c9b1de5d41f

Message from Alice to Bob:
  plaintext  : Voltex test vector 1
  nonce  (b64): AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcY
  ciphertext  : Nf8tLuDxZZunrSR+EafNaN0IBL4TUdcuXUfV97VH3wBv+0D9
  signature   : ZY3WLjuH/skHVzrZTQ9LIehKWCfF85qrocHm4Zq9z0ZlBS8/Xi7wpPVrFos2J8cDd+Gnycnv5BbLkD8lffkQAw==

Passphrase normalisation and PBKDF2:
  raw        : "  Alpha  BRAVO charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray  "
  normalised : "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray"
  salt (b64) : MzMzMzMzMzMzMzMzMzMzMw==
  iterations : 210000
  verifier   : 439d5f659e0590edc3b3321bd6b5e276b5b6fab530d9b49a19c440309de58595
```

Write these as unit tests first:
1. Seeding Ed25519 from Alice's X25519 secret yields Alice's Ed25519 public key.
2. Deriving the user id from each public key yields the values above.
3. Encrypting the plaintext with that exact nonce yields that exact ciphertext.
4. Signing `nonce || ciphertext` yields that exact signature.
5. Bob decrypts it to the plaintext; Alice can also decrypt her own message.
6. Flipping one ciphertext byte makes verification fail and nothing is displayed.
7. Normalising the raw passphrase yields the normalised string, and PBKDF2 yields that
   verifier hex.

Deliver the crypto module plus these passing tests **before** building screens.

---

## Prompt 2 — Authentication flows

Using the contract from Prompt 1, implement signup, sign-in, recovery and session
handling. Signup: generate the keypair, derive the user id, generate and display the
24-word passphrase with a confirmation step the user cannot skip, check username
availability live, register, immediately sign in via challenge/response, then wrap the
keypair with the passphrase and upload it. Store the identity in secure storage; never
write it to plain preferences, logs or analytics. Sign-in: challenge/response against a
stored identity, and a "recover with passphrase" path when there is no local key. Recovery:
fetch recovery params, derive the verifier, exchange it for a single-use token, fetch the
wrapped keypair, unwrap locally, then sign in normally. Handle 401 anywhere by clearing the
session and returning to sign-in, keeping the identity key so the user does not have to
recover again. Show clear, non-technical errors: taken username, wrong passphrase, expired
challenge, no network. Add a first-run screen explaining that the passphrase is the only
way back into the account and that nobody, including the operator, can recover it.

---

## Prompt 3 — Conversation list, chat thread and the socket

Implement the conversation list merging 1:1 conversations and groups, sorted by timestamp,
with unread badges and previews produced by decrypting `lastMessage` locally. Implement the
1:1 thread: load history with pagination, decrypt and verify every message, dedupe as
described, render sender-aligned bubbles with `IBM Plex Mono` timestamps, and mark the
conversation read on open. Wire the WebSocket as the primary transport: fresh ticket per
connection, automatic reconnect with exponential backoff and jitter, a visible but
unobtrusive connection indicator, and HTTP send as fallback when the socket is down.
Implement optimistic send with pending/sent/delivered/seen states reconciled against the
ACK. Queue outbound messages locally while offline and flush in order on reconnect.
Implement delete for me and delete for everyone. Handle 429 and 503 with the server's
`retryAfter`. Never render a message that fails signature verification.

---

## Prompt 4 — Groups

Implement group creation, invitations, accept and decline, the member list with roles and
statuses, admin actions (promote, remove member), leaving a group, pinning a message, and
deleting a group message. Implement group send: take the member public keys from the group
object, encrypt the plaintext once per active member including yourself, and post the
envelope map — if any active member is missing the server rejects the send, so build the
map from the group's current active members and refresh the group first if the send fails.
Implement group history: each message returns only your own envelope, so decrypt it with
your private key and verify against the sender's signing key from the member list. Show
per-message receipt state from the `receipt` object. Make it obvious in the UI that a
removed member can no longer read new messages.

---

## Prompt 5 — Images and media

Implement picking an image, downscaling sensibly, encrypting it with a fresh AES-256-GCM
key, uploading the ciphertext with the required headers, then sending the
`VOLTEX_IMAGE::` message described in Prompt 1. On receive, detect the prefix, parse the
payload, download the blob, decrypt in an isolate so the UI never blocks, cache the
decrypted bytes in memory only, and render inline with a blurred placeholder and a
full-screen viewer. Never write decrypted media to shared or external storage. If a
download or decrypt fails, show a retry affordance rather than a broken image. Apply the
same flow to group images using the group upload endpoint.

---

## Prompt 6 — Profile, settings, sessions and blocking

Implement the own-profile screen with display name, bio and avatar upload, the public
profile screen for other users with block and unblock, the settings screen covering
username discoverability and notification preferences, and an active sessions screen
listing devices with their last-active times and a revoke action for each. Show the current
device distinctly. Implement the block status check before opening a thread and handle the
`DIRECT_MESSAGE_BLOCKED` error on send with a clear explanation. Add an About screen that
explains the encryption in plain language, including that the operator cannot read
messages and that losing the passphrase means losing the account.

---

## Prompt 7 — Hardening and release readiness

Apply these as acceptance criteria, not suggestions. Nothing is unhackable; the goal is
that a compromise of the server, of the network, or of a stolen locked device yields no
message plaintext.

Add certificate pinning for `voltexchat.online` with a backup pin and a documented rotation
plan. Set `android:usesCleartextTraffic="false"` and `android:allowBackup="false"`. Store
the identity key and session token only in `flutter_secure_storage`, optionally behind a
biometric prompt. Encrypt any local message cache with a key held in the Keystore rather
than using plaintext SQLite. Apply `FLAG_SECURE` on chat and passphrase screens so
screenshots and recents thumbnails are blocked. Clear the clipboard on a timer after the
user copies a passphrase. Enable R8 with obfuscation for release builds, use
`--split-debug-info`, ship no debug symbols, and strip every log statement in release —
verify by running `logcat` against a real release build and confirming no plaintext,
key material or token appears. Add root and emulator detection as signals only, never as
the sole defence, and consider Play Integrity attestation if server-side assurance is
needed. Commit the lockfile and check dependencies in CI. Keep the crypto layer small,
isolated and heavily unit-tested with the vectors from Prompt 1 so an external reviewer can
audit it quickly — budget for that review before launch.

Additionally implement **key fingerprint verification**: derive a readable safety number
from both parties' public keys, show it on the profile and thread screens, warn prominently
if a contact's key changes, and pin the first key you saw. The web client does not do this
today, which means the server could substitute a public key undetected — closing that gap
is the single biggest security improvement this app can make.

One protocol weakness to be aware of but **not** to fix unilaterally: message signatures
cover only `nonce || ciphertext`, so sender, recipient, conversation and timestamp are not
bound, which permits replay and cross-conversation splicing. Fixing it changes the wire
format and both clients must ship simultaneously, or every message this app sends will be
rejected by the web client. Flag it and coordinate.




