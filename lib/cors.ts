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
 */

type Handler = (request: Request) => Promise<NextResponse> | NextResponse;

function allowedOrigins(): string[] {
  return (process.env.QUOTER_ALLOWED_ORIGINS ?? "*")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function corsHeadersFor(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  const allowed = allowedOrigins();
  const allowAny = allowed.includes("*");

  const headers: Record<string, string> = {
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "origin",
  };

  if (allowAny) {
    headers["access-control-allow-origin"] = "*";
  } else if (origin && allowed.includes(origin)) {
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
