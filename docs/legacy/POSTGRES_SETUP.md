# PostgreSQL Setup Guide for Real-Time Messaging

This guide provides step-by-step instructions for setting up PostgreSQL for your real-time messaging system with Cloudflare R2 archival.

## Architecture Overview

Your messaging system now uses a **3-tier storage strategy**:

1. **In-Memory (Real-time)**: Conversation history for currently active chats
2. **PostgreSQL (Hot Storage)**: Recent messages (last 2-3 hours) for fast retrieval
3. **Cloudflare R2 (Cold Storage)**: Archived messages for long-term storage

Messages flow: **Receive** → **PostgreSQL** → **R2 Archive** → **Delete from PostgreSQL**

## Prerequisites

- PostgreSQL 12+ installed on your VPS
- Access to your VPS via SSH or a PostgreSQL client
- Basic understanding of PostgreSQL and environment variables

## Step 1: Set Up PostgreSQL on Your VPS

### Option A: Install PostgreSQL on Ubuntu/Debian

```bash
# Update package manager
sudo apt update

# Install PostgreSQL
sudo apt install postgresql postgresql-contrib

# Start PostgreSQL service
sudo systemctl start postgresql
sudo systemctl enable postgresql

# Verify installation
psql --version
```

### Option B: Install PostgreSQL on CentOS/RHEL

```bash
# Install PostgreSQL
sudo dnf install postgresql-server postgresql-contrib

# Initialize database
sudo postgresql-setup initdb

# Start PostgreSQL service
sudo systemctl start postgresql
sudo systemctl enable postgresql
```

## Step 2: Create Database and User

```bash
# Connect to PostgreSQL as root user
sudo -u postgres psql

# Create database for messages
CREATE DATABASE voltex_messages;

# Create a dedicated user for the application
CREATE USER voltex_app WITH PASSWORD 'your-secure-password-here';

# Grant privileges
ALTER ROLE voltex_app SET client_encoding TO 'utf8';
ALTER ROLE voltex_app SET default_transaction_isolation TO 'read committed';
ALTER ROLE voltex_app SET default_transaction_deferrable TO on;
ALTER ROLE voltex_app SET default_timezone TO 'UTC';

# Grant database access
GRANT ALL PRIVILEGES ON DATABASE voltex_messages TO voltex_app;

# Exit PostgreSQL
\q
```

**Security Tip**: Use a strong, randomly generated password. Save it securely.

## Step 3: Configure PostgreSQL for Remote Access (if needed)

If your app server is on a different machine from PostgreSQL:

```bash
# Edit PostgreSQL configuration
sudo nano /etc/postgresql/14/main/postgresql.conf

# Find the line: #listen_addresses = 'localhost'
# Change to: listen_addresses = '*'

# Edit the access control file
sudo nano /etc/postgresql/14/main/pg_hba.conf

# Add a line for your app server IP:
# host    voltex_messages    voltex_app    YOUR_APP_SERVER_IP/32    md5

# Restart PostgreSQL
sudo systemctl restart postgresql
```

## Step 4: Set Environment Variables

Create or update your `.env` file with the PostgreSQL connection string:

```env
# PostgreSQL Connection (required for database storage)
DATABASE_URL=postgresql://voltex_app:your-secure-password@localhost:5432/voltex_messages

# Optional: For remote connections
# DATABASE_URL=postgresql://voltex_app:your-secure-password@your-vps-ip:5432/voltex_messages

# Existing Cloudflare R2 Configuration
R2_ACCESS_KEY_ID=your-r2-access-key
R2_SECRET_ACCESS_KEY=your-r2-secret-key
R2_ENDPOINT_URL=https://your-account-id.r2.cloudflarestorage.com

# Optional: Archival Job Configuration
# Interval between archival runs (milliseconds)
ARCHIVAL_INTERVAL_MS=7200000        # 2 hours (default)

# How old messages must be before archival (milliseconds)
MESSAGE_AGE_MS=7200000              # 2 hours old (default)

# Maximum messages to process per archival run
ARCHIVAL_BATCH_SIZE=1000

# Delete messages immediately after R2 archival
DELETE_AFTER_ARCHIVAL=true

# Grace period before deletion (milliseconds)
DELETE_GRACE_MS=0                   # Delete immediately (default)
```

