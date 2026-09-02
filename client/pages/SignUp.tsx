import { ChangeEvent, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Lock,
  Copy,
  Check,
  Download,
  ImagePlus,
  ArrowRight,
} from "lucide-react";
import {
  generateKeyPair,
  generateMnemonicPhrase,
  deriveUserIdFromPublicKey,
  storeKeyPair,
  signChallenge,
} from "@/lib/crypto";
import { ensureProtocolBundleRegistered } from "@/lib/protocol";
import {
  normalizePassphrase,
  generateSalt,
  generateRecoverySalt,
  deriveRecoveryVerifier,
  deriveEncryptionKey,
  encryptKeypair,
} from "@/lib/passphrase";
import { Loader } from "@/components/ui/loader";
import AvatarCropDialog from "@/components/AvatarCropDialog";
import { UserAvatar } from "@/components/UserAvatar";
import { toast } from "sonner";
import * as browserStorage from "@/lib/browserStorage";
import AuthSplitLayout from "@/components/AuthSplitLayout";
import RestrictionAppealDialog from "@/components/RestrictionAppealDialog";

type SignUpStep = "form" | "username" | "avatar" | "passphrase" | "completed";
const DISPLAY_NAME_MAX_LENGTH = 25;
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

export default function SignUp() {
  const navigate = useNavigate();
  const [step, setStep] = useState<SignUpStep>("form");
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [usernameError, setUsernameError] = useState("");
  const [isCheckingUsername, setIsCheckingUsername] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [mnemonic, setMnemonic] = useState("");
  const [sessionToken, setSessionToken] = useState("");
  const [copiedPassphrase, setCopiedPassphrase] = useState(false);
  const [generatedUserId, setGeneratedUserId] = useState("");
  const [keyPair, setKeyPair] = useState<any>(null);
  const [mnemonicData, setMnemonicData] = useState<any>(null);
  const [profileAvatar, setProfileAvatar] = useState<string | null>(null);
  const [emailNotificationsEnabled, setEmailNotificationsEnabled] =
    useState(false);
  const [notificationEmail, setNotificationEmail] = useState("");
  const [cropImageUrl, setCropImageUrl] = useState<string | null>(null);
  const [cropImageType, setCropImageType] = useState<
    "image/jpeg" | "image/png" | null
  >(null);
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);
  const [restrictionModalOpen, setRestrictionModalOpen] = useState(false);
  const [restrictionType, setRestrictionType] = useState<
    "ACCOUNT_BANNED" | "IP_RESTRICTED"
  >("IP_RESTRICTED");
  const [restrictionReason, setRestrictionReason] = useState("");
  const usernameCheckRequestRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleRestrictionPayload = (payload: any) => {
    const code =
      typeof payload?.code === "string" ? payload.code.toUpperCase() : "";
    if (code !== "ACCOUNT_BANNED" && code !== "IP_RESTRICTED") {
      return false;
    }
    setRestrictionType(code as "ACCOUNT_BANNED" | "IP_RESTRICTED");
    setRestrictionReason(
      typeof payload?.reason === "string" ? payload.reason : payload?.error || "",
    );
    setRestrictionModalOpen(true);
    return true;
  };

  const isNotificationEmailValid = (value: string) =>
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

  const signUpHighlights = [
    "Generate your secure account locally before registration.",
    "Choose a username, add a photo if you want, and continue.",
    "Save the recovery phrase that gives you access on future devices.",
  ];

  useEffect(() => {
    return () => {
      if (cropImageUrl) {
        URL.revokeObjectURL(cropImageUrl);
      }
    };
  }, [cropImageUrl]);

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

  const goToPassphraseStep = () => {
    if (!mnemonicData?.mnemonic) {
      setError("Session expired, please start over");
      setStep("form");
      return;
    }

    setMnemonic(mnemonicData.mnemonic);
    setStep("passphrase");
  };

  const handleCreateAccount = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!displayName.trim()) {
      setError("Display name is required");
      return;
    }

    if (displayName.trim().length > DISPLAY_NAME_MAX_LENGTH) {
      setError(
        `Display name must be ${DISPLAY_NAME_MAX_LENGTH} characters or fewer`,
      );
      return;
    }

    setIsLoading(true);
    setError("");

    try {
      // Generate key pair locally (non-blocking)
      const newKeyPair = generateKeyPair();

      // Generate mnemonic for recovery
      const newMnemonicData = generateMnemonicPhrase();

      // Store for next step
      setKeyPair(newKeyPair);
      setMnemonicData(newMnemonicData);

      // Move to username step
      setStep("username");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Account creation failed");
      toast.error(
        err instanceof Error ? err.message : "Account creation failed",
      );
    } finally {
      setIsLoading(false);
    }
  };

  const checkUsernameAvailability = async (usernameValue: string) => {
    const requestId = ++usernameCheckRequestRef.current;

    if (!usernameValue.trim()) {
      setUsernameError("");
      setIsCheckingUsername(false);
      return;
    }

    // Validate format
    if (usernameValue.length < 3) {
      setUsernameError("Username must be at least 3 characters");
      setIsCheckingUsername(false);
      return;
    }

    if (usernameValue.length > 30) {
      setUsernameError("Username must be no more than 30 characters");
      setIsCheckingUsername(false);
      return;
    }

    if (!/^[a-zA-Z0-9_]+$/.test(usernameValue)) {
      setUsernameError(
        "Username can only contain letters, numbers, and underscores",
      );
      setIsCheckingUsername(false);
      return;
    }

    setIsCheckingUsername(true);
    try {
      const response = await fetch("/api/auth/username-availability", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: usernameValue }),
      });

      const data = await response.json();
      if (requestId !== usernameCheckRequestRef.current) {
        return;
      }

      if (!response.ok) {
        setUsernameError(
          typeof data.error === "string"
            ? data.error
            : "Failed to check username availability",
        );
        return;
      }

      if (data.available === false) {
        setUsernameError("The Username is not Available, Please try another");
      } else {
        setUsernameError("");
      }
    } catch (err) {
      if (requestId !== usernameCheckRequestRef.current) {
        return;
      }
      setUsernameError("Failed to check username availability");
    } finally {
      if (requestId === usernameCheckRequestRef.current) {
        setIsCheckingUsername(false);
      }
    }
  };

  useEffect(() => {
    if (step !== "username") {
      return;
    }

    const trimmedUsername = username.trim();
    if (!trimmedUsername) {
      setUsernameError("");
      setIsCheckingUsername(false);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void checkUsernameAvailability(trimmedUsername);
    }, 250);

    return () => window.clearTimeout(timeoutId);
  }, [step, username]);

  const handleContinueWithUsername = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!username.trim()) {
      setUsernameError("Username is required");
      return;
    }

    if (usernameError) {
      setUsernameError("Please choose a different username");
      return;
    }

    if (
      emailNotificationsEnabled &&
      !isNotificationEmailValid(notificationEmail)
    ) {
      setError("Enter a valid email address to enable notifications");
      return;
    }

    if (!keyPair || !mnemonicData) {
      setError("Session expired, please start over");
      setStep("form");
      return;
    }

    setIsLoading(true);
    setError("");

    try {
      // Derive user ID from public key
      const derivedUserId = await deriveUserIdFromPublicKey(
        keyPair.publicKeyBase64,
      );

      // Hash the mnemonic passphrase for recovery
      // Normalize first to ensure consistency with recovery flow
      const normalizedPassphrase = normalizePassphrase(mnemonicData.mnemonic);
      const recoverySalt = generateRecoverySalt();
      const recoveryIterations = 210000;
      const recoveryVerifier = await deriveRecoveryVerifier(
        normalizedPassphrase,
        recoverySalt,
        recoveryIterations,
      );

      // Register account on server with username
      const registerResponse = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          publicKey: keyPair.publicKeyBase64,
          signPublicKey: keyPair.signPublicKeyBase64,
          recoveryVerifier,
          recoverySalt,
          recoveryIterations,
          username: username.toLowerCase(),
        }),
      });

      if (!registerResponse.ok) {
        const errorData = await registerResponse.json();
        if (handleRestrictionPayload(errorData)) {
          throw new Error(
            errorData?.error ||
              "Access from this account or IP is currently restricted",
          );
        }
        throw new Error(errorData.error || "Registration failed");
      }

      // Get challenge for authentication
      const challengeResponse = await fetch("/api/auth/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: derivedUserId,
          publicKey: keyPair.publicKeyBase64,
        }),
      });

      if (!challengeResponse.ok) {
        const errorData = await challengeResponse.json();
        throw new Error(errorData.error || "Failed to get challenge");
      }

      const { challenge } = await challengeResponse.json();

      // Sign challenge with signing private key
      const signature = signChallenge(challenge, keyPair.signPrivateKeyBase64);

      // Verify challenge and get session token
      const verifyResponse = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: derivedUserId,
          challenge,
          signature,
          publicKey: keyPair.publicKeyBase64,
        }),
      });

      if (!verifyResponse.ok) {
        const errorData = await verifyResponse.json();
        if (handleRestrictionPayload(errorData)) {
          throw new Error(
            errorData?.error ||
              "Access from this account or IP is currently restricted",
          );
        }
        throw new Error(errorData.error || "Authentication failed");
      }

      const { sessionToken: token } = await verifyResponse.json();

      // Encrypt keypair and save to R2 for cross-device recovery
      try {
        const salt = generateSalt();
        const encryptionKey = await deriveEncryptionKey(
          normalizedPassphrase,
          salt,
        );
        const { encryptedData, iv } = await encryptKeypair(
          keyPair,
          encryptionKey,
        );

        const saveResponse = await fetch("/api/auth/save-encrypted-keypair", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            userId: derivedUserId,
            encryptedData,
            salt,
            iv,
          }),
        });

        if (!saveResponse.ok) {
          const errorData = await saveResponse.json();
          console.error(
            "Failed to save encrypted keypair:",
            errorData.error || "Unknown error",
          );
          // Continue even if R2 save fails, as keys are stored locally
          toast.warning(
            "Note: Cross-device account recovery may not be available",
          );
        }
      } catch (err) {
        console.error("Failed to save encrypted keypair to R2:", err);
        // Continue even if R2 save fails, as keys are stored locally
        toast.warning(
          "Note: Cross-device account recovery may not be available",
        );
      }

      // Store keys and session locally
      await storeKeyPair(keyPair);
      await browserStorage.setItem("session_token", token);
      await browserStorage.setItem("current_public_key", keyPair.publicKeyBase64);

      // Store signing public key
      if (keyPair.signPublicKeyBase64) {
        await browserStorage.setItem(
          "current_sign_public_key",
          keyPair.signPublicKeyBase64,
        );
      }

      // Save display name and username to profile
      if (displayName.trim() || emailNotificationsEnabled || notificationEmail.trim()) {
        try {
          await fetch("/api/profile/me", {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              displayName: displayName.trim(),
              notificationEmail: emailNotificationsEnabled
                ? notificationEmail.trim() || null
                : null,
            }),
          });
        } catch (err) {
          console.error("Failed to save profile:", err);
        }
      }

      try {
        const settingsResponse = await fetch("/api/profile/settings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            notifications: emailNotificationsEnabled,
            notificationEmail: emailNotificationsEnabled
              ? notificationEmail.trim() || null
              : null,
          }),
        });

        if (!settingsResponse.ok) {
          const settingsData = await settingsResponse.json().catch(() => ({}));
          throw new Error(
            settingsData.error || "Failed to save notification settings",
          );
        }
      } catch (err) {
        console.error("Failed to save notification settings:", err);
        toast.warning("Account created, but email notifications were not saved");
      }

      void ensureProtocolBundleRegistered(token, {
        identityKey: keyPair.publicKeyBase64,
        signingPublicKey: keyPair.signPublicKeyBase64,
        signingPrivateKey: keyPair.signPrivateKeyBase64,
      });

      setGeneratedUserId(derivedUserId);
      setSessionToken(token);
      setProfileAvatar(null);
      setStep("avatar");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Account creation failed");
      toast.error(
        err instanceof Error ? err.message : "Account creation failed",
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleAvatarFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    const normalizedType =
      file.type === "image/png"
        ? "image/png"
        : file.type === "image/jpeg"
          ? "image/jpeg"
          : null;

    if (!normalizedType) {
      toast.error("Only JPG, JPEG, and PNG images are allowed");
      event.target.value = "";
      return;
    }

    if (file.size > AVATAR_MAX_BYTES) {
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
    if (!sessionToken) {
      toast.error("Session expired, please sign up again");
      return;
    }

    try {
      setIsUploadingAvatar(true);

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
      setProfileAvatar(data?.profile?.avatar || null);
      closeCropDialog();
      toast.success("Profile photo uploaded");
      goToPassphraseStep();
    } catch (error) {
      console.error("Error uploading avatar during signup:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to upload profile photo",
      );
    } finally {
      setIsUploadingAvatar(false);
    }
  };

  const handleSkipAvatar = () => {
    closeCropDialog();
    goToPassphraseStep();
  };

  const handleConfirmPassphrase = () => {
    setStep("completed");
    toast.success("Account created successfully! You're now logged in.");
    navigate("/");
  };

  const copyPassphrase = async () => {
    try {
      await navigator.clipboard.writeText(mnemonic);
      setCopiedPassphrase(true);
      toast.success("Passphrase copied to clipboard");
      setTimeout(() => setCopiedPassphrase(false), 2000);
    } catch (err) {
      console.error("Failed to copy to clipboard:", err);
      // Fallback: create a text area and copy manually
      try {
        const textArea = document.createElement("textarea");
        textArea.value = mnemonic;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand("copy");
        document.body.removeChild(textArea);
        setCopiedPassphrase(true);
        toast.success("Passphrase copied to clipboard");
        setTimeout(() => setCopiedPassphrase(false), 2000);
      } catch {
        toast.error("Failed to copy passphrase to clipboard");
      }
    }
  };

  const downloadPassphrase = () => {
    const normalizedUsername = username.trim().toLowerCase();
    const safeUsername = normalizedUsername || "voltex-user";
    const safeUserId = generatedUserId || "unknown-user-id";
    const passphraseWords = mnemonic
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .join(", ");

    const fileContents = [
      "•••••• Voltex Signin Credentials ••••••",
      `Username: ${normalizedUsername}`,
      `User ID: ${safeUserId}`,
      `24 words Passphrase: ${passphraseWords}`,
      "",
      "NOTE: if you've lost your account info you can use the above credentials to recover or sign back into your account.",
    ].join("\n");

    try {
      const blob = new Blob([fileContents], {
        type: "text/plain;charset=utf-8",
      });
      const fileName = `${safeUsername}-voltex-signin-credentials.txt`;

      if (
        typeof navigator !== "undefined" &&
        "msSaveOrOpenBlob" in navigator &&
        typeof (navigator as Navigator & {
          msSaveOrOpenBlob?: (blob: Blob, defaultName?: string) => boolean;
        }).msSaveOrOpenBlob === "function"
      ) {
        (
          navigator as Navigator & {
            msSaveOrOpenBlob: (blob: Blob, defaultName?: string) => boolean;
          }
        ).msSaveOrOpenBlob(blob, fileName);
        toast.success("Passphrase file downloaded");
        return;
      }

      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = fileName;
      link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      toast.success("Passphrase file downloaded");
    } catch (err) {
      console.error("Failed to download passphrase:", err);
      toast.error("Failed to download passphrase");
    }
  };

  // Step 1: Display Name Form
  if (step === "form") {
    return (
      <AuthSplitLayout
        eyebrow="Create account"
        title="Create an account built for private, independent communication."
        description="Voltex is designed for people who want secure communication, real privacy, and more freedom than many platforms that only make those promises."
        desktopTitle="Create a Voltex account built around real privacy."
        desktopDescription="Voltex is made for secure, private communication without unnecessary data exposure, giving users a more trustworthy and control-focused alternative to platforms that treat privacy as a marketing feature."
        highlights={signUpHighlights}
        secondaryLink={{ label: "Learn more about Voltex", to: "/about-v0lt3x" }}
        primaryCta={{ label: "Already have an account?", to: "/signin" }}
      >
        <div className="mb-8 lg:mb-10">
          <p className="tactical-kicker mb-3">Create account</p>
          <h1 className="max-w-[16ch] text-4xl leading-[1] text-foreground sm:text-5xl">
            Join Voltex
          </h1>
          <p className="mt-3 max-w-xl text-sm font-semibold leading-7 text-muted-foreground sm:text-base">
            Join a platform built to keep communication private, reduce
            unnecessary data exposure, and put more control back in the hands
            of the user.
          </p>
        </div>

        <form onSubmit={handleCreateAccount} className="mb-6 space-y-4 lg:mb-8">
            {error && (
              <div className="p-3 bg-destructive/10 border border-destructive text-destructive rounded-lg text-sm">
                {error}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                Display Name
              </label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => {
                  setDisplayName(
                    e.target.value.slice(0, DISPLAY_NAME_MAX_LENGTH),
                  );
                  setError("");
                }}
                placeholder="Your name"
                required
                maxLength={DISPLAY_NAME_MAX_LENGTH}
                disabled={isLoading}
                className="tactical-input w-full px-4 py-3 disabled:cursor-not-allowed disabled:opacity-50"
              />
              <p className="mt-2 text-xs text-muted-foreground">
                {displayName.length}/{DISPLAY_NAME_MAX_LENGTH} characters
              </p>
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="tactical-button mt-6 w-full font-semibold uppercase tracking-[0.2em]"
            >
              {isLoading ? (
                <span className="flex items-center justify-center gap-2">
                  <Loader size="sm" className="shrink-0" />
                  Creating Account...
                </span>
              ) : (
                "Create Account"
              )}
            </button>
          </form>

          <div className="mb-8 flex items-center gap-3">
            <div className="flex-1 h-px bg-border"></div>
            <span className="text-muted-foreground text-sm">
              Already have an account?
            </span>
            <div className="flex-1 h-px bg-border"></div>
          </div>

          <Link
            to="/signin"
            className="tactical-button-outline flex w-full font-semibold uppercase tracking-[0.2em]"
          >
            Sign In
          </Link>

          <div className="tactical-panel-soft mt-10 p-4">
            <div className="flex gap-3">
              <Lock className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-foreground mb-1">
                  Your Privacy
                </p>
                <p className="text-xs text-muted-foreground">
                  Your account is secure and private. Only you can read your
                  messages.
                </p>
              </div>
            </div>
          </div>
      </AuthSplitLayout>
    );
  }

  // Step 2: Username Selection
  if (step === "username") {
    return (
      <>
        <AuthSplitLayout
          eyebrow="Username"
          title="Choose the identity people will use to reach you."
          description="Voltex keeps the experience simple while staying focused on privacy, secure communication, and user freedom."
          desktopTitle="Choose the name people will recognize in Voltex."
          desktopDescription="Every part of Voltex is designed to support private communication with less exposure and more user control than most mainstream messaging platforms."
          highlights={signUpHighlights}
        >
          <div className="mb-8 lg:mb-10">
          <p className="tactical-kicker mb-3">Username</p>
          <h1 className="max-w-[18ch] text-4xl leading-[1] text-foreground sm:text-5xl">
            Choose your username
          </h1>
          <p className="mt-3 max-w-xl text-sm font-semibold leading-7 text-muted-foreground sm:text-base">
            This is how people will find you in a messaging space built around
            privacy, trust, and user control.
          </p>
        </div>

        <form
          onSubmit={handleContinueWithUsername}
          className="mb-6 space-y-4"
        >
            {error && (
              <div className="p-3 bg-destructive/10 border border-destructive text-destructive rounded-lg text-sm">
                {error}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                Username
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={username}
                  onChange={(e) => {
                    setUsername(e.target.value);
                    setError("");
                  }}
                  placeholder="your_username"
                  required
                  disabled={isLoading}
                  className="tactical-input w-full px-4 py-3 disabled:cursor-not-allowed disabled:opacity-50"
                />
                {isCheckingUsername && (
                  <div className="absolute right-4 top-1/2 transform -translate-y-1/2">
                    <Loader size="sm" />
                  </div>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                3-30 characters, letters, numbers, and underscores only
              </p>
              {usernameError && (
                <p className="text-xs text-destructive mt-2">{usernameError}</p>
              )}
            </div>

            <div className="rounded-[24px] border border-border/70 bg-secondary/20 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground">
                    Want to Receive Message Notifications?
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Turn this on to get an email after every 3 unread offline direct messages.
                  </p>
                </div>
                <label className="mt-0.5 flex items-center">
                  <input
                    type="checkbox"
                    checked={emailNotificationsEnabled}
                    onChange={(e) => {
                      setEmailNotificationsEnabled(e.target.checked);
                      setError("");
                    }}
                    disabled={isLoading}
                    className="h-4 w-4 rounded"
                  />
                </label>
              </div>

              <div className="mt-3">
                <input
                  type="email"
                  value={notificationEmail}
                  onChange={(e) => {
                    setNotificationEmail(e.target.value);
                    setError("");
                  }}
                  placeholder="you@example.com"
                  disabled={isLoading || !emailNotificationsEnabled}
                  className="tactical-input w-full px-4 py-3 disabled:cursor-not-allowed disabled:opacity-50"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={
                isLoading ||
                isCheckingUsername ||
                !!usernameError ||
                (emailNotificationsEnabled &&
                  !isNotificationEmailValid(notificationEmail))
              }
              className="tactical-button mt-6 w-full font-semibold uppercase tracking-[0.2em]"
            >
              {isLoading ? (
                <span className="flex items-center justify-center gap-2">
                  <Loader size="sm" className="shrink-0" />
                  Creating Account...
                </span>
              ) : (
                emailNotificationsEnabled ? "Continue" : "Skip Notifications & Continue"
              )}
            </button>
          </form>

          <div className="tactical-panel-soft p-4">
            <div className="flex gap-3">
              <Lock className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-foreground mb-1">
                  Username Requirements
                </p>
                <p className="text-xs text-muted-foreground">
                  • Minimum 3 characters
                  <br />
                  • Maximum 30 characters
                  <br />
                  • No spaces or special characters
                  <br />• Must be unique
                </p>
              </div>
            </div>
          </div>
        </AuthSplitLayout>
        <RestrictionAppealDialog
          open={restrictionModalOpen}
          onOpenChange={setRestrictionModalOpen}
          restrictionType={restrictionType}
          reason={restrictionReason}
        />
      </>
    );
  }

  if (step === "avatar") {
    return (
      <>
        <AuthSplitLayout
          eyebrow="Profile setup"
          title="Add a profile photo if you want a more recognizable account."
          description="This step remains optional. The upload, crop, and skip behavior are unchanged."
          desktopTitle="Add a profile photo."
          desktopDescription="This step stays optional. The layout is simply cleaner and better balanced on larger screens."
          highlights={signUpHighlights}
        >
          <div className="mb-8 lg:mb-10">
            <p className="tactical-kicker mb-3">Profile setup</p>
            <h1 className="max-w-[18ch] text-4xl leading-[1] text-foreground sm:text-5xl">
              Add a profile photo
            </h1>
          <p className="mt-3 max-w-xl text-sm font-semibold leading-7 text-muted-foreground sm:text-base">
            Upload a JPG or PNG image to help people recognize you. You can
            skip this and add one later without affecting account creation.
          </p>
          </div>

          <div className="rounded-[28px] border border-border/70 bg-secondary/30 p-6">
              <div className="flex flex-col items-center text-center">
                <UserAvatar
                  name={displayName.trim() || username || "New User"}
                  avatar={profileAvatar}
                  className="h-28 w-28 rounded-[36px] ring-0"
                  fallbackClassName="rounded-[36px] bg-primary/12 text-3xl font-black text-primary"
                />
                <p className="mt-4 text-lg font-semibold text-foreground">
                  {displayName.trim() || "Your profile"}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {username ? `@${username.toLowerCase()}` : "Choose a profile photo"}
                </p>
              </div>

              <div className="mt-6 space-y-3">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png"
                  capture="user"
                  onChange={handleAvatarFileChange}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isUploadingAvatar}
                  className="tactical-button h-12 w-full text-sm font-semibold uppercase tracking-[0.12em]"
                >
                  {isUploadingAvatar ? (
                    <Loader size="sm" className="shrink-0" />
                  ) : (
                    <ImagePlus className="h-4 w-4" />
                  )}
                  {profileAvatar ? "Change photo" : "Upload photo"}
                </button>
                <button
                  type="button"
                  onClick={handleSkipAvatar}
                  disabled={isUploadingAvatar}
                  className="tactical-button-outline h-12 w-full text-sm font-semibold uppercase tracking-[0.12em]"
                >
                  <ArrowRight className="h-4 w-4" />
                  Skip for now
                </button>
              </div>

              <p className="mt-4 text-center text-xs text-muted-foreground">
                Photos are cropped locally in your browser before upload and limited to 5MB.
              </p>
          </div>
        </AuthSplitLayout>

        <AvatarCropDialog
          imageUrl={cropImageUrl}
          imageType={cropImageType}
          open={Boolean(cropImageUrl && cropImageType)}
          isSaving={isUploadingAvatar}
          onOpenChange={(open) => {
            if (!open) {
              closeCropDialog();
            }
          }}
          onSave={handleSaveAvatar}
        />
      </>
    );
  }

  // Step 3: Recovery Passphrase
  if (step === "passphrase") {
    return (
      <AuthSplitLayout
        eyebrow="Recovery passphrase"
        title="Save the only credential that can recover this account."
        description="This screen keeps the same recovery content and actions, but the responsive layout is now much more usable on tablets, laptops, and desktops."
        desktopTitle="Store your recovery passphrase."
        desktopDescription="The passphrase remains the same 24-word recovery key generated by the current sign-up flow. The redesign only improves how it is presented across screen sizes."
        highlights={signUpHighlights}
        panelClassName="lg:max-h-[calc(100vh-3.5rem)] lg:overflow-hidden"
      >
        <div className="flex flex-col gap-4 lg:h-full lg:min-h-0 lg:gap-3">
          <div className="shrink-0">
            <p className="tactical-kicker mb-3">Recovery passphrase</p>
            <h1 className="max-w-[18ch] text-3xl leading-[1.02] text-foreground sm:text-4xl lg:text-[2.35rem]">
              Save your recovery passphrase
            </h1>
            <p className="mt-2.5 max-w-xl text-sm font-semibold leading-6 text-muted-foreground sm:text-[0.95rem] sm:leading-7">
              This 24-word passphrase is the only way to recover your account if
              you lose access to this device.
            </p>
          </div>

          <div className="rounded-none border border-primary/30 bg-secondary/80 p-3 sm:p-4 lg:min-h-0">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:gap-1.5">
              {mnemonic.split(" ").map((word, index) => (
                <div
                  key={index}
                  className="rounded-none border border-border bg-background px-2 py-1.5 text-center text-xs font-mono sm:px-2.5 sm:text-[13px]"
                >
                  <span className="mr-1.5 text-muted-foreground">
                    {index + 1}.
                  </span>
                  <span className="font-semibold">{word}</span>
                </div>
              ))}
            </div>

            <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
              <button
                type="button"
                onClick={downloadPassphrase}
                className="tactical-button-outline w-full py-2 text-sm font-semibold rounded-none"
              >
                <Download className="h-4 w-4" />
                Download Passphrase
              </button>

              <button
                type="button"
                onClick={copyPassphrase}
                className="tactical-button-outline w-full py-2 text-sm font-medium rounded-none"
              >
                {copiedPassphrase ? (
                  <>
                    <Check className="h-4 w-4" />
                    Copied!
                  </>
                ) : (
                  <>
                    <Copy className="h-4 w-4" />
                    Save Passphrase
                  </>
                )}
              </button>
            </div>
          </div>

          <div className="space-y-3 lg:mt-auto">
            <div className="rounded-none border border-destructive bg-destructive/10 p-3.5">
              <p className="text-sm font-semibold text-destructive">
                Important Security Notice
              </p>
              <p className="mt-1.5 text-xs leading-5 text-destructive/80">
                • Never share this passphrase with anyone
                <br />
                • Store it securely (write it down, password manager, etc.)
                <br />
                • Anyone with this passphrase can access your account
                <br />• There is no way to recover your account without this
                phrase
              </p>
            </div>

            <button
              onClick={handleConfirmPassphrase}
              className="tactical-button w-full py-2.5 text-sm font-semibold uppercase tracking-[0.18em] sm:text-base rounded-none"
            >
              I've Saved My Passphrase
            </button>

            <p className="text-center text-xs leading-5 text-muted-foreground">
              Your account has been created and you're logged in. Your recovery
              passphrase and private key are stored safely on this device.
            </p>
          </div>
        </div>
      </AuthSplitLayout>
    );
  }

  return null;
}
