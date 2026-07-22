import { describe, expect, it } from "vitest";

import { isOriginAllowed } from "@/lib/cors";

describe("isOriginAllowed", () => {
  it("allows configured exact origins", () => {
    process.env.QUOTER_ALLOWED_ORIGINS =
      "https://quoter-widget-frontend.vercel.app";
    expect(
      isOriginAllowed("https://quoter-widget-frontend.vercel.app"),
    ).toBe(true);
    expect(isOriginAllowed("https://evil.example")).toBe(false);
  });

  it("allows Vercel preview URLs for the widget project", () => {
    process.env.QUOTER_ALLOWED_ORIGINS =
      "https://quoter-widget-frontend.vercel.app";
    expect(
      isOriginAllowed(
        "https://quoter-widget-frontend-534j1uyv8-quote-bubble.vercel.app",
      ),
    ).toBe(true);
    expect(
      isOriginAllowed("https://other-app-abc-quote-bubble.vercel.app"),
    ).toBe(false);
  });

  it("allows any origin when * is configured", () => {
    process.env.QUOTER_ALLOWED_ORIGINS = "*";
    expect(isOriginAllowed("https://anything.example")).toBe(true);
  });
});
