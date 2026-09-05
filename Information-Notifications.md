# Notifications — everything the app build needs to know

Voltex delivers notifications without Firebase, without FCM, without Google, and without
any hosted third party. The transport is a **self-hosted ntfy instance** on the same VPS as
the API, reached through **UnifiedPush**. This document is the complete contract for the
client side; it is self-contained, so it can be handed to a code generator on its own.

Server implementation, if you want to read it: `server/lib/push-notifications.ts`,
`server/lib/push-store.ts`, `server/routes/push.ts`.

---

## 1. The one rule

**A wake-up carries no information.** The published body is the fixed ASCII constant `1`.
There is no ciphertext, no message id, no sender user id, no username, no display name, no
group id, no group name, no unread count, and no per-conversation topic. The only thing a
wake-up may ever imply is:

> *this device should reconnect and fetch.*

Everything the user sees — who sent it, what it says, which conversation — is decrypted and
composed **on the phone**, after the app reconnects over its own pinned TLS connection.

This is not a stylistic preference. The reason for not using FCM is to avoid handing anyone
the social graph, and a wake-up that leaked "user A messaged user B at 14:32" would give
away exactly that. The server has a test whose only job is to assert the payload contains
none of those fields (`server/lib/push-notifications.spec.ts`, "wake-up payload leaks
nothing"). **Write the mirror of that test in the app.** If either test ever needs
relaxing, the design has regressed.

---

## 2. How the pieces fit

```
  Alice sends a message
          │
          ▼
  Voltex API  ──► is Bob's WebSocket open?
                        │
              yes ──────┴────── no
               │                 │
        deliver over WS     POST https://push.voltexchat.online/<topic>?up=1
        (no wake-up sent)   body: "1"      (write-only token, server-side only)
                                  │
                                  ▼
                        self-hosted ntfy ──► UnifiedPush distributor on the phone
                                                        │
                                                        ▼
                                            Voltex app wakes, opens its socket,
                                            fetches envelopes, decrypts locally,
                                            builds the notification text itself
```

A device with a live socket is **never** woken — the server only reaches the push path when
delivery failed because nothing was connected. The sending device is always excluded, so
your own message never wakes your own phone.

---

## 3. Server endpoints

Base URL `https://voltexchat.online`. Both endpoints need a normal Voltex session.

### POST /api/push/register

Registers the calling session's device. Idempotent — the same device keeps the same topic
across calls.

**Headers**

```
Authorization: Bearer <sessionToken>     required
Content-Type: application/json           required when a body is sent
```

**Body** — both forms are accepted:

```json
{}
```
```json
{ "endpoint": "https://push.voltexchat.online/<topic>" }
```

Send `endpoint` when the UnifiedPush distributor has already allocated one — the server
adopts its topic after checking the URL's scheme and host match its own push host. Send
`{}` to have the server allocate a fresh random topic instead.

The device is always taken from the **session**, never from the body. You cannot register on
behalf of another device, and you do not send a device id.

**200**

```json
{
  "success": true,
  "deviceId": "e0f3dc0ffa711acb60ceda17",
  "topic": "9f2c4b7a1d0e5638ac91bd7042e6f315",
  "baseUrl": "https://push.voltexchat.online",
  "endpoint": "https://push.voltexchat.online/9f2c4b7a1d0e5638ac91bd7042e6f315",
  "subscribeToken": "tk_…",
  "createdAt": 1788583593000
}
```

`subscribeToken` is a **read-only** ntfy credential. The instance is configured deny-all, so
subscribing without it returns 403. It cannot publish.

**Errors**

| Status | Body | Meaning |
|---|---|---|
| 400 | `{"error":"endpoint must be a UnifiedPush endpoint on this server's push host"}` | Endpoint host/scheme mismatch or malformed topic |
| 401 | `{"error":"Authentication required"}` | No bearer token |
| 401 | `{"error":"Invalid or expired session"}` | Expired or unknown session |
| 401 | `{"error":"Current session is missing a device binding"}` | Session predates device binding — re-authenticate |
| 429 | `{"error":"Too many profile updates…","retryAfter":<seconds>}` | 10 per minute per identity |
| 503 | `{"error":"Push wake-ups are not configured on this server"}` | Transport not configured; run without push |
| 500 | `{"error":"Failed to register for push"}` | Unexpected |

### DELETE /api/push/register

Removes the registration for the calling session's device. No body.

```json
{ "success": true, "removed": true }
```

`removed` is `false` when there was nothing to remove. Same 401 / 429 / 500 shapes.

---

## 4. Topic format

32 lowercase hex characters — 128 bits from a CSPRNG. It is **not** derived from the user
id, username or device id, and it is globally unique. One topic per **device**. Never one
per conversation: a per-conversation topic would leak which conversation was active.

Treat the topic as a secret. It is only ever sent to the device it belongs to.

---

## 5. What actually arrives

The server publishes:

```
POST https://push.voltexchat.online/<topic>?up=1
Authorization: Bearer <write-only token — never leaves the server>
Content-Type: text/plain
Cache: no
Firebase: no

1
```

No title, no tags, no priority, no click action, no actions, no attachment. `Cache: no`
plus a server-side `cache-duration: 0` means nothing is retained on disk anywhere. The
instance has no `upstream-base-url` and no `firebase-key-file`, so nothing is ever forwarded
to ntfy.sh, APNs or FCM.

---

## 6. Client integration (Flutter)

```yaml
dependencies:
  unifiedpush: ^6.2.0        # official UnifiedPush Flutter connector
  # unifiedpush_ui           # optional distributor-picker dialog
  flutter_local_notifications: ^17.0.0   # or your preferred local notifier
  flutter_secure_storage: ^9.0.0
```

The whole API is static methods on `UnifiedPush`. Register the handlers once at startup:

```dart
await UnifiedPush.initialize(
  onNewEndpoint: (PushEndpoint endpoint, String instance) async {
    // Send endpoint.url to POST /api/push/register, then persist the returned
    // topic, baseUrl and subscribeToken.
  },
  onMessage: (PushMessage message, String instance) async {
    // DO NOT read message. See §7. Just wake, reconnect and fetch.
  },
  onRegistrationFailed: (FailedReason reason, String instance) { /* log, retry later */ },
  onUnregistered: (String instance) { /* clear local push state */ },
  onTempUnavailable: (String instance) { /* distributor temporarily down */ },
);
```

Distributor selection, then registration:

```dart
if (await UnifiedPush.getDistributor() == null) {
  final available = await UnifiedPush.getDistributors();
  // Let the user choose; ntfy is the expected one.
  await UnifiedPush.saveDistributor(chosen);
}
await UnifiedPush.register();   // must be called on EVERY app start
```

`register()` has to run at every launch with the same distributor and instance — that is the
documented contract of the connector, not an optimisation.

### The distributor the user needs

The ntfy Android app, pointed at **your** server, not ntfy.sh:

1. Install ntfy for Android (F-Droid or Play).
2. Settings → **Default server** → `https://push.voltexchat.online`.
3. Settings → add the **read-only** credentials for that server, using the
   `subscribeToken` your API returned. The instance is deny-all; without a token every
   subscribe attempt is 403 and no notification will ever arrive.
4. Settings → **UnifiedPush** enabled.

Ship an in-app onboarding screen that walks the user through this. It is the single most
likely place for a real user to end up with silent notifications, and "it just doesn't
notify" is impossible to diagnose from the server side.

If no distributor is installed, the app must still work — it simply only receives while it
is running and has a socket. Say so in the UI rather than failing silently.

---

## 7. Never parse the payload — this is also your compatibility escape hatch

UnifiedPush 3.x can negotiate RFC 8291 Web Push encryption between the distributor and the
app. Our wake-up is deliberately plain text, so depending on the negotiated features the
connector may hand you a body you cannot decrypt, or an empty one.

**That does not matter, and you must not depend on the body at all.** The correct rule:

> Any push delivered on this endpoint — decryptable or not, empty or not — means
> "reconnect and fetch". Ignore `message` entirely.

Implementing it that way makes the app immune to distributor and connector version drift,
and it is the only interpretation consistent with §1.

If a connector version refuses to deliver an undecryptable message at all, the fallback is
to subscribe to `{baseUrl}/{topic}` directly over ntfy's own protocol with the
`subscribeToken` and treat each frame the same way. Raise it with the server team before
choosing that path so both sides stay in step.

---

## 8. What to do when woken

The app process may be dead. The wake-up gives you a short window; use it deliberately.

1. **Do not** try to render anything from the push.
2. Read the session token from secure storage. If absent or expired, stop — do not notify.
3. Open the WebSocket: `POST /api/auth/ws-ticket` for a fresh single-use 60-second ticket,
   then connect to `wss://voltexchat.online/ws?ticket=<ticket>`. Queued messages are pushed
   immediately on connect.
4. As a belt-and-braces path (and if the socket fails), fetch
   `GET /api/messages/conversations` and any changed threads over HTTP.
5. Verify each envelope's signature, then decrypt locally. **Never display a message whose
   signature fails.**
6. Compose the notification text on the device from the decrypted content, and post it with
   your local notifier. Group by conversation, and collapse multiples rather than stacking
   dozens.
7. Update the unread badge from local state, not from anything the push said.

Do the work off the UI isolate, and keep it short — Android will not let a background wake
run indefinitely. If the fetch cannot finish, post nothing rather than a placeholder like
"New message" that later turns out to be wrong.

Battery and Doze: wake-ups arrive over the distributor's own long-lived connection, so you
do not need your own foreground service to receive them. You may need a brief foreground
service to finish the fetch on some OEM builds. Do not add a permanent foreground
notification unless a real device forces you to.

---

## 9. Lifecycle

| Event | What the app must do |
|---|---|
| First sign-in | Pick a distributor, `register()`, then `POST /api/push/register` with the endpoint |
| Every app start | `register()` again with the same distributor and instance |
| `onNewEndpoint` fires | `POST /api/push/register` with the new endpoint; the server replaces the stored topic |
| Sign-out | `DELETE /api/push/register`, then `UnifiedPush.unregister()`, then wipe local push state |
| Session revoked from another device | Server already deleted the registration; on the next 401 clear local state and stop |
| User uninstalls the distributor | Registration goes stale; the server prunes it when the transport reports 404/410 |
| Push not configured on the server (503) | Run without push. Do not retry in a loop |

Revocation matters on the server side too: revoking a device from the account's Devices list
calls `deletePushRegistrationsForDevice`, so a revoked device loses the ability to be woken
at the same moment it loses the ability to read.

---

## 10. Reliability — what the server guarantees, and what it does not

**Guaranteed:**

- A device with a live socket is never woken.
- The sending device is never woken by its own message.
- One wake-up per device per **15 seconds**. Ten messages arriving in a burst produce one
  wake-up, not ten. Do not expect a wake-up per message, ever.
- Wake-ups on both the direct-message path and the group-message and group-invite paths.

**Not guaranteed:**

- Delivery. The server makes **one** publish attempt with a 5-second timeout and never
  retries. A wake-up is a hint; if it is lost, nothing is lost permanently because the app
  reconciles on its next reconnect.
- Ordering, or any relationship between the number of wake-ups and the number of messages.

So: always reconcile fully on reconnect and on app foreground. Never treat "no wake-up
arrived" as "no new messages", and never treat "one wake-up" as "exactly one message".

---

## 11. Failure modes you will actually hit

| Symptom | Cause | Fix |
|---|---|---|
| Subscribe returns 403 | No `subscribeToken` in the ntfy app, or wrong server | Configure the read-only credentials for `push.voltexchat.online` |
| `push.voltexchat.online` does not resolve | Public hostname not yet routed through the tunnel | Server-side prerequisite; ask the operator |
| Register returns 401 "missing a device binding" | Old session from before device binding | Re-authenticate |
| Register returns 503 | Transport not configured on that deployment | Run without push; do not loop |
| Register returns 400 on endpoint | Distributor is pointed at ntfy.sh, not this server | Change the default server in the ntfy app |
| Wake-ups arrive but nothing shows | App is parsing the payload | Ignore the payload; reconnect and fetch (§7) |
| Only one notification for many messages | Coalescing, working as designed | Fetch all pending, group locally |
| Nothing arrives while the app is open | Correct — the socket delivered it | Not a bug |

---

## 12. Testing checklist

Do these on a real device, not an emulator, and at least once with the app force-stopped.

1. Register, and confirm the returned `topic` matches `^[0-9a-f]{32}$` and contains neither
   your user id nor your device id.
2. Register twice and confirm the topic is unchanged.
3. Force-stop the app. Have another account send a message. Confirm a notification appears
   with the correct sender and text — both composed locally.
4. Send ten messages in five seconds. Confirm **one** wake-up and that all ten messages are
   present after the fetch.
5. With the app open and connected, send a message. Confirm no wake-up is published (watch
   the ntfy app's own log or the endpoint) and the message arrives over the socket.
6. Send yourself a message from the same account on another device. Confirm the sending
   device is not woken.
7. Sign out, then have someone message you. Confirm no notification.
8. Revoke the device from Account → Devices on another device, then message it. Confirm no
   notification.
9. Airplane mode for two minutes while messages arrive, then reconnect. Confirm everything
   is reconciled and no message is missing.
10. **The contract test.** Capture whatever the app receives on the endpoint and assert it
    contains no sender id, username, display name, group id, group name, ciphertext or
    message id, and that the body is either the constant `1`, empty, or undecryptable. This
    mirrors the server's test and is the feature's contract.

---

## 13. Anti-requirements — things that must never happen

- **No Firebase, FCM, Google Play Services messaging, or any hosted push service.** Not as a
  fallback, not "just for Android without a distributor", not behind a flag. Adding an
  embedded FCM distributor would defeat the entire design.
- **No content in the push.** Never ask the server for it. If you find yourself wanting the
  sender's name in the payload to make the UX nicer, that is exactly the thing this design
  refuses.
- **No per-conversation or per-sender topics.** One topic per device.
- **No logging of the session token, the identity key, decrypted content, or the topic** —
  not in release, not truncated, not in crash reports.
- **No third-party analytics or crash reporter that could see notification text.**
- **No notification content on the lock screen by default.** Offer it as a setting; default
  to a sender-only or fully generic preview.
- **Do not weaken the signature check** to make a notification appear. Fail closed.

---

## 14. Operational facts

- Push host: `https://push.voltexchat.online` — a reverse proxy in front of ntfy, which
  itself listens only on `127.0.0.1:2586` and is not reachable directly.
- ntfy is configured `auth-default-access: deny-all`. Two identities exist: a **write-only**
  token held solely by the API server, and a **read-only** token handed to devices as
  `subscribeToken`. Anonymous access has no permissions at all.
- `cache-duration: 0`, no cache file, attachments disabled, no upstream, no Firebase key.
  Nothing is retained.
- Wake-up publishes carry `Cache: no` and `Firebase: no` per message as well.
- Server env vars: `NTFY_BASE_URL`, `NTFY_INTERNAL_URL`, `NTFY_PUBLISH_TOKEN`,
  `NTFY_SUBSCRIBE_TOKEN`, `PUSH_WAKEUP_COALESCE_MS`. With them unset the feature is a silent
  no-op and the app must behave correctly in that case.

One residual weakness, stated plainly: `subscribeToken` is shared across devices, so a
holder who *also* learned another device's topic could subscribe to it. Topics are 128-bit
random and only ever sent to their owner, so it is not reachable in practice, but per-device
read tokens would close it properly. If the app team would rather have that, say so — it is
a server change, not a client one.

