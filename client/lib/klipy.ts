import { KlipyGifItem } from "@/lib/gifMessages";
import * as browserStorage from "@/lib/browserStorage";

interface KlipyGifResponse {
  items: KlipyGifItem[];
}

async function request(path: string, query?: string) {
  const sessionToken = browserStorage.getItem("session_token");
  if (!sessionToken) {
    throw new Error("No active session");
  }

  const response = await fetch(
    query ? `/api/klipy/${path}?${query}` : `/api/klipy/${path}`,
    {
      headers: {
        Authorization: `Bearer ${sessionToken}`,
      },
    },
  );

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || "Failed to load GIFs");
  }

  return (await response.json()) as KlipyGifResponse;
}

export async function searchKlipyGifs(query: string) {
  const params = new URLSearchParams({ q: query.trim() });
  return request("gifs/search", params.toString());
}

export async function getTrendingKlipyGifs() {
  return request("gifs/trending");
}

export async function searchKlipyStickers(query: string) {
  const params = new URLSearchParams({ q: query.trim() });
  return request("stickers/search", params.toString());
}

export async function getTrendingKlipyStickers() {
  return request("stickers/trending");
}
