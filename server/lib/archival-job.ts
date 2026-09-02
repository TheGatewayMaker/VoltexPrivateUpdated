import { StoredMessage } from "./db-messages";
import {
  getMessagesForArchival,
  markMessagesAsArchived,
  deleteArchivedMessages,
  isDatabaseConnected,
} from "./db-messages";
import {
  saveMessageArchiveToR2,
  deleteArchivedMessagesFromR2,
  deleteFromR2,
} from "./r2-storage";

/**
 * Configuration for archival job
 */
export interface ArchivalConfig {
  /**
   * How often to run the archival job (in milliseconds)
   * Default: 2-3 hours (10800000 ms)
   */
  intervalMs: number;

  /**
   * How old messages must be before archival (in milliseconds)
   * Default: 2 hours (7200000 ms)
   */
  messageAgeMs: number;

  /**
   * Maximum number of messages to process per archival run
   * Default: 1000
   */
  batchSize: number;

  /**
   * Whether to immediately delete messages after R2 archival
   * Default: true
   */
  deleteAfterArchival: boolean;

  /**
   * Grace period before deletion (in milliseconds)
   * Only used if deleteAfterArchival is true
   * Default: 0 (delete immediately)
   */
  deleteGraceMs: number;
}

/**
 * Archival job state
 */
let archivalJobInterval: NodeJS.Timeout | null = null;
let lastArchivalTime: number = 0;
let isArchivalRunning: boolean = false;

/**
 * Default configuration
 */
const DEFAULT_CONFIG: ArchivalConfig = {
  intervalMs: 2 * 60 * 60 * 1000, // 2 hours
  messageAgeMs: 2 * 60 * 60 * 1000, // 2 hours old
  batchSize: 1000,
  deleteAfterArchival: true,
  deleteGraceMs: 0,
};

/**
 * Start the archival job
 */
export function startArchivalJob(customConfig?: Partial<ArchivalConfig>): void {
  if (archivalJobInterval) {
    console.log("Archival job is already running");
    return;
  }

  if (!isDatabaseConnected()) {
    console.warn("Database not connected. Archival job will not start.");
    return;
  }

  const config = { ...DEFAULT_CONFIG, ...customConfig };

  console.log(
    `Starting message archival job (interval: ${config.intervalMs}ms, message age: ${config.messageAgeMs}ms)`,
  );

  // Run archival job immediately on start
  runArchivalJob(config);

  // Schedule archival job
  archivalJobInterval = setInterval(() => {
    runArchivalJob(config);
  }, config.intervalMs);
}

/**
 * Stop the archival job
 */
export function stopArchivalJob(): void {
  if (archivalJobInterval) {
    clearInterval(archivalJobInterval);
    archivalJobInterval = null;
    console.log("Archival job stopped");
  }
}

/**
 * Run the archival job once
 */
export async function runArchivalJob(
  config: ArchivalConfig = DEFAULT_CONFIG,
): Promise<{ archived: number; deleted: number }> {
  if (isArchivalRunning) {
    console.log("Archival job is already running, skipping...");
    return { archived: 0, deleted: 0 };
  }

  if (!isDatabaseConnected()) {
    console.warn("Database not connected. Skipping archival job.");
    return { archived: 0, deleted: 0 };
  }

  isArchivalRunning = true;
  lastArchivalTime = Date.now();

  try {
    console.log("Starting archival job...");

    // Get messages that are ready for archival
    const messagesToArchive = await getMessagesForArchival(
      config.messageAgeMs,
      config.batchSize,
    );

    if (messagesToArchive.length === 0) {
      console.log("No messages to archive");
      isArchivalRunning = false;
      return { archived: 0, deleted: 0 };
    }

    console.log(
      `Found ${messagesToArchive.length} messages ready for archival`,
    );

    // Group messages by conversation for efficient R2 storage
    const messagesByConversation =
      groupMessagesByConversation(messagesToArchive);

    let archivedCount = 0;
    let deletedCount = 0;
    const failedMessageIds: string[] = [];

    // Archive each conversation batch to R2
    for (const [conversationKey, messages] of messagesByConversation) {
      try {
        console.log(
          `Archiving ${messages.length} messages from conversation ${conversationKey}`,
        );

        // Save messages to R2
        const archiveKey = `archives/${conversationKey}/${Date.now()}.json`;
        await saveMessageArchiveToR2(archiveKey, messages);

        console.log(
          `Successfully archived conversation ${conversationKey} to R2`,
        );

        // Mark messages as archived in PostgreSQL
        const messageIds = messages
          .map((m) => m.id!)
          .filter((id): id is string => !!id);
        const markedCount = await markMessagesAsArchived(messageIds);
        archivedCount += markedCount;

        // Delete from PostgreSQL after successful R2 archival
        if (config.deleteAfterArchival) {
          if (config.deleteGraceMs > 0) {
            console.log(
              `Grace period: waiting ${config.deleteGraceMs}ms before deletion`,
            );
            await new Promise((resolve) =>
              setTimeout(resolve, config.deleteGraceMs),
            );
          }

          const deletedCountForConv = await deleteArchivedMessages(messageIds);
          deletedCount += deletedCountForConv;

          // Also try to delete from R2 if needed
          if (deletedCountForConv > 0) {
            try {
              await deleteArchivedMessagesFromR2(archiveKey);
              console.log(`Cleanup: deleted R2 archive for ${conversationKey}`);
            } catch (error) {
              console.warn(
                `Failed to cleanup R2 archive for ${conversationKey}:`,
                error,
              );
            }
          }
        }
      } catch (error) {
        console.error(
          `Failed to archive conversation ${conversationKey}:`,
          error,
        );

        // Collect failed message IDs for retry
        const failedIds = messages
          .map((m) => m.id!)
          .filter((id): id is string => !!id);
        failedMessageIds.push(...failedIds);
      }
    }

    console.log(
      `Archival job completed: ${archivedCount} archived, ${deletedCount} deleted`,
    );

    if (failedMessageIds.length > 0) {
      console.warn(
        `${failedMessageIds.length} messages failed to archive and will be retried`,
      );
    }

    isArchivalRunning = false;
    return { archived: archivedCount, deleted: deletedCount };
  } catch (error) {
    console.error("Archival job failed with error:", error);
    isArchivalRunning = false;
    return { archived: 0, deleted: 0 };
  }
}

/**
 * Group messages by conversation for batch processing
 */
function groupMessagesByConversation(
  messages: StoredMessage[],
): Map<string, StoredMessage[]> {
  const grouped = new Map<string, StoredMessage[]>();

  for (const message of messages) {
    const senderId = message.senderId || message.sender_id || "";
    const recipientId = message.recipientId || message.recipient_id || "";
    const sorted = [senderId, recipientId].sort();
    const conversationKey = sorted.join(":");

    if (!grouped.has(conversationKey)) {
      grouped.set(conversationKey, []);
    }

    grouped.get(conversationKey)!.push(message);
  }

  return grouped;
}

/**
 * Get archival job status
 */
export function getArchivalJobStatus(): {
  running: boolean;
  lastArchivalTime: number;
  timeSinceLastArchival: number;
} {
  return {
    running: isArchivalRunning,
    lastArchivalTime,
    timeSinceLastArchival: Date.now() - lastArchivalTime,
  };
}

/**
 * Get archival job configuration
 */
export function getDefaultArchivalConfig(): ArchivalConfig {
  return { ...DEFAULT_CONFIG };
}
