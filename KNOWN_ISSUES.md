# Known issues

Findings from a code audit and live testing of this codebase, September 2026. Items marked
**Reproduced** were demonstrated against a running instance, not inferred from reading.

Read §1 and §4 before designing anything. They will change what you build.

## 1. Message signatures do not bind the conversation — Reproduced

**Severity: high.** `client/lib/crypto.ts:149-155` signs only `nonce || ciphertext`, and
the AEAD covers only the plaintext. `senderId`, `recipientId`, `timestamp` and `groupId`
travel outside both.

A stored ciphertext can therefore be lifted and replayed in a different context and still
pass verification. Demonstrated: a 1:1 message from A to B was resubmitted verbatim as a
group envelope for B, and B's client verified the signature and displayed it as an
authentic group message. The same gap allows replay of a stored message with a fresh
timestamp.

**Fix direction:** include a context header inside the signed and encrypted payload —
protocol version, sender id, recipient id, conversation or group id, and timestamp — and
verify it after decryption. This changes the wire format, so web and Android must ship
the change together. Coordinate before implementing.

## 2. No forward secrecy

Every message uses the account's long-term X25519 keypair. Compromise of one private key
decrypts all history that the server still holds. There is no ratchet in the live path.

`client/lib/protocol.ts` and `client/lib/protocolSessions.ts` look like a solution but are
not: they perform a single DH against a long-lived prekey, cache the result forever, then
use `secretbox` per message. No ephemeral keys, no chain keys, no ratchet step. See also §4.

## 3. No key verification, so the server can impersonate

Recipient public keys are fetched from the server and used with no fingerprint check, no
safety-number comparison, and no warning when a contact's key changes. A malicious or
compromised server can hand out substituted keys and read everything.

This is the weakest link in the current design. An Android client is a good place to fix
it: display a fingerprint derived from both parties' public keys, and pin the key you
first saw, warning on change.

## 4. Large parts of the codebase are dead — do not build against them

Verified by repo-wide grep for callers:

| Area | Status |
|---|---|
| `server/routes/messages-v2.ts`, `client/lib/directMessageV2.ts` | Fully implemented server-side, **never called**. `getDirectMessageV2ReadinessForUsername` hardcodes `mode: "v1"` with `reason: "device_session_crypto_not_implemented"` (`client/lib/directMessageV2.ts:113`). The `direct_messages_v2` table has 0 rows in production. |
| `client/lib/protocolSessions.ts` | Zero importers. Prekey bundles *are* published, but nothing encrypts with them. |
| `server/routes/devices.ts` history-key endpoints | Complete server side, no client calls them. `device_wrapped_history_keys` is empty. |
| `client/lib/messageApi.ts` | Zero importers — `Chat.tsx` inlines its own `fetch` calls. |
| `client/pages/Index.tsx` | Unreachable scaffold page. |

Use the v1 path documented in `ANDROID_INTEGRATION.md`. If you want the v2 path revived,
treat it as a project with its own design review, not as existing functionality.

Additionally, `decryptProtocolEnvelope` never verifies `envelope.signature`
(`client/lib/protocolSessions.ts:349-375`), and `server/routes/protocol.ts:95-101`
validates prekey signature *length* without verifying the signature. If v2 is ever wired
up, both must be fixed first.

## 5. Per-IP rate limits can be bypassed with a spoofed header — Reproduced

`server/lib/rate-limit.ts:19-45` trusts `cf-connecting-ip`, then `x-real-ip`, then
`x-forwarded-for`, ahead of the real socket address and without consulting Express's
`trust proxy` setting.

Demonstrated against a local instance: a fixed source was blocked on request 4, while
rotating `X-Forwarded-For` gave 0 blocks out of 20. Rotating `CF-Connecting-IP` was the
same.

In the current deployment Cloudflare sets `cf-connecting-ip` and strips client-supplied
copies, so the live origin is protected in practice. The origin has no defence of its own,
which matters if it is ever reachable another way or fronted by a different proxy.

Related, lower severity: the authenticated rate-limit identity is derived from the session
token, so limits scale with the number of sessions a user holds rather than per account.

## 6. Duplicate message history when PostgreSQL is unavailable — Reproduced

`server/routes/messages.ts:747` deduplicates the file-store path by message UUID only,
but in-memory copies are registered under a synthetic `timestamp-senderId` key and carry
no UUID (`server/index.ts:1162` stores the envelope without the id). Every message still
in the memory cache is therefore returned twice.

Demonstrated: two messages sent, four returned, two distinct ciphertexts.

Not active in production, because the PostgreSQL path deduplicates correctly and gates the
file path off (`messages.ts:680`). It appears during a database outage. An Android client
should deduplicate on server message id defensively.

