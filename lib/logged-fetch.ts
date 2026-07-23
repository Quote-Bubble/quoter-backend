/**
 * Dev-only fetch wrapper that logs every outbound call this backend makes —
 * label, method, host + path, status, duration — so during a test run you
 * can watch the terminal and see exactly which third-party APIs got hit and
 * how often, instead of trusting the code reading.
 */
export async function loggedFetch(
  label: string,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const method = init?.method ?? "GET";
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  const { host, pathname } = new URL(url);
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
