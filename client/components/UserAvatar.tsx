import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

interface UserAvatarProps {
  name: string;
  avatar?: string | null;
  className?: string;
  fallbackClassName?: string;
}

function getInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return "?";
  }

  return trimmed
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] || "")
    .join("")
    .toUpperCase();
}

export function UserAvatar({
  name,
  avatar,
  className,
  fallbackClassName,
}: UserAvatarProps) {
  return (
    <Avatar className={cn("h-10 w-10 ring-1 ring-border/60", className)}>
      {avatar ? <AvatarImage src={avatar} alt={name} className="object-cover" /> : null}
      <AvatarFallback
        className={cn(
          "bg-primary/12 text-sm font-semibold text-primary",
          fallbackClassName,
        )}
      >
        {getInitials(name)}
      </AvatarFallback>
    </Avatar>
  );
}
