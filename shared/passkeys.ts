export type PasskeyCredentialDeviceType = "singleDevice" | "multiDevice";

export interface StoredPasskeyCredential {
  userId: string;
  credentialId: string;
  publicKey: string;
  counter: number;
  transports?: string[];
  deviceType?: PasskeyCredentialDeviceType;
  backedUp?: boolean;
  aaguid?: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number | null;
}

export interface StoredPasskeyChallenge {
  flowId: string;
  challenge: string;
  purpose: "registration" | "authentication" | "step-up";
  userId?: string | null;
  expiresAt: number;
  createdAt: number;
}

export interface PasskeyStatusResponse {
  enabled: boolean;
  credentialId?: string;
  createdAt?: number;
  lastUsedAt?: number | null;
  deviceType?: PasskeyCredentialDeviceType;
  backedUp?: boolean;
}
