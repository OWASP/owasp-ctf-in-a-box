// The proxy's matcher and its one remaining page rule.
//
// Next requires `config.matcher` to be a static literal. Since #464 the proxy
// guards no module pages at all — the pre-launch lock needs a Redis read, which
// the proxy deliberately never makes, so it lives in each page and route
// (lib/launch.ts; launch-guard-coverage.test.ts pins that every one calls it).
// What the proxy still owns: the CSRF origin assertion on /api/*, and the
// optimistic /profile sign-in redirect.
import { describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ getSessionCookie: vi.fn(() => null as string | null) }));
vi.mock("better-auth/cookies", () => ({ getSessionCookie: mocks.getSessionCookie }));

import { config, proxy } from "@/proxy";

/** The slice of NextRequest the proxy reads for a GET page request. */
function request(pathname: string): NextRequest {
  const url = new URL(pathname, "http://localhost:3000");
  return { nextUrl: url, url: url.toString(), method: "GET", headers: new Headers(), cookies: { get: () => undefined } } as unknown as NextRequest;
}

/** Where the proxy sent this request, or `null` when it let it through. */
function destination(pathname: string): string | null {
  const location = proxy(request(pathname)).headers.get("location");
  return location ? new URL(location).pathname : null;
}

describe("the proxy matcher", () => {
  it("carries exactly /profile and the API pattern — no module page routes", () => {
    // The API pattern's one exemption (the archive import) is pinned against
    // Next's own matcher compiler in proxy-matcher.test.ts.
    expect([...config.matcher].sort()).toEqual(["/api/((?!admin/event/?$).*)", "/profile"]);
  });
});

describe("the /profile rule", () => {
  it("bounces a signed-out visitor off /profile", () => {
    mocks.getSessionCookie.mockReturnValue(null);
    expect(destination("/profile")).toBe("/");
  });

  it("leaves a signed-in visitor on /profile", () => {
    mocks.getSessionCookie.mockReturnValue("session-token");
    expect(destination("/profile")).toBeNull();
  });

  it("lets any other path through untouched, signed out or not", () => {
    mocks.getSessionCookie.mockReturnValue(null);
    expect(destination("/quiz")).toBeNull();
  });
});
