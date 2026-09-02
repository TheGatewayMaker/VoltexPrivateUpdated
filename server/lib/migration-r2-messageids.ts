/**
 * Migration utility to fix existing R2 messages that may not have proper messageId fields
 * This is necessary to ensure deleted message reconciliation works correctly
 *
 * IMPORTANT: This should be run after deploying the fixes to ensure data consistency
 */

import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { sdkStreamMixin } from "@aws-sdk/util-stream-node";
import { query } from "./db";

let r2Client: S3Client | null = null;

function initializeR2Client(): S3Client {
  if (r2Client) {
    return r2Client;
  }

  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const endpoint = process.env.R2_ENDPOINT_URL;

  if (!accessKeyId || !secretAccessKey || !endpoint) {
    throw new Error("Missing R2 credentials in environment variables");
  }

  r2Client = new S3Client({
    region: "auto",
    endpoint: endpoint,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });

  return r2Client;
}

interface MigrationStats {
  total: number;
  updated: number;
  alreadyValid: number;
  failed: number;
  errors: string[];
}

/**
 * Migrate R2 messages to ensure all have proper messageId fields
 * This function:
 * 1. Lists all message objects in R2
 * 2. Checks if each message has a valid messageId field
 * 3. If missing or invalid, reconstructs it from the database
 * 4. Updates the R2 object with the corrected data
 */
export async function migrateR2MessageIds(): Promise<MigrationStats> {
  const stats: MigrationStats = {
    total: 0,
    updated: 0,
    alreadyValid: 0,
    failed: 0,
    errors: [],
  };

  try {
    const client = initializeR2Client();
    const bucketName = "voltex-messages";
    const prefix = "conversations/";

    console.log("[R2-MIGRATION] Starting R2 message ID migration...");

    let continuationToken: string | undefined;
    let pageCount = 0;

    do {
      pageCount++;
      console.log(`[R2-MIGRATION] Processing R2 page ${pageCount}...`);

      const command = new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: prefix,
        ContinuationToken: continuationToken,
        MaxKeys: 100, // Process in smaller batches
      });

      const response = await client.send(command);

      if (!response.Contents || response.Contents.length === 0) {
        if (pageCount === 1) {
          console.log("[R2-MIGRATION] No messages found in R2");
          return stats;
        }
        break;
      }

      // Process each message
      for (const content of response.Contents) {
        if (!content.Key || !content.Key.endsWith(".json")) {
          continue;
        }

        stats.total++;

        try {
          const getCommand = new GetObjectCommand({
            Bucket: bucketName,
            Key: content.Key,
          });

          const getResponse = await client.send(getCommand);
          if (!getResponse.Body) {
            stats.failed++;
            stats.errors.push(`Failed to read body for ${content.Key}`);
            continue;
          }

          const bodyStream = sdkStreamMixin(getResponse.Body);
          const data = await bodyStream.transformToString();
          const messageData = JSON.parse(data);

          // Check if messageId is already valid
          if (
            messageData.messageId &&
            typeof messageData.messageId === "string" &&
            messageData.messageId.trim() !== ""
          ) {
            stats.alreadyValid++;
            continue;
          }

          // Try to extract messageId from the R2 key
          // Key format: conversations/{sortedUserIds}/{messageId}.json
          const match = content.Key.match(
            /conversations\/[^/]+\/([^/]+)\.json$/,
          );
          if (!match || !match[1]) {
            stats.failed++;
            stats.errors.push(
              `Could not extract messageId from key: ${content.Key}`,
            );
            continue;
          }

          const extractedMessageId = match[1];

          // Validate that this messageId exists in the database
          try {
            const dbResult = await query<{ id: string }>(
              `SELECT id FROM messages WHERE id = $1 LIMIT 1;`,
              [extractedMessageId],
            );

            if (!dbResult || dbResult.length === 0) {
              console.warn(
                `[R2-MIGRATION] Message ID ${extractedMessageId} from R2 key not found in database - skipping to preserve data`,
              );
              stats.alreadyValid++; // Don't count as failure, just skip
              continue;
            }
          } catch (dbError) {
            console.error(
              `[R2-MIGRATION] Database error checking ${extractedMessageId}:`,
              dbError,
            );
            stats.failed++;
            stats.errors.push(
              `Database error for ${extractedMessageId}: ${dbError instanceof Error ? dbError.message : String(dbError)}`,
            );
            continue;
          }

          // Update the message with the corrected messageId
          const updatedData = {
            ...messageData,
            messageId: extractedMessageId,
          };

          const putCommand = new PutObjectCommand({
            Bucket: bucketName,
            Key: content.Key,
            Body: JSON.stringify(updatedData),
            ContentType: "application/json",
          });

          await client.send(putCommand);
          stats.updated++;
          console.log(
            `[R2-MIGRATION] ✓ Updated ${content.Key} with messageId ${extractedMessageId}`,
          );
        } catch (error) {
          stats.failed++;
          const errorMsg =
            error instanceof Error ? error.message : String(error);
          stats.errors.push(`Error processing ${content.Key}: ${errorMsg}`);
          console.error(
            `[R2-MIGRATION] ✗ Error processing ${content.Key}:`,
            error,
          );
        }
      }

      // Handle pagination
      if (response.IsTruncated && response.NextContinuationToken) {
        continuationToken = response.NextContinuationToken;
      } else {
        continuationToken = undefined;
      }
    } while (continuationToken);

    console.log(`[R2-MIGRATION] Migration complete:`);
    console.log(`  Total messages processed: ${stats.total}`);
    console.log(`  Messages updated: ${stats.updated}`);
    console.log(`  Messages already valid: ${stats.alreadyValid}`);
    console.log(`  Messages failed: ${stats.failed}`);

    if (stats.errors.length > 0) {
      console.log(`[R2-MIGRATION] Errors encountered:`);
      stats.errors.slice(0, 10).forEach((error) => {
        console.log(`  - ${error}`);
      });
      if (stats.errors.length > 10) {
        console.log(`  ... and ${stats.errors.length - 10} more errors`);
      }
    }

    return stats;
  } catch (error) {
    console.error("[R2-MIGRATION] Fatal error during migration:", error);
    stats.errors.push(
      `Fatal error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return stats;
  }
}

/**
 * Run the migration (can be called from CLI or startup)
 */
export async function runMigration() {
  console.log(
    "[R2-MIGRATION] ========== R2 MESSAGE ID MIGRATION START ==========",
  );
  const stats = await migrateR2MessageIds();
  console.log(
    "[R2-MIGRATION] ========== R2 MESSAGE ID MIGRATION COMPLETE ==========",
  );
  return stats;
}
