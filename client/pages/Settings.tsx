import { useEffect, useMemo, useRef, useState } from "react";
import { useBeforeUnload, useNavigate } from "react-router-dom";
import { Bell, KeyRound, Shield } from "lucide-react";
import Layout from "@/components/Layout";
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
import { toast } from "sonner";
import * as browserStorage from "@/lib/browserStorage";
import {
  createPasskey,
  deletePasskey,
  fetchPasskeyStatus,
  isPasskeySupported,
} from "@/lib/passkeys";
import {
  deriveRecoveryVerifier,
  hashPassphrase,
  normalizePassphrase,
  validatePassphraseFormat,
} from "@/lib/passphrase";
import { PasskeyStatusResponse } from "@shared/passkeys";

interface UserSettings {
  userId?: string;
  notifications?: boolean;
  notificationEmail?: string | null;
  showTimestamps?: boolean;
  usernameDiscoveryEnabled?: boolean;
}

type PasskeyAction = "create" | "delete" | null;
const BROWSER_BACK_PENDING = "__browser_back__";
interface SettingsSnapshot {
  notifications: boolean;
  notificationEmail: string;
  showTimestamps: boolean;
  usernameDiscoveryEnabled: boolean;
}

function toSettingsSnapshot(settings: UserSettings): SettingsSnapshot {
  return {
    notifications: settings.notifications ?? false,
    notificationEmail: (settings.notificationEmail ?? "").trim(),
    showTimestamps: settings.showTimestamps ?? true,
    usernameDiscoveryEnabled: settings.usernameDiscoveryEnabled ?? true,
  };
}

