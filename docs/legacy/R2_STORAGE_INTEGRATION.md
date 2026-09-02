# Cloudflare R2 Storage Integration Guide

## Overview

Voltex now stores all critical application data in Cloudflare R2 Storage, ensuring persistence and security across server restarts and deployments.

## Configured Environment Variables

The following R2 credentials have been configured in your deployment:

```
R2_API_TOKEN=eeG_vJQ0TUZScCQ4tjRUDX4CqyZ1Z793FzfgTLHa
R2_ACCESS_KEY_ID=cdcc5e5d5e0052ec81fa61ebf1e55581
R2_SECRET_ACCESS_KEY=6de40255da692165151bbfbf0ae17100a5ccfada390f74555ba587d6ca0ca4d7
R2_ENDPOINT_URL=https://692721994bc25d00006b205c4b487e7f.r2.cloudflarestorage.com
```

## R2 Buckets Structure

### 1. **voltex-users** Bucket

Stores all user-related data with the following structure:

```
voltex-users/
├── accounts/{userId}.json          # User account metadata
├── profiles/{userId}.json          # User profile information
└── avatars/{userId}.jpg            # User profile pictures
```

**Data stored in accounts:**

- userId (derived from public key)
- publicKey (cryptographic public key)
- createdAt (account creation timestamp)
- updatedAt (last update timestamp)

**Data stored in profiles:**

- userId
- publicKey
- displayName
- bio
- avatar
- notifications (boolean)
- theme (light/dark/system)
- privacy (public/friends/private)
- createdAt
- updatedAt

### 2. **voltex-recovery** Bucket

Stores account recovery data for passphrase-based restoration:

```
voltex-recovery/
└── {userId}/
    └── passphrase.json             # Hashed recovery passphrase
```

**Data stored:**

- userId
- passphraseHash (SHA-256 hash)
- createdAt

### 3. **voltex-messages** Bucket

Stores encrypted messages with metadata:

```
voltex-messages/
└── conversations/{sortedUserIds}/
    └── {messageId}.json            # Individual message data
```

**Data stored for each message:**

- messageId (UUID)
- senderId
- recipientId
- nonce (encryption nonce)
- ciphertext (encrypted message)
- createdAt (message timestamp)
- updatedAt (storage timestamp)

## Data Flow

### User Registration Flow

1. **Client Side:**
   - User enters display name
   - Generate cryptographic key pair locally
   - Generate 24-word mnemonic passphrase
   - Hash the passphrase using SHA-256
   - Derive User ID from public key

2. **Server Side (POST /api/auth/register):**
   - Verify public key format
   - Derive userId from public key
   - Save UserAccount to R2 (voltex-users/accounts/{userId}.json)
   - Save Passphrase Hash to R2 (voltex-recovery/{userId}/passphrase.json)
   - Return userId to client

3. **Client Side:**
   - Store key pair in localStorage (device-specific)
   - Store mnemonic passphrase locally
   - Proceed to authentication challenge

### Profile Update Flow

1. **Client Side (PUT /api/profile/me):**
   - Send display name, bio, and other profile data
   - Include session token in Authorization header

2. **Server Side:**
   - Verify session token
   - Merge new data with existing profile
   - Save updated profile to R2 (voltex-users/profiles/{userId}.json)
   - Return updated profile

### Message Storage Flow

1. **Client Side:**
   - Encrypt message locally using recipient's public key
   - Send encrypted message to server

2. **Server Side (POST /api/messages/send):**
   - Verify session token
   - Generate unique messageId (UUID)
   - Store message in memory for current session
   - Save message to R2 (voltex-messages/conversations/{key}/{messageId}.json)
   - Acknowledge receipt to sender

### Account Recovery Flow

1. **User initiates recovery (GET /recover page):**
   - Enter User ID
   - Enter 24-word recovery passphrase

2. **Client Side:**
   - Hash the provided passphrase using SHA-256
   - Send userId and passphraseHash to server

3. **Server Side (POST /api/auth/recover):**
   - Retrieve stored passphraseHash from R2
   - Compare with provided hash
   - If match: Return public key and proceed with challenge
   - If no match: Return error

4. **Challenge-Response Authentication:**
   - Client receives challenge
   - User needs access to original device with private key
   - Sign challenge and complete authentication

## API Endpoints

### Authentication Endpoints

#### POST /api/auth/register

**Request:**

```json
{
  "publicKey": "base64-encoded-public-key",
  "passphraseHash": "sha256-hash-of-passphrase"
}
```

**Response:**

```json
{
  "userId": "16-char-user-id",
  "message": "Account created successfully"
}
```

**R2 Actions:**

- Stores account in voltex-users/accounts/{userId}.json
- Stores passphrase hash in voltex-recovery/{userId}/passphrase.json

#### POST /api/auth/recover

**Request:**

```json
{
  "userId": "16-char-user-id",
  "passphraseHash": "sha256-hash-of-passphrase"
}
```

**Response:**

