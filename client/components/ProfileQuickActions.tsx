import { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { UserRound } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface ProfileQuickActionsProps {
  username?: string | null;
  children: ReactNode;
  align?: "start" | "center" | "end";
}

function normalizeUsername(value: string): string {
  return value.trim().replace(/^@+/, "").toLowerCase();
}

export function ProfileQuickActions({
  username,
  children,
  align = "end",
}: ProfileQuickActionsProps) {
  const navigate = useNavigate();
  const normalizedUsername =
    typeof username === "string" ? normalizeUsername(username) : "";

  if (!normalizedUsername) {
    return <>{children}</>;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        side="bottom"
        sideOffset={10}
        collisionPadding={16}
        className="w-44 rounded-2xl border border-border/80 bg-popover/98 p-2 shadow-[0_20px_45px_rgba(0,0,0,0.45)]"
      >
        <DropdownMenuItem
          onClick={() => navigate(`/${normalizedUsername}/profile`)}
          className="cursor-pointer gap-2.5 rounded-xl px-3 py-2.5 text-sm font-semibold"
        >
          <UserRound className="h-4 w-4 shrink-0" />
          <span>Profile</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
