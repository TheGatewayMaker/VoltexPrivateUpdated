import { describe, expect, it } from "vitest";
import { normalizeUnreadCount } from "./unreadCount";

describe("normalizeUnreadCount", () => {
  it("keeps numeric counts as integers", () => {
    expect(normalizeUnreadCount(2)).toBe(2);
    expect(normalizeUnreadCount(2.9)).toBe(2);
  });

  it("converts persisted string counts to numbers", () => {
    expect(normalizeUnreadCount("0")).toBe(0);
    expect(normalizeUnreadCount("2")).toBe(2);
    expect(normalizeUnreadCount(" 31 ")).toBe(31);
  });

  it("guards against invalid and negative values", () => {
    expect(normalizeUnreadCount(undefined)).toBe(0);
    expect(normalizeUnreadCount("bad")).toBe(0);
    expect(normalizeUnreadCount(-4)).toBe(0);
  });
});