Same mode, related: unread counts are only computed when the database is connected
(`messages.ts:967`), so in file-only mode every conversation silently reports 0 unread.

## 7. Credential storage weaknesses

- The recovery verifier is stored verbatim and compared for equality
  (`server/lib/auth-store.ts:213-249`, `server/routes/auth.ts:290-295`). It is a
  password-equivalent held in plaintext: any database or object-store read yields account
  takeover. It should be stored hashed.
- The legacy recovery branch compares with `===` rather than a constant-time comparison
  (`server/routes/auth.ts:300`).
- Admin panel passwords are a single unsalted SHA-256 with an optional pepper
  (`server/lib/admin-panel-store.ts:264-269`). Crackable offline at GPU speed if the
  config leaks. Should be scrypt or argon2.
- `validateAdminSession` still accepts unhashed legacy session keys
  (`admin-panel-store.ts:516-527`).

## 8. Cryptographic hygiene

- **Cross-primitive key reuse.** The 32-byte X25519 secret is reused as the Ed25519 seed
  (`client/lib/crypto.ts:46-48`). Unsound in principle; documented in
  `ANDROID_INTEGRATION.md` §2.1 because clients must reproduce it. Changing it is an
  account-format migration.
- **Truncated identifiers.** User ids are 64 bits of SHA-256 (`client/lib/crypto.ts:77`).
  Birthday collisions become plausible around 4 billion accounts, but the truncation also
  weakens any assumption that a user id is a unique commitment to a key.
- **`Math.random()` for prekey ids** (`client/lib/protocol.ts:59-61`). Not key material,
  but ids collide and `findLocalPreKeyForEnvelope` selects by id.
- **Dead compatibility fallbacks** verify Ed25519 signatures with an X25519 key when the
  signing key is absent (`client/lib/crypto.ts:282-283` and callers). These can never
  succeed; they fail closed but silently drop messages
  (`client/pages/GroupChat.tsx:484-486`).
- **Unawaited key deletion.** `clearKeyPair` and `clearMnemonic` call
  `void browserStorage.removeItem(...)` (`client/lib/crypto.ts:444`, `:465`), so failures
  to erase key material go unobserved.

## 9. Endpoint and routing defects

- `POST /api/protocol/consume/:userId` and `GET /api/protocol/bundles/:userId` treat the
  session as optional (`server/routes/protocol.ts:215,258`), so anyone can enumerate
  device bundles and drain another account's one-time prekeys.
- `POST /api/protocol/consume/by-username/:username` is registered after
  `POST /api/protocol/consume/:userId/:deviceId` (`server/index.ts:459,464`) and is
  therefore unreachable — requests bind `userId="by-username"`.
- `GET /api/auth/recovery-params/by-username/:username` is unauthenticated and unthrottled,
  so it confirms account existence and leaks KDF parameters.
- WebSocket upgrades complete the handshake before the ticket is validated, then close
  with 4002. Harmless but wasteful.
- The dev server (`vite.config.ts:63`) performs no `Origin` check on upgrades, while
  production does (`server/node-build.ts:39-49`) but accepts upgrades on any path.

## 10. Operational notes

- **`pnpm test` in a production checkout writes to production.** `server/index.ts:8-21`
  calls `dotenv.config({ override: true })` at import time, which overrides the isolation
  `server/integration.spec.ts` sets up — verified: `LOCAL_STORAGE_DIR` reverts to
  `server/data` and `ENABLE_POSTGRES_STORAGE` to `true`. Run the suite from a copy, or skip
  the dotenv load when `NODE_ENV === "test"`.
- **`.env` was committed to the original public repository.** The historical Supabase
  connection string and an old R2 key pair remain in that history. Those credentials have
  since been rotated. This repository starts with no history and no `.env`; keep it that
  way.
- **TypeScript is configured loosely** — `strict: false`, `strictNullChecks: false`
  (`tsconfig.json`). A clean `pnpm typecheck` is therefore a weaker signal than it looks.

## What is genuinely solid

For balance, these were tested and hold up:

- Messages are encrypted before they leave the device. Verified that no plaintext appears
  in the server's storage tree or logs, and that the server stores only the envelope.
- Signature verification is enforced on both the server and the receiving client, and
  fails closed.
- Sender-id spoofing is blocked on both HTTP and WebSocket.
- WebSocket tickets are single-use and short-lived.
- Group membership is enforced cryptographically for new messages and by authorization for
  stored ones; a removed member cannot read new traffic.
- Media is encrypted per file with a fresh key that never reaches the server.
- Private keys leave the device only wrapped under a passphrase-derived key.
- Ownership checks on user-owned resources were reviewed handler by handler and no IDOR was
  found.

