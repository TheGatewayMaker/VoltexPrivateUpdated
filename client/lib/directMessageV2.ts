import type {
  DirectMessageV2Envelope,
  DirectMessageV2Record,
  SupportedProtocolMessageVersion,
} from "@shared/crypto";
import {
  getLocalProtocolDeviceState,
  getProtocolBundlesForUsername,
} from "./protocol";

export interface DirectMessageV2ConversationMessage
  extends DirectMessageV2Record,
    DirectMessageV2Envelope {
  deliveredAt?: number;
  seenAt?: number;
}

export interface DirectMessageV2ReceiptSummary {
  recipientUserId: string;
  recipientDeviceCount: number;
  deliveredDeviceCount: number;
  seenDeviceCount: number;
  deliveredToAny: boolean;
  seenByAny: boolean;
  seenByAll: boolean;
}

export interface DirectMessageV2ConversationResponse {
  messages: DirectMessageV2ConversationMessage[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  receiptSummaryByMessageId: Record<string, DirectMessageV2ReceiptSummary>;
  deviceId?: string;
}

export interface DirectMessageV2Readiness {
  ready: boolean;
  mode: "v1" | "v2";
  reason:
    | "ready"
    | "missing_local_protocol_state"
    | "missing_remote_bundles"
    | "remote_bundle_missing_v2"
    | "device_session_crypto_not_implemented";
  localDeviceId?: string;
  remoteDeviceIds: string[];
  remoteSupportedMessageVersions: SupportedProtocolMessageVersion[][];
}

function normalizeSupportedVersions(
  value: unknown,
): SupportedProtocolMessageVersion[] {
  if (!Array.isArray(value)) {
    return ["v1"];
  }

  const versions = value.filter(
    (entry): entry is SupportedProtocolMessageVersion =>
      entry === "v1" || entry === "v2",
  );

  return versions.length > 0 ? Array.from(new Set(versions)) : ["v1"];
}

export async function getDirectMessageV2ReadinessForUsername(
  username: string,
  sessionToken?: string,
): Promise<DirectMessageV2Readiness> {
  const localState = await getLocalProtocolDeviceState();
  if (!localState) {
    return {
      ready: false,
      mode: "v1",
      reason: "missing_local_protocol_state",
      remoteDeviceIds: [],
      remoteSupportedMessageVersions: [],
    };
  }

  const bundles = await getProtocolBundlesForUsername(username, sessionToken);
  if (bundles.length === 0) {
    return {
      ready: false,
      mode: "v1",
      reason: "missing_remote_bundles",
      localDeviceId: localState.deviceId,
      remoteDeviceIds: [],
      remoteSupportedMessageVersions: [],
    };
  }

  const remoteSupportedMessageVersions = bundles.map((bundle) =>
    normalizeSupportedVersions(bundle.supportedMessageVersions),
  );
  const remoteDeviceIds = bundles.map((bundle) => bundle.deviceId);
  const everyRemoteBundleSupportsV2 = remoteSupportedMessageVersions.every((versions) =>
    versions.includes("v2"),
  );

  if (!everyRemoteBundleSupportsV2) {
    return {
      ready: false,
      mode: "v1",
      reason: "remote_bundle_missing_v2",
      localDeviceId: localState.deviceId,
      remoteDeviceIds,
      remoteSupportedMessageVersions,
    };
  }

  return {
    ready: false,
    mode: "v1",
    reason: "device_session_crypto_not_implemented",
    localDeviceId: localState.deviceId,
    remoteDeviceIds,
    remoteSupportedMessageVersions,
  };
}

export async function sendDirectMessageV2(
  params: {
    recipientId?: string;
    recipientUsername?: string;
    messageType: DirectMessageV2Record["messageType"];
    clientTimestamp?: number;
    clientMessageId?: string;
    envelopes: DirectMessageV2Envelope[];
  },
  sessionToken: string,
): Promise<{
  success: boolean;
  recipientDeviceCount: number;
  senderDeviceCount: number;
  serverTimestamp: number;
}> {
  const response = await fetch("/api/messages/v2/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sessionToken}`,
    },
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || "Failed to send direct message v2");
  }

  return response.json();
}

export async function getConversationHistoryV2(
  recipientUsername: string,
  sessionToken: string,
  limit: number = 50,
  offset: number = 0,
): Promise<DirectMessageV2ConversationResponse> {
  const url = new URL(
    `/api/messages/v2/conversation/by-username/${encodeURIComponent(recipientUsername)}`,
    window.location.origin,
  );
  url.searchParams.set("limit", limit.toString());
  url.searchParams.set("offset", offset.toString());

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${sessionToken}`,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || "Failed to load direct message v2 conversation");
  }

  return response.json();
}

export async function markConversationAsReadV2(
  recipientUsername: string,
  sessionToken: string,
): Promise<{ success: boolean; updatedCount: number; deviceId?: string }> {
  const response = await fetch(
    `/api/messages/v2/conversations/by-username/${encodeURIComponent(recipientUsername)}/read`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${sessionToken}`,
      },
    },
  );

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || "Failed to mark direct message v2 conversation as read");
  }

  return response.json();
}
