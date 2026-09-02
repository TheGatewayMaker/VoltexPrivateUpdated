import { getUserIdByUsername } from "./auth-store";
import { getUserProfile, isUsernameDiscoveryEnabled } from "./profile-store";

export function normalizeUsernameForLookup(value: unknown): string {
  return typeof value === "string"
    ? value.trim().replace(/^@+/, "").toLowerCase()
    : "";
}

export async function resolveDiscoverableUserIdByUsername(input: {
  username: unknown;
  requesterUserId?: string | null;
}): Promise<string> {
  const normalizedUsername = normalizeUsernameForLookup(input.username);
  if (!normalizedUsername) {
    return "";
  }

  const userId = await getUserIdByUsername(normalizedUsername);
  if (!userId) {
    return "";
  }

  if (input.requesterUserId && input.requesterUserId === userId) {
    return userId;
  }

  const profile = await getUserProfile(userId);
  if (!isUsernameDiscoveryEnabled(profile)) {
    return "";
  }

  return userId;
}

