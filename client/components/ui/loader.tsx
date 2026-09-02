import { cn } from "@/lib/utils";

interface LoaderProps {
  size?: "sm" | "md" | "lg";
  className?: string;
}

const sizeClasses = {
  sm: "h-4 w-[18px]",
  md: "h-8 w-[36px]",
  lg: "h-12 w-[54px]",
};

export function Loader({ size = "md", className }: LoaderProps) {
  return (
    <div
      className={cn("app-loader", sizeClasses[size], className)}
      aria-label="Loading"
      role="status"
    />
  );
}
