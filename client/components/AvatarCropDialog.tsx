import { useEffect, useMemo, useRef, useState } from "react";
import { ImagePlus } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import { Loader } from "@/components/ui/loader";

interface AvatarCropDialogProps {
  imageUrl: string | null;
  imageType: "image/jpeg" | "image/png" | null;
  open: boolean;
  isSaving?: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (file: File) => Promise<void> | void;
}

interface ImageMetrics {
  width: number;
  height: number;
}

const CROP_OUTPUT_SIZE = 512;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

async function loadImageMetrics(src: string): Promise<ImageMetrics> {
  const image = new Image();
  image.decoding = "async";
  image.src = src;
  await image.decode();

  return {
    width: image.naturalWidth,
    height: image.naturalHeight,
  };
}

async function renderCroppedAvatar(params: {
  imageUrl: string;
  imageType: "image/jpeg" | "image/png";
  metrics: ImageMetrics;
  zoom: number;
  offsetX: number;
  offsetY: number;
}): Promise<File> {
  const canvas = document.createElement("canvas");
  canvas.width = CROP_OUTPUT_SIZE;
  canvas.height = CROP_OUTPUT_SIZE;
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("Canvas is not available");
  }

  const image = new Image();
  image.decoding = "async";
  image.src = params.imageUrl;
  await image.decode();

  const cropSize = CROP_OUTPUT_SIZE;
  const baseScale = Math.max(
    cropSize / params.metrics.width,
    cropSize / params.metrics.height,
  );
  const renderedScale = baseScale * params.zoom;
  const renderedWidth = params.metrics.width * renderedScale;
  const renderedHeight = params.metrics.height * renderedScale;
  const sourceWidth = cropSize / renderedScale;
  const sourceHeight = cropSize / renderedScale;
  const sourceX =
    ((renderedWidth - cropSize) / 2 - params.offsetX) / renderedScale;
  const sourceY =
    ((renderedHeight - cropSize) / 2 - params.offsetY) / renderedScale;

  context.clearRect(0, 0, cropSize, cropSize);
  context.drawImage(
    image,
    clamp(sourceX, 0, params.metrics.width - sourceWidth),
    clamp(sourceY, 0, params.metrics.height - sourceHeight),
    sourceWidth,
    sourceHeight,
    0,
    0,
    cropSize,
    cropSize,
  );

  const outputType = params.imageType === "image/png" ? "image/png" : "image/jpeg";
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, outputType, outputType === "image/jpeg" ? 0.92 : undefined),
  );

  if (!blob) {
    throw new Error("Failed to render avatar");
  }

  const extension = outputType === "image/png" ? "png" : "jpg";
  return new File([blob], `avatar.${extension}`, { type: outputType });
}

