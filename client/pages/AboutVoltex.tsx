import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  Globe,
  Info,
  LockKeyhole,
  MessageSquareText,
  ShieldCheck,
  Smartphone,
  Users,
} from "lucide-react";
import { VOLTEX_LOGO_URL } from "@/lib/branding";
import { getItem } from "@/lib/browserStorage";

const capabilities = [
  {
    title: "End-to-end encryption",
    description:
      "Only intended participants can read message content, backed by Voltex encryption flows.",
    icon: LockKeyhole,
  },
  {
    title: "Browser-native availability",
    description:
      "No installation required. Voltex is optimized for desktop and mobile browsers with a consistent UX.",
    icon: Globe,
  },
  {
    title: "Real-time messaging",
    description:
      "Conversations stay responsive with live delivery, read status, and secure message handling.",
    icon: MessageSquareText,
  },
  {
    title: "Controlled collaboration",
    description:
      "Private groups, invite access, and moderation tooling provide clear control surfaces.",
    icon: Users,
  },
];

const principles = [
  {
    title: "Security first",
    body: "Security architecture is the baseline, not a premium feature.",
  },
  {
    title: "Operational clarity",
    body: "Critical settings are obvious and accessible without cluttering daily messaging.",
  },
  {
    title: "Cross-device continuity",
    body: "Desktop and mobile layouts preserve the same behavior and trust model.",
  },
];

const stats = [
  { value: "24-word", label: "account recovery passphrase" },
  { value: "Live", label: "message flow engineered for real-time use" },
  { value: "Web", label: "secure browser-first access" },
  { value: "Private", label: "communication boundaries by design" },
];

function hasSession(): boolean {
  return Boolean(getItem("session_token"));
}

