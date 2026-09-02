# Messaging System Security Audit Report

## CRITICAL FINDINGS

### 1. ENCRYPTION KEY USAGE - FUNDAMENTAL FLAW

**Status: CRITICAL**
**Location:** `client/pages/Chat.tsx:73-84` and `decryptMessage()` in `client/lib/crypto.ts:261-296`

**Issue:**

- When decrypting messages received from another user, the client uses the **recipient's public key** (not the sender's):

  ```typescript
  const senderPublicKey =
    encMsg.senderId === userId
      ? pubKeyData.publicKey // WRONG: This is recipient's key, not sender's
      : pubKeyData.publicKey; // WRONG: Still using recipient's key
  ```

- **NaCl box.open() requires**: `nacl.box.open(ciphertext, nonce, senderPublicKey, recipientPrivateKey)`
  - `senderPublicKey`: Must be the actual sender's public key
  - `recipientPrivateKey`: The receiver's private key
- **Current implementation always uses recipientPublicKey** even when the message is from the other party

**Impact:**

- Cannot decrypt messages from other users (decryption will always fail)
- Only own messages decrypt successfully (sender=receiver scenario)
- End-to-end encryption completely broken for two-party chat

---

### 2. SENDER AUTHENTICATION - MISSING ENTIRELY

**Status: CRITICAL**
**Location:** `server/index.ts:136-179` and `client/pages/Chat.tsx`

**Issue:**

- Server only validates that `encryptedMessage.senderId === authenticatedUserId` (line 155)
- Server does NOT verify message authenticity or prevent tampering
- No signature verification on messages
- Message can be modified in transit (nonce, ciphertext) without detection
- Client accepts any message from WebSocket without sender verification

**Impact:**

- Man-in-the-middle can forge messages
- Server cannot ensure message integrity
- No proof that message came from claimed sender

---

### 3. SESSION HANDLING - CRITICAL GAPS

**Status: CRITICAL**
**Location:** `client/pages/Chat.tsx:40-51`

**Issue:**

- Session validation happens only once during component mount
- Private key is retrieved from localStorage repeatedly (no session-bound key management)
- No session token validation before message operations
- Session expiration not checked before encryption/decryption
- If session expires mid-chat, messages still sent without validation

**Impact:**

- Stale sessions can send messages
- No continuous session validation
- Private key accessible even if session invalid

---

### 4. RECIPIENT PUBLIC KEY RETRIEVAL - RACE CONDITION

**Status: HIGH**
**Location:** `client/pages/Chat.tsx:67-70` and `71-81`

**Issue:**

- Recipient's public key fetched from server during conversation load
- No caching or validation of retrieved key
- If key changes on server, client won't know
- Sender could use wrong key if key changed between load and send

**Impact:**

- Message encrypted to wrong recipient in race conditions
- No key continuity verification

---

### 5. NONCE REUSE VULNERABILITY

**Status: HIGH**
**Location:** `client/lib/crypto.ts:238` and server storage

**Issue:**

- Each encryption generates random nonce (good)
- BUT: Nonce stored alongside ciphertext in plaintext
- Same sender+recipient pair could generate same nonce if system time repeats
- No per-message uniqueness guarantee
- Old messages with same nonce can reveal patterns

**Impact:**

- Theoretical nonce collision possible
- Plaintext metadata leaks (can see who talks to whom, message timing)

---

### 6. MESSAGE PERSISTENCE - UNENCRYPTED

**Status: CRITICAL**
**Location:** `server/routes/messages.ts:47-63`

**Issue:**

- Messages stored in in-memory map AND R2 storage
- Stored as: `{ nonce, ciphertext, senderId, recipientId, timestamp }`
- Metadata in plaintext: who talks to whom, when
- Server admin can see all conversations (metadata + timing)
- No protection of message metadata

**Impact:**

- Conversation metadata visible to server
- Traffic analysis attacks possible
- Server compromise exposes all conversation patterns

---

### 7. MISSING SENDER IDENTITY IN DECRYPTION

**Status: CRITICAL**
**Location:** `client/pages/Chat.tsx:73-84`, `105-108`

