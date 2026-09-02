/**
 * Server Time Synchronization Utility
 * Synchronizes client time with server time to handle clock skew
 */

let timeOffset = 0; // Milliseconds to add to client time to get server time
let isSynced = false;

/**
 * Initialize server time synchronization
 * Call this once when the app loads
 */
export async function initializeServerTime(): Promise<void> {
  try {
    const clientTime = Date.now();
    const response = await fetch("/api/auth/server-time");

    if (!response.ok) {
      console.warn("Failed to fetch server time, using client time");
      return;
    }

    const data = await response.json();
    const serverTime = data.timestamp;

    // Calculate offset: how much to add to client time to get server time
    timeOffset = serverTime - clientTime;
    isSynced = true;

    console.log(
      `Server time synced. Offset: ${timeOffset}ms (${(timeOffset / 1000).toFixed(2)}s)`,
    );
  } catch (error) {
    console.error("Failed to initialize server time:", error);
    // Continue with client time if sync fails
  }
}

/**
 * Get current server time
 */
export function getServerTime(): number {
  return Date.now() + timeOffset;
}

/**
 * Convert a timestamp to client's current server time
 * This ensures all timestamps are consistent with server time
 */
export function normalizeTimestamp(timestamp: number): number {
  // If timestamp seems too far from server time (> 24 hours), it's likely invalid
  const now = getServerTime();
  const diff = Math.abs(now - timestamp);
  const MAX_DIFF = 24 * 60 * 60 * 1000; // 24 hours

  if (diff > MAX_DIFF) {
    // Timestamp is very old or in the future - return current server time
    return now;
  }

  return timestamp;
}

/**
 * Check if server time is synced
 */
export function isServerTimeSynced(): boolean {
  return isSynced;
}