export default function AboutVoltex() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(hasSession);

  useEffect(() => {
    setIsAuthenticated(hasSession());
  }, []);

  return (
    <div className="app-screen-min relative overflow-hidden bg-background text-foreground">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_10%_12%,rgba(91,217,169,0.16),transparent_33%),radial-gradient(circle_at_88%_20%,rgba(136,188,255,0.14),transparent_30%),radial-gradient(circle_at_78%_84%,rgba(34,197,94,0.09),transparent_30%)]" />
        <div className="absolute inset-0 opacity-[0.07] [background-image:linear-gradient(rgba(166,255,223,0.25)_1px,transparent_1px),linear-gradient(90deg,rgba(166,255,223,0.22)_1px,transparent_1px)] [background-size:56px_56px]" />
      </div>

      <div className="relative w-full px-4 py-4 sm:px-6 lg:px-10 xl:px-14">
        <header className="rounded-[2rem] border border-border/70 bg-card/90 p-5 shadow-[0_24px_80px_rgba(1,10,8,0.34)] backdrop-blur-xl sm:p-7">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
            <Link to="/" className="flex items-center gap-4">
              <img
                src={VOLTEX_LOGO_URL}
                alt="Voltex"
                className="h-16 w-16 object-contain sm:h-20 sm:w-20"
              />
              <div>
                <p className="tactical-kicker text-primary">About Voltex</p>
                <h1 className="text-4xl font-black tracking-[-0.05em] text-foreground sm:text-5xl">
                  Secure Messaging At Scale
                </h1>
              </div>
            </Link>

            {!isAuthenticated && (
              <div className="flex flex-wrap items-center gap-3">
                <Link
                  to="/signin"
                  className="tactical-button-outline h-12 px-5 text-sm font-semibold normal-case tracking-normal"
                >
                  Sign in
                </Link>
                <Link
                  to="/signup"
                  className="tactical-button h-12 gap-2 px-5 text-sm font-semibold normal-case tracking-normal"
                >
                  Create account
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </div>
            )}
          </div>
        </header>

        <main className="space-y-6 py-6 sm:space-y-7 sm:py-8 lg:space-y-8 lg:py-10">
          <section className="grid gap-6 xl:grid-cols-[minmax(0,1.36fr)_minmax(0,0.78fr)]">
            <article className="rounded-[2rem] border border-border/70 bg-card/92 p-6 shadow-[0_30px_90px_rgba(1,10,8,0.44)] backdrop-blur-xl sm:p-8 lg:p-10 xl:p-12">
              <p className="tactical-kicker text-primary">Infrastructure overview</p>
              <h2 className="mt-4 text-[2.4rem] font-black leading-[0.93] tracking-[-0.06em] text-foreground sm:text-6xl lg:text-7xl">
                Built for private communication with strong operational discipline.
              </h2>
              <p className="mt-6 max-w-4xl text-base leading-8 text-foreground/82 sm:text-lg">
                Voltex focuses on practical security, predictable behavior, and clean communication flows.
                It combines encrypted messaging, account recovery, and moderation-safe controls into a
                platform designed for dependable daily use.
              </p>

              {!isAuthenticated && (
                <p className="mt-5 text-sm leading-7 text-foreground/78 sm:text-base">
                  New here? Open <Link to="/signup" className="font-semibold text-primary underline-offset-4 hover:underline">Sign up</Link> to create your account,
                  or <Link to="/signin" className="font-semibold text-primary underline-offset-4 hover:underline">Sign in</Link> if you already use Voltex.
                </p>
              )}
            </article>

            <aside className="grid gap-6">
              <div className="rounded-[1.8rem] border border-primary/25 bg-[linear-gradient(180deg,rgba(66,167,131,0.24),rgba(8,16,14,0.98))] p-6 shadow-[0_24px_70px_rgba(1,10,8,0.35)] sm:p-8">
                <div className="flex items-center gap-3 text-foreground">
                  <ShieldCheck className="h-5 w-5 text-primary" />
                  <p className="tactical-kicker text-primary">Security posture</p>
                </div>
                <p className="mt-4 text-2xl font-black tracking-[-0.04em] text-foreground sm:text-3xl">
                  Message visibility is limited to valid participants.
                </p>
                <p className="mt-4 text-sm leading-7 text-foreground/80">
                  Voltex architecture avoids exposing readable content to unrelated systems and emphasizes
                  privacy-preserving defaults.
                </p>
              </div>

              <div className="rounded-[1.8rem] border border-border/70 bg-card/92 p-6 backdrop-blur-xl sm:p-8">
                <div className="flex items-center gap-3">
                  <Smartphone className="h-5 w-5 text-primary" />
                  <p className="tactical-kicker">Cross-platform</p>
                </div>
                <p className="mt-3 text-xl font-black tracking-[-0.03em] text-foreground sm:text-2xl">
                  One secure flow on desktop and mobile
                </p>
                <p className="mt-3 text-sm leading-7 text-foreground/78">
                  Responsive layouts and browser-native behavior keep the platform consistent across devices.
                </p>
              </div>
            </aside>
          </section>

          <section className="grid gap-px overflow-hidden rounded-[1.8rem] border border-border/70 bg-border/70 sm:grid-cols-2 xl:grid-cols-4">
            {stats.map((stat) => (
              <article key={stat.label} className="bg-card/94 p-5 sm:p-6 lg:p-7">
                <p className="text-4xl font-black tracking-[-0.06em] text-foreground">
                  {stat.value}
                </p>
                <p className="mt-2 text-sm leading-6 text-foreground/74">{stat.label}</p>
              </article>
            ))}
          </section>

          <section className="grid gap-px overflow-hidden rounded-[1.8rem] border border-border/70 bg-border/70 lg:grid-cols-2">
            {capabilities.map(({ title, description, icon: Icon }) => (
              <article key={title} className="bg-card/92 p-6 backdrop-blur-xl sm:p-8 lg:p-10">
                <div className="flex items-start gap-4">
                  <div className="mt-0.5 flex h-12 w-12 shrink-0 items-center justify-center rounded-[1rem] border border-primary/25 bg-primary/10">
                    <Icon className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <h3 className="text-2xl font-black tracking-[-0.04em] text-foreground">
                      {title}
                    </h3>
                    <p className="mt-4 text-sm leading-7 text-foreground/76 sm:text-base">
                      {description}
                    </p>
                  </div>
                </div>
              </article>
            ))}
          </section>

          <section className="grid gap-6 xl:grid-cols-[minmax(0,1.12fr)_minmax(0,0.88fr)]">
            <article className="rounded-[1.9rem] border border-border/70 bg-card/92 p-6 backdrop-blur-xl sm:p-8 lg:p-10">
              <p className="tactical-kicker">Operating model</p>
              <h2 className="mt-4 text-4xl font-black leading-tight tracking-[-0.04em] text-foreground sm:text-5xl lg:text-6xl">
                Reliability, privacy, and clean UX are core product requirements.
              </h2>
              <p className="mt-6 text-sm leading-7 text-foreground/80 sm:text-base">
                Voltex is engineered to support secure one-to-one chat, encrypted groups, controlled invites,
                recovery safeguards, and moderation paths without compromising baseline user experience.
              </p>
            </article>

            <div className="grid gap-px overflow-hidden rounded-[1.8rem] border border-border/70 bg-border/70">
              {principles.map((principle, index) => (
                <article key={principle.title} className="bg-card/92 p-6 sm:p-7 lg:p-8">
                  <div className="flex items-center justify-between gap-4">
                    <h3 className="text-xl font-black tracking-[-0.03em] text-foreground sm:text-2xl">
                      {principle.title}
                    </h3>
                    <span className="text-sm font-semibold tracking-[0.2em] text-foreground/62">
                      0{index + 1}
                    </span>
                  </div>
                  <p className="mt-4 text-sm leading-7 text-foreground/76 sm:text-base">
                    {principle.body}
                  </p>
                </article>
              ))}
            </div>
          </section>

          <section className="rounded-[1.8rem] border border-border/70 bg-card/92 p-5 backdrop-blur-xl sm:p-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-[0.9rem] border border-primary/25 bg-primary/10">
                  <Info className="h-4 w-4 text-primary" />
                </div>
                <p className="text-sm leading-6 text-foreground/74 sm:text-base">
                  This About page is optimized for full-width desktop reading and balanced mobile stacking.
                </p>
              </div>
              <Link
                to={isAuthenticated ? "/conversations" : "/signin"}
                className="tactical-button-outline h-11 px-4 text-sm font-semibold normal-case tracking-normal"
              >
                {isAuthenticated ? "Open conversations" : "Open sign in"}
              </Link>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
