import { describe, expect, it } from "vitest";
import {
  formatAccountCreationDate,
  formatConversationTime,
  formatMessageTimestamp,
  formatPublicProfileCreationDate,
} from "./dateFormatter";

describe("dateFormatter", () => {
  it("formats numeric millisecond timestamps", () => {
    expect(formatMessageTimestamp(1775199982378)).toBe("03-04-2026 07:06 AM");
  });

  it("formats persisted numeric string timestamps", () => {
    expect(formatMessageTimestamp("1775199982378")).toBe(
      "03-04-2026 07:06 AM",
    );
  });

  it("formats persisted ISO timestamps instead of showing invalid date", () => {
    expect(formatMessageTimestamp("2026-04-03T07:06:22.378Z")).toBe(
      "03-04-2026 07:06 AM",
    );
  });

  it("supports seconds-based timestamps when rendering conversation time", () => {
    expect(formatConversationTime("1775199982", 1775199982378)).toBe(
      "07:06 AM",
    );
  });

  it("keeps invalid fallback for truly bad timestamps", () => {
    expect(formatMessageTimestamp("not-a-date")).toBe("Invalid date");
    expect(formatConversationTime("not-a-date", 1775199982378)).toBe("now");
  });

  it("formats account creation dates with day month and year", () => {
    expect(formatAccountCreationDate("1775192869885")).toBe("April 3, 2026");
  });

  it("formats public profile creation dates with month and year only", () => {
    expect(formatPublicProfileCreationDate("1775192869885")).toBe("April 2026");
  });
});