```json
{
  "userId": "16-char-user-id",
  "publicKey": "base64-encoded-public-key",
  "message": "Account recovered successfully..."
}
```

**R2 Actions:**

- Reads from voltex-recovery/{userId}/passphrase.json
- Reads from voltex-users/accounts/{userId}.json

### Profile Endpoints

#### GET /api/profile/me

**Response:**

```json
{
  "userId": "16-char-user-id",
  "publicKey": "base64-encoded-public-key",
  "displayName": "User's Display Name",
  "bio": "User biography",
  "notifications": true,
  "theme": "dark",
  "privacy": "public",
  "createdAt": 1234567890
}
```

**R2 Actions:**

- Reads from voltex-users/profiles/{userId}.json

#### PUT /api/profile/me

**Request:**

```json
{
  "displayName": "New Display Name",
  "bio": "New biography"
}
```

**Response:**

```json
{
  "message": "Profile updated successfully",
  "profile": {
    /* updated profile */
  }
}
```

**R2 Actions:**

- Writes to voltex-users/profiles/{userId}.json

#### POST /api/profile/settings

**Request:**

```json
{
  "notifications": true,
  "theme": "dark",
  "privacy": "public"
}
```

**R2 Actions:**

- Writes to voltex-users/profiles/{userId}.json

### Message Endpoints

#### POST /api/messages/send

**Request:**

```json
{
  "recipientId": "recipient-user-id",
  "nonce": "base64-encoded-nonce",
  "ciphertext": "base64-encoded-ciphertext",
  "timestamp": 1234567890
}
```

**R2 Actions:**

- Writes to voltex-messages/conversations/{sortedUserIds}/{messageId}.json

## Security Considerations

### Passphrase Protection

- Passphrases are **hashed using SHA-256** before storage
- Original plaintext passphrase is never stored on the server
- User stores the mnemonic passphrase locally on their device
- Recovery can only succeed if the exact passphrase is provided

### Encryption

- All messages are **end-to-end encrypted** using TweetNaCl
- Messages are encrypted on the client before transmission
- Server cannot decrypt messages (no access to recipient's private key)
- Passphrase hashes cannot be reversed to recover the original

### Key Storage

- **Private keys** are stored ONLY on the device where the account was created
- Private keys are **never sent to the server**
- Account recovery requires the original device or manual private key entry
- This ensures no server can access user's private keys

## Data Persistence

### In-Memory Cache

- Sessions and challenges are kept in memory for quick access
- Challenges expire after 5 minutes for security
- Sessions expire after 24 hours

### Persistent Storage (R2)

- All user accounts and metadata
- All messages (encrypted)
- Account recovery data (hashed passphrases)
- Profile information

## Monitoring and Logging

All R2 operations include logging:

```
Successfully uploaded {key} to R2
Successfully deleted {key} from R2
Error uploading to R2: {error}
Message {messageId} stored in R2
User {userId} registered and stored in R2
```

## Troubleshooting

### Account Data Not Appearing

1. Check R2 credentials in environment variables
2. Verify Cloudflare R2 bucket names exist
3. Check server logs for R2 upload errors
4. Ensure network connectivity to R2 endpoint

### Profile Updates Not Persisting

1. Verify session token is valid
2. Check R2 bucket write permissions
3. Ensure correct userId is being used
4. Check for any error messages in server logs

### Recovery Passphrase Issues

1. Ensure passphrase is entered exactly as saved (spaces matter)
2. Passphrase is case-sensitive
3. Check that userId matches the account
4. Verify passphrase hasn't been modified

## Production Deployment

For production deployment on your Ubuntu 22 VPS:

1. **Set environment variables:**

   ```bash
   export R2_API_TOKEN="..."
   export R2_ACCESS_KEY_ID="..."
   export R2_SECRET_ACCESS_KEY="..."
   export R2_ENDPOINT_URL="..."
   ```

2. **Build the application:**

   ```bash
   npm run build
   ```

3. **Start the server:**

   ```bash
   npm start
   ```

4. **Verify R2 connectivity:**
   - Create a test account
   - Check R2 buckets for created files
   - Verify messages are being stored

## Backup Strategy

**Important:** Regularly backup your R2 buckets to prevent data loss:

```bash
# Using aws-cli with R2 credentials
aws s3 sync s3://voltex-users ./backups/voltex-users \
  --endpoint-url https://your-r2-endpoint

aws s3 sync s3://voltex-recovery ./backups/voltex-recovery \
  --endpoint-url https://your-r2-endpoint

aws s3 sync s3://voltex-messages ./backups/voltex-messages \
  --endpoint-url https://your-r2-endpoint
```

## Future Enhancements

- [ ] Implement ListObjectsV2 for message history retrieval
- [ ] Add message deletion with R2 cleanup
- [ ] Implement conversation archival
- [ ] Add user data export feature
- [ ] Implement bucket lifecycle policies
- [ ] Add R2 bucket versioning for recovery
- [ ] Implement compression for message storage
- [ ] Add encryption at rest options

---

**Last Updated:** 2024
**Version:** 1.0
**Status:** Production Ready
