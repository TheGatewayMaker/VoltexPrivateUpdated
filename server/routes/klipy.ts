import { RequestHandler } from "express";
import { getSessionFromToken } from "./auth";

interface KlipyGifItem {
  id: string;
  title: string;
  url: string;
  previewUrl: string;
  width?: number;
  height?: number;
  type?: "gif" | "sticker";
}

const KLIPY_BASE_URL = "https://api.klipy.com";
const DEFAULT_KLIPY_LOCALE = "us_US";
const KLIPY_ALLOWED_HOST_PATTERNS = [
  /(^|\.)klipy\.com$/i,
  /(^|\.)giphy\.com$/i,
  /(^|\.)giphyusercontent\.com$/i,
  /(^|\.)media\d*\.giphy\.com$/i,
];

function getBearerToken(header: string | undefined): string {
  return typeof header === "string" ? header.replace("Bearer ", "") : "";
}

function normalizeString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function toProxyUrl(url: string): string {
  return `/api/klipy/asset?url=${encodeURIComponent(url)}`;
}

function normalizeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stripQuery(url: string): string {
  return url.split("?")[0] || url;
}

function scoreAssetUrl(url: string): number {
  const normalized = stripQuery(url).toLowerCase();

  if (normalized.endsWith(".gif")) return 60;
  if (normalized.endsWith(".webp")) return 50;
  if (normalized.endsWith(".png")) return 40;
  if (normalized.endsWith(".jpg") || normalized.endsWith(".jpeg")) return 35;
  if (normalized.endsWith(".avif")) return 30;
  if (normalized.endsWith(".mp4")) return 20;
  if (normalized.endsWith(".webm")) return 15;
  if (normalized.endsWith(".mov")) return 10;
  return 0;
}

function collectCandidateUrls(value: unknown, acc: string[] = []): string[] {
  if (!value) {
    return acc;
  }

  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value)) {
      acc.push(value);
    }
    return acc;
  }

  if (Array.isArray(value)) {
    value.forEach((entry) => collectCandidateUrls(entry, acc));
    return acc;
  }

  if (typeof value === "object") {
    Object.values(value as Record<string, unknown>).forEach((entry) =>
      collectCandidateUrls(entry, acc),
    );
  }

  return acc;
}

function pickAsset(candidate: Record<string, any> | null | undefined) {
  if (!candidate) {
    return null;
  }

  const file = candidate.file || candidate;
  const url =
    normalizeString(file.url) ||
    normalizeString(file.webp?.url) ||
    normalizeString(file.gif?.url) ||
    normalizeString(file.mp4?.url) ||
    normalizeString(file.webm?.url) ||
    collectCandidateUrls(file)[0] ||
    "";

  if (!url) {
    return null;
  }

  return {
    url,
    width: normalizeNumber(file.width),
    height: normalizeNumber(file.height),
  };
}

function pickBestAsset(
  candidates: Array<Record<string, any> | null | undefined>,
  options?: { preferPreview?: boolean },
) {
  const all = candidates
    .flatMap((candidate) => {
      if (!candidate) {
        return [];
      }

      if (Array.isArray(candidate)) {
        return candidate
          .map((entry) => pickAsset(entry as Record<string, any>))
          .filter(Boolean);
      }

      if (typeof candidate === "object") {
        const direct = pickAsset(candidate);
        const nested =
          "file" in candidate || "url" in candidate
            ? []
            : Object.values(candidate).map((entry) =>
                pickAsset(entry as Record<string, any>),
              );
        return [direct, ...nested].filter(Boolean);
      }

      return [];
    })
    .filter((asset): asset is NonNullable<typeof asset> => !!asset);

  const ranked = all.sort((a, b) => {
    const aScore = scoreAssetUrl(a.url);
    const bScore = scoreAssetUrl(b.url);

    if (options?.preferPreview) {
      return bScore - aScore;
    }

    return bScore - aScore;
  });

  return ranked[0] || null;
}

function normalizeFromTenorLike(
  item: Record<string, any>,
  type: "gif" | "sticker",
): KlipyGifItem | null {
  const formats = item.media_formats || item.media || {};
  const primary = pickBestAsset([
    formats.gif,
    formats.mediumgif,
    formats.tinygif,
    formats.nanogif,
    formats.webp,
    formats.nanowebp,
    formats.mediumwebp,
    formats.mp4,
    formats.webm,
  ]);
  const preview = pickBestAsset(
    [
      formats.tinygif,
      formats.nanogif,
      formats.gif,
      formats.webp,
      formats.nanowebp,
      formats.mediumwebp,
      formats.mp4,
      formats.webm,
    ],
    { preferPreview: true },
  ) || primary;

  if (!primary || !preview) {
    return null;
  }

  return {
    id: normalizeString(item.id, primary.url),
    title: normalizeString(item.content_description, "GIF"),
    url: toProxyUrl(primary.url),
    previewUrl: toProxyUrl(preview.url),
    width: primary.width || preview.width,
    height: primary.height || preview.height,
    type,
  };
}

