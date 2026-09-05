# Testing Guide: Real-Time Messaging with PostgreSQL and R2 Archival

This guide provides comprehensive instructions for testing the complete messaging system with PostgreSQL storage and R2 archival.

## Prerequisites

- PostgreSQL running and configured (see POSTGRES_SETUP.md)
- Application running with `npm run dev` or `npm start`
- Cloudflare R2 bucket access and credentials configured
- A tool for making HTTP requests (curl, Postman, or your browser)

## Quick Start: 5-Minute Test

### 1. Check System Health

```bash
curl http://localhost:3000/api/admin/health
```

Expected response:

```json
{
  "status": "healthy",
  "database": {
    "connected": true,
    "stats": {
      "total": 0,
      "archived": 0,
      "active": 0
    }
  },
  "archival": {
    "running": false,
    "lastArchivalTime": 0,
    "timeSinceLastArchival": 0
  },
  "timestamp": 1234567890
}
```

### 2. Send a Test Message

Use the chat UI or simulate a message via WebSocket:

```javascript
// Open browser console and run:
const token = localStorage.getItem("session_token");
const ws = new WebSocket(`ws://localhost:3000/ws?token=${token}`);

ws.onopen = () => {
  const message = {
    type: "message",
    data: {
      senderId: "user1",
      recipientId: "user2",
      nonce: "test-nonce",
      ciphertext: "test-ciphertext",
      signature: "test-signature",
      timestamp: Date.now(),
    },
  };
  ws.send(JSON.stringify(message));
};

ws.onmessage = (event) => {
  console.log("Received:", event.data);
};
```

### 3. Check Database

```bash
curl http://localhost:3000/api/admin/database-stats
```

Expected response:

```json
{
  "messages": {
    "total": 1,
    "archived": 0,
    "active": 1,
    "archivalPercentage": "0.00%"
  },
  "timestamp": 1234567890
}
```

### 4. Check Archival Configuration

```bash
curl http://localhost:3000/api/admin/archival-config
```

## Comprehensive Test Scenarios

### Scenario 1: Message Storage in PostgreSQL

**Objective**: Verify messages are stored in PostgreSQL

**Steps**:

1. Start the application:

```bash
npm start
```

2. Check database is connected:

```bash
curl http://localhost:3000/api/admin/health
```

Verify: `"connected": true`

3. Send messages through chat UI
   - Log in with two test accounts
   - Exchange 5-10 messages between them

4. Check database stats:

```bash
curl http://localhost:3000/api/admin/database-stats
```

Verify: `"active": 5+` (messages should be in active state)

5. Query database directly:

```bash
psql -U voltex_app -d voltex_messages
SELECT COUNT(*) FROM messages WHERE archived = FALSE;
-- Should return 5+
\q
```

**Expected Result**: ✅ All messages stored in PostgreSQL

---

### Scenario 2: Real-Time Message Delivery

**Objective**: Verify WebSocket delivers messages instantly

**Steps**:

1. Open two browser windows with the chat app
2. Log in with different accounts in each window
3. Send a message from window 1
4. Check window 2 receives it within 100ms
5. Verify message appears in both chat UIs

**Expected Result**: ✅ Messages delivered in real-time (<500ms)

---

### Scenario 3: Message Retrieval from PostgreSQL

**Objective**: Verify recent messages load from PostgreSQL

**Steps**:

1. Send 10 messages between two users
2. Refresh the chat page (browser refresh)
3. Observe chat history loads immediately
4. Check that messages come from PostgreSQL:

```bash
curl -H "Authorization: Bearer YOUR_SESSION_TOKEN" \
  http://localhost:3000/api/messages/conversation/user2
