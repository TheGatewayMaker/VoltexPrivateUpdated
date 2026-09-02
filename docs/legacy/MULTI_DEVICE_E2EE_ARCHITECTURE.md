# Voltex Multi-Device E2EE Architecture

## Goal

Add proper multi-device end-to-end encryption for Voltex while preserving:

- Existing accounts
- Existing web workflows
- Direct messages
- Group chats
- Images/media
- Delivery and seen receipts
- Pinned group messages
- Per-user hide/delete behavior
- Recovery and account continuity

Required product behavior:

- One user account can have multiple devices.
- Each device has its own cryptographic identity.
- The server stores ciphertext and metadata, but cannot read message content.
- A newly linked device must be able to decrypt old history.
- Existing features and UI workflows must continue working during migration.

## Current State

The current codebase already includes:

- User accounts with box and signing keys
- Per-user encrypted direct messages
- Per-user encrypted group envelopes
- Device bundle registration groundwork
- Encrypted keypair backup
- Encrypted image message support

Current limitations:

- Direct messages are modeled per user pair, not per device.
- Group message envelopes are modeled per user, not per device.
- Read/delivery state is tracked at user level.
- Protocol bundle APIs are not yet the source of truth for message fanout.
- Old history access for newly linked devices is not solved.

Relevant current files:

- [server/lib/db.ts](/home/neoroot/VOLTEX-ACTIVE/voltexsms/server/lib/db.ts:74)
- [server/lib/protocol-store.ts](/home/neoroot/VOLTEX-ACTIVE/voltexsms/server/lib/protocol-store.ts:17)
- [server/routes/messages.ts](/home/neoroot/VOLTEX-ACTIVE/voltexsms/server/routes/messages.ts:391)
- [server/routes/groups.ts](/home/neoroot/VOLTEX-ACTIVE/voltexsms/server/routes/groups.ts:740)
- [shared/groups.ts](/home/neoroot/VOLTEX-ACTIVE/voltexsms/shared/groups.ts:45)
- [server/routes/auth.ts](/home/neoroot/VOLTEX-ACTIVE/voltexsms/server/routes/auth.ts:866)

## Core Model

Voltex should move to this model:

- `user`
  - stable account identity
- `device`
  - one browser install, one Android app install, one iPhone install
- `device bundle`
  - public identity keys, signed prekey, one-time prekeys
- `canonical message`
  - one logical message record for ordering, deletion, and history
- `message envelope`
  - ciphertext for one specific target device
- `history master key`
  - account-level key used to unlock old history on newly linked devices
- `group sender key`
  - per-group content key for efficient multi-device group messaging

## Security Model

### Live Messaging

Live messaging remains device-to-device E2EE:

- The sending device fetches all recipient device bundles.
- It encrypts one envelope per recipient device.
- The server stores and routes those envelopes.
- The server cannot decrypt them.

### Old History For New Devices

To let a newly linked device decrypt old history without server plaintext access, Voltex needs a `History Master Key`.

Rules:

- Generated client-side.
- Never stored on the server in plaintext.
- Wrapped separately for each authorized device.
- Used to encrypt or unwrap conversation history keys and media history keys.
- Re-wrapped by an already-authorized device when a new device is linked.

Without this layer, proper multi-device E2EE and old-history access conflict.

### Media

Media remains encrypted client-side before upload:

- The media blob is encrypted with a random media key.
- The server stores only encrypted bytes.
- The media key is carried inside encrypted message/history payloads.
- Newly linked devices recover old media access through history-key-backed payload sync.

## Data Model

## Tables To Keep

Keep these current tables during migration:

- `user_accounts`
- `username_reservations`
- `recovery_secrets`
- `encrypted_keypairs`
- `auth_sessions`
- `user_profiles`
- `user_blocks`
- `protocol_device_bundles`

## Tables To Add

### `user_devices`

Tracks active and revoked devices.

Suggested columns:

- `user_id VARCHAR(255) NOT NULL`
- `device_id VARCHAR(255) NOT NULL`
- `device_name TEXT`
- `platform VARCHAR(64)`
- `app_kind VARCHAR(32)`
- `status VARCHAR(16) NOT NULL`
- `linked_at BIGINT NOT NULL`
- `revoked_at BIGINT`
- `last_seen_at BIGINT`
- `created_by_device_id VARCHAR(255)`
- `PRIMARY KEY (user_id, device_id)`

Status values:

- `active`
- `revoked`
- `pending_link`

### `direct_messages_v2`

Canonical direct message records.

Suggested columns:

