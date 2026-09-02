function stripQuery(url: string): string {
  const [base] = url.split("?");
  return base || url;
}

export function isVideoUrl(url: string): boolean {
  const normalized = stripQuery(url).toLowerCase();
  return normalized.endsWith(".mp4") || normalized.endsWith(".webm") || normalized.endsWith(".mov");
}

export function isImageUrl(url: string): boolean {
  const normalized = stripQuery(url).toLowerCase();
  return (
    normalized.endsWith(".gif") ||
    normalized.endsWith(".webp") ||
    normalized.endsWith(".png") ||
    normalized.endsWith(".jpg") ||
    normalized.endsWith(".jpeg") ||
    normalized.endsWith(".avif")
  );
}