```

Verify response includes: `"source": "database+r2"`

4. Query PostgreSQL to confirm storage:

```bash
psql -U voltex_app -d voltex_messages
SELECT COUNT(*) FROM messages WHERE archived = FALSE;
-- Should equal number of active messages
\q
```

**Expected Result**: ✅ Messages loaded from PostgreSQL

---

### Scenario 4: Manual Archival Test (Quick)

**Objective**: Test archival without waiting 2 hours

**Steps**:

1. Send 5+ messages
2. Verify all in PostgreSQL:

```bash
curl http://localhost:3000/api/admin/database-stats
```

3. For quick testing, modify MESSAGE_AGE_MS to 1 second:

```env
MESSAGE_AGE_MS=1000  # 1 second (for testing only!)
```

4. Restart application:

```bash
npm start
```

5. Wait 1 second, then manually trigger archival:

```bash
curl -X POST http://localhost:3000/api/admin/run-archival
```

Expected response:

```json
{
  "success": true,
  "result": {
    "archived": 5,
    "deleted": 5
  },
  "message": "Archival complete: 5 messages archived, 5 deleted from PostgreSQL"
}
```

6. Verify messages moved to R2:
   - Check Cloudflare R2 console
   - Look for `archives/` folder with files named like `archives/user1:user2/1234567890.json`

7. Verify deletion from PostgreSQL:

```bash
curl http://localhost:3000/api/admin/database-stats
```

Verify: `"active": 0`, `"archived": 0` (deleted after R2 upload)

**Expected Result**: ✅ Messages archived to R2 and deleted from PostgreSQL

---

### Scenario 5: Loading Archived Messages

**Objective**: Verify old messages can be retrieved from R2

**Steps**:

1. Archive messages as in Scenario 4
2. Query conversation history:

```bash
curl -H "Authorization: Bearer YOUR_SESSION_TOKEN" \
  http://localhost:3000/api/messages/conversation/user2
```

3. Verify response:

```json
{
  "messages": [...],
  "source": "r2+memory",  // Should show messages from R2
  "total": 5
}
```

**Expected Result**: ✅ Archived messages loaded from R2

---

### Scenario 6: Conversation List

**Objective**: Test conversation list with multiple chats

**Steps**:

1. Send messages in multiple conversations:
   - User1 → User2: 3 messages
   - User1 → User3: 5 messages
   - User1 → User4: 2 messages

2. Retrieve conversation list:

```bash
curl -H "Authorization: Bearer YOUR_SESSION_TOKEN" \
  http://localhost:3000/api/messages/conversations
```

Expected response:

```json
{
  "conversations": [
    { "userId": "user3", "timestamp": 1234567890, "lastMessage": "..." },
    { "userId": "user2", "timestamp": 1234567885, "lastMessage": "..." },
    { "userId": "user4", "timestamp": 1234567880, "lastMessage": "..." }
  ],
  "count": 3,
  "source": "database+r2"
}
```

**Expected Result**: ✅ All conversations listed with correct timestamps

---

### Scenario 7: Scheduled Archival (Full Test)

**Objective**: Verify automatic archival job runs on schedule

**Setup Time**: ~30 minutes for full test

**Steps**:

1. Set archival parameters for testing:

```env
ARCHIVAL_INTERVAL_MS=60000      # Run every 1 minute (for testing)
MESSAGE_AGE_MS=10000             # Archive messages 10+ seconds old
```

2. Restart application:

```bash
npm start
```

3. Watch server logs for archival startup:

```
Message archival job started
Starting archival job...
```

4. Send some messages:
   - Exchange 10 messages between users
   - Note the current time

5. Wait 15 seconds for messages to age

6. Check logs as archival runs (at 60-second intervals):

```
Found X messages ready for archival
Archiving X messages from conversation user1:user2
Successfully archived conversation user1:user2 to R2
Marked X messages as archived
Deleted X archived messages from PostgreSQL
Archival job completed: X archived, X deleted
```

7. Monitor database stats over time:

```bash
# Before archival (X active messages)
curl http://localhost:3000/api/admin/database-stats

# After archival (0 active, X archived)
curl http://localhost:3000/api/admin/database-stats
```

8. Verify R2 files created:
   - Log into Cloudflare Dashboard
   - Navigate to R2 bucket → voltex-messages
   - Check `archives/` folder for timestamped JSON files

**Expected Result**: ✅ Automatic archival runs on schedule

---

## Performance Testing

### Load Test: Bulk Message Sending

```bash
#!/bin/bash

# Send 100 messages rapidly
for i in {1..100}; do
  curl -X POST http://localhost:3000/api/messages/send \
    -H "Authorization: Bearer YOUR_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
      \"recipientId\": \"user2\",
      \"nonce\": \"nonce-$i\",
      \"ciphertext\": \"cipher-$i\",
      \"signature\": \"sig-$i\",
      \"timestamp\": $(date +%s%3N)
    }" &
done

wait
echo "Sent 100 messages"

# Check storage
curl http://localhost:3000/api/admin/database-stats
```

Expected: All 100 messages stored, no errors

### Retrieval Performance Test

```bash
#!/bin/bash

# Retrieve conversation multiple times and measure response time
for i in {1..10}; do
  time curl -H "Authorization: Bearer YOUR_TOKEN" \
    http://localhost:3000/api/messages/conversation/user2
