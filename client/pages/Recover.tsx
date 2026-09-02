import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Lock } from "lucide-react";
import {
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
import { Loader } from "@/components/ui/loader";
import { VOLTEX_LOGO_URL } from "@/lib/branding";
import { toast } from "sonner";
import * as browserStorage from "@/lib/browserStorage";

type RecoverStep = "userId" | "passphrase" | "authenticating" | "success";

export default function Recover() {
  const navigate = useNavigate();
  const [step, setStep] = useState<RecoverStep>("userId");
  const [userIdInput, setUserIdInput] = useState("");
  const [passphraseInput, setPassphraseInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [recoveredUsername, setRecoveredUsername] = useState("");
  const [recoveryUsername, setRecoveryUsername] = useState<string | null>(null);

  const handleCheckUserId = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!userIdInput.trim()) {
      setError("User ID is required");
      return;
    }

    setError("");
    setIsLoading(true);

    try {
      setRecoveryUsername(userIdInput.trim().replace(/^@+/, "").toLowerCase());
      setStep("passphrase");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch account");
    } finally {
      setIsLoading(false);
    }
  };

  const handleRecoverAccount = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!passphraseInput.trim()) {
      setError("Passphrase is required");
      return;
    }

    if (!recoveryUsername) {
      setError("Session expired. Please start over.");
      setStep("userId");
      return;
    }

    setIsLoading(true);
    setError("");

    try {
      const normalizedPassphrase = normalizePassphrase(passphraseInput);
      const recoveryParamsResponse = await fetch(
        `/api/auth/recovery-params/by-username/${encodeURIComponent(recoveryUsername)}`,
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

      const recoveryResponse = await fetch("/api/auth/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: recoveryUsername,
          ...recoveryPayload,
        }),
      });

      if (!recoveryResponse.ok) {
        const errorData = await recoveryResponse.json();
        throw new Error(errorData.error || "Failed to verify passphrase");
      }

      const recoveryData = await recoveryResponse.json();

      const encryptedKeypairResponse = await fetch(
        `/api/auth/encrypted-keypair/by-username/${encodeURIComponent(recoveryUsername)}`,
        {
          headers: {
            "X-Recovery-Token": recoveryData.recoveryToken,
          },
        },
      );

      if (!encryptedKeypairResponse.ok) {
        const errorData = await encryptedKeypairResponse.json();
        throw new Error(errorData.error || "Failed to fetch account");
      }

      const encryptedKeypairData = await encryptedKeypairResponse.json();

      // Normalize passphrase
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

      setRecoveredUsername(recoveryUsername);
      setStep("authenticating");

      // Proceed with challenge-response authentication
      const challengeResponse = await fetch("/api/auth/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: derivedUserId,
          publicKey: decryptedKeypair.publicKeyBase64,
        }),
      });

      if (!challengeResponse.ok) {
        const errorData = await challengeResponse.json();
        throw new Error(errorData.error || "Failed to get challenge");
      }

      const challengeData = await challengeResponse.json();
      const challenge = challengeData.challenge;

      // Sign the challenge with decrypted signing private key
      const signature = signChallenge(
        challenge,
        decryptedKeypair.signPrivateKeyBase64,
      );

      // Verify signed challenge with server
      const verifyResponse = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: derivedUserId,
          challenge,
          signature,
          publicKey: decryptedKeypair.publicKeyBase64,
        }),
      });

      if (!verifyResponse.ok) {
        const errorData = await verifyResponse.json();
        throw new Error(errorData.error || "Authentication failed");
      }

      const authData = await verifyResponse.json();

      // Store the decrypted keypair locally
      await storeKeyPair(decryptedKeypair);

      // Store session token and user ID
      await browserStorage.setItem("session_token", authData.sessionToken);
      await browserStorage.setItem(
        "current_public_key",
        decryptedKeypair.publicKeyBase64,
      );
      if (decryptedKeypair.signPublicKeyBase64) {
        await browserStorage.setItem(
          "current_sign_public_key",
          decryptedKeypair.signPublicKeyBase64,
        );
      }

      setStep("success");
      void ensureProtocolBundleRegistered(authData.sessionToken, {
        identityKey: decryptedKeypair.publicKeyBase64,
        signingPublicKey: decryptedKeypair.signPublicKeyBase64,
        signingPrivateKey: decryptedKeypair.signPrivateKeyBase64,
      });

      toast.success("Account recovered successfully!");

      // Redirect after a short delay
      setTimeout(() => navigate("/"), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Account recovery failed");
      toast.error(
        err instanceof Error ? err.message : "Account recovery failed",
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleBackToUserId = () => {
    setStep("userId");
    setPassphraseInput("");
    setError("");
    setRecoveryUsername(null);
  };

  // Step 1: Enter Username
  if (step === "userId") {
    return (
      <div className="tactical-shell flex flex-col items-center justify-center px-4 py-8 sm:px-6 sm:py-12">
        <div className="tactical-panel w-full max-w-md p-6 sm:p-8">
          {/* Logo & Title */}
          <div className="mb-10 flex flex-col items-center">
            <img
              src={VOLTEX_LOGO_URL}
              alt="Voltex"
              className="mb-6 h-16 w-16 object-contain sm:h-[4.5rem] sm:w-[4.5rem]"
            />
            <p className="tactical-kicker mb-3">Recover account</p>
            <h1 className="mb-2 text-4xl font-black tracking-[-0.05em] text-foreground md:text-5xl">
              Recover Account
            </h1>
            <p className="text-center text-lg font-semibold text-muted-foreground">
              Restore your account using your recovery passphrase
            </p>
          </div>

          {/* Recovery Form */}
          <form onSubmit={handleCheckUserId} className="space-y-4 mb-6">
            {error && (
              <div className="p-3 bg-destructive/10 border border-destructive text-destructive rounded-lg text-sm">
                {error}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                Username
              </label>
              <input
                type="text"
                value={userIdInput}
                onChange={(e) => {
                  setUserIdInput(e.target.value);
                  setError("");
                }}
                placeholder="Enter your username"
                required
                className="tactical-input w-full px-4 py-3"
              />
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="tactical-button mt-6 w-full font-semibold uppercase tracking-[0.2em]"
            >
              {isLoading ? (
                <span className="flex items-center justify-center gap-2">
                  <Loader size="sm" className="shrink-0" />
                  Fetching Account...
                </span>
              ) : (
                "Continue"
              )}
            </button>
          </form>

          {/* Back to Sign In */}
          <Link
            to="/signin"
            className="tactical-button-outline flex w-full font-semibold uppercase tracking-[0.2em]"
          >
            Back to Sign In
          </Link>

          {/* Info */}
          <div className="tactical-panel-soft mt-10 p-4">
            <div className="flex gap-3">
              <Lock className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-foreground mb-1">
                  Recovery Process
                </p>
                <p className="text-xs text-muted-foreground">
                  Enter your username and recovery passphrase. We'll verify your
                  identity and help you restore access to your account.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Step 2: Enter Passphrase
  if (step === "passphrase") {
    return (
      <div className="tactical-shell flex flex-col items-center justify-center px-4 py-8 sm:px-6 sm:py-12">
        <div className="tactical-panel w-full max-w-md p-6 sm:p-8">
          {/* Logo & Title */}
          <div className="mb-10 flex flex-col items-center">
            <img
              src={VOLTEX_LOGO_URL}
              alt="Voltex"
              className="mb-6 h-16 w-16 object-contain sm:h-[4.5rem] sm:w-[4.5rem]"
            />
            <p className="tactical-kicker mb-3">Recovery passphrase</p>
            <h1 className="mb-2 text-4xl font-black tracking-[-0.05em] text-foreground md:text-5xl">
              Enter Recovery Passphrase
            </h1>
            <p className="text-center text-base font-semibold text-muted-foreground md:text-lg">
              Enter the 24-word passphrase you saved when creating your account
            </p>
          </div>

          {/* Passphrase Form */}
          <form onSubmit={handleRecoverAccount} className="space-y-4 mb-6">
            {error && (
              <div className="p-3 bg-destructive/10 border border-destructive text-destructive rounded-lg text-sm">
                {error}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                Recovery Passphrase
              </label>
              <textarea
                value={passphraseInput}
                onChange={(e) => {
                  setPassphraseInput(e.target.value);
                  setError("");
                }}
                placeholder="Paste your 24-word recovery passphrase here"
                rows={4}
                required
                disabled={isLoading}
                className="tactical-input w-full resize-none px-4 py-3 font-mono text-sm disabled:cursor-not-allowed disabled:opacity-50"
              />
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="tactical-button w-full font-semibold uppercase tracking-[0.2em]"
            >
              {isLoading ? (
                <span className="flex items-center justify-center gap-2">
                  <Loader size="sm" className="shrink-0" />
                  Recovering Account...
                </span>
              ) : (
                "Recover Account"
              )}
            </button>
          </form>

          {/* Back Button */}
          <button
            onClick={handleBackToUserId}
            className="tactical-button-outline w-full font-semibold uppercase tracking-[0.2em]"
          >
            Back
          </button>

          {/* Info */}
          <div className="tactical-panel-soft mt-6 p-4">
            <p className="text-sm text-foreground font-semibold">
              Your Passphrase
            </p>
            <p className="text-xs text-muted-foreground mt-2">
              Enter the exact 24-word passphrase you saved when creating your
              account. It will be used to decrypt your cryptographic keys
              securely.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Step 3: Success
  if (step === "success") {
    return (
      <div className="tactical-shell flex flex-col items-center justify-center px-4 py-8 sm:px-6 sm:py-12">
        <div className="tactical-panel w-full max-w-md p-8 text-center">
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
          <h2 className="mb-2 text-4xl font-black tracking-[-0.05em]">Account Recovered!</h2>
          <p className="text-muted-foreground mb-8">
            Your account has been successfully recovered. Redirecting...
          </p>
          <p className="text-sm text-muted-foreground break-all">
            @{recoveredUsername}
          </p>
        </div>
      </div>
    );
  }

  return null;
}
