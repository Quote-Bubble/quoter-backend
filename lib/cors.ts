import { NextResponse } from "next/server";

/**
 * CORS for the split architecture: the quoter-widget frontend (and, later,
 * the widget embedded on roofers' own sites) calls this API from other
 * origins, so every route answers preflights and stamps allow headers.
 *
 * QUOTER_ALLOWED_ORIGINS is a comma-separated origin list. The default "*"
 * keeps development friction-free; tighten it in production. Note the
 * routes are also protected by their own server-side keys never leaving
 * this app, so CORS here is about controlling who may consume the API.
 *
 * Vercel preview URLs for this team's widget
 * (`https://quoter-widget-frontend-<hash>-quote-bubble.vercel.app`) are
 * always allowed so preview deploys can call the API without updating env
 * for every new deployment URL.
 */

type Handler = (request: Request) => Promise<NextResponse> | NextResponse;

const WIDGET_PREVIEW_ORIGIN =
  /^https:\/\/quoter-widget-frontend-[a-z0-9]+-quote-bubble\.vercel\.app$/i;

function allowedOrigins(): string[] {
  return (process.env.QUOTER_ALLOWED_ORIGINS ?? "*")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function isOriginAllowed(origin: string | null): boolean {
  if (!origin) return false;
  const allowed = allowedOrigins();
  if (allowed.includes("*")) return true;
  if (allowed.includes(origin)) return true;
  if (WIDGET_PREVIEW_ORIGIN.test(origin)) return true;
  return false;
}

function corsHeadersFor(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  const allowed = allowedOrigins();
  const allowAny = allowed.includes("*");

  const headers: Record<string, string> = {
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "origin",
  };

  if (allowAny) {
    headers["access-control-allow-origin"] = "*";
  } else if (origin && isOriginAllowed(origin)) {
    // Echo the request origin (required when not using "*").
    headers["access-control-allow-origin"] = origin;
  }

  return headers;
}

/** Wrap a route handler so its response carries the CORS headers. */
export function withCors(
  handler: Handler,
): (request: Request) => Promise<NextResponse> {
  return async (request: Request) => {
    const response = await handler(request);
    for (const [key, value] of Object.entries(corsHeadersFor(request))) {
      response.headers.set(key, value);
    }
    return response;
  };
}

/** Shared OPTIONS (preflight) handler for every route. */
export function preflight(request: Request): NextResponse {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeadersFor(request),
  });
}
