import { useEffect, useMemo, useState } from "react";
import { ArrowRight } from "lucide-react";

type StatusPageProps = {
  statusCode: number;
  title: string;
  description: string;
  actionLabel?: string;
  actionHref?: string;
  redirectUrl?: string;
  redirectInSeconds?: number;
  enableRedirect?: boolean;
};

function formatCode(code: number): string {
  return String(code).padStart(3, "0");
}

export default function StatusPage({
  statusCode,
  title,
  description,
  actionLabel = "Open Voltex",
  actionHref = "/",
  redirectUrl = "https://voltexchat.online",
  redirectInSeconds = 6,
  enableRedirect = true,
}: StatusPageProps) {
  const [secondsRemaining, setSecondsRemaining] = useState(redirectInSeconds);
  const safeRedirectSeconds = Math.max(1, Math.floor(redirectInSeconds));

  const actionTarget = useMemo(
    () => (enableRedirect ? redirectUrl : actionHref),
    [actionHref, enableRedirect, redirectUrl],
  );

  useEffect(() => {
    if (!enableRedirect) {
      return;
    }

    const deadline = Date.now() + safeRedirectSeconds * 1000;
    const intervalId = window.setInterval(() => {
      const remainingMs = Math.max(0, deadline - Date.now());
      setSecondsRemaining(Math.ceil(remainingMs / 1000));
    }, 250);

    const timeoutId = window.setTimeout(() => {
      window.location.assign(redirectUrl);
    }, safeRedirectSeconds * 1000);

    return () => {
      window.clearInterval(intervalId);
      window.clearTimeout(timeoutId);
    };
  }, [enableRedirect, redirectUrl, safeRedirectSeconds]);

  return (
    <div className="app-screen-min relative overflow-hidden bg-background px-4 py-6 text-foreground sm:px-6">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_12%_12%,rgba(72,196,152,0.18),transparent_36%),radial-gradient(circle_at_85%_78%,rgba(105,187,255,0.14),transparent_34%)]" />
        <div className="absolute inset-0 opacity-[0.08] [background-image:linear-gradient(rgba(135,252,214,0.22)_1px,transparent_1px),linear-gradient(90deg,rgba(135,252,214,0.2)_1px,transparent_1px)] [background-size:44px_44px]" />
      </div>

      <div className="relative mx-auto flex min-h-[var(--app-viewport-height)] w-full max-w-7xl items-center justify-center">
        <div className="w-full max-w-4xl rounded-[2rem] border border-border/70 bg-card/92 p-7 shadow-[0_34px_100px_rgba(1,10,8,0.42)] backdrop-blur-xl sm:p-10 lg:p-12">
          <p className="text-xs font-black uppercase tracking-[0.26em] text-primary/90">
            Voltex Error
          </p>
          <h1 className="mt-5 text-[4.5rem] font-black leading-none tracking-[-0.07em] text-foreground sm:text-[6.2rem] lg:text-[7rem]">
            {formatCode(statusCode)}
          </h1>
          <h2 className="mt-5 text-3xl font-black tracking-[-0.04em] text-foreground sm:text-4xl">
            {title}
          </h2>
          <p className="mt-4 max-w-2xl text-base leading-7 text-foreground/80 sm:text-lg sm:leading-8">
            {description}
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <a
              href={actionTarget}
              className="inline-flex h-12 items-center gap-2 rounded-2xl border border-primary bg-primary px-5 text-sm font-black uppercase tracking-[0.1em] text-primary-foreground transition hover:bg-primary/90"
            >
              {actionLabel}
              <ArrowRight className="h-4 w-4" />
            </a>
            {!enableRedirect && (
              <a
                href="/"
                className="inline-flex h-12 items-center rounded-2xl border border-border px-5 text-sm font-semibold text-foreground/88 transition hover:border-primary/50"
              >
                Return Home
              </a>
            )}
          </div>

          {enableRedirect && (
            <p className="mt-6 text-sm font-semibold text-foreground/72">
              Redirecting to {redirectUrl} in{" "}
              <span className="font-black text-foreground">{secondsRemaining}</span>s
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
