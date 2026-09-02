import { useEffect, useState } from "react";
import { ImageMessagePayload } from "@/lib/imageMessages";
import { decryptMediaBlob } from "@/lib/mediaCrypto";
import * as browserStorage from "@/lib/browserStorage";

const objectUrlCache = new Map<string, string>();
const inflightObjectUrls = new Map<string, Promise<string>>();
const MAX_CACHED_OBJECT_URLS = 96;

function cacheObjectUrl(mediaId: string, objectUrl: string): string {
  if (objectUrlCache.has(mediaId)) {
    return objectUrlCache.get(mediaId)!;
  }

  objectUrlCache.set(mediaId, objectUrl);
  while (objectUrlCache.size > MAX_CACHED_OBJECT_URLS) {
    const oldestKey = objectUrlCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    const cachedUrl = objectUrlCache.get(oldestKey);
    if (cachedUrl) {
      URL.revokeObjectURL(cachedUrl);
    }
    objectUrlCache.delete(oldestKey);
  }

  return objectUrl;
}

async function loadImageObjectUrl(image: ImageMessagePayload): Promise<string> {
  const cached = objectUrlCache.get(image.mediaId);
  if (cached) {
    return cached;
  }

  const pending = inflightObjectUrls.get(image.mediaId);
  if (pending) {
    return pending;
  }

  const sessionToken = browserStorage.getItem("session_token");
  if (!sessionToken) {
    throw new Error("Missing session token");
  }

  const request = fetch(`/api/media/images/${encodeURIComponent(image.mediaId)}`, {
    headers: {
      Authorization: `Bearer ${sessionToken}`,
    },
  })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error("Failed to load image");
      }
      if (image.encryption) {
        const encryptedBytes = await response.arrayBuffer();
        const decryptedBlob = await decryptMediaBlob(
          encryptedBytes,
          image.encryption,
        );
        return cacheObjectUrl(
          image.mediaId,
          URL.createObjectURL(decryptedBlob),
        );
      }

      const blob = await response.blob();
      return cacheObjectUrl(image.mediaId, URL.createObjectURL(blob));
    })
    .finally(() => {
      inflightObjectUrls.delete(image.mediaId);
    });

  inflightObjectUrls.set(image.mediaId, request);
  return request;
}

interface ImageMessageContentProps {
  image: ImageMessagePayload;
  onReady?: () => void;
}

export default function ImageMessageContent({
  image,
  onReady,
}: ImageMessageContentProps) {
  const [src, setSrc] = useState<string | null>(() => objectUrlCache.get(image.mediaId) || null);
  const [hasError, setHasError] = useState(false);
  const aspectRatio =
    image.width && image.height ? `${image.width} / ${image.height}` : undefined;

  useEffect(() => {
    let cancelled = false;
    setHasError(false);

    void loadImageObjectUrl(image)
      .then((objectUrl) => {
        if (!cancelled) {
          setSrc(objectUrl);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHasError(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [image]);

  if (hasError) {
    return (
      <div className="flex h-44 w-full items-center justify-center rounded-2xl bg-black/10 px-4 text-center text-sm text-muted-foreground">
        Unable to load image.
      </div>
    );
  }

  if (!src) {
    return (
      <div
        className="w-full animate-pulse rounded-2xl bg-black/10"
        style={{
          aspectRatio: aspectRatio || "4 / 3",
          minHeight: "11rem",
        }}
      />
    );
  }

  return (
    <div
      className="w-full overflow-hidden rounded-2xl bg-black/5"
      style={{
        aspectRatio,
      }}
    >
      <img
        src={src}
        alt="Shared image"
        className="max-h-[24rem] w-full rounded-2xl object-cover"
        width={image.width}
        height={image.height}
        loading="eager"
        decoding="async"
        draggable={false}
        onLoad={onReady}
      />
    </div>
  );
}
