import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { loggedFetch } from "@/lib/logged-fetch";

let cached: SupabaseClient | null | undefined;

const SUPABASE_TIMEOUT_MS = 5_000;

/**
 * Service-role client for trusted server writes (bypasses RLS).
 * Returns null when env is not configured (local/dev without Supabase).
 */
export function getServiceSupabase(): SupabaseClient | null {
  if (cached !== undefined) return cached;

  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!url || !key) {
    cached = null;
    return cached;
  }

  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) => {
        const signal = init?.signal ?? AbortSignal.timeout(SUPABASE_TIMEOUT_MS);
        return loggedFetch("supabase", input, { ...init, signal });
      },
    },
  });
  return cached;
}

/** Test helper — clears the memoized client between cases. */
export function resetServiceSupabaseCache(): void {
  cached = undefined;
}
