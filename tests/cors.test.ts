import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isOriginAllowed, withCors } from "@/lib/cors";

import { NextResponse } from "next/server";

describe("isOriginAllowed", () => {
  const previous = process.env.QUOTER_ALLOWED_ORIGINS;

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.QUOTER_ALLOWED_ORIGINS;
    } else {
      process.env.QUOTER_ALLOWED_ORIGINS = previous;
    }
  });

  it("allows configured exact origins", () => {
    process.env.QUOTER_ALLOWED_ORIGINS =
      "https://quoter-widget-frontend.vercel.app";
    expect(
      isOriginAllowed("https://quoter-widget-frontend.vercel.app"),
    ).toBe(true);
    expect(isOriginAllowed("https://evil.example")).toBe(false);
  });

  it("does not allow unlisted Vercel preview URLs", () => {
    process.env.QUOTER_ALLOWED_ORIGINS =
      "https://quoter-widget-frontend.vercel.app";
    expect(
      isOriginAllowed(
        "https://quoter-widget-frontend-534j1uyv8-quote-bubble.vercel.app",
      ),
    ).toBe(false);
    expect(
      isOriginAllowed(
        "https://quoter-widget-frontend-x-quote-bubble.vercel.app",
      ),
    ).toBe(false);
  });

  it("allows any origin when * is configured", () => {
    process.env.QUOTER_ALLOWED_ORIGINS = "*";
    expect(isOriginAllowed("https://anything.example")).toBe(true);
  });
});

describe("withCors", () => {
  const previous = process.env.QUOTER_ALLOWED_ORIGINS;

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.QUOTER_ALLOWED_ORIGINS;
    } else {
      process.env.QUOTER_ALLOWED_ORIGINS = previous;
    }
  });

  it("stamps access-control-allow-origin on allowed responses", async () => {
    process.env.QUOTER_ALLOWED_ORIGINS = "https://widget.example";
    const handler = withCors(async () =>
      NextResponse.json({ ok: true }, { status: 200 }),
    );
    const response = await handler(
      new Request("http://localhost/api/x", {
        headers: { origin: "https://widget.example" },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://widget.example",
    );
  });

  it("rejects disallowed origins with 403 before running the handler", async () => {
    process.env.QUOTER_ALLOWED_ORIGINS = "https://widget.example";
    let ran = false;
    const handler = withCors(async () => {
      ran = true;
      return NextResponse.json({ ok: true });
    });
    const response = await handler(
      new Request("http://localhost/api/x", {
        headers: { origin: "https://evil.example" },
      }),
    );
    expect(ran).toBe(false);
    expect(response.status).toBe(403);
  });

  it("returns a CORS-stamped 500 when the handler throws", async () => {
    process.env.QUOTER_ALLOWED_ORIGINS = "*";
    const handler = withCors(async () => {
      throw new Error("boom");
    });
    const response = await handler(new Request("http://localhost/api/x"));
    expect(response.status).toBe(500);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });
});