- `id UUID PRIMARY KEY`
- `conversation_id VARCHAR(255) NOT NULL`
- `sender_user_id VARCHAR(255) NOT NULL`
- `sender_device_id VARCHAR(255) NOT NULL`
- `message_type VARCHAR(32) NOT NULL`
- `server_timestamp BIGINT NOT NULL`
- `client_timestamp BIGINT`
- `client_message_id TEXT`
- `deleted_for_everyone BOOLEAN DEFAULT FALSE`
- `deleted_at BIGINT`
- `deleted_by_user_id VARCHAR(255)`
- `created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`

Notes:

- This row contains metadata only.
- It does not store plaintext content.
- It can carry content classification like `text`, `image`, `system`, `gif`, `sticker`.

### `direct_message_device_envelopes`

One encrypted envelope per target device.

Suggested columns:

- `message_id UUID NOT NULL`
- `target_user_id VARCHAR(255) NOT NULL`
- `target_device_id VARCHAR(255) NOT NULL`
- `ciphertext TEXT NOT NULL`
- `nonce VARCHAR(64) NOT NULL`
- `signature VARCHAR(256) NOT NULL`
- `envelope_version VARCHAR(16) NOT NULL`
- `delivered_at BIGINT`
- `seen_at BIGINT`
- `PRIMARY KEY (message_id, target_device_id)`

Indexes:

- by `target_user_id, target_device_id, delivered_at`
- by `target_user_id, target_device_id, seen_at`
- by `message_id`

### `direct_message_visibility`

Per-user or per-device hiding state.

Suggested columns:

- `message_id UUID NOT NULL`
- `user_id VARCHAR(255) NOT NULL`
- `hidden_at BIGINT NOT NULL`
- `PRIMARY KEY (message_id, user_id)`

Optional later:

- Add `device_id` if hide-for-this-device becomes a product requirement.

### `account_history_keys`

Versioned account-level history metadata.

Suggested columns:

- `user_id VARCHAR(255) NOT NULL`
- `history_key_version INTEGER NOT NULL`
- `status VARCHAR(16) NOT NULL`
- `created_at BIGINT NOT NULL`
- `rotated_at BIGINT`
- `PRIMARY KEY (user_id, history_key_version)`

### `device_wrapped_history_keys`

One wrapped history key per authorized device.

Suggested columns:

- `user_id VARCHAR(255) NOT NULL`
- `history_key_version INTEGER NOT NULL`
- `device_id VARCHAR(255) NOT NULL`
- `wrapped_key TEXT NOT NULL`
- `wrapper_algorithm VARCHAR(32) NOT NULL`
- `created_at BIGINT NOT NULL`
- `PRIMARY KEY (user_id, history_key_version, device_id)`

### `group_messages_v2`

Canonical group message records.

Suggested columns:

- `id UUID PRIMARY KEY`
- `group_id VARCHAR(255) NOT NULL`
- `sender_user_id VARCHAR(255) NOT NULL`
- `sender_device_id VARCHAR(255) NOT NULL`
- `message_type VARCHAR(32) NOT NULL`
- `sender_key_epoch INTEGER`
- `server_timestamp BIGINT NOT NULL`
- `deleted_for_everyone BOOLEAN DEFAULT FALSE`
- `deleted_at BIGINT`
- `deleted_by_user_id VARCHAR(255)`
- `created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`

### `group_message_device_envelopes`

Per-device sender-key distribution and fallback envelopes.

Suggested columns:

- `message_id UUID NOT NULL`
- `group_id VARCHAR(255) NOT NULL`
- `target_user_id VARCHAR(255) NOT NULL`
- `target_device_id VARCHAR(255) NOT NULL`
- `ciphertext TEXT NOT NULL`
- `nonce VARCHAR(64) NOT NULL`
- `signature VARCHAR(256) NOT NULL`
- `envelope_kind VARCHAR(32) NOT NULL`
- `delivered_at BIGINT`
- `seen_at BIGINT`
- `PRIMARY KEY (message_id, target_device_id)`

### `group_sender_keys`

Tracks sender-key epochs by sender device.

Suggested columns:

- `group_id VARCHAR(255) NOT NULL`
- `sender_user_id VARCHAR(255) NOT NULL`
- `sender_device_id VARCHAR(255) NOT NULL`
- `epoch INTEGER NOT NULL`
- `status VARCHAR(16) NOT NULL`
- `created_at BIGINT NOT NULL`
- `rotated_at BIGINT`
- `PRIMARY KEY (group_id, sender_device_id, epoch)`

### `group_sender_key_device_distribution`

Tracks which devices received which sender key epoch.

Suggested columns:

