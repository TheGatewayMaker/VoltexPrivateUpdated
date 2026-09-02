import { GifMessagePayload } from "@/lib/gifMessages";
import { isVideoUrl } from "@/lib/mediaUrls";

interface GifMessageContentProps {
  gif: GifMessagePayload;
  isOwn?: boolean;
  onReady?: () => void;
}

export default function GifMessageContent({
  gif,
  onReady,
}: GifMessageContentProps) {
  const mediaUrl = gif.previewUrl || gif.url;
  const aspectRatio =
    gif.width && gif.height ? `${gif.width} / ${gif.height}` : undefined;

  return (
    <div
      className="w-full overflow-hidden rounded-2xl bg-black/5"
      style={{
        aspectRatio,
      }}
    >
      {isVideoUrl(mediaUrl) ? (
        <video
          src={mediaUrl}
          className="max-h-72 w-full rounded-2xl object-cover"
          autoPlay
          loop
          muted
          playsInline
          preload="auto"
          onLoadedData={onReady}
        />
      ) : (
        <img
          src={mediaUrl}
          alt={gif.title || "GIF"}
          className="max-h-72 w-full rounded-2xl object-cover"
          loading="eager"
          onLoad={onReady}
        />
      )}
    </div>
  );
}
