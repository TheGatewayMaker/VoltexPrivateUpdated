import type { UploadedImageDescriptor } from "./imageMessages";
import {
  ENCRYPTED_MEDIA_VERSION,
  encryptMediaFile,
  supportsEncryptedMedia,
} from "./mediaCrypto";

const ACCEPTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
]);

async function getImageDimensions(
  file: File,
): Promise<{ width?: number; height?: number }> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      const result = {
        width: bitmap.width,
        height: bitmap.height,
      };
      bitmap.close();
      return result;
    } catch {
      return {};
    }
  }

  return {};
}

function validateImageFile(file: File): void {
  if (!ACCEPTED_IMAGE_TYPES.has(file.type)) {
    throw new Error("Only JPG, PNG, WEBP, and AVIF images are supported");
  }

  if (file.size > 12 * 1024 * 1024) {
    throw new Error("Image exceeds the 12MB limit");
  }
}

async function uploadImage(
  url: string,
  file: File,
  sessionToken: string,
): Promise<UploadedImageDescriptor> {
  validateImageFile(file);
  if (!supportsEncryptedMedia()) {
    throw new Error(
      "This browser does not support encrypted image messaging",
    );
  }

  const dimensions = await getImageDimensions(file);
  const encrypted = await encryptMediaFile(file);
  const body = encrypted.encryptedBytes.buffer.slice(
    encrypted.encryptedBytes.byteOffset,
    encrypted.encryptedBytes.byteOffset + encrypted.encryptedBytes.byteLength,
  ) as ArrayBuffer;
  const uploadContentType = "application/octet-stream";
  const encryption = encrypted.encryption;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": uploadContentType,
      Authorization: `Bearer ${sessionToken}`,
      ...(dimensions.width ? { "X-Image-Width": String(dimensions.width) } : {}),
      ...(dimensions.height ? { "X-Image-Height": String(dimensions.height) } : {}),
      ...(encryption
        ? {
            "X-Voltex-Media-Encryption": ENCRYPTED_MEDIA_VERSION,
            "X-Voltex-Original-Content-Type": file.type,
          }
        : {}),
    },
    body,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Failed to upload image");
  }

  return {
    mediaId: String(data.mediaId || ""),
    mimeType: String(data.mimeType || file.type),
    width:
      typeof data.width === "number" ? data.width : dimensions.width,
    height:
      typeof data.height === "number" ? data.height : dimensions.height,
    size: typeof data.size === "number" ? data.size : file.size,
    encryption,
  };
}

export async function uploadDirectImage(
  username: string,
  file: File,
  sessionToken: string,
): Promise<UploadedImageDescriptor> {
  return uploadImage(
    `/api/media/images/direct/by-username/${encodeURIComponent(username)}`,
    file,
    sessionToken,
  );
}

export async function uploadGroupImage(
  groupId: string,
  file: File,
  sessionToken: string,
): Promise<UploadedImageDescriptor> {
  return uploadImage(
    `/api/media/images/groups/${encodeURIComponent(groupId)}`,
    file,
    sessionToken,
  );
}
