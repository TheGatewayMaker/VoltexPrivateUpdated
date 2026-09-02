import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Lock } from "lucide-react";
import { motion } from "framer-motion";
import {
  getStoredKeyPair,
  signChallenge,
  deriveUserIdFromPublicKey,
  storeKeyPair,
} from "@/lib/crypto";
import { ensureProtocolBundleRegistered } from "@/lib/protocol";
import {
  normalizePassphrase,
  deriveEncryptionKey,
  decryptKeypair,
  hashPassphrase,
  deriveRecoveryVerifier,
} from "@/lib/passphrase";
import {
  authenticateWithPasskey,
  isPasskeySupported,
} from "@/lib/passkeys";
import { Loader } from "@/components/ui/loader";
import { toast } from "sonner";
import * as browserStorage from "@/lib/browserStorage";
import AuthSplitLayout from "@/components/AuthSplitLayout";
import RestrictionAppealDialog from "@/components/RestrictionAppealDialog";

type SignInStep = "userId" | "passphrase" | "authenticating" | "success";

const passphraseStepTransition = {
  initial: { opacity: 0, x: 36 },
  animate: { opacity: 1, x: 0 },
  transition: { duration: 0.28, ease: [0.22, 1, 0.36, 1] as const },
};

function normalizeUserId(value: string): string {
  return value.trim().toLowerCase();
}

function isValidUserId(value: string): boolean {
  return /^[a-f0-9]{16}$/.test(value);
}