## Step 5: Test Database Connection

```bash
# From your application server, test the connection
psql "postgresql://voltex_app:your-secure-password@localhost:5432/voltex_messages"

# If successful, you should see:
# psql (14.x)
# Type "help" for help.
# voltex_messages=>

# Exit
\q
```

## Step 6: Deploy and Start

The database tables are created automatically when your app starts:

```bash
# Build the application
npm run build

# Start the application
npm start

# Check logs for database initialization messages
# You should see:
# "Successfully connected to PostgreSQL"
# "Database tables initialized"
```

## How the Archival System Works

### 1. Message Flow

```
User sends message
    ↓
Message stored in PostgreSQL
    ↓
Message delivered via WebSocket (real-time)
    ↓
Message stored in R2 (backup)
    ↓
[Wait 2-3 hours] ← Archival Job runs
    ↓
Archived messages moved to R2 archive
    ↓
Messages marked as archived in PostgreSQL
    ↓
Messages deleted from PostgreSQL
```

### 2. Archival Job Configuration

The archival job runs automatically every **2-3 hours** (configurable).

**Configuration Options** (in `.env`):

```env
# Run archival job every 2 hours (in milliseconds)
ARCHIVAL_INTERVAL_MS=7200000

# Archive messages older than 2 hours
MESSAGE_AGE_MS=7200000

# Process up to 1000 messages per run
ARCHIVAL_BATCH_SIZE=1000

# Immediately delete from PostgreSQL after successful R2 upload
DELETE_AFTER_ARCHIVAL=true

# Optional: Grace period before deletion (in milliseconds)
DELETE_GRACE_MS=3600000  # Wait 1 hour before deletion
```

### 3. API Endpoints for Monitoring (optional)

You can add monitoring endpoints to check:

```typescript
// Example: Get archival job status
app.get("/api/admin/archival-status", (req, res) => {
  const status = getArchivalJobStatus();
  res.json(status);
});

// Example: Get database statistics
app.get("/api/admin/db-stats", async (req, res) => {
  const stats = await getDatabaseStats();
  res.json(stats);
});

// Example: Run archival manually (for testing)
app.post("/api/admin/archival-run", async (req, res) => {
  const result = await runArchivalJob();
  res.json(result);
});
```

## Database Schema

The following tables are created automatically:

### `messages` Table

Stores encrypted messages with full metadata.

```sql
-- Columns
id UUID                    -- Unique message ID
sender_id VARCHAR(255)    -- Sender's user ID
recipient_id VARCHAR(255) -- Recipient's user ID
nonce VARCHAR(32)         -- Encryption nonce
ciphertext TEXT           -- Encrypted message content
signature VARCHAR(128)    -- Message signature
timestamp BIGINT          -- Message timestamp
created_at TIMESTAMP      -- Database creation time
archived BOOLEAN          -- Archival status
archived_at TIMESTAMP     -- When message was archived

-- Indexes (for performance)
-- idx_messages_conversation - Fast conversation lookups
-- idx_messages_timestamp_archived - Archival query optimization
-- idx_messages_not_archived - Active messages only
-- idx_messages_bidirectional - Bidirectional conversation queries
```

### `conversations` Table

Stores conversation metadata for quick list retrieval.

```sql
-- Columns
id SERIAL                 -- Auto-incrementing ID
user_id VARCHAR(255)     -- User ID (sorted)
other_user_id VARCHAR(255) -- Other user ID (sorted)
last_message_timestamp BIGINT -- Timestamp of last message
last_message_preview VARCHAR(100) -- Preview of last message
updated_at TIMESTAMP     -- Last update time

-- Unique Constraint
-- Ensures only one record per conversation pair
```

## Query Performance

