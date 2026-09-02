import { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { VOLTEX_LOGO_URL } from "@/lib/branding";

interface AuthSplitLayoutProps {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
  panelClassName?: string;
  desktopTitle?: string;
  desktopDescription?: string;
  highlights?: string[];
  secondaryLink?: {
    label: string;
    to: string;
  };
  primaryCta?: {
    label: string;
    to: string;
  };
}

export default function AuthSplitLayout({
  eyebrow,
  title,
  description,
  children,
  panelClassName,
  desktopTitle,
  desktopDescription,
  highlights,
  secondaryLink,
  primaryCta,
}: AuthSplitLayoutProps) {
  const resolvedTitle = desktopTitle || title;
  const resolvedDescription = desktopDescription || description;

  return (
    <div className="tactical-shell">
      <div className="grid min-h-[var(--app-viewport-height)] w-full grid-cols-1 lg:h-[var(--app-viewport-height)] lg:grid-cols-2">
        <section className="relative hidden overflow-hidden bg-primary px-6 py-7 text-primary-foreground sm:px-8 sm:py-8 lg:flex lg:h-[var(--app-viewport-height)] lg:flex-col lg:justify-between lg:px-12 lg:py-10 xl:px-14">
          <div className="pointer-events-none absolute -left-28 -top-28 h-80 w-80 rounded-full bg-white/10 blur-3xl" />
          <div className="pointer-events-none absolute -right-24 bottom-0 h-96 w-96 rounded-full bg-black/20 blur-3xl" />

          <div className="relative">
            <Link to="/" className="inline-flex items-center gap-3 text-primary-foreground">
              <img
                src={VOLTEX_LOGO_URL}
                alt="Voltex"
                className="h-10 w-10 rounded-xl bg-white/20 p-1.5 object-contain sm:h-11 sm:w-11"
              />
              <span className="text-sm font-extrabold uppercase tracking-[0.16em] text-primary-foreground/90">
                {eyebrow}
              </span>
            </Link>
          </div>

          <div className="relative mt-8 lg:mt-0">
            <h1 className="text-6xl leading-[0.88] tracking-[-0.06em] text-primary-foreground sm:text-7xl lg:text-8xl xl:text-[7rem]">
              Voltex
            </h1>
            <p className="mt-3 max-w-[34rem] text-base font-semibold text-primary-foreground/95 sm:text-lg">
              A True Secure e2e Encrypted Messaging app.
            </p>
            <h2 className="mt-6 max-w-[22ch] text-3xl leading-[1.02] tracking-[-0.04em] text-primary-foreground sm:text-4xl lg:mt-7">
              {resolvedTitle}
            </h2>
            <p className="mt-3 max-w-[36rem] text-sm leading-7 text-primary-foreground/85 sm:text-base">
              {resolvedDescription}
            </p>
          </div>

          {highlights && highlights.length > 0 ? (
            <div className="relative mt-7 lg:mt-6">
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-primary-foreground/90">
                Security First
              </p>
              <ul className="mt-2.5 space-y-2">
                {highlights.map((item, index) => (
                  <li
                    key={`${item}-${index}`}
                    className="flex items-start gap-2.5 text-sm leading-6 text-primary-foreground/92"
                  >
                    <span className="mt-2 h-1.5 w-1.5 rounded-full bg-primary-foreground/95" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>

        <section className="bg-background lg:h-[var(--app-viewport-height)] lg:overflow-y-auto">
          <div
            className={`mx-auto flex min-h-[var(--app-viewport-height)] w-full max-w-[42rem] flex-col justify-start px-4 py-4 sm:px-6 sm:py-5 lg:min-h-[var(--app-viewport-height)] lg:justify-center lg:px-10 lg:py-8 ${panelClassName ?? ""}`}
          >
            <div className="mb-4 lg:hidden">
              <Link
                to="/"
                className="inline-flex items-center gap-2.5 text-foreground"
              >
                <img
                  src={VOLTEX_LOGO_URL}
                  alt="Voltex"
                  className="h-8 w-8 rounded-lg bg-primary/15 p-1 object-contain"
                />
                <span className="text-lg font-extrabold tracking-[-0.02em]">
                  Voltex
                </span>
              </Link>
              <p className="mt-1 text-xs text-muted-foreground">
                Secure sign in and account access
              </p>
            </div>

            <div className="mb-4 border-b border-border/60 pb-4 lg:mb-5">
              <p className="text-[0.72rem] font-semibold uppercase tracking-[0.2em] text-primary/80">
                {eyebrow}
              </p>
              <p className="mt-1.5 text-sm leading-6 text-muted-foreground sm:text-[0.95rem]">
                Continue with your existing secure workflow.
              </p>
            </div>
            {children}

            {(secondaryLink || primaryCta) && (
              <div className="mt-4 flex flex-col gap-3 text-center sm:flex-row sm:justify-center">
                {secondaryLink ? (
                  <Link
                    to={secondaryLink.to}
                    className="inline-flex items-center justify-center text-sm font-medium text-muted-foreground transition hover:text-foreground"
                  >
                    {secondaryLink.label}
                  </Link>
                ) : null}
                {primaryCta ? (
                  <Link
                    to={primaryCta.to}
                    className="inline-flex items-center justify-center gap-1 text-sm font-semibold text-primary transition hover:text-primary/80"
                  >
                    {primaryCta.label}
                    <ChevronRight className="h-4 w-4" />
                  </Link>
                ) : null}
              </div>
            )}

            <p className="mt-4 text-center text-xs text-muted-foreground lg:hidden">
              Private messaging with end-to-end encryption.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
