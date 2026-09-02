import type { EncryptedMediaDescriptor } from "./mediaCrypto";

export interface ImageMessagePayload {
  type: "image";
  provider: "voltex-media";
  mediaId: string;
  mimeType: string;
  width?: number;
  height?: number;
  size?: number;
  encryption?: EncryptedMediaDescriptor;
}

export interface UploadedImageDescriptor {
  mediaId: string;
  mimeType: string;
  width?: number;
  height?: number;
  size?: number;
  encryption?: EncryptedMediaDescriptor;
}

const IMAGE_MESSAGE_PREFIX = "VOLTEX_IMAGE::";

export function buildImageMessageContent(
  image: UploadedImageDescriptor,
): string {
  const payload: ImageMessagePayload = {
    type: "image",
    provider: "voltex-media",
    mediaId: image.mediaId,
    mimeType: image.mimeType,
    width: image.width,
    height: image.height,
    size: image.size,
    encryption: image.encryption,
  };

  return `${IMAGE_MESSAGE_PREFIX}${JSON.stringify(payload)}`;
}

export function parseImageMessageContent(
  content: string,
): ImageMessagePayload | null {
  if (!content.startsWith(IMAGE_MESSAGE_PREFIX)) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      content.slice(IMAGE_MESSAGE_PREFIX.length),
    ) as Partial<ImageMessagePayload>;

    if (
      parsed.type !== "image" ||
      parsed.provider !== "voltex-media" ||
      typeof parsed.mediaId !== "string" ||
      typeof parsed.mimeType !== "string"
    ) {
      return null;
    }

    const encryption =
      parsed.encryption &&
      typeof parsed.encryption === "object" &&
      parsed.encryption.version === "aes-gcm-v1" &&
      typeof parsed.encryption.key === "string" &&
      typeof parsed.encryption.iv === "string" &&
      typeof parsed.encryption.originalContentType === "string"
        ? parsed.encryption
        : undefined;

    return {
      type: "image",
      provider: "voltex-media",
      mediaId: parsed.mediaId,
      mimeType: parsed.mimeType,
      width: typeof parsed.width === "number" ? parsed.width : undefined,
      height: typeof parsed.height === "number" ? parsed.height : undefined,
      size: typeof parsed.size === "number" ? parsed.size : undefined,
      encryption,
    };
  } catch {
    return null;
  }
}