function normalizeFromLegacyFiles(
  item: Record<string, any>,
  type: "gif" | "sticker",
): KlipyGifItem | null {
  const files = item.files;
  const assets = Array.isArray(files)
    ? files
    : typeof files === "object"
      ? Object.values(files)
      : [];
  const primary = pickBestAsset(assets);
  const preview = pickBestAsset(assets, { preferPreview: true }) || primary;

  if (!primary || !preview) {
    return null;
  }

  return {
    id: normalizeString(item.slug || item.id, primary.url),
    title: normalizeString(item.title || item.name, type === "sticker" ? "Sticker" : "GIF"),
    url: toProxyUrl(primary.url),
    previewUrl: toProxyUrl(preview.url),
    width: primary.width || preview.width,
    height: primary.height || preview.height,
    type,
  };
}

function normalizeDirectItem(
  item: Record<string, any>,
  type: "gif" | "sticker",
): KlipyGifItem | null {
  const primary = pickBestAsset([item]);
  const preview =
    pickBestAsset([item.preview, item.images, item.files], {
      preferPreview: true,
    }) ||
    primary;

  if (!primary || !preview) {
    return null;
  }

  return {
    id: normalizeString(item.id || item.slug, primary.url),
    title: normalizeString(
      item.title || item.name || item.content_description,
      type === "sticker" ? "Sticker" : "GIF",
    ),
    url: toProxyUrl(primary.url),
    previewUrl: toProxyUrl(preview.url),
    width: primary.width || preview.width,
    height: primary.height || preview.height,
    type,
  };
}

function normalizeItems(
  payload: any,
  type: "gif" | "sticker",
): KlipyGifItem[] {
  const rawItems = Array.isArray(payload?.results)
    ? payload.results
    : Array.isArray(payload?.data?.results)
      ? payload.data.results
    : Array.isArray(payload?.data?.data)
      ? payload.data.data
      : Array.isArray(payload?.data)
        ? payload.data
        : [];

  return rawItems
    .map((item: Record<string, any>) =>
      item?.media_formats || item?.media
        ? normalizeFromTenorLike(item, type)
        : item?.files
          ? normalizeFromLegacyFiles(item, type)
          : normalizeDirectItem(item, type),
    )
    .filter((item): item is KlipyGifItem => !!item)
    .slice(0, 24);
}

async function requireSession(req: Parameters<RequestHandler>[0]) {
  const sessionToken = getBearerToken(req.headers.authorization);
  if (!sessionToken) {
    return null;
  }

  return getSessionFromToken(sessionToken);
}

async function fetchKlipy(
  path: string,
  query: URLSearchParams,
  type: "gif" | "sticker",
): Promise<KlipyGifItem[]> {
  const url = `${KLIPY_BASE_URL}${path}?${query.toString()}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Klipy request failed with status ${response.status}`);
  }

  const payload = await response.json();
  const items = normalizeItems(payload, type);

  const explicitError =
    normalizeString(payload?.error) ||
    normalizeString(payload?.message) ||
    normalizeString(payload?.meta?.msg);

  console.log(
    "[KLIPY]",
    JSON.stringify({
      path,
      query: Object.fromEntries(query.entries()),
      itemCount: items.length,
      topLevelKeys:
        payload && typeof payload === "object" ? Object.keys(payload).slice(0, 12) : [],
      explicitError,
    }),
  );

  if (!items.length && explicitError) {
    throw new Error(explicitError);
  }

  return items;
}

