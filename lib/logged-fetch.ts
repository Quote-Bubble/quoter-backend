/**
 * Dev-only fetch wrapper that logs every outbound call this backend makes —
 * label, method, host + path, status, duration — so during a test run you
 * can watch the terminal and see exactly which third-party APIs got hit and
 * how often, instead of trusting the code reading.
 */

/** Strip PII / column values from PostgREST-style errors before logging. */
export function redact(error: unknown): { code?: string; message: string } {
  if (!error || typeof error !== "object") {
    return { message: "unknown error" };
  }
  const e = error as {
    code?: unknown;
    message?: unknown;
    name?: unknown;
  };
  const code = typeof e.code === "string" ? e.code : undefined;
  // Prefer a short name/code over message — PostgrestError.message/details
  // often embed the offending column values (name, phone, email).
  if (code) {
    return { code, message: typeof e.name === "string" ? e.name : "error" };
  }
  if (typeof e.name === "string") {
    return { message: e.name };
  }
  return { message: "error" };
}

export async function loggedFetch(
  label: string,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const method = init?.method ?? "GET";
  let host = "?";
  let pathname = "";
  try {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const parsed = new URL(url);
    host = parsed.host;
    pathname = parsed.pathname;
  } catch {
    // Scheme-less / invalid URL — surface as config error, not delivery fail.
    throw new Error(`Invalid URL for outbound fetch (${label})`);
  }

  const start = Date.now();

  try {
    const response = await fetch(input, init);
    if (process.env.NODE_ENV !== "production") {
      console.log(
        `[outbound] ${label} ${method} ${host}${pathname} -> ${response.status} (${Date.now() - start}ms)`,
      );
    }
    return response;
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.log(
        `[outbound] ${label} ${method} ${host}${pathname} -> FAILED (${Date.now() - start}ms)`,
      );
    }
    throw error;
  }
}
