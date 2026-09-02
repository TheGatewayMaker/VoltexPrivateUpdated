import { query, queryOne, isDatabaseConnected } from "./db";
import {
  getUserProfile as getUserProfileR2,
  saveUserProfile as saveUserProfileR2,
} from "./r2-storage";

export interface UserProfileRecord {
  userId: string;
  displayName?: string;
  bio?: string;
  avatar?: string | null;
  notifications?: boolean;
  notificationEmail?: string | null;
  privacy?: string;
  showTimestamps?: boolean;
  createdAt: number;
  updatedAt?: number;
}

interface ProfilePrivacySettings {
  usernameDiscoveryEnabled?: boolean;
  [key: string]: unknown;
}

export function parseProfilePrivacySettings(
  privacy: string | undefined | null,
): ProfilePrivacySettings {
  if (!privacy || typeof privacy !== "string") {
    return {};
  }

  try {
    const parsed = JSON.parse(privacy);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as ProfilePrivacySettings;
    }
  } catch {
    // Ignore malformed legacy values and fall back to defaults.
  }

  return {};
}

export function isUsernameDiscoveryEnabled(
  profile: UserProfileRecord | null | undefined,
): boolean {
  const privacySettings = parseProfilePrivacySettings(profile?.privacy);
  return typeof privacySettings.usernameDiscoveryEnabled === "boolean"
    ? privacySettings.usernameDiscoveryEnabled
    : true;
}

export function setUsernameDiscoveryEnabled(
  profile: UserProfileRecord,
  enabled: boolean,
): void {
  const currentPrivacy = parseProfilePrivacySettings(profile.privacy);
  profile.privacy = JSON.stringify({
    ...currentPrivacy,
    usernameDiscoveryEnabled: enabled,
  });
}

export async function getUserProfile(
  userId: string,
): Promise<UserProfileRecord | null> {
  if (isDatabaseConnected()) {
    const record = await queryOne<{
      user_id: string;
      display_name: string | null;
      bio: string | null;
      avatar: string | null;
      notifications: boolean | null;
      notification_email: string | null;
      privacy: string | null;
      show_timestamps: boolean | null;
      created_at: number;
      updated_at: number;
    }>(
      `SELECT user_id, display_name, bio, avatar, notifications, notification_email, privacy,
              show_timestamps, created_at, updated_at
       FROM user_profiles
       WHERE user_id = $1
       LIMIT 1;`,
      [userId],
    );

    if (record) {
      return {
        userId: record.user_id,
        displayName: record.display_name || undefined,
        bio: record.bio || undefined,
        avatar: record.avatar,
        notifications:
          typeof record.notifications === "boolean"
            ? record.notifications
            : undefined,
        notificationEmail: record.notification_email || null,
        privacy: record.privacy || undefined,
        showTimestamps:
          typeof record.show_timestamps === "boolean"
            ? record.show_timestamps
            : undefined,
        createdAt: record.created_at,
        updatedAt: record.updated_at,
      };
    }
    return null;
  }

  return getUserProfileR2(userId);
}

export async function saveUserProfile(
  userId: string,
  profile: UserProfileRecord,
): Promise<void> {
  const now = Date.now();
  const createdAt = profile.createdAt || now;

  if (isDatabaseConnected()) {
    await query(
      `INSERT INTO user_profiles (
         user_id, display_name, bio, avatar, notifications, notification_email,
         privacy, show_timestamps, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (user_id) DO UPDATE
       SET display_name = EXCLUDED.display_name,
           bio = EXCLUDED.bio,
           avatar = EXCLUDED.avatar,
           notifications = EXCLUDED.notifications,
           notification_email = EXCLUDED.notification_email,
           privacy = EXCLUDED.privacy,
           show_timestamps = EXCLUDED.show_timestamps,
           updated_at = EXCLUDED.updated_at;`,
      [
        userId,
        profile.displayName || null,
        profile.bio || null,
        profile.avatar || null,
        typeof profile.notifications === "boolean"
          ? profile.notifications
          : null,
        profile.notificationEmail || null,
        profile.privacy || null,
        typeof profile.showTimestamps === "boolean"
          ? profile.showTimestamps
          : null,
        createdAt,
        now,
      ],
    );
    return;
  }

  await saveUserProfileR2(userId, {
    ...profile,
    createdAt,
    updatedAt: now,
  });
}