export default function SignIn() {
  const navigate = useNavigate();
  const [step, setStep] = useState<SignInStep>("userId");
  const [userIdInput, setUserIdInput] = useState("");
  const [passphraseInput, setPassphraseInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [authenticatedUserId, setAuthenticatedUserId] = useState("");
  const [recoveryUserId, setRecoveryUserId] = useState<string | null>(null);
  const [pendingPasskeySession, setPendingPasskeySession] = useState<{
    sessionToken: string;
    userId: string;
    publicKey: string;
    signPublicKey: string | null;
  } | null>(null);
  const [passkeySupported, setPasskeySupported] = useState(false);
  const [restrictionModalOpen, setRestrictionModalOpen] = useState(false);
  const [restrictionType, setRestrictionType] = useState<
    "ACCOUNT_BANNED" | "IP_RESTRICTED"
  >("ACCOUNT_BANNED");
  const [restrictionReason, setRestrictionReason] = useState("");

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

  const signInHighlights = [
    "Enter the 16-character ID linked to your account.",
    "Use your 24-word recovery phrase when signing in on a new device.",
    "The same secure flow stays consistent across mobile and desktop.",
  ];

  useEffect(() => {
    setPasskeySupported(isPasskeySupported());
  }, []);

  const finalizeAuthenticatedSession = async (
    authData: {
      sessionToken: string;
      userId: string;
      publicKey: string;
      signPublicKey?: string | null;
      expiresAt?: number;
    },
    keyPair: any,
  ) => {
    await storeKeyPair(keyPair);
    await browserStorage.setItem("session_token", authData.sessionToken);
    await browserStorage.setItem(
      "current_public_key",
      keyPair.publicKeyBase64,
    );

    if (keyPair.signPublicKeyBase64) {
      await browserStorage.setItem(
        "current_sign_public_key",
        keyPair.signPublicKeyBase64,
      );
    }

    setAuthenticatedUserId(normalizeUserId(authData.userId));
    setPendingPasskeySession(null);
    setStep("success");
    void ensureProtocolBundleRegistered(authData.sessionToken, {
      identityKey: keyPair.publicKeyBase64,
      signingPublicKey: keyPair.signPublicKeyBase64,
      signingPrivateKey: keyPair.signPrivateKeyBase64,
    });

    setTimeout(() => navigate("/"), 1500);
  };

  const authenticateWithKeyPair = async (userId: string, keyPair: any) => {
    try {
      // Request challenge from server
      const challengeResponse = await fetch("/api/auth/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          publicKey: keyPair.publicKeyBase64,
        }),
      });

      if (!challengeResponse.ok) {
        const errorData = await challengeResponse.json();
        throw new Error(errorData.error || "Failed to get challenge");
      }

      const challengeData = await challengeResponse.json();
      const challenge = challengeData.challenge;

      // Sign the challenge with signing private key
      const signature = signChallenge(challenge, keyPair.signPrivateKeyBase64);

      // Verify signed challenge with server
      const verifyResponse = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
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
              "Access to this account is currently restricted",
          );
        }
        throw new Error(errorData.error || "Authentication failed");
      }

      const authData = await verifyResponse.json();
      await finalizeAuthenticatedSession(
        {
          sessionToken: authData.sessionToken,
          userId,
          publicKey: keyPair.publicKeyBase64,
          signPublicKey: keyPair.signPublicKeyBase64,
          expiresAt: authData.expiresAt,
        },
        keyPair,
      );
    } catch (err) {
      throw err;
    }
  };

  const handlePasskeySignIn = async () => {
    setIsLoading(true);
    setError("");

    try {
      const authData = await authenticateWithPasskey();
      const storedKeyPair = getStoredKeyPair();

      if (storedKeyPair) {
        const derivedUserId = await deriveUserIdFromPublicKey(
          storedKeyPair.publicKeyBase64,
        );
        if (
          derivedUserId === authData.userId &&
          storedKeyPair.publicKeyBase64 === authData.publicKey
        ) {
          await finalizeAuthenticatedSession(
            {
              sessionToken: authData.sessionToken,
              userId: authData.userId,
              publicKey: authData.publicKey,
              signPublicKey: authData.signPublicKey,
              expiresAt: authData.expiresAt,
            },
            storedKeyPair,
          );
          return;
        }
      }

      setPendingPasskeySession({
        sessionToken: authData.sessionToken,
        userId: authData.userId,
        publicKey: authData.publicKey,
        signPublicKey: authData.signPublicKey,
      });
      setRecoveryUserId(authData.userId);
      setStep("passphrase");
      toast.message(
        "Passkey verified. Restore your encryption keys with your 24-word passphrase to finish signing in.",
      );
    } catch (err) {
      if (
        err instanceof Error &&
        handleRestrictionPayload((err as Error & { payload?: unknown }).payload)
      ) {
        setError(err.message);
        return;
      }
      setError(err instanceof Error ? err.message : "Passkey sign-in failed");
    } finally {
      setIsLoading(false);
    }
  };

  const handleCheckUserId = async (e: React.FormEvent) => {
    e.preventDefault();

    const normalizedUserId = normalizeUserId(userIdInput);

    if (!normalizedUserId) {
      setError("User ID is required");
      return;
    }

    if (!isValidUserId(normalizedUserId)) {
      setError("Enter your 16-character user ID");
      return;
    }

    setIsLoading(true);
    setError("");

    try {
      // Check if keypair exists locally
      const storedKeyPair = getStoredKeyPair();

      if (storedKeyPair) {
        const publicKeyResponse = await fetch(
          `/api/auth/public-key/by-user-id/${encodeURIComponent(normalizedUserId)}`,
        );

        if (!publicKeyResponse.ok) {
          const errorData = await publicKeyResponse.json();
          throw new Error(errorData.error || "Account not found");
        }

        const publicKeyData = await publicKeyResponse.json();

        const derivedUserId = await deriveUserIdFromPublicKey(
          storedKeyPair.publicKeyBase64,
        );

        if (derivedUserId !== normalizedUserId) {
          throw new Error(
            "This user ID does not match the account stored on this device",
          );
        }

        if (publicKeyData.publicKey !== storedKeyPair.publicKeyBase64) {
          throw new Error(
            "This user ID does not match your stored account on this device",
          );
        }

        // Same-device signin: proceed with challenge-response
        await authenticateWithKeyPair(derivedUserId, storedKeyPair);
      } else {
        // Cross-device signin: collect passphrase first, then exchange it for a short-lived recovery ticket.
        setRecoveryUserId(normalizedUserId);
        setStep("passphrase");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
    } finally {
      setIsLoading(false);
    }
  };

  const handlePassphraseSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!passphraseInput.trim()) {
      setError("Passphrase is required");
      return;
    }

    if (!recoveryUserId) {
      setError("Session expired. Please start over.");
      setStep("userId");
      return;
    }

    setIsLoading(true);
    setError("");

    try {
      const normalizedPassphrase = normalizePassphrase(passphraseInput);
      const recoveryParamsResponse = await fetch(
        `/api/auth/recovery-params/by-user-id/${encodeURIComponent(recoveryUserId)}`,
      );

      if (!recoveryParamsResponse.ok) {
        const errorData = await recoveryParamsResponse.json();
        throw new Error(errorData.error || "Failed to fetch recovery config");
      }

      const recoveryParams = await recoveryParamsResponse.json();
      const recoveryPayload =
        recoveryParams.version === 2
          ? {
              recoveryVerifier: await deriveRecoveryVerifier(
                normalizedPassphrase,
                recoveryParams.salt,
                recoveryParams.iterations,
              ),
            }
          : {
              passphraseHash: await hashPassphrase(normalizedPassphrase),
            };

      let encryptedKeypairResponse: Response;
      if (pendingPasskeySession) {
        encryptedKeypairResponse = await fetch(
          `/api/auth/encrypted-keypair/by-user-id/${encodeURIComponent(recoveryUserId)}`,
          {
            headers: {
              Authorization: `Bearer ${pendingPasskeySession.sessionToken}`,
            },
          },
        );
      } else {
        const recoveryResponse = await fetch("/api/auth/recover", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: recoveryUserId,
            ...recoveryPayload,
          }),
        });

        if (!recoveryResponse.ok) {
          const errorData = await recoveryResponse.json();
          throw new Error(errorData.error || "Failed to verify recovery phrase");
        }

        const recoveryData = await recoveryResponse.json();

        encryptedKeypairResponse = await fetch(
          `/api/auth/encrypted-keypair/by-user-id/${encodeURIComponent(recoveryUserId)}`,
          {
            headers: {
              "X-Recovery-Token": recoveryData.recoveryToken,
            },
          },
        );
      }

      if (!encryptedKeypairResponse.ok) {
        const errorData = await encryptedKeypairResponse.json();
        throw new Error(errorData.error || "Failed to fetch encrypted keypair");
      }

      const encryptedKeypairData = await encryptedKeypairResponse.json();

      // Derive decryption key from passphrase
      const decryptionKey = await deriveEncryptionKey(
        normalizedPassphrase,
        encryptedKeypairData.salt,
      );

      // Decrypt keypair
      const decryptedKeypair = await decryptKeypair(
        encryptedKeypairData.encryptedData,
        encryptedKeypairData.iv,
        decryptionKey,
      );

      if (!decryptedKeypair) {
        throw new Error("Failed to decrypt keypair. Invalid passphrase?");
      }

      // Verify the decrypted keypair matches the user ID
      const derivedUserId = await deriveUserIdFromPublicKey(
        decryptedKeypair.publicKeyBase64,
      );

      if (!derivedUserId) {
        throw new Error("Decrypted keypair does not match user ID");
      }

      if (pendingPasskeySession) {
        if (
          derivedUserId !== pendingPasskeySession.userId ||
          decryptedKeypair.publicKeyBase64 !== pendingPasskeySession.publicKey
        ) {
          throw new Error(
            "Recovered keypair does not match the passkey-authenticated account",
          );
        }

        await finalizeAuthenticatedSession(
          {
            sessionToken: pendingPasskeySession.sessionToken,
            userId: pendingPasskeySession.userId,
            publicKey: pendingPasskeySession.publicKey,
            signPublicKey: pendingPasskeySession.signPublicKey,
          },
          decryptedKeypair,
        );
      } else {
        await authenticateWithKeyPair(derivedUserId, decryptedKeypair);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setIsLoading(false);
    }
  };

  // Step 1: Enter User ID
  if (step === "userId") {
    return (
      <>
        <AuthSplitLayout
          eyebrow="Sign in"
          title="Private communication starts with a secure sign in."
          description="Voltex is built for people who want real privacy, secure communication, and more control over how their conversations are handled."
          desktopTitle="Sign in to private, secure communication."
          desktopDescription="Voltex is designed for secure, private communication without unnecessary data exposure, giving people a clearer alternative to platforms that talk about privacy without truly prioritizing user control."
          highlights={signInHighlights}
          secondaryLink={{ label: "Learn more about Voltex", to: "/about-v0lt3x" }}
          primaryCta={{ label: "Create a new account", to: "/signup" }}
        >
          <div className="mb-8 lg:mb-10">
          <p className="tactical-kicker mb-3">Sign in</p>
          <h1 className="max-w-[16ch] text-4xl leading-[1] text-foreground sm:text-5xl">
            Welcome back
          </h1>
          <p className="mt-3 max-w-[34rem] text-sm font-semibold leading-7 text-muted-foreground sm:text-base">
            Sign in to access private conversations on a platform built to keep
            communication secure, personal, and under your control.
          </p>
        </div>

        <form onSubmit={handleCheckUserId} className="mb-6 space-y-4 lg:mb-8">
            {error && (
              <div className="p-3 bg-destructive/10 border border-destructive text-destructive rounded-lg text-sm">
                {error}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                User ID
              </label>
              <input
                type="text"
                value={userIdInput}
                onChange={(e) => {
                  setUserIdInput(normalizeUserId(e.target.value));
                  setError("");
                }}
                placeholder="Enter your 16-character user ID"
                autoComplete="username"
                required
                inputMode="text"
                maxLength={16}
                className="tactical-input w-full px-4 py-3"
              />
              <p className="text-xs text-muted-foreground mt-2">
                Use the unique 16-character ID shown in your account screen
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
                  Authenticating...
                </span>
              ) : (
                "Sign In"
              )}
            </button>
          </form>

          <button
            type="button"
            onClick={() => void handlePasskeySignIn()}
            disabled={isLoading || !passkeySupported}
            className="tactical-button-outline mb-6 flex w-full font-semibold uppercase tracking-[0.2em] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isLoading ? "Working..." : "Sign In With Passkey"}
          </button>

          {!passkeySupported && (
            <p className="mb-6 text-center text-xs text-muted-foreground">
              Passkeys are not available in this browser or on this device.
            </p>
          )}

          <div className="mb-8 flex items-center gap-3">
            <div className="flex-1 h-px bg-border"></div>
            <span className="text-muted-foreground text-sm">
              New to Voltex?
            </span>
            <div className="flex-1 h-px bg-border"></div>
          </div>

          <Link
            to="/signup"
            className="tactical-button-outline mb-3 flex w-full font-semibold uppercase tracking-[0.2em]"
          >
            Create Account
          </Link>

          <Link
            to="/recover"
            className="block w-full py-2 text-sm text-primary hover:text-primary/80 transition-all text-center font-medium"
          >
            Recover using passphrase
          </Link>

          <div className="mt-10 grid gap-4 sm:grid-cols-2">
            <div className="tactical-panel-soft p-4">
              <div className="flex gap-3">
                <Lock className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-foreground mb-1">
                    How It Works
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Enter your 16-character user ID to sign in securely. Your account access
                    is protected by secure authentication.
                  </p>
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-primary/25 bg-primary/10 p-4">
              <p className="text-xs font-medium leading-6 text-primary/90">
                Tip: You can restore your account using your recovery phrase on
                a new device.
              </p>
            </div>
          </div>
        </AuthSplitLayout>
        <RestrictionAppealDialog
          open={restrictionModalOpen}
          onOpenChange={setRestrictionModalOpen}
          restrictionType={restrictionType}
          reason={restrictionReason}
          userId={normalizeUserId(userIdInput) || undefined}
        />
      </>
    );
  }

  // Step 2: Enter Passphrase (for cross-device signin)
  if (step === "passphrase") {
    return (
      <>
        <motion.div
          initial={passphraseStepTransition.initial}
          animate={passphraseStepTransition.animate}
          transition={passphraseStepTransition.transition}
        >
          <AuthSplitLayout
            eyebrow="Account recovery"
            title="Restore secure access from any device."
            description="Voltex keeps account recovery aligned with the same privacy-first approach: secure access without giving up user control."
            desktopTitle="Recover access without compromising privacy."
            desktopDescription="Voltex is built so secure recovery still supports private communication and user freedom, instead of relying on unnecessary exposure of your account data."
            highlights={signInHighlights}
            secondaryLink={{ label: "Back to initial sign in", to: "/signin" }}
          >
            <div className="mb-8 lg:mb-10">
            <p className="tactical-kicker mb-3">Account recovery</p>
            <h1 className="max-w-[18ch] text-4xl leading-[1] text-foreground sm:text-5xl">
              Recovery passphrase
            </h1>
            <p className="mt-3 max-w-xl text-sm font-semibold leading-7 text-muted-foreground sm:text-base">
              Use your recovery phrase to regain access while keeping the same
              privacy-focused experience Voltex is designed to provide.
            </p>
          </div>

          <form onSubmit={handlePassphraseSubmit} className="mb-6 space-y-4">
              {error && (
                <div className="p-3 bg-destructive/10 border border-destructive text-destructive rounded-lg text-sm">
                  {error}
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-foreground mb-2">
                  Your 24-Word Passphrase
                </label>
                <textarea
                  value={passphraseInput}
                  onChange={(e) => {
                    setPassphraseInput(e.target.value);
                    setError("");
                  }}
                  placeholder="word1 word2 word3 ... word24"
                  required
                  disabled={isLoading}
                  className="tactical-input h-24 w-full resize-none px-4 py-3 font-mono text-sm disabled:cursor-not-allowed disabled:opacity-50"
                />
                <p className="text-xs text-muted-foreground mt-2">
                  Enter the 24 words separated by spaces
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
                    Decrypting...
                  </span>
                ) : (
                  "Sign In"
                )}
              </button>
            </form>

            <button
              onClick={() => {
                setStep("userId");
                setPassphraseInput("");
                setError("");
                setRecoveryUserId(null);
                setPendingPasskeySession(null);
              }}
              className="w-full text-sm text-primary hover:text-primary/80 transition-all text-center font-medium py-2"
            >
              Back to User ID
            </button>

            <div className="tactical-panel-soft mt-10 p-4">
              <div className="flex gap-3">
                <Lock className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-foreground mb-1">
                    {pendingPasskeySession
                      ? "Passkey verified"
                      : "Cross-Device Sign In"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {pendingPasskeySession
                      ? "Finish restoring your local encryption keys with the same 24-word passphrase used to protect your account."
                      : "You can securely restore your account from any device using your 24-word recovery passphrase."}
                  </p>
                </div>
              </div>
            </div>
          </AuthSplitLayout>
        </motion.div>
        <RestrictionAppealDialog
          open={restrictionModalOpen}
          onOpenChange={setRestrictionModalOpen}
          restrictionType={restrictionType}
          reason={restrictionReason}
          userId={normalizeUserId(userIdInput) || undefined}
        />
      </>
    );
  }

  // Step 3: Success
  if (step === "success") {
    return (
      <>
        <AuthSplitLayout
          eyebrow="Sign in complete"
          title="Authentication succeeded."
          description="Your existing sign-in flow is complete and you are being redirected into the app."
          desktopTitle="Access granted."
          desktopDescription="Voltex finished authenticating the account and is moving you into the live messaging interface."
          highlights={signInHighlights}
        >
          <div className="p-2 text-center sm:p-4">
          <div className="mb-8">
            <svg
              className="mx-auto h-16 w-16 animate-pulse text-primary"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 13l4 4L19 7"
              />
            </svg>
          </div>
          <h2 className="mb-2 text-4xl font-black tracking-[-0.05em]">Welcome Back!</h2>
          <p className="text-muted-foreground mb-8">
            You've been successfully authenticated. Redirecting...
          </p>
          <p className="text-sm text-muted-foreground break-all">
            {authenticatedUserId}
          </p>
        </div>
        </AuthSplitLayout>
        <RestrictionAppealDialog
          open={restrictionModalOpen}
          onOpenChange={setRestrictionModalOpen}
          restrictionType={restrictionType}
          reason={restrictionReason}
          userId={normalizeUserId(userIdInput) || undefined}
        />
      </>
    );
  }

  return null;
}