export default function AvatarCropDialog({
  imageUrl,
  imageType,
  open,
  isSaving = false,
  onOpenChange,
  onSave,
}: AvatarCropDialogProps) {
  const cropFrameRef = useRef<HTMLDivElement | null>(null);
  const dragStartRef = useRef<{
    pointerX: number;
    pointerY: number;
    offsetX: number;
    offsetY: number;
  } | null>(null);

  const [metrics, setMetrics] = useState<ImageMetrics | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offsetX, setOffsetX] = useState(0);
  const [offsetY, setOffsetY] = useState(0);
  const [isImageLoading, setIsImageLoading] = useState(false);

  useEffect(() => {
    if (!open || !imageUrl) {
      setMetrics(null);
      setZoom(1);
      setOffsetX(0);
      setOffsetY(0);
      return;
    }

    setIsImageLoading(true);
    loadImageMetrics(imageUrl)
      .then((nextMetrics) => {
        setMetrics(nextMetrics);
        setZoom(1);
        setOffsetX(0);
        setOffsetY(0);
      })
      .finally(() => {
        setIsImageLoading(false);
      });
  }, [imageUrl, open]);

  const cropSize = useMemo(() => {
    if (typeof window === "undefined") {
      return 280;
    }

    return Math.min(window.innerWidth < 640 ? window.innerWidth - 72 : 360, 360);
  }, [open]);

  const maxOffsets = useMemo(() => {
    if (!metrics) {
      return { x: 0, y: 0 };
    }

    const baseScale = Math.max(cropSize / metrics.width, cropSize / metrics.height);
    const renderedWidth = metrics.width * baseScale * zoom;
    const renderedHeight = metrics.height * baseScale * zoom;

    return {
      x: Math.max(0, (renderedWidth - cropSize) / 2),
      y: Math.max(0, (renderedHeight - cropSize) / 2),
    };
  }, [cropSize, metrics, zoom]);

  useEffect(() => {
    setOffsetX((current) => clamp(current, -maxOffsets.x, maxOffsets.x));
    setOffsetY((current) => clamp(current, -maxOffsets.y, maxOffsets.y));
  }, [maxOffsets.x, maxOffsets.y]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (!dragStartRef.current) {
        return;
      }

      const nextOffsetX = clamp(
        dragStartRef.current.offsetX + event.clientX - dragStartRef.current.pointerX,
        -maxOffsets.x,
        maxOffsets.x,
      );
      const nextOffsetY = clamp(
        dragStartRef.current.offsetY + event.clientY - dragStartRef.current.pointerY,
        -maxOffsets.y,
        maxOffsets.y,
      );

      setOffsetX(nextOffsetX);
      setOffsetY(nextOffsetY);
    };

    const stopDragging = () => {
      dragStartRef.current = null;
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopDragging);
    window.addEventListener("pointercancel", stopDragging);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopDragging);
      window.removeEventListener("pointercancel", stopDragging);
    };
  }, [maxOffsets.x, maxOffsets.y, open]);

  const handleSave = async () => {
    if (!imageUrl || !imageType || !metrics) {
      return;
    }

    const file = await renderCroppedAvatar({
      imageUrl,
      imageType,
      metrics,
      zoom,
      offsetX,
      offsetY,
    });

    await onSave(file);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(92vh,820px)] max-w-[92vw] overflow-hidden rounded-[28px] border-border bg-card p-0 sm:max-w-2xl">
        <DialogHeader className="border-b border-border/70 px-5 py-5 text-left sm:px-6">
          <DialogTitle className="text-2xl font-black tracking-[-0.04em] text-foreground">
            Crop profile photo
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            Drag to position the image and adjust the zoom before saving.
          </DialogDescription>
        </DialogHeader>

        <div className="overflow-y-auto px-5 py-5 pb-4 sm:px-6">
          <div className="space-y-5">
          <div className="flex justify-center">
            <div
              ref={cropFrameRef}
              className="relative overflow-hidden rounded-full border border-border/70 bg-secondary shadow-inner"
              style={{ width: cropSize, height: cropSize }}
              onPointerDown={(event) => {
                if (!metrics) {
                  return;
                }

                dragStartRef.current = {
                  pointerX: event.clientX,
                  pointerY: event.clientY,
                  offsetX,
                  offsetY,
                };
              }}
            >
              {imageUrl && metrics ? (
                <img
                  src={imageUrl}
                  alt="Avatar crop preview"
                  draggable={false}
                  className="absolute left-1/2 top-1/2 max-w-none select-none touch-none"
                  style={{
                    width: metrics.width * Math.max(cropSize / metrics.width, cropSize / metrics.height) * zoom,
                    height: metrics.height * Math.max(cropSize / metrics.width, cropSize / metrics.height) * zoom,
                    transform: `translate(calc(-50% + ${offsetX}px), calc(-50% + ${offsetY}px))`,
                  }}
                />
              ) : null}

              {(isImageLoading || !imageUrl) && (
                <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-center">
                  {isImageLoading ? <Loader size="lg" /> : <ImagePlus className="h-10 w-10 text-muted-foreground" />}
                  <p className="text-sm text-muted-foreground">
                    {isImageLoading ? "Preparing image..." : "Choose a photo to start"}
                  </p>
                </div>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium text-foreground">Zoom</span>
              <span className="text-muted-foreground">{zoom.toFixed(1)}x</span>
            </div>
            <Slider
              min={1}
              max={3}
              step={0.01}
              value={[zoom]}
              onValueChange={(value) => setZoom(value[0] || 1)}
              disabled={!metrics || isSaving}
            />
          </div>
          </div>
        </div>

        <DialogFooter className="gap-3 border-t border-border/70 bg-card px-5 py-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] sm:px-6 sm:pb-4">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="inline-flex h-11 w-full items-center justify-center rounded-2xl border border-border bg-secondary px-4 text-sm font-semibold text-foreground transition hover:bg-accent sm:w-auto"
            disabled={isSaving}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!imageUrl || !metrics || isSaving}
            className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-2xl bg-primary px-4 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
          >
            {isSaving ? <Loader size="sm" /> : null}
            Save photo
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
