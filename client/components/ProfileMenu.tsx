import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { User, Settings, Info, LogOut } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { UserAvatar } from "@/components/UserAvatar";
import { toast } from "sonner";
import * as browserStorage from "@/lib/browserStorage";

interface ProfileMenuProps {
  displayName?: string;
  avatar?: string;
}

export default function ProfileMenu({
  displayName = "User",
  avatar,
}: ProfileMenuProps) {
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(false);
  const [profileName, setProfileName] = useState(displayName);
  const [profileAvatar, setProfileAvatar] = useState<string | undefined>(avatar);

  // Fetch the user's display name from profile if not provided
  useEffect(() => {
    if (displayName === "User") {
      const fetchProfile = async () => {
        try {
          const sessionToken = browserStorage.getItem("session_token");
          if (!sessionToken) return;

          const response = await fetch("/api/profile/me", {
            headers: {
              Authorization: `Bearer ${sessionToken}`,
            },
          });

          if (response.ok) {
            const data = await response.json();
            if (data.displayName) {
              setProfileName(data.displayName);
            }
            setProfileAvatar(data.avatar || undefined);
          }
        } catch (err) {
          console.error("Failed to fetch profile name:", err);
        }
      };

      fetchProfile();
    } else {
      setProfileName(displayName);
      setProfileAvatar(avatar);
    }
  }, [avatar, displayName]);

  const handleLogout = async () => {
    try {
      setIsLoading(true);
      const sessionToken = browserStorage.getItem("session_token");

      if (sessionToken) {
        await fetch("/api/auth/logout", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${sessionToken}`,
          },
        });
      }

      // Clear all session data including crypto_keypair to prevent user ID mismatch errors
      await browserStorage.clear();

      toast.success("Logged out successfully");
      navigate("/signin");
    } catch (error) {
      console.error("Logout error:", error);
      toast.error("Failed to logout");
    } finally {
      setIsLoading(false);
    }
  };

  const handleAccount = () => {
    navigate("/account");
  };

  const handleSettings = () => {
    navigate("/settings");
  };

  const handleAbout = () => {
    navigate("/about-v0lt3x");
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="tactical-icon-button h-12 w-12 p-2 focus:ring-2 focus:ring-primary">
          <UserAvatar
            name={profileName}
            avatar={profileAvatar}
            className="h-8 w-8 ring-0"
          />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-48">
        {/* User Info */}
        <div className="px-4 py-3 border-b border-border">
          <p className="text-sm font-semibold text-foreground truncate">
            {profileName}
          </p>
        </div>

        {/* Account Button */}
        <DropdownMenuItem onClick={handleAccount} className="cursor-pointer">
          <User className="w-4 h-4 mr-2" />
          <span>Account</span>
        </DropdownMenuItem>

        {/* Settings Button */}
        <DropdownMenuItem onClick={handleSettings} className="cursor-pointer">
          <Settings className="w-4 h-4 mr-2" />
          <span>Settings</span>
        </DropdownMenuItem>

        <DropdownMenuItem onClick={handleAbout} className="cursor-pointer">
          <Info className="w-4 h-4 mr-2" />
          <span>About Voltex</span>
        </DropdownMenuItem>

        {/* Separator */}
        <DropdownMenuSeparator />

        {/* Logout Button */}
        <DropdownMenuItem
          onClick={handleLogout}
          disabled={isLoading}
          className="cursor-pointer text-destructive focus:text-destructive"
        >
          <LogOut className="w-4 h-4 mr-2" />
          <span>{isLoading ? "Logging out..." : "Logout"}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
