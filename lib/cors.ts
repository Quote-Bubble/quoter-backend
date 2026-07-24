import { NextResponse } from "next/server";

/**
 * CORS for the split architecture: the widget (and embeds on roofers' sites)
 * call this API from other origins, so every route answers preflights and
 * stamps allow headers.
 *
 * CORS is browser-side defence-in-depth only — it does not authenticate callers
 * and does not stop curl, scripts, or non-browser clients. The actual controls
 * are rate limiting (lib/rate-limit.ts) and strict body validation
 * (lib/validate.ts). QUOTER_ALLOWED_ORIGINS is a comma-separated origin list;
 * the default "*" keeps development friction-free — tighten it in production.
 *
 * Preview deploys must be enumerated in QUOTER_ALLOWED_ORIGINS. Do not use a
 * regex against *.vercel.app — the namespace is globally first-come-first-served.
 */

type Handler = (request: Request) => Promise<NextResponse> | NextResponse;

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
  return allowed.includes(origin);
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
  } else if (origin && isOriginAllowed(origin)) {
    headers["access-control-allow-origin"] = origin;
  }

  return headers;
}

function stampCors(request: Request, response: NextResponse): NextResponse {
  for (const [key, value] of Object.entries(corsHeadersFor(request))) {
    response.headers.set(key, value);
  }
  return response;
}

/** Wrap a route handler so its response carries the CORS headers. */
export function withCors(
  handler: Handler,
): (request: Request) => Promise<NextResponse> {
  return async (request: Request) => {
    const origin = request.headers.get("origin");
    const allowAny = allowedOrigins().includes("*");

    // Reject disallowed origins early — do not run the handler and merely omit
    // the header (that still burns upstream quota / DB writes).
    if (origin && !allowAny && !isOriginAllowed(origin)) {
      return stampCors(
        request,
        NextResponse.json({ error: "Origin not allowed." }, { status: 403 }),
      );
    }

    try {
      const response = await handler(request);
      return stampCors(request, response);
    } catch (error) {
      console.error("Unhandled route error", error);
      return stampCors(
        request,
        NextResponse.json(
          { error: "An unexpected error occurred." },
          { status: 500 },
        ),
      );
    }
  };
}

/** Shared OPTIONS (preflight) handler for every route. */
export function preflight(request: Request): NextResponse {
  const origin = request.headers.get("origin");
  const allowAny = allowedOrigins().includes("*");
  if (origin && !allowAny && !isOriginAllowed(origin)) {
    return stampCors(
      request,
      NextResponse.json({ error: "Origin not allowed." }, { status: 403 }),
    );
  }
  return new NextResponse(null, {
    status: 204,
    headers: corsHeadersFor(request),
  });
}
