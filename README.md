# Voltex — end-to-end encrypted messaging

Voltex is an end-to-end encrypted chat service. The web app in this repository is the
reference client and the server it talks to. This repository exists so a team can build a
native **Flutter** client that interoperates with the same accounts, the same messages and
the same encryption.

**Start here:** [`ANDROID_INTEGRATION.md`](./ANDROID_INTEGRATION.md) is the authoritative
specification — key generation, the message envelope, the HTTP API, the WebSocket
protocol, Dart package choices, interface parity with this web app, and the hardening
requirements. [`KNOWN_ISSUES.md`](./KNOWN_ISSUES.md) lists defects and dead code you must
know about before designing anything.

## The one thing that matters most

Messages are encrypted on the sending device and decrypted on the receiving device. The
server stores ciphertext and never holds a key that can read it. An Android client
therefore has to reproduce the cryptography **exactly** — same algorithms, same byte
layout, same encoding. A single mismatch means messages arrive and cannot be opened.

Two details in particular are non-obvious and easy to get wrong. Both are specified in
`ANDROID_INTEGRATION.md`:

1. The Ed25519 signing key is **derived from the X25519 encryption secret key**, not
   generated independently.
2. The user id is a **truncated** SHA-256 of the public key — first 16 hex characters.

## Layout

| Path | What it is |
|---|---|
| `client/` | React web client. `client/lib/crypto.ts` is the reference implementation of the encryption. |
| `server/` | Express + WebSocket server. `server/index.ts` registers every route. |
| `shared/` | Type definitions used by both sides. Treat these as the wire format contract. |
| `scripts/` | Operational scripts (data migration, restore, integrity repair). |
| `deploy/` | systemd units used in production. |
| `docs/legacy/` | Historical design notes. **Not authoritative** — some describe features that were never wired up. See `KNOWN_ISSUES.md`. |

## Running the web app locally

```bash
pnpm install
cp .env.example .env     # fill in the values you need
pnpm dev                 # http://localhost:8080
```

`pnpm test` runs the test suite. `pnpm typecheck` type checks. `pnpm build` produces
`dist/spa` (client) and `dist/server` (server bundle); `pnpm start` serves the built app.

The server works without PostgreSQL — it falls back to a local file store — but several
features degrade in that mode, listed in `KNOWN_ISSUES.md`.

## Configuration

All configuration is environment variables; see `.env.example` for the full list. No
secrets are committed to this repository. The important ones:

- `DATABASE_URL` — PostgreSQL connection string. Primary store for messages and accounts.
- `ALLOWED_ORIGINS` — comma-separated list of origins allowed to call the API.
- `PUBLIC_APP_ORIGIN` — canonical public origin.
- `ADMIN_PANEL_*` — admin console credentials. The console path is defined in
  `client/lib/adminPanel.ts`; treat that path as sensitive.

## Security expectations for contributors

Never commit `.env`. Never log plaintext message content, private keys or session
tokens. Keep the encryption boundary where it is: if you find yourself needing the
server to read a message body, the design has gone wrong.
