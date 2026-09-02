import "./global.css";

import React, { lazy, Suspense, useEffect, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Routes, Route } from "react-router-dom";
import { initializeServerTime } from "@/lib/serverTime";
import { getItem, initBrowserStorage } from "@/lib/browserStorage";
import { VOLTEX_FAVICON_URL, VOLTEX_FAVICON_VERSION } from "@/lib/branding";
import { ADMIN_DASHBOARD_PATH } from "@/lib/adminPanel";
import { Loader } from "@/components/ui/loader";

const Conversations = lazy(() => import("./pages/Conversations"));
const Chat = lazy(() => import("./pages/Chat"));
const GroupChat = lazy(() => import("./pages/GroupChat"));
const GroupInvite = lazy(() => import("./pages/GroupInvite"));
const SignIn = lazy(() => import("./pages/SignIn"));
const SignUp = lazy(() => import("./pages/SignUp"));
const Recover = lazy(() => import("./pages/Recover"));
const Account = lazy(() => import("./pages/Account"));
const Settings = lazy(() => import("./pages/Settings"));
const PublicProfile = lazy(() => import("./pages/PublicProfile"));
const AboutVoltex = lazy(() => import("./pages/AboutVoltex"));
const NotFound = lazy(() => import("./pages/NotFound"));
const Forbidden = lazy(() => import("./pages/Forbidden"));
const Unauthorized = lazy(() => import("./pages/Unauthorized"));
const ServerError = lazy(() => import("./pages/ServerError"));
const AdminDashboard = lazy(() => import("./pages/AdminDashboard"));

const queryClient = new QueryClient();
const CHUNK_RELOAD_FLAG = "voltex:chunk-reload-attempted";

function canUseSessionStorage(): boolean {
  return typeof window !== "undefined" && "sessionStorage" in window;
}

function readChunkReloadFlag(): boolean {
  if (!canUseSessionStorage()) {
    return false;
  }

  try {
    return window.sessionStorage.getItem(CHUNK_RELOAD_FLAG) === "1";
  } catch {
    return false;
  }
}

function writeChunkReloadFlag(value: boolean): void {
  if (!canUseSessionStorage()) {
    return;
  }

  try {
    if (value) {
      window.sessionStorage.setItem(CHUNK_RELOAD_FLAG, "1");
    } else {
      window.sessionStorage.removeItem(CHUNK_RELOAD_FLAG);
    }
  } catch {
    // Ignore storage failures and continue with in-memory behavior.
  }
}

function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("failed to fetch dynamically imported module") ||
    message.includes("importing a module script failed") ||
    message.includes("error loading dynamically imported module") ||
    message.includes("loading chunk") ||
    message.includes("chunkloaderror")
  );
}

function FullScreenLoader({ label }: { label: string }) {
  return (
    <div className="app-screen-min flex items-center justify-center bg-background px-4 text-foreground">
      <div className="flex flex-col items-center gap-4 text-center">
        <Loader size="lg" />
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}

function RootEntry() {
  const sessionToken = getItem("session_token");

  if (!sessionToken) {
    return <Navigate to="/signin" replace />;
  }

  return <Navigate to="/conversations" replace />;
}

function PublicAuthEntry({ children }: { children: ReactNode }) {
  const sessionToken = getItem("session_token");

  if (sessionToken) {
    return <Navigate to="/conversations" replace />;
  }

  return <>{children}</>;
}

function ChunkRecoveryMarker() {
  useEffect(() => {
    writeChunkReloadFlag(false);
  }, []);

  return null;
}

class RouteErrorBoundary extends React.Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, _errorInfo: ErrorInfo) {
    if (isChunkLoadError(error) && !readChunkReloadFlag()) {
      writeChunkReloadFlag(true);
      window.location.reload();
      return;
    }

    console.error("Route rendering failed:", error);
  }

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <div className="app-screen-min flex items-center justify-center bg-background px-4 text-foreground">
        <div className="max-w-sm rounded-3xl border border-border/70 bg-card/90 p-6 text-center shadow-[0_24px_80px_rgba(2,6,23,0.35)]">
          <h1 className="text-2xl font-black tracking-[-0.04em] text-foreground">
            Unable to load Voltex
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            The app files did not load correctly. Refresh to load the latest version.
          </p>
          <button
            type="button"
            onClick={() => {
              writeChunkReloadFlag(false);
              window.location.reload();
            }}
            className="mt-5 inline-flex h-11 items-center justify-center rounded-2xl bg-primary px-5 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90"
          >
            Reload app
          </button>
        </div>
      </div>
    );
  }
}

export default function App() {
  const [storageReady, setStorageReady] = useState(false);

  // Initialize server time on app load
  useEffect(() => {
    initializeServerTime();
    let isActive = true;

    void initBrowserStorage().finally(() => {
      if (isActive) {
        setStorageReady(true);
      }
    });

    return () => {
      isActive = false;
    };
  }, []);

  useEffect(() => {
    const faviconHref = `${VOLTEX_FAVICON_URL}?v=${VOLTEX_FAVICON_VERSION}`;
    const rels = ["icon", "shortcut icon", "apple-touch-icon"];

    rels.forEach((rel) => {
      let link = document.head.querySelector<HTMLLinkElement>(
        `link[rel='${rel}']`,
      );

      if (!link) {
        link = document.createElement("link");
        link.rel = rel;
        document.head.appendChild(link);
      }

      link.type = "image/png";
      link.href = faviconHref;
    });
  }, []);

  if (!storageReady) {
    return <FullScreenLoader label="Preparing secure storage" />;
  }

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter>
          <RouteErrorBoundary>
            <Suspense fallback={<FullScreenLoader label="Loading" />}>
              <ChunkRecoveryMarker />
              <Routes>
                <Route path="/" element={<RootEntry />} />
                <Route
                  path="/signin"
                  element={
                    <PublicAuthEntry>
                      <SignIn />
                    </PublicAuthEntry>
                  }
                />
                <Route
                  path="/signup"
                  element={
                    <PublicAuthEntry>
                      <SignUp />
                    </PublicAuthEntry>
                  }
                />
                <Route path="/recover" element={<Recover />} />
                <Route path="/about-v0lt3x" element={<AboutVoltex />} />
                <Route path="/401" element={<Unauthorized />} />
                <Route path="/403" element={<Forbidden />} />
                <Route path="/500" element={<ServerError />} />
                <Route path="/conversations" element={<Conversations />} />
                <Route path="/chat/:id" element={<Chat />} />
                <Route path="/groups/:id" element={<GroupChat />} />
                <Route path="/group-invites/:inviteId" element={<GroupInvite />} />
                <Route path="/:username/profile" element={<PublicProfile />} />
                <Route path="/account" element={<Account />} />
                <Route path="/settings" element={<Settings />} />
                <Route path={`${ADMIN_DASHBOARD_PATH}/*`} element={<AdminDashboard />} />
                {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
                <Route path="*" element={<NotFound />} />
              </Routes>
            </Suspense>
          </RouteErrorBoundary>
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
