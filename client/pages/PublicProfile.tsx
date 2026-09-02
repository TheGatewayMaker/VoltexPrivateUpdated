import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import Layout from "@/components/Layout";
import { UserAvatar } from "@/components/UserAvatar";
import { Loader } from "@/components/ui/loader";
import { formatPublicProfileCreationDate } from "@/lib/dateFormatter";
import { useWebSocket } from "@/lib/useWebSocket";
import * as browserStorage from "@/lib/browserStorage";
import { toast } from "sonner";

interface PublicProfileData {
  username: string | null;
  displayName: string;
  bio: string;
  avatar: string | null;
  createdAt?: number | string | null;
}

interface DirectBlockStatus {
  blockedByMe: boolean;
  blockedMe: boolean;
  isMutual: boolean;
  canSend: boolean;
}

const ALLOW_ALL_DIRECT_MESSAGES: DirectBlockStatus = {
  blockedByMe: false,
  blockedMe: false,
  isMutual: false,
  canSend: true,
};

function normalizeUsername(value: string): string {
  return value.trim().replace(/^@+/, "").toLowerCase();
}

export default function PublicProfile() {
  const navigate = useNavigate();
  const { username = "" } = useParams<{ username: string }>();
  const [profile, setProfile] = useState<PublicProfileData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [isOwnProfile, setIsOwnProfile] = useState(false);
  const [directBlockStatus, setDirectBlockStatus] = useState<DirectBlockStatus>(
    ALLOW_ALL_DIRECT_MESSAGES,
  );
  const [isBlockActionPending, setIsBlockActionPending] = useState(false);

  const syncBlockStatusForProfile = async (
    sessionToken: string,
    normalizedUsername: string,
    signal?: AbortSignal,
  ) => {
    try {
      const statusResponse = await fetch(
        `/api/blocks/status/by-username/${encodeURIComponent(normalizedUsername)}`,
        {
          headers: {
            Authorization: `Bearer ${sessionToken}`,
          },
          signal,
        },
      );

      if (!statusResponse.ok) {
        return;
      }

      const statusData = await statusResponse.json();
      if (statusData?.status) {
        setDirectBlockStatus({
          blockedByMe: Boolean(statusData.status.blockedByMe),
          blockedMe: Boolean(statusData.status.blockedMe),
          isMutual: Boolean(statusData.status.isMutual),
          canSend: Boolean(statusData.status.canSend),
        });
      }
    } catch (error) {
      if (!signal?.aborted) {
        console.error("Failed to load profile block status:", error);
      }
    }
  };

  useEffect(() => {
    const normalizedUsername = normalizeUsername(username);
    if (!normalizedUsername) {
      setError("Profile not found");
      setIsLoading(false);
      return;
    }

    const controller = new AbortController();

    const loadProfile = async () => {
      try {
        setIsLoading(true);
        setError("");

        const response = await fetch(
          `/api/profile/by-username/${encodeURIComponent(normalizedUsername)}`,
          {
            signal: controller.signal,
          },
        );

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || "Profile not found");
        }

        const data = await response.json();
        setProfile({
          username: data.username || normalizedUsername,
          displayName: data.displayName || "User",
          bio: data.bio || "",
          avatar: data.avatar || null,
          createdAt: data.createdAt ?? null,
        });
      } catch (fetchError) {
        if (controller.signal.aborted) {
          return;
        }

        setError(
          fetchError instanceof Error
            ? fetchError.message
            : "Failed to load profile",
        );
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      }
    };

    void loadProfile();

    return () => controller.abort();
  }, [username]);

  useEffect(() => {
    const normalizedUsername = normalizeUsername(username);
    if (!normalizedUsername) {
      return;
    }

    const sessionToken = browserStorage.getItem("session_token");
    if (!sessionToken) {
      setIsOwnProfile(false);
      setDirectBlockStatus(ALLOW_ALL_DIRECT_MESSAGES);
      return;
    }

    const controller = new AbortController();

    const loadBlockContext = async () => {
      try {
        const meResponse = await fetch("/api/profile/me", {
          headers: {
            Authorization: `Bearer ${sessionToken}`,
          },
          signal: controller.signal,
        });

        if (meResponse.ok) {
          const meData = await meResponse.json();
          const meUsername = normalizeUsername(String(meData.username || ""));
          setIsOwnProfile(meUsername === normalizedUsername);
        } else {
          setIsOwnProfile(false);
        }

        await syncBlockStatusForProfile(
          sessionToken,
          normalizedUsername,
          controller.signal,
        );
      } catch (loadError) {
        if (!controller.signal.aborted) {
          console.error("Failed to load profile block context:", loadError);
        }
      }
    };

    void loadBlockContext();

    return () => controller.abort();
  }, [username]);

  const toggleBlockState = async () => {
    const normalizedUsername = normalizeUsername(username);
    const sessionToken = browserStorage.getItem("session_token");
    if (!normalizedUsername || !sessionToken || isOwnProfile || isBlockActionPending) {
      if (!sessionToken) {
        toast.error("Please sign in to manage block settings.");
      }
      return;
    }

    const willBlock = !directBlockStatus.blockedByMe;
    if (willBlock) {
      const confirmed = window.confirm(
        "Are you sure you want to block this person? You will not be able to send messages until you unblock them.",
      );
      if (!confirmed) {
        return;
      }
    }

    setIsBlockActionPending(true);
    try {
      const response = await fetch(
        `/api/blocks/by-username/${encodeURIComponent(normalizedUsername)}`,
        {
          method: willBlock ? "POST" : "DELETE",
          headers: {
            Authorization: `Bearer ${sessionToken}`,
          },
        },
      );
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || "Failed to update block status");
      }

      if (data?.status) {
        setDirectBlockStatus({
          blockedByMe: Boolean(data.status.blockedByMe),
          blockedMe: Boolean(data.status.blockedMe),
          isMutual: Boolean(data.status.isMutual),
          canSend: Boolean(data.status.canSend),
        });
      }
      toast.success(willBlock ? "User blocked" : "User unblocked");
    } catch (toggleError) {
      const message =
        toggleError instanceof Error
          ? toggleError.message
          : "Failed to update block status";
      setError(message);
      toast.error(message);
    } finally {
      setIsBlockActionPending(false);
    }
  };

  useWebSocket({
    onDirectBlockUpdated: () => {
      const normalizedUsername = normalizeUsername(username);
      const sessionToken = browserStorage.getItem("session_token");
      if (!normalizedUsername || !sessionToken) {
        return;
      }
      void syncBlockStatusForProfile(sessionToken, normalizedUsername);
    },
  });

  return (
    <Layout
      showBack={true}
      title={profile?.displayName || "Profile"}
      onBackClick={() => navigate(-1)}
      showProfileMenu={false}
    >
      <div className="h-full overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-4 py-5 pb-10 sm:px-6 sm:py-6 sm:pb-12 lg:px-8 lg:py-8 lg:pb-16">
          {isLoading ? (
            <div className="flex min-h-[60vh] items-center justify-center">
              <div className="flex flex-col items-center gap-4 text-center">
                <Loader size="lg" />
                <p className="text-sm font-semibold text-muted-foreground">
                  Loading profile
                </p>
              </div>
            </div>
          ) : error || !profile ? (
            <div className="flex min-h-[60vh] items-center justify-center">
              <div className="w-full max-w-lg rounded-[28px] border border-border bg-card px-6 py-8 text-center">
                <p className="tactical-kicker">Profile</p>
                <h1 className="mt-3 text-4xl font-black text-foreground">
                  Not Found
                </h1>
                <p className="mt-3 text-sm font-medium text-muted-foreground">
                  {error || "This profile is unavailable."}
                </p>
              </div>
            </div>
          ) : (
            <section className="rounded-[28px] border border-border/70 bg-card/88">
              <div className="border-b border-border/70 px-4 py-5 sm:px-6 sm:py-6">
                <div className="flex items-start gap-4 sm:gap-6">
                  <UserAvatar
                    name={profile.displayName}
                    avatar={profile.avatar}
                    className="h-20 w-20 rounded-full ring-0 sm:h-24 sm:w-24 md:h-28 md:w-28"
                    fallbackClassName="rounded-full bg-primary/14 text-2xl font-black text-primary sm:text-3xl"
                  />

                  <div className="min-w-0 flex-1 pt-1">
                    <div className="flex flex-col gap-2">
                      <h1 className="truncate text-2xl font-black text-foreground sm:text-3xl">
                        @{profile.username}
                      </h1>
                      <p className="text-base font-extrabold text-foreground sm:text-lg">
                        {profile.displayName}
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="px-4 py-5 sm:px-6 sm:py-6">
                {!isOwnProfile ? (
                  <div className="mb-5 border border-border/60 bg-background/20 px-4 py-4 sm:px-5">
                    <button
                      type="button"
                      onClick={toggleBlockState}
                      disabled={isBlockActionPending}
                      className={`w-full border px-4 py-3 text-sm font-black tracking-wide transition ${
                        directBlockStatus.blockedByMe
                          ? "border-border text-foreground hover:bg-accent"
                          : "border-destructive text-destructive hover:bg-destructive/10"
                      } disabled:cursor-not-allowed disabled:opacity-60`}
                    >
                      {isBlockActionPending
                        ? "Please wait..."
                        : directBlockStatus.blockedByMe
                          ? "Unblock this person"
                          : "Block this person"}
                    </button>
                  </div>
                ) : null}

                <div className="mb-5 rounded-3xl border border-border/60 bg-background/20 px-4 py-4 sm:px-5">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    Account created
                  </p>
                  <p className="mt-3 text-sm font-medium leading-7 text-foreground sm:text-base">
                    {formatPublicProfileCreationDate(profile.createdAt)}
                  </p>
                </div>

                <div className="rounded-3xl border border-border/60 bg-background/20 px-4 py-4 sm:px-5">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    Bio
                  </p>
                  <p className="mt-3 whitespace-pre-wrap text-sm font-medium leading-7 text-foreground sm:text-base">
                    {profile.bio || "No bio yet."}
                  </p>
                </div>
              </div>
            </section>
          )}
        </div>
      </div>
    </Layout>
  );
}
