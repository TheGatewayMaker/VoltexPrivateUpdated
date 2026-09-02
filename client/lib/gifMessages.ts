export type KlipyMediaKind = "gif" | "sticker";

export interface GifMessagePayload {
  type: KlipyMediaKind;
  provider: "klipy";
  id: string;
  title: string;
  url: string;
  previewUrl: string;
  width?: number;
  height?: number;
}

export interface KlipyGifItem {
  id: string;
  title: string;
  url: string;
  previewUrl: string;
  width?: number;
  height?: number;
  type?: KlipyMediaKind;
}

const GIF_MESSAGE_PREFIX = "VOLTEX_GIF::";

export function buildGifMessageContent(
  gif: KlipyGifItem,
  type: KlipyMediaKind = "gif",
): string {
  const payload: GifMessagePayload = {
    type,
    provider: "klipy",
    id: gif.id,
    title: gif.title,
    url: gif.url,
    previewUrl: gif.previewUrl,
    width: gif.width,
    height: gif.height,
  };

  return `${GIF_MESSAGE_PREFIX}${JSON.stringify(payload)}`;
}

export function parseGifMessageContent(
  content: string,
): GifMessagePayload | null {
  if (!content.startsWith(GIF_MESSAGE_PREFIX)) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      content.slice(GIF_MESSAGE_PREFIX.length),
    ) as Partial<GifMessagePayload>;

    if (
      (parsed.type !== "gif" && parsed.type !== "sticker") ||
      parsed.provider !== "klipy" ||
      typeof parsed.id !== "string" ||
      typeof parsed.url !== "string" ||
      typeof parsed.previewUrl !== "string"
    ) {
      return null;
    }

    return {
      type: parsed.type,
      provider: "klipy",
      id: parsed.id,
      title:
        typeof parsed.title === "string"
          ? parsed.title
          : parsed.type === "sticker"
            ? "Sticker"
            : "GIF",
      url: parsed.url,
      previewUrl: parsed.previewUrl,
      width: typeof parsed.width === "number" ? parsed.width : undefined,
      height: typeof parsed.height === "number" ? parsed.height : undefined,
    };
  } catch {
    return null;
  }
}