- `group_id VARCHAR(255) NOT NULL`
- `sender_device_id VARCHAR(255) NOT NULL`
- `epoch INTEGER NOT NULL`
- `target_device_id VARCHAR(255) NOT NULL`
- `wrapped_sender_key TEXT NOT NULL`
- `created_at BIGINT NOT NULL`
- `PRIMARY KEY (group_id, sender_device_id, epoch, target_device_id)`

### `history_chunks`

Optional but recommended for efficient old-history sync.

Suggested columns:

- `id UUID PRIMARY KEY`
- `user_id VARCHAR(255) NOT NULL`
- `scope_type VARCHAR(16) NOT NULL`
- `scope_id VARCHAR(255) NOT NULL`
- `chunk_order INTEGER NOT NULL`
- `ciphertext TEXT NOT NULL`
- `nonce VARCHAR(64) NOT NULL`
- `history_key_version INTEGER NOT NULL`
- `created_at BIGINT NOT NULL`

This can represent:

- direct conversation history chunks
- group history chunks
- old media metadata chunks

## API Changes

All new APIs should be additive first.

## Auth And Device APIs

### Keep

- existing auth flows
- existing session flows
- existing recovery flows

### Add

#### `POST /api/devices/link/start`

Starts linking from an already-authorized device.

Returns:

- `linkId`
- `qrPayload`
- `expiresAt`

#### `POST /api/devices/link/complete`

Completes linking from a trusted device after verifying the new device bundle.

Request:

- `linkId`
- `newDeviceBundle`
- `wrappedHistoryKeys`
- optional bootstrap sync payload

#### `GET /api/devices`

Lists active devices for the current user.

#### `DELETE /api/devices/:deviceId`

Revokes a device.

Effects:

- mark revoked
- stop future message fanout
- rotate future group sender keys as needed
- optionally rotate history key for future content

## Protocol APIs

Current protocol routes should evolve like this:

- keep current single-bundle compatibility
- add multi-device listing

### `GET /api/protocol/bundles/:userId`

Returns all active device bundles for a user.

### `POST /api/protocol/bundles/consume`

Consumes one-time prekeys for multiple target devices in one request.

## Direct Message APIs

### Existing

Keep current `v1` direct message routes during transition.

### Add `v2`

#### `POST /api/messages/v2/send`

Request:

- canonical metadata
- list of per-device encrypted envelopes

Server responsibilities:

- validate session and device
- validate target devices
- verify signatures
- store canonical message
- store envelopes
- queue/deliver per target device

#### `GET /api/messages/v2/conversation/:conversationId`

Returns:

- canonical messages
- only envelopes for the current device
- aggregated user-facing receipt state

#### `PUT /api/messages/v2/conversation/:conversationId/read`

Marks visible envelopes as seen for the current device.

Server should aggregate to user-facing receipt summaries so existing UI semantics survive.

## Group APIs

### Existing

Keep current group routes.

### Add `v2`

#### `POST /api/groups/:groupId/messages/v2`

Request:

- canonical message metadata
- encrypted group content or sender-key payload
- sender-key distribution envelopes for recipient devices as needed

#### `GET /api/groups/:groupId/messages/v2`

Returns:

- canonical group messages
- current device envelopes
- aggregated receipt summaries
- pinned message payload resolved for current device

#### `PUT /api/groups/:groupId/read/v2`

Marks visible group messages as seen for current device.

## Message Semantics

## Direct Messages

For every direct message:

- sender device produces one envelope per recipient device
- sender device also stores self envelopes for sender-owned devices that should sync
- server stores one canonical message and many envelopes

### Delivery State

Track internally at device level:

- delivered to device
- seen by device

Aggregate for UI:

- delivered if any target device for that user got it
- seen if any target device for that user saw it

This preserves the current single-thread UX while supporting many devices.

## Group Messages

Use sender keys:

- content encrypted once per sender key epoch
- sender key distributed to all recipient devices
- recipient devices decrypt content locally

When group membership changes:

- rotate sender-key epochs where necessary
- new members do not automatically gain old sender keys unless policy allows it

## Old History Sync

This is mandatory for your product requirement.

Recommended model:

### History Master Key

Each account gets:

- `HMK v1`
- later rotations `HMK v2`, `HMK v3`, etc.

### History Access

Old history is exposed to newly linked devices by:

1. existing trusted device wraps current HMK for the new device
2. new device downloads encrypted history chunks
3. new device unwraps HMK locally
4. new device decrypts chunks and media metadata locally

### History Chunk Content

A chunk can contain:

- message IDs
- ciphertext blobs
- media message payloads
- sender metadata already known to the conversation

It must not contain plaintext on the server.

### Backfill Existing History

For v1 messages already stored:

- existing trusted device reads old message ciphertext and metadata
- builds encrypted history chunks under HMK
- uploads chunks to server

This is the safest way to preserve current history while moving to multi-device access.

