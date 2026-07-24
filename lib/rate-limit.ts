import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

import { NextResponse } from "next/server";

type Bucket =
  | "solar"
  | "reverse-geocode"
  | "geocode"
  | "lead-ip"
  | "lead-slug"
  | "lead-submission"
  | "event";

const LIMITS: Record<
  Bucket,
  { requests: number; window: `${number} h` | `${number} m` }
> = {
  solar: { requests: 20, window: "1 h" },
  "reverse-geocode": { requests: 30, window: "1 h" },
  geocode: { requests: 60, window: "1 h" },
  "lead-ip": { requests: 10, window: "1 h" },
  "lead-slug": { requests: 100, window: "1 h" },
  // Distinct submission ids — retries with the same id share one slot.
  "lead-submission": { requests: 10, window: "1 h" },
  event: { requests: 300, window: "1 h" },
};

let redis: Redis | null | undefined;
const limiters = new Map<Bucket, Ratelimit>();

function getRedis(): Redis | null {
  if (redis !== undefined) return redis;
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!url || !token) {
    redis = null;
    return redis;
  }
  redis = new Redis({ url, token });
  return redis;
}

function getLimiter(bucket: Bucket): Ratelimit | null {
  const client = getRedis();
  if (!client) return null;
  let limiter = limiters.get(bucket);
  if (!limiter) {
    const cfg = LIMITS[bucket];
    limiter = new Ratelimit({
      redis: client,
      limiter: Ratelimit.slidingWindow(cfg.requests, cfg.window),
      prefix: `quoter:${bucket}`,
      analytics: false,
    });
    limiters.set(bucket, limiter);
  }
  return limiter;
}

/** Missing x-forwarded-for fails closed into one shared bucket, not unlimited. */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (!forwarded) return "missing-xff";
  const first = forwarded.split(",")[0]?.trim();
  return first || "missing-xff";
}

export async function limitOr429(
  request: Request,
  bucket: Bucket,
  keySuffix?: string,
): Promise<NextResponse | null> {
  const limiter = getLimiter(bucket);
  // No Redis configured → skip (local/dev). Production must set Upstash env.
  if (!limiter) return null;

  const ip = clientIp(request);
  const identifier = keySuffix ? `${ip}:${keySuffix}` : ip;
  const result = await limiter.limit(identifier);

  if (result.success) return null;

  const retryAfter = Math.max(
    1,
    Math.ceil((result.reset - Date.now()) / 1000),
  );
  return NextResponse.json(
    { error: "Too many requests. Please try again shortly." },
    {
      status: 429,
      headers: {
        "retry-after": String(retryAfter),
      },
    },
  );
}

/** Cache helpers for solar/geocode — same Redis, TTL in seconds. */
export async function cacheGet<T>(key: string): Promise<T | null> {
  const client = getRedis();
  if (!client) return null;
  try {
    return (await client.get<T>(key)) ?? null;
  } catch {
    return null;
  }
}

export async function cacheSet(
  key: string,
  value: unknown,
  ttlSeconds: number,
): Promise<void> {
  const client = getRedis();
  if (!client) return;
  try {
    await client.set(key, value, { ex: ttlSeconds });
  } catch {
    // Cache is best-effort.
  }
}

/** Test helper. */
export function resetRateLimitCache(): void {
  redis = undefined;
  limiters.clear();
}
