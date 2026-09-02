import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { getStorageRoot } from "./storage-paths";

export const IMAGE_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
] as const;
export const ENCRYPTED_MEDIA_CONTENT_TYPE = "application/octet-stream";

type SupportedImageContentType = (typeof IMAGE_CONTENT_TYPES)[number];
type StoredMediaContentType =
  | SupportedImageContentType
  | typeof ENCRYPTED_MEDIA_CONTENT_TYPE;

type MediaScope =
  | {
      type: "direct";
      participantIds: [string, string];
      participantUsernames?: [string, string];
    }
  | {
      type: "group";
      groupId: string;
    };

type StoredImageRecordBase = {
  id: string;
  ownerId: string;
  createdAt: number;
  contentType: StoredMediaContentType;
  size: number;
  width?: number;
  height?: number;
  sha256: string;
  relativeFilePath: string;
  encryptionVersion?: "aes-gcm-v1";
  originalContentType?: SupportedImageContentType;
};

export type StoredImageRecord = StoredImageRecordBase & MediaScope;

function getDefaultMediaRoot(): string {
  return path.join(getStorageRoot(), "voltex-media");
}

function getConfiguredMediaRoot(): string {
  return path.resolve(
    process.env.VOLTEX_MEDIA_STORAGE_ROOT?.trim() || getDefaultMediaRoot(),
  );
}

function getLegacyMediaRoots(): string[] {
  const configuredRoot = getConfiguredMediaRoot();
  const defaultRoot = path.resolve(getDefaultMediaRoot());

  return configuredRoot === defaultRoot
    ? [configuredRoot]
    : [configuredRoot, defaultRoot];
}

function getShard(id: string): string {
  return id.slice(0, 2);
}

function getFileExtension(contentType: StoredMediaContentType): string {
  switch (contentType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/avif":
      return "avif";
    case ENCRYPTED_MEDIA_CONTENT_TYPE:
      return "bin";
  }
}

function sanitizeStorageSegment(value: string): string {
  const normalized = value.trim().toLowerCase();
  const sanitized = normalized.replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-");
  const trimmed = sanitized.replace(/^[-.]+|[-.]+$/g, "");
  return trimmed || "unknown";
}

function getDirectConversationFolder(
  participantUsernames: [string, string],
): string {
  return participantUsernames
    .map(sanitizeStorageSegment)
    .sort((left, right) => left.localeCompare(right))
    .join("-");
}

function getRelativeFilePath(
  id: string,
  contentType: StoredMediaContentType,
  scope: MediaScope,
): string {
  const extension = getFileExtension(contentType);

  if (scope.type === "direct" && scope.participantUsernames) {
    return path.join(
      "files",
      "direct",
      getDirectConversationFolder(scope.participantUsernames),
      getShard(id),
      `${id}.${extension}`,
    );
  }

  if (scope.type === "group") {
    return path.join(
      "files",
      "groups",
      sanitizeStorageSegment(scope.groupId),
      getShard(id),
      `${id}.${extension}`,
    );
  }

  return path.join("files", getShard(id), `${id}.${extension}`);
}

function getMetadataPath(id: string): string {
  return path.join(getConfiguredMediaRoot(), "metadata", getShard(id), `${id}.json`);
}

function getAbsoluteFilePath(relativeFilePath: string): string {
  return path.join(getConfiguredMediaRoot(), relativeFilePath);
}

async function ensureMediaDirectories(id: string): Promise<void> {
  const mediaRoot = getConfiguredMediaRoot();
  await fs.mkdir(path.join(mediaRoot, "metadata", getShard(id)), {
    recursive: true,
    mode: 0o700,
  });
}

async function ensureMediaFileDirectory(relativeFilePath: string): Promise<void> {
  await fs.mkdir(path.dirname(getAbsoluteFilePath(relativeFilePath)), {
    recursive: true,
    mode: 0o700,
  });
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return undefined;
}

export function isSupportedImageContentType(
  value: unknown,
): value is SupportedImageContentType {
  return typeof value === "string" && IMAGE_CONTENT_TYPES.includes(value as SupportedImageContentType);
}

function isStoredMediaContentType(
  value: unknown,
): value is StoredMediaContentType {
  return (
    isSupportedImageContentType(value) || value === ENCRYPTED_MEDIA_CONTENT_TYPE
  );
}

export function sniffImageContentType(
  buffer: Buffer,
): SupportedImageContentType | null {
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return "image/jpeg";
  }

  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }

  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }

  if (
    buffer.length >= 12 &&
    buffer.subarray(4, 8).toString("ascii") === "ftyp" &&
    (buffer.subarray(8, 12).toString("ascii") === "avif" ||
      buffer.subarray(8, 12).toString("ascii") === "avis")
  ) {
    return "image/avif";
  }

  return null;
}

