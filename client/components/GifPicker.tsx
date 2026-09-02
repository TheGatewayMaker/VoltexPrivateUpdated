import { useEffect, useState } from "react";
import { Search, Sparkles, X } from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Loader } from "@/components/ui/loader";
import {
  getTrendingKlipyGifs,
  getTrendingKlipyStickers,
  searchKlipyGifs,
  searchKlipyStickers,
} from "@/lib/klipy";
import { KlipyGifItem, KlipyMediaKind } from "@/lib/gifMessages";
import { isVideoUrl } from "@/lib/mediaUrls";
import { cn } from "@/lib/utils";

interface GifPickerProps {
  disabled?: boolean;
  onSelect: (gif: KlipyGifItem, type: KlipyMediaKind) => Promise<void> | void;
}

function GifPickerBody({
  isMobile,
  query,
  setQuery,
  items,
  isLoading,
  error,
  isSendingId,
  activeType,
  onTypeChange,
  onSelect,
  onClose,
}: {
  isMobile: boolean;
  query: string;
  setQuery: (value: string) => void;
  items: KlipyGifItem[];
  isLoading: boolean;
  error: string;
  isSendingId: string | null;
  activeType: KlipyMediaKind;
  onTypeChange: (type: KlipyMediaKind) => void;
  onSelect: (gif: KlipyGifItem, type: KlipyMediaKind) => Promise<void>;
  onClose: () => void;
}) {
  return (
    <>
      <div className="border-b border-border/70 p-3 sm:p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
            <img
              src="/klipy-klipy-branding.png"
              alt="KLIPY"
              className="h-6 w-6 rounded-md object-cover"
              loading="lazy"
            />
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">
                {query.trim()
                  ? `Results from KLIPY ${activeType === "sticker" ? "Stickers" : "GIFs"}`
                  : `Trending on KLIPY ${activeType === "sticker" ? "Stickers" : "GIFs"}`}
              </span>
            </span>
          </div>
          <div className="flex items-center gap-3">
            <a
              href="https://klipy.com/migrate"
              target="_blank"
              rel="noreferrer"
              className="hidden shrink-0 text-[11px] font-semibold text-foreground underline underline-offset-2 sm:inline"
            >
              Powered by KLIPY
            </a>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-border/70 bg-background/80 text-muted-foreground transition hover:bg-accent hover:text-foreground"
              aria-label="Close GIF picker"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search KLIPY"
            className="w-full rounded-full border border-border bg-background px-10 py-3 text-sm text-foreground outline-none ring-0"
          />
        </div>
        <div className="mt-3 inline-flex rounded-full border border-primary/20 bg-background/80 p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
          {(["gif", "sticker"] as const).map((type) => {
            const isActive = activeType === type;
            return (
              <button
                key={type}
                type="button"
                onClick={() => onTypeChange(type)}
                className={cn(
                  "min-w-[7.25rem] rounded-full px-4 py-2 text-sm font-black tracking-[0.08em] transition",
                  isActive
                    ? "bg-[linear-gradient(135deg,rgba(27,71,64,0.98),rgba(10,30,27,0.98))] text-[#d6f1e5] shadow-[0_10px_24px_rgba(6,18,17,0.28)]"
                    : "text-muted-foreground hover:text-foreground",
                )}
                aria-pressed={isActive}
              >
                {type === "gif" ? "GIFs" : "Stickers"}
              </button>
            );
          })}
        </div>
        <a
          href="https://klipy.com/migrate"
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-flex text-[11px] font-semibold text-foreground underline underline-offset-2 sm:hidden"
        >
          Powered by KLIPY
        </a>
      </div>

      <div
        className={cn(
          "overflow-y-auto p-3 sm:p-4",
          isMobile
            ? "max-h-[min(52vh,30rem)] sm:max-h-[min(58vh,32rem)]"
            : "max-h-[min(34vh,20rem)]",
        )}
      >
        {isLoading ? (
          <div className="flex min-h-48 items-center justify-center">
            <Loader size="lg" />
          </div>
        ) : error ? (
          <div className="flex min-h-48 items-center justify-center px-6 text-center text-sm text-destructive">
            {error}
          </div>
        ) : items.length === 0 ? (
          <div className="flex min-h-48 flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
            <img
              src="/gifbuttonicon.png"
              alt=""
              className="h-8 w-8 opacity-70 [filter:brightness(0)_saturate(100%)_invert(80%)_sepia(10%)_saturate(524%)_hue-rotate(116deg)_brightness(91%)_contrast(87%)]"
            />
            No GIFs found.
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {items.map((item, index) => (
              <button
                key={item.id}
                type="button"
                disabled={isSendingId !== null}
                onClick={() => onSelect(item, activeType)}
                className="group overflow-hidden rounded-2xl border border-border/70 bg-background text-left transition hover:-translate-y-0.5 hover:border-primary/40 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isVideoUrl(item.previewUrl || item.url) ? (
                  <video
                    src={item.previewUrl || item.url}
                    className="aspect-[4/3] w-full object-cover"
                    autoPlay
                    loop
                    muted
                    playsInline
                    preload={index < 6 ? "metadata" : "none"}
                  />
                ) : (
                  <img
                    src={item.previewUrl || item.url}
                    alt={item.title || "GIF"}
                    className="aspect-[4/3] w-full object-cover"
                    loading={index < 6 ? "eager" : "lazy"}
                    decoding="async"
                  />
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

export default function GifPicker({ disabled, onSelect }: GifPickerProps) {
  const isMobile = useIsMobile();
  const [query, setQuery] = useState("");
  const trimmedQuery = query.trim();
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [activeType, setActiveType] = useState<KlipyMediaKind>("gif");
  const [items, setItems] = useState<KlipyGifItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [isSendingId, setIsSendingId] = useState<string | null>(null);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setDebouncedQuery(trimmedQuery);
    }, 220);

    return () => window.clearTimeout(timeout);
  }, [trimmedQuery]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    let cancelled = false;

    const run = async () => {
      setIsLoading(true);
      setError("");

      try {
        const data = debouncedQuery
          ? activeType === "sticker"
            ? await searchKlipyStickers(debouncedQuery)
            : await searchKlipyGifs(debouncedQuery)
          : activeType === "sticker"
            ? await getTrendingKlipyStickers()
            : await getTrendingKlipyGifs();

        if (!cancelled) {
          setItems(Array.isArray(data.items) ? data.items : []);
        }
      } catch (err) {
        if (!cancelled) {
          setItems([]);
          setError(err instanceof Error ? err.message : "Failed to load GIFs");
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [activeType, debouncedQuery, isOpen]);

  const handleSelect = async (item: KlipyGifItem, type: KlipyMediaKind) => {
    try {
      setIsSendingId(item.id);
      await onSelect(item, type);
      setIsOpen(false);
      setQuery("");
    } finally {
      setIsSendingId(null);
    }
  };

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setIsOpen((current) => !current)}
        disabled={disabled}
        aria-label="Open GIF picker"
        className={cn(
          "inline-flex h-11 w-11 items-center justify-center rounded-full border border-primary/20 bg-[linear-gradient(135deg,rgba(21,55,50,0.95),rgba(8,24,22,0.95))] text-foreground shadow-[0_14px_32px_rgba(6,18,17,0.28)] transition hover:border-primary/40 hover:bg-[linear-gradient(135deg,rgba(27,71,64,0.98),rgba(10,30,27,0.98))] disabled:cursor-not-allowed disabled:opacity-50",
        )}
      >
        <img
          src="/gifbuttonicon.png"
          alt=""
          className="h-5 w-5 [filter:brightness(0)_saturate(100%)_invert(78%)_sepia(22%)_saturate(428%)_hue-rotate(116deg)_brightness(96%)_contrast(89%)]"
        />
      </button>

      {isMobile ? (
        <Drawer open={isOpen} onOpenChange={setIsOpen}>
          <DrawerContent className="max-h-[72vh] rounded-t-[1.75rem] border-border/70 bg-card/95 backdrop-blur-xl">
            <DrawerHeader className="pb-1">
              <DrawerTitle className="text-left text-lg font-black tracking-[-0.03em] text-foreground">
                GIFs
              </DrawerTitle>
              <DrawerDescription className="text-left">
                Search and send GIFs without leaving the conversation.
              </DrawerDescription>
            </DrawerHeader>
            <GifPickerBody
              isMobile={true}
              query={query}
              setQuery={setQuery}
              items={items}
              isLoading={isLoading}
              error={error}
              isSendingId={isSendingId}
              activeType={activeType}
              onTypeChange={setActiveType}
              onSelect={handleSelect}
              onClose={() => setIsOpen(false)}
            />
          </DrawerContent>
        </Drawer>
      ) : isOpen ? (
        <div className="absolute bottom-[calc(100%+8px)] left-0 z-[120] w-[min(25rem,calc(100vw-1.5rem))] max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-[1.75rem] border border-border/70 bg-card/95 shadow-[0_24px_60px_rgba(2,6,23,0.45)] backdrop-blur-xl">
          <GifPickerBody
            isMobile={false}
            query={query}
            setQuery={setQuery}
            items={items}
            isLoading={isLoading}
            error={error}
            isSendingId={isSendingId}
            activeType={activeType}
            onTypeChange={setActiveType}
            onSelect={handleSelect}
            onClose={() => setIsOpen(false)}
          />
        </div>
      ) : null}
    </div>
  );
}