**Issue:**

- When loading history, code tries to determine sender's public key:

  ```typescript
  const senderPublicKey =
    encMsg.senderId === userId
      ? pubKeyData.publicKey // Wrong - pubKeyData is RECIPIENT's key
      : pubKeyData.publicKey; // Wrong - still recipient's key
  ```

- For messages from other user, should fetch THAT user's public key
- Currently fetches in some cases (line 82-87) but uses wrong variable

**Impact:**

- All decryption fails
- Cannot verify message origin

---

### 8. NO MESSAGE SIGNATURE

**Status: CRITICAL**
**Location:** Entire codebase

**Issue:**

- Messages have no cryptographic signature
- Server cannot verify sender identity
- Client cannot verify sender identity
- Message integrity cannot be verified
- Attacker with server access can modify messages

**Impact:**

- No authenticity guarantee
- No integrity guarantee
- Receiver cannot prove who sent a message

---

### 9. PRIVATE KEY EXPOSURE DURING SESSION

**Status: HIGH**
**Location:** `client/lib/useWebSocket.ts` and `client/pages/Chat.tsx`

**Issue:**

- Private key retrieved from localStorage on every message operation
- Stored as plaintext in localStorage (despite comments suggesting encrypted IndexedDB)
- Private key in memory during entire chat session
- No key lifecycle management

**Impact:**

- XSS can steal private key
- Browser dev tools can access key
- Session compromise = key compromise

---

### 10. INCOMPLETE MESSAGE DECRYPTION ERROR HANDLING

**Status: MEDIUM**
**Location:** `client/pages/Chat.tsx:76-100`

**Issue:**

- When decryption fails, message is silently skipped (line 99)
- No retry mechanism
- User doesn't know message failed to decrypt
- No logging of decryption failures

**Impact:**

- Silent message loss
- User unaware of problems
- Cannot debug crypto issues

---

## SUMMARY TABLE

| Issue                                   | Component               | Severity | Status     |
| --------------------------------------- | ----------------------- | -------- | ---------- |
| Wrong public key in decryption          | Chat.tsx, crypto.ts     | CRITICAL | Broken     |
| No message signature                    | All                     | CRITICAL | Missing    |
| No sender authentication                | Server WS               | CRITICAL | Missing    |
| Message metadata plaintext              | R2 storage              | CRITICAL | Vulnerable |
| Session not continuously validated      | Chat.tsx                | CRITICAL | Incomplete |
| Sender public key not fetched correctly | Chat.tsx                | CRITICAL | Bug        |
| Private key in localStorage             | useWebSocket, crypto.ts | HIGH     | Insecure   |
| Nonce stored plaintext                  | Server                  | HIGH     | Exposed    |
| Race condition on key fetch             | Chat.tsx                | HIGH     | Possible   |
| Silent decryption failures              | Chat.tsx                | MEDIUM   | Unhelpful  |

## REQUIRED FIXES (In Order of Priority)

1. **FIX RECIPIENT PUBLIC KEY LOOKUP** - Fetch sender's public key (not recipient's) when decrypting
2. **ADD MESSAGE SIGNATURES** - Sign every message with sender's private key
3. **VERIFY SENDER AUTHENTICITY** - Both client and server verify signatures
4. **VALIDATE SESSION CONTINUOUSLY** - Check session before every operation
5. **FETCH SENDER'S PUBLIC KEY** - Lookup sender's actual public key, not recipient's
6. **ADD KEY DERIVATION** - Derive message signing key from session authentication
7. **PROTECT METADATA** - Minimize plaintext metadata in storage
8. **SECURE PRIVATE KEY** - Move from localStorage to encrypted IndexedDB
9. **ADD DECRYPTION ERROR REPORTING** - Notify user of decryption failures

## CONCLUSION

The current implementation has **fundamental encryption flaws** that prevent messages from being decrypted correctly. Additionally, the **lack of message signatures** means there is no way to verify sender identity or message integrity. These are non-negotiable security requirements that must be fixed before the system can be considered secure.

The system is currently **NOT PRODUCTION READY**.
