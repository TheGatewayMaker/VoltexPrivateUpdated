import { ChangeEvent, useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Check, AlertCircle, Eye, EyeOff, ImagePlus, LogOut, Trash2 } from "lucide-react";
import Layout from "@/components/Layout";
import AvatarCropDialog from "@/components/AvatarCropDialog";
import { UserAvatar } from "@/components/UserAvatar";
import { Loader } from "@/components/ui/loader";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { formatAccountCreationDate } from "@/lib/dateFormatter";
import { toast } from "sonner";
import * as browserStorage from "@/lib/browserStorage";
import { fetchPasskeyStatus, verifyPasskeyStepUp } from "@/lib/passkeys";
import {
  deriveRecoveryVerifier,
  hashPassphrase,
  normalizePassphrase,
  validatePassphraseFormat,
} from "@/lib/passphrase";
import { PasskeyStatusResponse } from "@shared/passkeys";

const DISPLAY_NAME_MAX_LENGTH = 25;

interface UserProfile {
  userId?: string;
  displayName?: string;
  username?: string | null;
  bio?: string;
  avatar?: string;
  createdAt?: number | string;
}

interface DeviceSession {
  sessionId: string;
  current: boolean;
  online: boolean;
  deviceName: string;
  platform: string;
  loginAt: number;
  lastActiveAt: number;
  expiresAt: number;
}

