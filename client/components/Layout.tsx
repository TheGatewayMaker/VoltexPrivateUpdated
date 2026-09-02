import { ReactNode, useState } from "react";
import { Link } from "react-router-dom";
import { Search } from "lucide-react";
import ProfileMenu from "./ProfileMenu";
import * as browserStorage from "@/lib/browserStorage";
import { VOLTEX_LOGO_URL } from "@/lib/branding";

interface LayoutProps {
  children: ReactNode;
  showBack?: boolean;
  title?: string;
  onBackClick?: () => void;
  showProfileMenu?: boolean;
  showDesktopPersistentHeader?: boolean;
  profileData?: {
    displayName?: string;
    avatar?: string;
  };
  onSearchClick?: () => void;
}

export default function Layout({
  children,
  showBack,
  title,
  onBackClick,
  showProfileMenu = false,
  showDesktopPersistentHeader = false,
  profileData = {},
  onSearchClick,
}: LayoutProps) {
  const [isAuthenticated] = useState(() => !!browserStorage.getItem("session_token"));
  const showDesktopHomeHeader = !showBack && isAuthenticated;
  const showDesktopChatHeader = showBack && showDesktopPersistentHeader && isAuthenticated;
  const showBrandHeader = showDesktopHomeHeader || showDesktopChatHeader;
  const showBackHeader = showBack && !showDesktopPersistentHeader;
  const showMobileBackHeader = showBack && showDesktopPersistentHeader;

  return (
    <div className="app-screen flex flex-col overflow-hidden bg-background text-foreground">
      <header className="flex-shrink-0 border-b border-border/70 bg-card/82 px-4 py-3 backdrop-blur-xl md:px-6">
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            {showBackHeader ? (
              <button
                onClick={onBackClick}
                className="tactical-icon-button h-10 w-10 text-foreground"
                aria-label="Go back"
              >
                <svg
                  className="h-5 w-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M15 19l-7-7 7-7"
                  />
                </svg>
              </button>
            ) : null}
            {showMobileBackHeader ? (
              <button
                onClick={onBackClick}
                className="tactical-icon-button h-10 w-10 text-foreground lg:hidden"
                aria-label="Go back"
              >
                <svg
                  className="h-5 w-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M15 19l-7-7 7-7"
                  />
                </svg>
              </button>
            ) : null}
            {showBrandHeader && (
              <Link
                to="/"
                className={`min-w-0 items-center gap-3 ${
                  showDesktopChatHeader ? "hidden lg:flex" : "flex"
                }`}
              >
                <img
                  src={VOLTEX_LOGO_URL}
                  alt="Voltex"
                  className="h-12 w-12 object-contain md:h-[3.35rem] md:w-[3.35rem]"
                />
                <div className="hidden min-w-0 sm:block">
                  <h1 className="text-2xl font-black tracking-[-0.05em] text-foreground md:text-[2rem]">
                    Voltex
                  </h1>
                  <p className="text-sm text-muted-foreground">
                    Private messaging
                  </p>
                </div>
              </Link>
            )}
            {showBack && title && (
              <div>
                <h2
                  className={`truncate text-xl font-black tracking-[-0.04em] md:text-2xl ${
                    showDesktopPersistentHeader ? "lg:hidden" : ""
                  }`}
                >
                  {title}
                </h2>
              </div>
            )}
          </div>
          {(showDesktopHomeHeader || showDesktopChatHeader) && (
            <div
              className={`flex items-center justify-end gap-2 ${
                showBrandHeader ? "min-w-[6.5rem]" : ""
              }`}
            >
              {isAuthenticated && (
                <button
                  onClick={onSearchClick}
                  className="tactical-icon-button h-10 w-10 text-foreground"
                  title="Search users"
                  aria-label="Search users"
                >
                  <Search className="h-5 w-5" />
                </button>
              )}

              {isAuthenticated && showProfileMenu && (
                <ProfileMenu
                  displayName={profileData.displayName}
                  avatar={profileData.avatar}
                />
              )}
            </div>
          )}
        </div>
      </header>

      {/* Main Content */}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {children}
      </main>
    </div>
  );
}
