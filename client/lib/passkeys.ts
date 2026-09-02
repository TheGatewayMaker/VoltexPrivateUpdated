import {
  browserSupportsWebAuthn,
  platformAuthenticatorIsAvailable,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import { PasskeyStatusResponse } from "@shared/passkeys";
import * as browserStorage from "./browserStorage";

type PreferredAuthenticatorType = "securityKey" | "localDevice" | "remoteDevice";

export function isPasskeySupported(): boolean {
  return browserSupportsWebAuthn();
}

export async function isPlatformPasskeyAvailable(): Promise<boolean> {
  try {
    return await platformAuthenticatorIsAvailable();
  } catch {
    return false;
  }
}

function getPreferredAuthenticatorType(): PreferredAuthenticatorType {
  if (typeof window === "undefined") {
    return "localDevice";
  }

  const isLikelyMobile =
    window.matchMedia?.("(pointer: coarse)")?.matches ||
    /android|iphone|ipad|ipod/i.test(window.navigator.userAgent);

  return isLikelyMobile ? "localDevice" : "remoteDevice";
}

function getPasskeyErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return "Passkey request was cancelled";
    }

    if (error.name === "NotAllowedError") {
      return "Passkey request was cancelled or timed out";
    }

    if (error.name === "InvalidStateError") {
      return "A passkey is already registered for this account on this device";
    }

    return error.message;
  }

  return "Passkey request failed";
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      typeof payload?.error === "string" ? payload.error : "Request failed";
    const error = new Error(message) as Error & { payload?: unknown };
    error.payload = payload;
    throw error;
  }

  return payload as T;
}

export async function fetchPasskeyStatus(): Promise<PasskeyStatusResponse> {
  const sessionToken = browserStorage.getItem("session_token");
  if (!sessionToken) {
    throw new Error("Authentication required");
  }

  const response = await fetch("/api/auth/passkeys/status", {
    headers: {
      Authorization: `Bearer ${sessionToken}`,
    },
  });

  return readJsonResponse<PasskeyStatusResponse>(response);
}

export async function createPasskey(input: {
  recoveryVerifier?: string;
  passphraseHash?: string;
}): Promise<PasskeyStatusResponse> {
  const sessionToken = browserStorage.getItem("session_token");
  if (!sessionToken) {
    throw new Error("Authentication required");
  }

  if (!isPasskeySupported()) {
    throw new Error("Passkeys are not supported on this device or browser");
  }

  const beginResponse = await fetch("/api/auth/passkeys/register/options", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sessionToken}`,
    },
    body: JSON.stringify({
      ...input,
      preferredAuthenticatorType: getPreferredAuthenticatorType(),
    }),
  });
  const beginData = await readJsonResponse<{
    flowId: string;
    options: Record<string, unknown>;
  }>(beginResponse);

  let attestation: any;
  try {
    attestation = await startRegistration({
      optionsJSON: beginData.options as any,
      useAutoRegister: false,
    });
  } catch (error) {
    throw new Error(getPasskeyErrorMessage(error));
  }

  const verifyResponse = await fetch("/api/auth/passkeys/register/verify", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sessionToken}`,
    },
    body: JSON.stringify({
      flowId: beginData.flowId,
      response: attestation,
    }),
  });

  const verifyData = await readJsonResponse<{
    status: PasskeyStatusResponse;
  }>(verifyResponse);

  return verifyData.status;
}

export async function authenticateWithPasskey(input?: {
  userId?: string;
}): Promise<{
  sessionToken: string;
  userId: string;
  publicKey: string;
  signPublicKey: string | null;
  username: string | null;
  expiresAt: number;
  passkey: PasskeyStatusResponse;
}> {
  if (!isPasskeySupported()) {
    throw new Error("Passkeys are not supported on this device or browser");
  }

  const beginResponse = await fetch("/api/auth/passkeys/authenticate/options", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      userId: input?.userId || undefined,
    }),
  });
  const beginData = await readJsonResponse<{
    flowId: string;
    options: Record<string, unknown>;
  }>(beginResponse);

  let assertion: any;
  try {
    assertion = await startAuthentication({
      optionsJSON: beginData.options as any,
      useBrowserAutofill: false,
      verifyBrowserAutofillInput: false,
    });
  } catch (error) {
    throw new Error(getPasskeyErrorMessage(error));
  }

  const verifyResponse = await fetch("/api/auth/passkeys/authenticate/verify", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      flowId: beginData.flowId,
      response: assertion,
    }),
  });

  return readJsonResponse<{
    sessionToken: string;
    userId: string;
    publicKey: string;
    signPublicKey: string | null;
    username: string | null;
    expiresAt: number;
    passkey: PasskeyStatusResponse;
  }>(verifyResponse);
}

export async function deletePasskey(input: {
  recoveryVerifier?: string;
  passphraseHash?: string;
}): Promise<PasskeyStatusResponse> {
  const sessionToken = browserStorage.getItem("session_token");
  if (!sessionToken) {
    throw new Error("Authentication required");
  }

  const response = await fetch("/api/auth/passkeys", {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sessionToken}`,
    },
    body: JSON.stringify(input),
  });

  const payload = await readJsonResponse<{ status: PasskeyStatusResponse }>(
    response,
  );

  return payload.status;
}

export async function verifyPasskeyStepUp(): Promise<{
  verificationToken: string;
  expiresAt: number;
}> {
  const sessionToken = browserStorage.getItem("session_token");
  if (!sessionToken) {
    throw new Error("Authentication required");
  }

  if (!isPasskeySupported()) {
    throw new Error("Passkeys are not supported on this device or browser");
  }

  const beginResponse = await fetch("/api/auth/passkeys/step-up/options", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${sessionToken}`,
    },
  });
  const beginData = await readJsonResponse<{
    flowId: string;
    options: Record<string, unknown>;
  }>(beginResponse);

  let assertion: any;
  try {
    assertion = await startAuthentication({
      optionsJSON: beginData.options as any,
      useBrowserAutofill: false,
      verifyBrowserAutofillInput: false,
    });
  } catch (error) {
    throw new Error(getPasskeyErrorMessage(error));
  }

  const verifyResponse = await fetch("/api/auth/passkeys/step-up/verify", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sessionToken}`,
    },
    body: JSON.stringify({
      flowId: beginData.flowId,
      response: assertion,
    }),
  });

  return readJsonResponse<{
    verificationToken: string;
    expiresAt: number;
  }>(verifyResponse);
}