export default function Account() {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [showUserId, setShowUserId] = useState(false);
  const [cropImageUrl, setCropImageUrl] = useState<string | null>(null);
  const [cropImageType, setCropImageType] = useState<"image/jpeg" | "image/png" | null>(null);
  const [deviceSessions, setDeviceSessions] = useState<DeviceSession[]>([]);
  const [isDeviceSessionsLoading, setIsDeviceSessionsLoading] = useState(false);
  const [deviceSessionsError, setDeviceSessionsError] = useState<string | null>(null);
  const [isRevokingDevice, setIsRevokingDevice] = useState(false);
  const [revokeTargetSession, setRevokeTargetSession] = useState<DeviceSession | null>(null);
  const [revokePassphraseInput, setRevokePassphraseInput] = useState("");
  const [passkeyStatus, setPasskeyStatus] = useState<PasskeyStatusResponse>({
    enabled: false,
  });
  const [passkeyStepUpToken, setPasskeyStepUpToken] = useState<string | null>(null);
  const [isVerifyingPasskeyStepUp, setIsVerifyingPasskeyStepUp] = useState(false);

  useEffect(() => {
    // Check if user is authenticated
    const sessionToken = browserStorage.getItem("session_token");

    if (!sessionToken) {
      navigate("/signin");
      return;
    }

    void Promise.all([fetchProfile(), fetchDeviceSessions(), fetchCurrentPasskeyStatus()]);
  }, [navigate]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void fetchDeviceSessions({ silent: true });
    }, 20_000);

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void fetchDeviceSessions({ silent: true });
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (cropImageUrl) {
        URL.revokeObjectURL(cropImageUrl);
      }
    };
  }, [cropImageUrl]);

  const fetchProfile = async () => {
    try {
      setIsLoading(true);
      const sessionToken = browserStorage.getItem("session_token");

      const response = await fetch("/api/profile/me", {
        headers: {
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      if (!response.ok) {
        throw new Error("Failed to fetch profile");
      }

      const data = await response.json();

      setProfile({
        ...data,
      });

      setDisplayName(data.displayName || "");
      setBio(data.bio || "");
    } catch (error) {
      console.error("Error fetching profile:", error);
      toast.error("Failed to load profile");
    } finally {
      setIsLoading(false);
    }
  };

  const fetchCurrentPasskeyStatus = async () => {
    try {
      const status = await fetchPasskeyStatus();
      setPasskeyStatus(status);
    } catch {
      setPasskeyStatus({ enabled: false });
    }
  };

  const fetchDeviceSessions = async (options?: { silent?: boolean }) => {
    const silent = options?.silent === true;
    try {
      if (!silent) {
        setIsDeviceSessionsLoading(true);
      }
      setDeviceSessionsError(null);
      const sessionToken = browserStorage.getItem("session_token");

      const response = await fetch("/api/auth/sessions", {
        headers: {
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      if (!response.ok) {
        throw new Error("Failed to load logged-in devices");
      }

      const data = await response.json();
      const devices = Array.isArray(data?.devices) ? data.devices : [];
      const now = Date.now();
      const normalized = devices
        .filter(
          (device: any) =>
            typeof device?.sessionId === "string" &&
            typeof device?.deviceName === "string",
        )
        .map((device: any) => ({
          sessionId: device.sessionId,
          current: device.current === true,
          online: device.online === true,
          deviceName: device.deviceName,
          platform:
            typeof device.platform === "string" ? device.platform : "Unknown",
          loginAt: typeof device.loginAt === "number" ? device.loginAt : now,
          lastActiveAt:
            typeof device.lastActiveAt === "number" ? device.lastActiveAt : now,
          expiresAt: typeof device.expiresAt === "number" ? device.expiresAt : now,
        }));
      setDeviceSessions(normalized);
    } catch (error) {
      console.error("Error fetching account sessions:", error);
      if (!silent) {
        setDeviceSessionsError("Failed to load logged-in devices");
      }

      // Keep account controls usable even if device-history endpoint fails by showing this device.
      try {
        const sessionToken = browserStorage.getItem("session_token");
        const fallbackResponse = await fetch("/api/auth/verify-session", {
          headers: {
            Authorization: `Bearer ${sessionToken}`,
          },
        });
        if (fallbackResponse.ok) {
          const fallbackData = await fallbackResponse.json();
          setDeviceSessions((current) => {
            if (current.some((device) => device.current)) {
              return current;
            }
            return [
              {
                sessionId: `current-${fallbackData.userId || "session"}`,
                current: true,
                online: true,
                deviceName: "This Device",
                platform: "Current Session",
                loginAt: Date.now(),
                lastActiveAt: Date.now(),
                expiresAt:
                  typeof fallbackData.expiresAt === "number"
                    ? fallbackData.expiresAt
                    : Date.now() + 24 * 60 * 60 * 1000,
              },
            ];
          });
        }
      } catch (fallbackError) {
        console.error("Fallback device session load failed:", fallbackError);
      }
    } finally {
      if (!silent) {
        setIsDeviceSessionsLoading(false);
      }
    }
  };

  const buildRecoveryPayload = async (passphrase: string) => {
    const userId = profile?.userId || "";
    if (!userId) {
      throw new Error("User account is unavailable");
    }

    const normalized = normalizePassphrase(passphrase);
    if (!validatePassphraseFormat(normalized)) {
      throw new Error("Enter your full 24-word recovery passphrase");
    }

    const response = await fetch(
      `/api/auth/recovery-params/by-user-id/${encodeURIComponent(userId)}`,
    );
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || "Failed to load recovery configuration");
    }

    const params = await response.json();
    if (params.version === 2) {
      return {
        recoveryVerifier: await deriveRecoveryVerifier(
          normalized,
          params.salt,
          params.iterations,
        ),
      };
    }

    return {
      passphraseHash: await hashPassphrase(normalized),
    };
  };

  const closeRevokeDialog = () => {
    if (isRevokingDevice) {
      return;
    }
    setRevokeTargetSession(null);
    setRevokePassphraseInput("");
    setPasskeyStepUpToken(null);
  };

  const handleVerifyPasskeyForRevoke = async () => {
    try {
      setIsVerifyingPasskeyStepUp(true);
      const result = await verifyPasskeyStepUp();
      setPasskeyStepUpToken(result.verificationToken);
      toast.success("Passkey verification complete");
    } catch (error) {
      console.error("Passkey step-up failed:", error);
      toast.error(
        error instanceof Error ? error.message : "Passkey verification failed",
      );
    } finally {
      setIsVerifyingPasskeyStepUp(false);
    }
  };

  const handleRevokeDeviceSession = async () => {
    if (!revokeTargetSession) {
      return;
    }

    try {
      setIsRevokingDevice(true);

      const recoveryPayload = await buildRecoveryPayload(revokePassphraseInput);
      if (passkeyStatus.enabled && !passkeyStepUpToken) {
        throw new Error("Passkey verification is required");
      }

      const sessionToken = browserStorage.getItem("session_token");
      const response = await fetch(
        `/api/auth/sessions/${encodeURIComponent(revokeTargetSession.sessionId)}/revoke`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${sessionToken}`,
          },
          body: JSON.stringify({
            ...recoveryPayload,
            passkeyStepUpToken: passkeyStatus.enabled ? passkeyStepUpToken : undefined,
          }),
        },
      );

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Failed to log out device");
      }

      const revokedCurrentSession = payload?.revokedCurrentSession === true;
      if (revokedCurrentSession) {
        toast.success("This device session was revoked");
        void browserStorage.clear();
        navigate("/signin");
        return;
      }

      setDeviceSessions((current) =>
        current.filter(
          (device) => device.sessionId !== revokeTargetSession.sessionId,
        ),
      );
      toast.success("Selected device logged out successfully");
      closeRevokeDialog();
    } catch (error) {
      console.error("Revoke device session failed:", error);
      toast.error(error instanceof Error ? error.message : "Failed to log out device");
    } finally {
      setIsRevokingDevice(false);
    }
  };

  const formatDeviceDateTime = (value: number) =>
    new Date(value).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });

  const handleSaveProfile = async () => {
    try {
      const normalizedDisplayName = displayName.trim();

      if (normalizedDisplayName.length > DISPLAY_NAME_MAX_LENGTH) {
        toast.error(
          `Display name must be ${DISPLAY_NAME_MAX_LENGTH} characters or fewer`,
        );
        return;
      }

      setIsSaving(true);
      const sessionToken = browserStorage.getItem("session_token");

      const response = await fetch("/api/profile/me", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({
          displayName: normalizedDisplayName || undefined,
          bio: bio || undefined,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to update profile");
      }

      const data = await response.json();
      setProfile(data.profile);
      toast.success("Profile updated successfully");
    } catch (error) {
      console.error("Error saving profile:", error);
      toast.error("Failed to save profile");
    } finally {
      setIsSaving(false);
    }
  };

  const closeCropDialog = () => {
    if (cropImageUrl) {
      URL.revokeObjectURL(cropImageUrl);
    }
    setCropImageUrl(null);
    setCropImageType(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleAvatarFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    const normalizedType =
      file.type === "image/png" ? "image/png" : file.type === "image/jpeg" ? "image/jpeg" : null;

    if (!normalizedType) {
      toast.error("Only JPG, JPEG, and PNG images are allowed");
      event.target.value = "";
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      toast.error("Profile photos must be 5MB or smaller");
      event.target.value = "";
      return;
    }

    if (cropImageUrl) {
      URL.revokeObjectURL(cropImageUrl);
    }

    setCropImageUrl(URL.createObjectURL(file));
    setCropImageType(normalizedType);
  };

  const handleSaveAvatar = async (file: File) => {
    try {
      setIsUploadingAvatar(true);
      const sessionToken = browserStorage.getItem("session_token");

      const response = await fetch("/api/profile/avatar", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          "Content-Type": file.type,
        },
        body: await file.arrayBuffer(),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || "Failed to upload profile photo");
      }

      const data = await response.json();
      setProfile(data.profile);
      closeCropDialog();
      toast.success("Profile photo updated");
    } catch (error) {
      console.error("Error uploading avatar:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to upload profile photo",
      );
    } finally {
      setIsUploadingAvatar(false);
    }
  };

  const handleRemoveAvatar = async () => {
    try {
      setIsUploadingAvatar(true);
      const sessionToken = browserStorage.getItem("session_token");
      const response = await fetch("/api/profile/avatar", {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || "Failed to remove profile photo");
      }

      const data = await response.json();
      setProfile(data.profile);
      toast.success("Profile photo removed");
    } catch (error) {
      console.error("Error removing avatar:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to remove profile photo",
      );
    } finally {
      setIsUploadingAvatar(false);
    }
  };

  const copyToClipboard = async (text: string, field: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      toast.success(`${field} copied to clipboard`);
      setTimeout(() => setCopiedField(null), 2000);
    } catch {
      try {
        const textArea = document.createElement("textarea");
        textArea.value = text;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand("copy");
        document.body.removeChild(textArea);
        setCopiedField(field);
        toast.success(`${field} copied to clipboard`);
        setTimeout(() => setCopiedField(null), 2000);
      } catch {
        toast.error("Failed to copy to clipboard");
      }
    }
  };

  const handleLogout = async () => {
    try {
      const sessionToken = browserStorage.getItem("session_token");
      if (sessionToken) {
        await fetch("/api/auth/logout", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${sessionToken}`,
          },
        });
      }
    } catch (error) {
      console.error("Logout error:", error);
    } finally {
      void browserStorage.clear();
      navigate("/signin");
    }
  };

  if (isLoading) {
    return (
      <Layout
        showProfileMenu={false}
        showBack={true}
        onBackClick={() => navigate("/")}
        title="Account"
      >
        <div className="flex items-center justify-center h-full">
          <div className="flex flex-col items-center gap-4 text-center">
            <Loader size="lg" />
            <p className="text-muted-foreground">Loading profile...</p>
          </div>
        </div>
      </Layout>
    );
  }

  if (!profile) {
    return (
      <Layout
        showProfileMenu={false}
        showBack={true}
        onBackClick={() => navigate("/")}
        title="Account"
      >
        <div className="flex items-center justify-center h-full">
          <div className="text-center">
            <p className="text-destructive">Failed to load profile</p>
          </div>
        </div>
      </Layout>
    );
  }

  return (
    <Layout
      showBack={true}
      title="Account"
      onBackClick={() => navigate("/")}
      showProfileMenu={false}
    >
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
        <div className="mx-auto max-w-6xl px-4 py-5 pb-[calc(env(safe-area-inset-bottom)+2.5rem)] sm:px-6 sm:py-6 sm:pb-[calc(env(safe-area-inset-bottom)+3.5rem)] lg:px-8 lg:py-8">
          <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)] lg:items-start">
            <aside className="lg:sticky lg:top-0">
              <div className="rounded-3xl border border-border bg-card p-5 shadow-sm sm:p-6">
                <div className="mb-5">
                  <UserAvatar
                    name={displayName || "Your Account"}
                    avatar={profile.avatar}
                    className="h-20 w-20 rounded-[28px]"
                    fallbackClassName="rounded-[28px] bg-primary/12 text-2xl font-black text-primary"
                  />
                </div>
                <h1 className="break-words text-3xl font-black tracking-[-0.05em] text-foreground sm:text-4xl">
                  {displayName || "Your Account"}
                </h1>
                <p className="mt-2 text-sm font-medium text-muted-foreground sm:text-base">
                  Manage your profile details, account identity, and session access.
                </p>

                <div className="mt-6 space-y-3">
                  <div className="rounded-2xl border border-border bg-secondary/50 p-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                      Username
                    </p>
                    <p className="mt-2 break-words text-sm font-semibold text-foreground">
                      {profile.username ? `@${profile.username}` : "Not set"}
                    </p>
                  </div>

                  <div className="rounded-2xl border border-primary/30 bg-primary/10 p-4">
                    <div className="flex gap-3">
                      <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary sm:h-5 sm:w-5" />
                      <div>
                        <p className="text-sm font-semibold text-primary">
                          End-to-end encrypted
                        </p>
                        <p className="mt-1 text-xs text-primary/90 sm:text-sm">
                          Your messages are encrypted on your device before they are sent.
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </aside>

            <div className="space-y-6">
              <section className="rounded-3xl border border-border bg-card p-5 shadow-sm sm:p-6">
                <div className="mb-5">
                  <h2 className="text-2xl font-black tracking-[-0.04em] text-foreground">
                    Profile
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Update the name and profile text shown to other people.
                  </p>
                </div>

                <div className="space-y-5">
                  <div className="rounded-2xl border border-border bg-secondary/40 p-4">
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <label className="block text-sm font-medium text-foreground">
                          Profile photo
                        </label>
                        <p className="mt-1 text-xs text-muted-foreground sm:text-sm">
                          Upload a JPG or PNG image up to 5MB. You can crop it before saving.
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept="image/jpeg,image/png"
                          onChange={handleAvatarFileChange}
                          className="hidden"
                        />
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          disabled={isUploadingAvatar}
                          className="tactical-button h-11 text-sm font-semibold"
                        >
                          {isUploadingAvatar ? <Loader size="sm" /> : <ImagePlus className="h-4 w-4" />}
                          {profile.avatar ? "Change photo" : "Upload photo"}
                        </button>
                        {profile.avatar ? (
                          <button
                            type="button"
                            onClick={handleRemoveAvatar}
                            disabled={isUploadingAvatar}
                            className="tactical-button-outline h-11 text-sm font-semibold"
                          >
                            <Trash2 className="h-4 w-4" />
                            Remove
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  <div>
                    <label className="mb-2 block text-sm font-medium text-foreground">
                      Display name
                    </label>
                    <input
                      type="text"
                      value={displayName}
                      onChange={(e) =>
                        setDisplayName(
                          e.target.value.slice(0, DISPLAY_NAME_MAX_LENGTH),
                        )
                      }
                      placeholder="Add a display name"
                      maxLength={DISPLAY_NAME_MAX_LENGTH}
                      className="w-full rounded-2xl border border-border bg-secondary px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary sm:text-base"
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      {displayName.length}/{DISPLAY_NAME_MAX_LENGTH} characters
                    </p>
                  </div>

                  <div>
                    <label className="mb-2 block text-sm font-medium text-foreground">
                      About
                    </label>
                    <textarea
                      value={bio}
                      onChange={(e) => setBio(e.target.value)}
                      placeholder="Tell others about yourself"
                      maxLength={200}
                      rows={4}
                      className="w-full resize-none rounded-2xl border border-border bg-secondary px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary sm:text-base"
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      {bio.length}/200 characters
                    </p>
                  </div>

                  <div>
                    <label className="mb-2 block text-sm font-medium text-foreground">
                      Account created
                    </label>
                    <div className="rounded-2xl border border-border bg-secondary px-4 py-3 text-sm text-foreground sm:text-base">
                      {formatAccountCreationDate(profile.createdAt)}
                    </div>
                  </div>

                  <button
                    onClick={handleSaveProfile}
                    disabled={isSaving}
                    className="tactical-button w-full text-sm font-semibold sm:text-base"
                  >
                    {isSaving ? (
                      <>
                        <Loader size="sm" className="shrink-0" />
                        Saving...
                      </>
                    ) : (
                      <>
                        <Check className="h-4 w-4" />
                        Save changes
                      </>
                    )}
                  </button>
                </div>
              </section>

              <section className="rounded-3xl border border-border bg-card p-5 shadow-sm sm:p-6">
                <div className="mb-5">
                  <h2 className="text-2xl font-black tracking-[-0.04em] text-foreground">
                    Unique User ID
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    This private identifier is visible only to you on this page.
                  </p>
                </div>

                <div className="space-y-4">
                  <div className="rounded-2xl border border-amber-500/35 bg-amber-500/10 p-4">
                    <div className="flex gap-3">
                      <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-300" />
                      <div>
                        <p className="text-sm font-semibold text-foreground">
                          Save these credentials somewhere secure
                        </p>
                        <p className="mt-1 text-sm leading-6 text-muted-foreground">
                          Your 16-character User ID and your 24-word passphrase key are both required to log back into this account. Store them safely. Without them, recovering access may be impossible.
                        </p>
                      </div>
                    </div>
                  </div>

                  <div>
                    <label className="mb-2 block text-sm font-medium text-foreground">
                      16-character user ID
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type={showUserId ? "text" : "password"}
                        value={profile.userId || ""}
                        readOnly
                        className="min-w-0 flex-1 rounded-2xl border border-border bg-secondary px-4 py-3 font-mono text-sm text-foreground sm:text-base"
                      />
                      <button
                        type="button"
                        onClick={() => setShowUserId((value) => !value)}
                        className="tactical-icon-button h-11 w-11 flex-shrink-0"
                        title={showUserId ? "Hide ID" : "Show ID"}
                      >
                        {showUserId ? (
                          <EyeOff className="h-4 w-4 sm:h-5 sm:w-5" />
                        ) : (
                          <Eye className="h-4 w-4 sm:h-5 sm:w-5" />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          profile.userId
                            ? copyToClipboard(profile.userId, "User ID")
                            : null
                        }
                        disabled={!profile.userId}
                        className="tactical-icon-button h-11 w-11 flex-shrink-0"
                        title="Copy user ID"
                      >
                        {copiedField === "User ID" ? (
                          <Check className="h-4 w-4 text-primary sm:h-5 sm:w-5" />
                        ) : (
                          <svg
                            className="h-4 w-4 sm:h-5 sm:w-5"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                            />
                          </svg>
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              </section>

              <section className="rounded-3xl border border-border bg-card p-5 shadow-sm sm:p-6">
                <div className="mb-5">
                  <h2 className="text-2xl font-black tracking-[-0.04em] text-foreground">
                    Logged-in Devices
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Review your active device sessions and revoke access per device.
                  </p>
                </div>

                {deviceSessionsError ? (
                  <div className="mb-4 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive sm:text-sm">
                    {deviceSessionsError}
                  </div>
                ) : null}

                {isDeviceSessionsLoading ? (
                  <div className="flex items-center justify-center rounded-2xl border border-border bg-secondary/30 px-4 py-8">
                    <div className="flex flex-col items-center gap-3 text-center">
                      <Loader size="md" />
                      <p className="text-sm text-muted-foreground">Loading devices...</p>
                    </div>
                  </div>
                ) : deviceSessions.length === 0 ? (
                  <div className="rounded-2xl border border-border bg-secondary/30 px-4 py-6 text-sm text-muted-foreground">
                    No active devices found.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {deviceSessions.map((device) => {
                      const canRevoke = /^[a-f0-9]{64}$/.test(device.sessionId);
                      return (
                        <div
                          key={device.sessionId}
                          className="rounded-2xl border border-border bg-secondary/35 p-4"
                        >
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div className="space-y-2">
                              <p className="text-sm font-semibold text-foreground sm:text-base">
                                {device.deviceName}
                                {device.current ? (
                                  <span className="ml-2 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs font-semibold uppercase tracking-[0.1em] text-primary">
                                    Current
                                  </span>
                                ) : null}
                                {device.online ? (
                                  <span className="ml-2 rounded-full border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-xs font-semibold uppercase tracking-[0.1em] text-emerald-400">
                                    Online
                                  </span>
                                ) : null}
                              </p>
                              <p className="text-xs text-muted-foreground sm:text-sm">
                                Platform: {device.platform}
                              </p>
                              <p className="text-xs text-muted-foreground sm:text-sm">
                                Login time: {formatDeviceDateTime(device.loginAt)}
                              </p>
                              {device.online ? (
                                <p className="text-xs text-emerald-300 sm:text-sm">
                                  Last active: Online now
                                </p>
                              ) : (
                                <p className="text-xs text-muted-foreground sm:text-sm">
                                  Last active: {formatDeviceDateTime(device.lastActiveAt)}
                                </p>
                              )}
                            </div>
                            <button
                              type="button"
                              onClick={() => {
                                setRevokeTargetSession(device);
                                setRevokePassphraseInput("");
                                setPasskeyStepUpToken(null);
                              }}
                              disabled={!canRevoke}
                              className="inline-flex h-10 items-center justify-center rounded-lg border border-destructive px-4 text-xs font-semibold uppercase tracking-[0.14em] text-destructive transition hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {canRevoke ? "Logout" : "Unavailable"}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>

              <section className="rounded-3xl border border-destructive/30 bg-destructive/5 p-5 shadow-sm sm:p-6">
                <div className="mb-5">
                  <h2 className="text-2xl font-black tracking-[-0.04em] text-foreground">
                    Danger Zone
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Sign out from this device when you are done using it.
                  </p>
                </div>

                <button
                  onClick={handleLogout}
                  className="tactical-chip-button-danger w-full gap-2 px-4 py-3 text-sm sm:text-base"
                >
                  <LogOut className="h-4 w-4" />
                  Sign Out
                </button>
              </section>
            </div>
          </div>
        </div>
      </div>
      <AlertDialog
        open={!!revokeTargetSession}
        onOpenChange={(open) => !open && closeRevokeDialog()}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Logout this device</AlertDialogTitle>
            <AlertDialogDescription>
              {revokeTargetSession
                ? `Revoke access for ${revokeTargetSession.deviceName}.`
                : "Revoke access for this device session."}
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-3">
            <div className="rounded-lg border border-border bg-secondary/30 p-3 text-xs text-muted-foreground">
              <p>Every device logout requires passphrase verification.</p>
              <p className="mt-1">
                {passkeyStatus.enabled
                  ? "Because passkey is enabled on this account, passkey verification is also required for this action."
                  : "Passkey is not enabled for this account, so passphrase verification is sufficient."}
              </p>
            </div>

            {passkeyStatus.enabled ? (
              <button
                type="button"
                onClick={() => void handleVerifyPasskeyForRevoke()}
                disabled={isVerifyingPasskeyStepUp || isRevokingDevice}
                className="tactical-button-outline h-10 w-full text-xs font-semibold uppercase tracking-[0.14em] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isVerifyingPasskeyStepUp
                  ? "Verifying passkey..."
                  : passkeyStepUpToken
                    ? "Passkey Verified"
                    : "Verify Passkey"}
              </button>
            ) : null}

            <div className="space-y-2">
              <label className="block text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
                Recovery passphrase
              </label>
              <textarea
                value={revokePassphraseInput}
                onChange={(event) => setRevokePassphraseInput(event.target.value)}
                placeholder="word1 word2 word3 ... word24"
                className="tactical-input h-24 w-full resize-none px-4 py-3 font-mono text-sm"
                disabled={isRevokingDevice}
              />
            </div>
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={isRevokingDevice}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void handleRevokeDeviceSession();
              }}
              disabled={
                isRevokingDevice ||
                (passkeyStatus.enabled && !passkeyStepUpToken) ||
                isVerifyingPasskeyStepUp
              }
            >
              {isRevokingDevice ? "Revoking..." : "Logout Device"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AvatarCropDialog
        open={Boolean(cropImageUrl)}
        imageUrl={cropImageUrl}
        imageType={cropImageType}
        isSaving={isUploadingAvatar}
        onOpenChange={(open) => {
          if (!open) {
            closeCropDialog();
          }
        }}
        onSave={handleSaveAvatar}
      />
    </Layout>
  );
}