export async function saveImageMedia(input: {
  ownerId: string;
  scope: MediaScope;
  buffer: Buffer;
  contentType: StoredMediaContentType;
  width?: unknown;
  height?: unknown;
  encryptionVersion?: "aes-gcm-v1";
  originalContentType?: SupportedImageContentType;
}): Promise<StoredImageRecord> {
  const id = crypto.randomUUID();
  const width = normalizePositiveInteger(input.width);
  const height = normalizePositiveInteger(input.height);

  await ensureMediaDirectories(id);

  const relativeFilePath = getRelativeFilePath(id, input.contentType, input.scope);
  await ensureMediaFileDirectory(relativeFilePath);
  const absoluteFilePath = getAbsoluteFilePath(relativeFilePath);
  const sha256 = crypto.createHash("sha256").update(input.buffer).digest("hex");

  const record: StoredImageRecord = {
    id,
    ownerId: input.ownerId,
    createdAt: Date.now(),
    contentType: input.contentType,
    size: input.buffer.length,
    width,
    height,
    sha256,
    relativeFilePath,
    encryptionVersion: input.encryptionVersion,
    originalContentType: input.originalContentType,
    ...input.scope,
  };

  await fs.writeFile(absoluteFilePath, input.buffer, { mode: 0o600 });
  await fs.writeFile(getMetadataPath(id), JSON.stringify(record, null, 2), {
    mode: 0o600,
  });

  return record;
}

export async function getImageMediaRecord(
  id: string,
): Promise<StoredImageRecord | null> {
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    return null;
  }

  try {
    let raw: string | null = null;

    for (const root of getLegacyMediaRoots()) {
      const metadataPath = path.join(root, "metadata", getShard(id), `${id}.json`);
      try {
        raw = await fs.readFile(metadataPath, "utf8");
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
          throw error;
        }
      }
    }

    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<StoredImageRecord>;

    if (
      typeof parsed.id !== "string" ||
      !isStoredMediaContentType(parsed.contentType) ||
      typeof parsed.ownerId !== "string" ||
      typeof parsed.createdAt !== "number" ||
      typeof parsed.size !== "number" ||
      typeof parsed.sha256 !== "string" ||
      typeof parsed.relativeFilePath !== "string"
    ) {
      return null;
    }

    if (
      parsed.type === "direct" &&
      Array.isArray(parsed.participantIds) &&
      parsed.participantIds.length === 2 &&
      typeof parsed.participantIds[0] === "string" &&
      typeof parsed.participantIds[1] === "string"
    ) {
      return {
        id: parsed.id,
        ownerId: parsed.ownerId,
        createdAt: parsed.createdAt,
        contentType: parsed.contentType,
        size: parsed.size,
        width:
          typeof parsed.width === "number" ? parsed.width : undefined,
        height:
          typeof parsed.height === "number" ? parsed.height : undefined,
        sha256: parsed.sha256,
        relativeFilePath: parsed.relativeFilePath,
        encryptionVersion:
          parsed.encryptionVersion === "aes-gcm-v1"
            ? parsed.encryptionVersion
            : undefined,
        originalContentType: isSupportedImageContentType(parsed.originalContentType)
          ? parsed.originalContentType
          : undefined,
        type: "direct",
        participantIds: [parsed.participantIds[0], parsed.participantIds[1]],
      };
    }

    if (parsed.type === "group" && typeof parsed.groupId === "string") {
      return {
        id: parsed.id,
        ownerId: parsed.ownerId,
        createdAt: parsed.createdAt,
        contentType: parsed.contentType,
        size: parsed.size,
        width:
          typeof parsed.width === "number" ? parsed.width : undefined,
        height:
          typeof parsed.height === "number" ? parsed.height : undefined,
        sha256: parsed.sha256,
        relativeFilePath: parsed.relativeFilePath,
        encryptionVersion:
          parsed.encryptionVersion === "aes-gcm-v1"
            ? parsed.encryptionVersion
            : undefined,
        originalContentType: isSupportedImageContentType(parsed.originalContentType)
          ? parsed.originalContentType
          : undefined,
        type: "group",
        groupId: parsed.groupId,
      };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.error("Failed to read stored media metadata:", error);
    }
  }

  return null;
}

export async function readImageMediaBody(
  record: StoredImageRecord,
): Promise<Buffer> {
  for (const root of getLegacyMediaRoots()) {
    const absolutePath = path.join(root, record.relativeFilePath);
    try {
      return await fs.readFile(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        throw error;
      }
    }
  }

  throw new Error("Stored media file not found");
}

export function getMediaStorageRoot(): string {
  return getConfiguredMediaRoot();
}