export default function Settings() {
  const navigate = useNavigate();
  const isNotificationEmailValid = (value: string) =>
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
  const [settings, setSettings] = useState<UserSettings>({
    notifications: false,
    notificationEmail: "",
    showTimestamps: true,
    usernameDiscoveryEnabled: true,
  });
  const [savedSnapshot, setSavedSnapshot] = useState<SettingsSnapshot | null>(
    null,
  );
  const [passkeyStatus, setPasskeyStatus] = useState<PasskeyStatusResponse>({
    enabled: false,
  });
  const [passkeySupported, setPasskeySupported] = useState(false);
  const [passkeyAction, setPasskeyAction] = useState<PasskeyAction>(null);
  const [passphraseInput, setPassphraseInput] = useState("");
  const [isPasskeyLoading, setIsPasskeyLoading] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [unsavedDialogOpen, setUnsavedDialogOpen] = useState(false);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const allowNextPopRef = useRef(false);

  useEffect(() => {
    // Check if user is authenticated
    const sessionToken = browserStorage.getItem("session_token");

    if (!sessionToken) {
      navigate("/signin");
      return;
    }

    fetchSettings();
  }, [navigate]);

  useEffect(() => {
    setPasskeySupported(isPasskeySupported());
  }, []);

  const fetchSettings = async () => {
    try {
      setIsLoading(true);
      const sessionToken = browserStorage.getItem("session_token");

      const response = await fetch("/api/profile/me", {
        headers: {
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      if (!response.ok) {
        throw new Error("Failed to fetch settings");
      }

      const data = await response.json();
      const nextSettings = {
        userId: data.userId || "",
        notifications: data.notifications ?? false,
        notificationEmail: data.notificationEmail ?? "",
        showTimestamps: data.showTimestamps ?? true,
        usernameDiscoveryEnabled: data.usernameDiscoveryEnabled ?? true,
      };
      setSettings({
        ...nextSettings,
      });
      setSavedSnapshot(toSettingsSnapshot(nextSettings));
      const nextPasskeyStatus = await fetchPasskeyStatus().catch(() => ({
        enabled: false,
      }));
      setPasskeyStatus(nextPasskeyStatus);
    } catch (error) {
      console.error("Error fetching settings:", error);
      toast.error("Failed to load settings");
    } finally {
      setIsLoading(false);
    }
  };

  const handleSaveSettings = async (): Promise<boolean> => {
    if (
      settings.notifications &&
      !isNotificationEmailValid(settings.notificationEmail ?? "")
    ) {
      toast.error("Enter a valid email address to enable notifications");
      return false;
    }

    try {
      setIsSaving(true);
      const sessionToken = browserStorage.getItem("session_token");

      const response = await fetch("/api/profile/settings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({
          ...settings,
          notificationEmail: (settings.notificationEmail ?? "").trim() || null,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to update settings");
      }

      const normalizedAfterSave: UserSettings = {
        ...settings,
        notificationEmail: (settings.notificationEmail ?? "").trim(),
      };
      setSettings(normalizedAfterSave);
      setSavedSnapshot(toSettingsSnapshot(normalizedAfterSave));
      toast.success("Settings saved successfully");
      return true;
    } catch (error) {
      console.error("Error saving settings:", error);
      toast.error("Failed to save settings");
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  const hasUnsavedChanges = useMemo(() => {
    if (!savedSnapshot) {
      return false;
    }
    const current = toSettingsSnapshot(settings);
    return JSON.stringify(savedSnapshot) !== JSON.stringify(current);
  }, [savedSnapshot, settings]);

  useBeforeUnload(
    (event) => {
      if (!hasUnsavedChanges) {
        return;
      }
      event.preventDefault();
      event.returnValue = "";
    },
    { capture: true },
  );

  useEffect(() => {
    if (!hasUnsavedChanges || isSaving) {
      return;
    }

    const markerState = {
      __settingsUnsavedGuard: true,
      at: Date.now(),
    };
    window.history.pushState(markerState, "", window.location.href);

    const handlePopState = () => {
      if (allowNextPopRef.current) {
        allowNextPopRef.current = false;
        return;
      }

      window.history.pushState(markerState, "", window.location.href);
      setPendingPath(BROWSER_BACK_PENDING);
      setUnsavedDialogOpen(true);
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [hasUnsavedChanges, isSaving]);

  const attemptNavigate = (to: string) => {
    if (hasUnsavedChanges) {
      setPendingPath(to);
      setUnsavedDialogOpen(true);
      return;
    }
    navigate(to);
  };

  const handleLeaveWithoutSaving = () => {
    setUnsavedDialogOpen(false);
    if (pendingPath === BROWSER_BACK_PENDING) {
      allowNextPopRef.current = true;
      setPendingPath(null);
      window.history.back();
      return;
    }
    if (pendingPath) {
      navigate(pendingPath);
      setPendingPath(null);
    }
  };

  const handleSaveAndLeave = async () => {
    const didSave = await handleSaveSettings();
    if (!didSave) {
      return;
    }

    setUnsavedDialogOpen(false);
    if (pendingPath === BROWSER_BACK_PENDING) {
      allowNextPopRef.current = true;
      setPendingPath(null);
      window.history.back();
      return;
    }
    if (pendingPath) {
      navigate(pendingPath);
      setPendingPath(null);
    }
  };

  const closePasskeyDialog = () => {
    if (isPasskeyLoading) {
      return;
    }
    setPasskeyAction(null);
    setPassphraseInput("");
  };

  const buildRecoveryPayload = async () => {
    const userId = settings.userId || "";
    if (!userId) {
      throw new Error("User account is unavailable");
    }

    const normalized = normalizePassphrase(passphraseInput);
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

  const handleConfirmPasskeyAction = async () => {
    if (!passkeyAction) {
      return;
    }

    try {
      setIsPasskeyLoading(true);
      const recoveryPayload = await buildRecoveryPayload();
      const nextStatus =
        passkeyAction === "create"
          ? await createPasskey(recoveryPayload)
          : await deletePasskey(recoveryPayload);
      setPasskeyStatus(nextStatus);
      toast.success(
        passkeyAction === "create"
          ? "Passkey enabled successfully"
          : "Passkey deleted successfully",
      );
      closePasskeyDialog();
    } catch (error) {
      console.error("Passkey action failed:", error);
      toast.error(
        error instanceof Error ? error.message : "Passkey action failed",
      );
    } finally {
      setIsPasskeyLoading(false);
    }
  };

  if (isLoading) {
    return (
      <Layout showProfileMenu={false}>
        <div className="flex items-center justify-center h-full">
          <div className="flex flex-col items-center gap-4 text-center">
            <Loader size="lg" />
            <p className="text-muted-foreground">Loading settings...</p>
          </div>
        </div>
      </Layout>
    );
  }

  return (
    <Layout
      showBack={true}
      title="Settings"
      onBackClick={() => attemptNavigate("/")}
      showProfileMenu={false}
    >
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
        <div className="mx-auto max-w-2xl px-3 py-4 pb-[calc(env(safe-area-inset-bottom)+2rem)] sm:px-4 sm:py-6 sm:pb-[calc(env(safe-area-inset-bottom)+3rem)] md:px-6 md:py-8 md:pb-[calc(env(safe-area-inset-bottom)+4rem)]">
          {/* Settings Header */}
          <div className="mb-6 sm:mb-8">
            <h1 className="text-2xl sm:text-3xl font-bold text-foreground mb-1 sm:mb-2">
              Settings
            </h1>
            <p className="text-muted-foreground text-xs sm:text-sm">
              Customize your Voltex experience
            </p>
          </div>

          {/* Notifications Section */}
          <div className="bg-card border border-border rounded-lg sm:rounded-lg p-4 sm:p-6 mb-4 sm:mb-6">
            <div className="flex items-start justify-between gap-3">
              <div className="flex gap-2 sm:gap-3 min-w-0">
                <Bell className="w-5 h-5 sm:w-6 sm:h-6 text-primary flex-shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <h2 className="text-base sm:text-lg font-semibold text-foreground">
                    Email notifications
                  </h2>
                  <p className="text-xs sm:text-sm text-muted-foreground mt-0.5 sm:mt-1">
                    Get notified only when unread direct messages build up while you are offline.
                  </p>
                </div>
              </div>

              <label className="flex items-center cursor-pointer flex-shrink-0">
                <input
                  type="checkbox"
                  checked={settings.notifications ?? false}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      notifications: e.target.checked,
                    })
                  }
                  className="w-4 h-4 sm:w-5 sm:h-5 rounded"
                />
              </label>
            </div>

            <div className="mt-4 sm:mt-5">
              <label className="mb-2 block text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
                Notification email
              </label>
              <input
                type="email"
                value={settings.notificationEmail ?? ""}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    notificationEmail: e.target.value,
                  })
                }
                disabled={isSaving || !(settings.notifications ?? false)}
                placeholder="you@example.com"
                className="tactical-input w-full px-4 py-3 disabled:cursor-not-allowed disabled:opacity-50"
              />
            </div>
          </div>

          {/* Messaging Section */}
          <div className="bg-card border border-border rounded-lg p-4 sm:p-6 mb-4 sm:mb-6">
            <div className="flex items-start gap-2 sm:gap-3 mb-3 sm:mb-4">
              <Shield className="w-5 h-5 sm:w-6 sm:h-6 text-primary flex-shrink-0 mt-0.5" />
              <div className="min-w-0">
                <h2 className="text-base sm:text-lg font-semibold text-foreground">
                  Messaging
                </h2>
                <p className="text-xs sm:text-sm text-muted-foreground mt-0.5 sm:mt-1">
                  Anyone can find and message you by your username.
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-2 sm:gap-3">
              <div className="p-2.5 sm:p-3 border border-border rounded-lg bg-secondary/30">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs sm:text-sm font-medium text-foreground">
                      Username-based discovery
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {settings.usernameDiscoveryEnabled ?? true
                        ? "Other users can find your account by searching your exact username."
                        : "Your account is hidden from username search and username-based discovery lookups."}
                    </p>
                  </div>
                  <label className="flex items-center cursor-pointer flex-shrink-0">
                    <input
                      type="checkbox"
                      checked={settings.usernameDiscoveryEnabled ?? true}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          usernameDiscoveryEnabled: e.target.checked,
                        })
                      }
                      className="w-4 h-4 sm:w-5 sm:h-5 rounded"
                    />
                  </label>
                </div>
              </div>

              {/* Show timestamps for messages toggle */}
              <div className="p-2.5 sm:p-3 border border-border rounded-lg bg-secondary/30">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs sm:text-sm font-medium text-foreground">
                      Show timestamps for messages
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {settings.showTimestamps
                        ? "Recipients will see date and time under your messages"
                        : "Recipients will not see timestamps for your messages"}
                    </p>
                  </div>
                  <label className="flex items-center cursor-pointer flex-shrink-0">
                    <input
                      type="checkbox"
                      checked={settings.showTimestamps ?? true}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          showTimestamps: e.target.checked,
                        })
                      }
                      className="w-4 h-4 sm:w-5 sm:h-5 rounded"
                    />
                  </label>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-card border border-border rounded-lg p-4 sm:p-6 mb-4 sm:mb-6">
            <div className="flex items-start gap-2 sm:gap-3 mb-3 sm:mb-4">
              <KeyRound className="w-5 h-5 sm:w-6 sm:h-6 text-primary flex-shrink-0 mt-0.5" />
              <div className="min-w-0">
                <h2 className="text-base sm:text-lg font-semibold text-foreground">
                  Passkey security
                </h2>
                <p className="text-xs sm:text-sm text-muted-foreground mt-0.5 sm:mt-1">
                  Passkeys are optional. Your existing sign-in flow stays unchanged unless you choose to enable one.
                </p>
              </div>
            </div>

            <div className="rounded-lg border border-border bg-secondary/30 p-3 sm:p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="text-xs sm:text-sm font-medium text-foreground">
                    Status: {passkeyStatus.enabled ? "Passkey Enabled" : "Passkey Disabled"}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {passkeySupported
                      ? "On desktop, your browser may offer a QR code so you can complete the passkey flow from your phone. On mobile, the flow stays native to your device."
                      : "This browser or device does not support passkeys yet."}
                  </p>
                  {passkeyStatus.enabled && (
                    <p className="text-xs text-muted-foreground mt-1">
                      Last used:{" "}
                      {passkeyStatus.lastUsedAt
                        ? new Date(passkeyStatus.lastUsedAt).toLocaleString()
                        : "Not available"}
                    </p>
                  )}
                </div>

                <button
                  type="button"
                  disabled={!passkeySupported || isPasskeyLoading}
                  onClick={() =>
                    setPasskeyAction(passkeyStatus.enabled ? "delete" : "create")
                  }
                  className={
                    passkeyStatus.enabled
                      ? "inline-flex h-10 items-center justify-center rounded-lg border border-destructive px-4 text-xs font-semibold uppercase tracking-[0.14em] text-destructive transition hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
                      : "tactical-button h-10 px-4 text-xs uppercase tracking-[0.14em] disabled:cursor-not-allowed disabled:opacity-50"
                  }
                >
                  {isPasskeyLoading ? (
                    <span className="flex items-center gap-2">
                      <Loader size="sm" className="shrink-0" />
                      Working...
                    </span>
                  ) : passkeyStatus.enabled ? (
                    "Delete Passkey"
                  ) : (
                    "Create Passkey"
                  )}
                </button>
              </div>
            </div>
          </div>

          {/* Save Button */}
          <button
            onClick={() => void handleSaveSettings()}
            disabled={isSaving || !hasUnsavedChanges}
            className="tactical-button w-full py-2.5 text-sm font-semibold sm:py-3 sm:text-base"
          >
            {isSaving ? (
              <span className="flex items-center justify-center gap-2">
                <Loader size="sm" className="shrink-0" />
                Saving...
              </span>
            ) : (
              "Save Changes"
            )}
          </button>
        </div>
      </div>

      <AlertDialog
        open={unsavedDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            return;
          }
          setUnsavedDialogOpen(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unsaved changes</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved changes in Settings. Choose whether to leave now
              or save before leaving.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={handleLeaveWithoutSaving}
              disabled={isSaving}
            >
              Leave without saving
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void handleSaveAndLeave();
              }}
              disabled={isSaving}
            >
              Save changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!passkeyAction} onOpenChange={(open) => !open && closePasskeyDialog()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {passkeyAction === "create" ? "Create passkey" : "Delete passkey"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {passkeyAction === "create"
                ? "Enter your 24-word recovery passphrase to confirm passkey creation for this account."
                : "Enter your 24-word recovery passphrase to confirm passkey deletion for this account."}
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-2">
            <label className="block text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
              Recovery passphrase
            </label>
            <textarea
              value={passphraseInput}
              onChange={(event) => setPassphraseInput(event.target.value)}
              placeholder="word1 word2 word3 ... word24"
              className="tactical-input h-24 w-full resize-none px-4 py-3 font-mono text-sm"
              disabled={isPasskeyLoading}
            />
            <p className="text-xs text-muted-foreground">
              Your passphrase is verified before the passkey is created or removed.
            </p>
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPasskeyLoading}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void handleConfirmPasskeyAction();
              }}
              disabled={isPasskeyLoading}
            >
              {isPasskeyLoading ? "Verifying..." : passkeyAction === "create" ? "Create Passkey" : "Delete Passkey"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Layout>
  );
}
