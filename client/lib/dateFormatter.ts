/**
 * Centralized date formatter for consistent timestamp display
 * Ensures all messages display dates in DD-MM-YYYY HH:MM AM/PM format
 */

function parseTimestamp(value: unknown): number | null {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) && time > 0 ? time : null;
  }

  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    const numericValue = Number(trimmed);
    if (Number.isFinite(numericValue) && numericValue > 0) {
      return numericValue < 1_000_000_000_000
        ? numericValue * 1000
        : numericValue;
    }

    const parsedDate = Date.parse(trimmed);
    if (Number.isFinite(parsedDate) && parsedDate > 0) {
      return parsedDate;
    }
  }

  return null;
}

function formatDateParts(
  timestamp: unknown,
  options: Intl.DateTimeFormatOptions,
): string {
  const normalizedTimestamp = parseTimestamp(timestamp);

  if (!normalizedTimestamp) {
    return "Unknown";
  }

  const date = new Date(normalizedTimestamp);
  if (isNaN(date.getTime())) {
    return "Unknown";
  }

  return date.toLocaleDateString("en-US", options);
}

/**
 * Format timestamp to DD-MM-YYYY HH:MM AM/PM
 * @param timestamp - Milliseconds since epoch or a persisted date-compatible value
 * @returns Formatted date string like "26-01-2026 02:34 PM"
 */
export function formatMessageTimestamp(timestamp: unknown): string {
  try {
    const normalizedTimestamp = parseTimestamp(timestamp);

    if (!normalizedTimestamp) {
      return "Invalid date";
    }

    const date = new Date(normalizedTimestamp);

    // Validate date is valid
    if (isNaN(date.getTime())) {
      return "Invalid date";
    }

    // Extract date components
    const day = String(date.getDate()).padStart(2, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const year = date.getFullYear();

    // Extract time components
    let hours = date.getHours();
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const ampm = hours >= 12 ? "PM" : "AM";

    // Convert to 12-hour format
    if (hours > 12) {
      hours -= 12;
    } else if (hours === 0) {
      hours = 12;
    }

    const hoursStr = String(hours).padStart(2, "0");

    // Return in DD-MM-YYYY HH:MM AM/PM format
    return `${day}-${month}-${year} ${hoursStr}:${minutes} ${ampm}`;
  } catch (error) {
    console.error("Error formatting timestamp:", error);
    return "Invalid date";
  }
}

/**
 * Format timestamp for conversation list (shorter format)
 * Shows "HH:MM AM/PM" for today, "DD-MM-YYYY" for other dates
 * @param timestamp - Milliseconds since epoch or a persisted date-compatible value
 * @param nowTimestamp - Current time (for comparison)
 * @returns Formatted time string
 */
export function formatConversationTime(
  timestamp: unknown,
  nowTimestamp: unknown,
): string {
  try {
    const normalizedTimestamp = parseTimestamp(timestamp);
    const normalizedNow = parseTimestamp(nowTimestamp);

    if (!normalizedTimestamp) {
      return "now";
    }

    const date = new Date(normalizedTimestamp);
    const now = new Date(
      Number.isFinite(normalizedNow) && normalizedNow > 0
        ? normalizedNow
        : Date.now(),
    );

    // Validate date is valid
    if (isNaN(date.getTime())) {
      return "now";
    }

    // Check if it's today
    if (date.toDateString() === now.toDateString()) {
      // Format as HH:MM AM/PM for today
      let hours = date.getHours();
      const minutes = String(date.getMinutes()).padStart(2, "0");
      const ampm = hours >= 12 ? "PM" : "AM";

      if (hours > 12) {
        hours -= 12;
      } else if (hours === 0) {
        hours = 12;
      }

      const hoursStr = String(hours).padStart(2, "0");
      return `${hoursStr}:${minutes} ${ampm}`;
    }

    // For past dates, show DD-MM-YYYY format
    const day = String(date.getDate()).padStart(2, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const year = date.getFullYear();

    return `${day}-${month}-${year}`;
  } catch (error) {
    console.error("Error formatting conversation time:", error);
    return "now";
  }
}

export function formatAccountCreationDate(timestamp: unknown): string {
  return formatDateParts(timestamp, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function formatPublicProfileCreationDate(timestamp: unknown): string {
  return formatDateParts(timestamp, {
    year: "numeric",
    month: "long",
  });
}