The system is optimized for:

1. **Recent Message Retrieval**: PostgreSQL with indexed queries (~10-50ms)
2. **Conversation List**: PostgreSQL with grouped queries (~5-20ms)
3. **Archived Message Retrieval**: R2 object storage (~100-500ms)
4. **Bulk Archival**: Batch processing with connection pooling

**Index Strategy**:

- Sender + Recipient + Timestamp for conversation queries
- Timestamp + Archived status for archival queries
- User ID + Updated time for conversation list queries

## Monitoring and Maintenance

### Check Database Size

```sql
SELECT
  schemaname,
  tablename,
  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
FROM pg_tables
WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;
```

### Monitor Message Growth

```sql
-- Active messages in PostgreSQL
SELECT COUNT(*) FROM messages WHERE archived = FALSE;

-- Archived messages
SELECT COUNT(*) FROM messages WHERE archived = TRUE;

-- Total messages
SELECT COUNT(*) FROM messages;
```

### Check Archival Job Status

```typescript
import { getArchivalJobStatus } from "./server/lib/archival-job";

const status = getArchivalJobStatus();
console.log(status);
// Output:
// {
//   running: false,
//   lastArchivalTime: 1234567890000,
//   timeSinceLastArchival: 3600000
// }
```

### Vacuum and Analyze (maintenance)

```bash
# Connect to database
psql -U voltex_app -d voltex_messages

# Run vacuum (cleanup dead rows)
VACUUM messages;

# Analyze (update statistics)
ANALYZE messages;

# Exit
\q
```

## Troubleshooting

### Connection Refused

```
Error: connect ECONNREFUSED 127.0.0.1:5432
```

**Solution**:

- Ensure PostgreSQL service is running: `sudo systemctl start postgresql`
- Check if port 5432 is open: `sudo netstat -tlnp | grep 5432`
- Verify DATABASE_URL is correct in `.env`

### Authentication Failed

```
Error: password authentication failed for user "voltex_app"
```

**Solution**:

- Reset user password: `ALTER USER voltex_app WITH PASSWORD 'new-password';`
- Update DATABASE_URL with new password
- Verify username in connection string

### Out of Disk Space

```
Error: disk quota exceeded
```

**Solution**:

1. Run archival job manually to clear old messages
2. Increase disk space on VPS
3. Check R2 archival is working: verify files in R2 bucket

### Slow Queries

If message retrieval is slow:

```sql
-- Rebuild indexes
REINDEX INDEX idx_messages_conversation;
REINDEX INDEX idx_messages_timestamp_archived;

-- Analyze table
ANALYZE messages;
```

## Fallback Behavior

If PostgreSQL becomes unavailable:

1. Messages still store in **in-memory** map
2. Messages still store in **R2** for persistence
3. Recent messages retrieved from **in-memory** or **R2**
4. Archival job pauses (resumes when DB comes back)

The system remains **fully functional** even without PostgreSQL.

## Performance Benchmarks

Expected performance with proper PostgreSQL setup:

| Operation                     | Time       | Storage          |
| ----------------------------- | ---------- | ---------------- |
| Send message                  | 5-15ms     | <1KB per message |
| Retrieve recent messages (50) | 10-50ms    | -                |
| List conversations            | 5-20ms     | -                |
| Archive batch (1000 messages) | 500-2000ms | ~1MB to R2       |
| Delete from PostgreSQL        | 100-500ms  | -                |

## Support and Resources

- [PostgreSQL Documentation](https://www.postgresql.org/docs/)
- [PostgreSQL Performance Tuning](https://wiki.postgresql.org/wiki/Performance_Optimization)
- [Node.js pg Library](https://node-postgres.com/)

## Next Steps

1. Set up PostgreSQL on your VPS
2. Create database and user as described above
3. Add DATABASE_URL to your `.env` file
4. Deploy your application
5. Monitor archival job runs in server logs
6. Check database size periodically

Your messaging system is now ready for production-scale real-time messaging with efficient storage management!
