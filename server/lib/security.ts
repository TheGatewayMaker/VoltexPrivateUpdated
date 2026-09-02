import { CorsOptions } from "cors";
import { Request, RequestHandler } from "express";

function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, "");
}

function getConfiguredOrigins(): string[] {
  const configured = process.env.ALLOWED_ORIGINS;
  if (!configured) {
    return [];
  }

  return configured
    .split(",")
    .map((origin) => normalizeOrigin(origin))
    .filter(Boolean);
}

function getRelatedOrigins(origin: string): string[] {
  try {
    const url = new URL(origin);
    const hostname = url.hostname.toLowerCase();
    const baseOrigin = `${url.protocol}//${hostname}${url.port ? `:${url.port}` : ""}`;

    if (hostname.startsWith("www.")) {
      const withoutWww = hostname.slice(4);
      return [
        baseOrigin,
        `${url.protocol}//${withoutWww}${url.port ? `:${url.port}` : ""}`,
      ];
    }

    return [
      baseOrigin,
      `${url.protocol}//www.${hostname}${url.port ? `:${url.port}` : ""}`,
    ];
  } catch {
    return [normalizeOrigin(origin)];
  }
}

function getRequestOriginFromHost(req: Request): string | null {
  const hostHeader = req.headers.host;
  if (!hostHeader || typeof hostHeader !== "string") {
    return null;
  }

  const forwardedProtoHeader = req.headers["x-forwarded-proto"];
  const forwardedProto =
    typeof forwardedProtoHeader === "string"
      ? forwardedProtoHeader.split(",")[0]?.trim()
      : undefined;

  const protocol =
    forwardedProto || (req.secure ? "https" : process.env.NODE_ENV === "production" ? "https" : "http");

  return `${protocol}://${hostHeader}`;
}

export function isAllowedOrigin(origin: string, req?: Request): boolean {
  const normalizedOrigin = normalizeOrigin(origin);
  const configuredOrigins = getConfiguredOrigins();

  if (configuredOrigins.length > 0) {
    const relatedOrigins = getRelatedOrigins(normalizedOrigin);
    return relatedOrigins.some((candidate) =>
      configuredOrigins.includes(candidate),
    );
  }

  if (req) {
    const requestOrigin = getRequestOriginFromHost(req);
    if (requestOrigin && normalizeOrigin(requestOrigin) === normalizedOrigin) {
      return true;
    }
  }

  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(normalizedOrigin);
}

export function createCorsOptions(req?: Request): CorsOptions {
  return {
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }

      if (isAllowedOrigin(origin, req)) {
        callback(null, true);
        return;
      }

      // Do not throw here. Returning an error causes a 500 response and may leak
      // implementation details. A simple "false" rejects CORS cleanly.
      callback(null, false);
    },
    credentials: false,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Authorization",
      "Content-Type",
      "X-Admin-Token",
      "X-Admin-Session",
      "X-Recovery-Token",
    ],
    maxAge: 600,
  };
}

export const applySecurityHeaders: RequestHandler = (_req, res, next) => {
  const isDevelopment = process.env.NODE_ENV !== "production";
  const trustedInlineScriptHashes = [
    "'sha256-3x30sT9BRGS4Js3IjX/xPpZ3DU+uAwaUKFbe4R9zhM4='",
    "'sha256-oG73FU+Ob3IXwgNPomqkOIpXcXKQwRSp6hFf1m3QbIc='",
  ].join(" ");
  const csp = [
    "default-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    isDevelopment
      ? `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${trustedInlineScriptHashes} https://www.googletagmanager.com`
      : `script-src 'self' ${trustedInlineScriptHashes} https://www.googletagmanager.com`,
    "connect-src 'self' ws: wss: https://www.google-analytics.com https://region1.google-analytics.com",
    "form-action 'self'",
  ].join("; ");

  res.setHeader("Content-Security-Policy", csp);
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-DNS-Prefetch-Control", "off");
  if (!isDevelopment) {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains; preload",
    );
  }
  next();
};

export const disableApiCaching: RequestHandler = (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
};

export const requireTrustedOrigin: RequestHandler = (req, res, next) => {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    next();
    return;
  }

  const originHeader = req.headers.origin;
  if (!originHeader || typeof originHeader !== "string") {
    next();
    return;
  }

  if (!isAllowedOrigin(originHeader, req)) {
    return res.status(403).json({ error: "Untrusted origin" });
  }

  next();
};

export const requireTrustedOriginStrict: RequestHandler = (req, res, next) => {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    next();
    return;
  }

  const originHeader = req.headers.origin;
  if (!originHeader || typeof originHeader !== "string") {
    if (process.env.NODE_ENV === "production") {
      return res.status(403).json({ error: "Origin header required" });
    }
    next();
    return;
  }

  if (!isAllowedOrigin(originHeader, req)) {
    return res.status(403).json({ error: "Untrusted origin" });
  }

  next();
};

export function isTrustedWebSocketOrigin(origin: string | undefined): boolean {
  if (!origin) {
    return process.env.NODE_ENV !== "production";
  }

  return isAllowedOrigin(origin);
}