## Media Model

Use this pattern:

- media blob encrypted with random media key
- encrypted blob uploaded to Voltex server
- message payload carries media descriptor and encrypted media key access
- history chunks also preserve media access descriptors

This ensures:

- existing image workflows survive
- new devices can open old images
- server still stores encrypted bytes only

## Device Linking Flow

Recommended flow:

1. Existing trusted device starts link.
2. New Android device generates device identity locally.
3. New device shows QR or short code.
4. Existing device verifies challenge.
5. Existing device authorizes new device and uploads:
   - wrapped HMK
   - optional current sender-key bootstrap material
6. Server activates the new device.
7. New device syncs encrypted history and message backlog.

Important rule:

- Never let the server generate or unwrap device private keys.

## Recovery Model

Current encrypted key backup should remain account recovery only.

For multi-device:

- account recovery restores account ownership
- it does not imply reusing one global device identity
- restored device should be treated as a newly authorized device unless exact-device restore is explicitly supported

Recommendation:

- keep `encrypted_keypairs` for transition
- later split backup into:
  - account identity recovery material
  - wrapped HMK recovery material
  - optional exact-device local backup

## Migration Strategy

Do not break existing clients.

## Phase 1: Device Awareness

- add `user_devices`
- bind auth sessions to a `device_id`
- expose `GET /api/devices`
- keep current message behavior unchanged

Success criteria:

- web still works unchanged
- devices can be listed and revoked

## Phase 2: Multi-Bundle Readiness

- expand protocol APIs to list all active device bundles
- keep current single-bundle endpoints for compatibility

Success criteria:

- Android client can fetch all device bundles for a recipient

## Phase 3: History Master Key

- define HMK format
- add history-key storage tables
- implement device wrapping for HMK
- add link flow endpoints

Success criteria:

- newly linked device can receive HMK

## Phase 4: Direct Message V2

- add `direct_messages_v2`
- add `direct_message_device_envelopes`
- dual-write from new clients
- dual-read in server response layer

Success criteria:

- Android can send and receive multi-device direct messages
- existing web direct messaging still works

## Phase 5: History Backfill

- existing trusted client builds encrypted history chunks
- upload them keyed by HMK

Success criteria:

- newly linked device decrypts old direct history

## Phase 6: Group Message V2

- add sender-key based group architecture
- keep current group UX and route contracts stable where possible
- aggregate receipts at user level for UI compatibility

Success criteria:

- Android can participate in multi-device groups
- web groups remain intact

## Phase 7: Media History Access

- ensure media descriptors are preserved in history chunks
- verify new devices can open old encrypted images

Success criteria:

- image messages remain E2EE and work across newly linked devices

## Phase 8: Gradual Web Migration

- move web client from v1 message model to v2
- keep compatibility reads until all active users are upgraded

Success criteria:

- old and new clients coexist without message loss

## Compatibility Rules

To avoid harming existing functionality:

- keep current route shapes where possible
- use additive `v2` routes instead of replacing `v1`
- do not change current message IDs in UI contracts unless aliased
- preserve current unread count behavior
- preserve current delete-for-self and delete-for-everyone behavior
- preserve current pinned message behavior
- preserve current media message payload shape at render layer
- preserve current group and conversation sort semantics

## Risks

### High Risk

- incorrectly modeling old-history access and weakening E2EE
- breaking direct-message receipt semantics during per-device migration
- group sender-key rollout causing missing messages for some devices

### Medium Risk

- dual-write divergence between v1 and v2
- incorrect backfill ordering
- device revocation without future-key rotation

### Low Risk

- additive device listing APIs
- additive bundle listing APIs

## Recommended Implementation Order

1. Add `user_devices` and device-bound sessions
2. Add multi-bundle listing API
3. Define HMK and wrapped key storage
4. Implement device linking
5. Implement direct-message v2 persistence and delivery
6. Implement history backfill
7. Implement group sender-key v2
8. Migrate web client incrementally

## Immediate Next Tasks

The next concrete implementation tasks in this repo should be:

1. Add `user_devices` table and migration in [server/lib/db.ts](/home/neoroot/VOLTEX-ACTIVE/voltexsms/server/lib/db.ts:70)
2. Extend auth session creation to include `device_id`
3. Add protocol route to list all active device bundles
4. Add a new shared type file for v2 device/message models
5. Create `messages-v2` storage layer alongside existing `db-messages`
6. Define HMK wrapping payload format and linking endpoints

## Non-Goals For First Android Release

These should not block the first Android release:

- per-device hide-for-me
- exact-device cryptographic restore
- cross-device draft sync
- message edit history

The priority is secure delivery, stable sync, old-history access, and feature parity with current web chat.