async function resolveKlipyItems(input: {
  mode: "search" | "trending";
  type: "gif" | "sticker";
  query?: string;
}) {
  const apiKey = process.env.KLIPY_API_KEY;
  if (!apiKey) {
    throw new Error("KLIPY_API_KEY is not configured on the server");
  }

  const requestedLocale = process.env.KLIPY_LOCALE || DEFAULT_KLIPY_LOCALE;
  const rating = process.env.KLIPY_RATING || "pg";

  const localeCandidates = Array.from(
    new Set([requestedLocale, DEFAULT_KLIPY_LOCALE, "en_US", ""]),
  );

  const v2AuthVariants = [
    { key: apiKey },
    { client_key: apiKey },
    { key: apiKey, client_key: "voltexsms" },
    { client_key: apiKey, key: "voltexsms" },
  ];

  for (const locale of localeCandidates) {
    for (const authVariant of v2AuthVariants) {
      const v2Params = new URLSearchParams({
        ...authVariant,
        media_filter: "minimal",
        contentfilter: "medium",
        limit: "24",
      });

      if (locale) {
        v2Params.set("locale", locale);
      }

      if (input.mode === "search") {
        v2Params.set("q", input.query || "");
      }

      try {
        const v2Items = await fetchKlipy(
          input.mode === "search"
            ? input.type === "sticker"
              ? "/v2/stickers/search"
              : "/v2/search"
            : input.type === "sticker"
              ? "/v2/stickers/featured"
              : "/v2/featured",
          v2Params,
          input.type,
        );

        if (v2Items.length > 0) {
          return v2Items;
        }
      } catch (error) {
        console.warn(
          "[KLIPY] v2 attempt failed",
          JSON.stringify({
            mode: input.mode,
            locale,
            authVariant: Object.keys(authVariant),
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
  }

  for (const locale of localeCandidates) {
    const legacyParams = new URLSearchParams({
      per_page: "24",
      rating,
    });

    if (input.mode === "search") {
      legacyParams.set("q", input.query || "");
    }
    if (locale) {
      legacyParams.set("locale", locale);
    }

    try {
      const legacyItems = await fetchKlipy(
        input.mode === "search"
          ? `/api/v1/${encodeURIComponent(apiKey)}/${input.type === "sticker" ? "stickers" : "gifs"}/search`
          : `/api/v1/${encodeURIComponent(apiKey)}/${input.type === "sticker" ? "stickers" : "gifs"}/trending`,
        legacyParams,
        input.type,
      );

      if (legacyItems.length > 0) {
        return legacyItems;
      }
    } catch (error) {
      console.warn(
        "[KLIPY] legacy attempt failed",
        JSON.stringify({
          mode: input.mode,
          locale,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  throw new Error(
    "Klipy returned no media for this request. Check API key access, locale settings, or upstream response format.",
  );
}

export const handleSearchKlipyGifs: RequestHandler = async (req, res) => {
  try {
    const session = await requireSession(req);
    if (!session) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const query = normalizeString(req.query.q);
    if (!query) {
      return res.status(400).json({ error: "Search query is required" });
    }

    const items = await resolveKlipyItems({
      mode: "search",
      type: "gif",
      query,
    });

    return res.status(200).json({ items });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to search GIFs",
    });
  }
};

export const handleTrendingKlipyGifs: RequestHandler = async (req, res) => {
  try {
    const session = await requireSession(req);
    if (!session) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const items = await resolveKlipyItems({
      mode: "trending",
      type: "gif",
    });

    return res.status(200).json({ items });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to load trending GIFs",
    });
  }
};

export const handleSearchKlipyStickers: RequestHandler = async (req, res) => {
  try {
    const session = await requireSession(req);
    if (!session) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const query = normalizeString(req.query.q);
    if (!query) {
      return res.status(400).json({ error: "Search query is required" });
    }

    const items = await resolveKlipyItems({
      mode: "search",
      type: "sticker",
      query,
    });

    return res.status(200).json({ items });
  } catch (error) {
    return res.status(500).json({
      error:
        error instanceof Error ? error.message : "Failed to search stickers",
    });
  }
};

export const handleTrendingKlipyStickers: RequestHandler = async (req, res) => {
  try {
    const session = await requireSession(req);
    if (!session) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const items = await resolveKlipyItems({
      mode: "trending",
      type: "sticker",
    });

    return res.status(200).json({ items });
  } catch (error) {
    return res.status(500).json({
      error:
        error instanceof Error ? error.message : "Failed to load trending stickers",
    });
  }
};

export const handleKlipyAssetProxy: RequestHandler = async (req, res) => {
  try {
    const rawUrl = normalizeString(req.query.url);
    if (!rawUrl) {
      return res.status(400).json({ error: "Missing asset URL" });
    }

    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return res.status(400).json({ error: "Invalid asset URL" });
    }

    if (!["http:", "https:"].includes(parsed.protocol)) {
      return res.status(400).json({ error: "Unsupported asset protocol" });
    }

    const isAllowedHost = KLIPY_ALLOWED_HOST_PATTERNS.some((pattern) =>
      pattern.test(parsed.hostname),
    );

    if (!isAllowedHost) {
      return res.status(403).json({ error: "Asset host is not allowed" });
    }

    const upstream = await fetch(parsed.toString(), {
      headers: {
        "User-Agent": "VoltexSMS/1.0",
        Accept:
          "image/avif,image/webp,image/apng,image/svg+xml,image/*,video/webm,video/mp4,*/*;q=0.8",
      },
    });

    if (!upstream.ok) {
      return res
        .status(upstream.status)
        .json({ error: `Failed to fetch asset (${upstream.status})` });
    }

    const contentType = upstream.headers.get("content-type");
    const cacheControl = upstream.headers.get("cache-control");

    if (contentType) {
      res.setHeader("Content-Type", contentType);
    }
    if (cacheControl) {
      res.setHeader("Cache-Control", cacheControl);
    } else {
      res.setHeader("Cache-Control", "public, max-age=3600");
    }

    const arrayBuffer = await upstream.arrayBuffer();
    return res.status(200).send(Buffer.from(arrayBuffer));
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to proxy asset",
    });
  }
};