done
```

Expected: <100ms per request for PostgreSQL, <500ms for R2 fallback

---

## Monitoring Commands

### Check Server Logs (Development)

```bash
# In the window running the app, check for:
# - "Message stored in PostgreSQL"
# - "Archival job completed"
# - "Deleted X archived messages"
```

### Monitor PostgreSQL Activity

```sql
-- Connect to database
psql -U voltex_app -d voltex_messages

-- Check message counts over time
SELECT COUNT(*) as total,
       SUM(CASE WHEN archived = FALSE THEN 1 END) as active,
       SUM(CASE WHEN archived = TRUE THEN 1 END) as archived
FROM messages;

-- Check conversation updates
SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 5;

-- Monitor table size
SELECT pg_size_pretty(pg_total_relation_size('messages'));

-- Exit
\q
```

### Monitor R2 Archival

```bash
# List archived files in R2
aws s3 ls s3://your-bucket/archives/ --recursive \
  --endpoint-url https://your-r2-endpoint.r2.cloudflarestorage.com \
  --region auto

# Count archived files
aws s3 ls s3://your-bucket/archives/ --recursive \
  --endpoint-url https://your-r2-endpoint.r2.cloudflarestorage.com \
  --region auto | wc -l
```

---

## Troubleshooting Tests

### Problem: Database not connected

**Solution**:

```bash
# Verify PostgreSQL is running
sudo systemctl status postgresql

# Check DATABASE_URL in .env
grep DATABASE_URL .env

# Test connection manually
psql "postgresql://voltex_app:password@localhost:5432/voltex_messages"
```

### Problem: Archival job not running

**Check**:

1. Verify database is connected
2. Check environment variables:
   ```bash
   echo $ARCHIVAL_INTERVAL_MS
   echo $MESSAGE_AGE_MS
   ```
3. Check server logs for errors
4. Manually trigger: `curl -X POST http://localhost:3000/api/admin/run-archival`

### Problem: Messages not in PostgreSQL

**Check**:

1. Verify `isDatabaseConnected()` returns true
2. Check PostgreSQL logs: `sudo tail -f /var/log/postgresql/postgresql.log`
3. Test database connection: `psql "postgresql://..."`
4. Verify table exists: `psql ... -c "SELECT COUNT(*) FROM messages;"`

### Problem: R2 archival failing

**Check**:

1. Verify R2 credentials in `.env`
2. Check R2 buckets exist (voltex-messages)
3. Verify IAM permissions
4. Test R2 connection: Try uploading a test file via AWS SDK

---

## Test Checklist

Use this checklist to verify all functionality:

```
[ ] Database connected on startup
[ ] Messages store in PostgreSQL
[ ] Messages deliver in real-time via WebSocket
[ ] Recent messages load from PostgreSQL
[ ] Conversation list shows all chats
[ ] Messages store in R2 as backup
[ ] Archival job runs on schedule
[ ] Messages archived to R2 successfully
[ ] Messages deleted from PostgreSQL after archival
[ ] Archived messages load from R2
[ ] Admin health endpoint works
[ ] Admin stats endpoint shows correct counts
[ ] Manual archival endpoint works
[ ] No errors in server logs
[ ] Database size remains stable after archival
[ ] R2 bucket shows archived files
```

## Production Verification

Before deploying to production:

1. **Database**: Ensure PostgreSQL is running on VPS
2. **Backups**: Set up PostgreSQL backup strategy
3. **Monitoring**: Set up alerts for archival job failures
4. **Performance**: Conduct load testing under expected traffic
5. **Recovery**: Test data recovery from R2 in case of PostgreSQL failure
6. **Security**: Verify all credentials are in environment variables

## Getting Help

If tests fail:

1. Check application logs: Look for error messages
2. Check PostgreSQL logs: `sudo tail -f /var/log/postgresql/postgresql.log`
3. Check Cloudflare R2 for errors in upload/download
4. Verify network connectivity between app server and PostgreSQL
5. Verify R2 credentials and bucket permissions

## Next Steps

After successful testing:

1. Reset `MESSAGE_AGE_MS` to `7200000` (2 hours) for production
2. Reset `ARCHIVAL_INTERVAL_MS` to `7200000` (2 hours) for production
3. Set up database backups
4. Monitor database growth over time
5. Set up alerts for archival job failures
6. Document your PostgreSQL connection details securely
