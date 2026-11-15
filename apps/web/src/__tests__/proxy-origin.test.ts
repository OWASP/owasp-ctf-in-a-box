// What the proxy DOES with a cross-origin write — the behaviour half of the
// matcher entry checked in `proxy.test.ts`.
//
// Same lesson that file records: a matcher carrying `/api/:path*` proves only
// that the proxy RUNS on those routes. Deleting the origin check itself would
// leave the matcher test green and every route handler running exactly as
// before. This is the file that fails.
import { describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

vi.hoisted(() => {
  process.env.BETTER_AUTH_SECRET = "test-secret";
  process.env.BETTER_AUTH_URL = "https://ctf.example.org";
});

vi.mock("better-auth/cookies", () => ({ getSessionCookie: vi.fn(() => null) }));

import { proxy } from "@/proxy";

/** The slice of NextRequest the origin branch reads. */
function request(pathname: string, method: string, origin?: string): NextRequest {
  const url = new URL(pathname, "https://ctf.example.org");
  return {
    nextUrl: url,
    url: url.toString(),
    method,
    headers: { get: (name: string) => (name === "origin" ? (origin ?? null) : null) },
    cookies: { get: () => undefined },
  } as unknown as NextRequest;
}

const status = (...args: Parameters<typeof request>) => proxy(request(...args)).status;

describe("the proxy's cross-origin refusal", () => {
  it("refuses a cross-origin POST to a custom API route", () => {
    expect(status("/api/team/join", "POST", "https://evil.example")).toBe(403);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])("refuses a cross-origin %s", (method) => {
    expect(status("/api/admin/settings", method, "https://evil.example")).toBe(403);
  });

  it("lets the event's own origin through", () => {
    expect(status("/api/team/join", "POST", "https://ctf.example.org")).not.toBe(403);
  });

  it("lets a POST with no Origin header through", () => {
    // Non-browser clients carry no ambient cookie; see lib/origin.ts.
    expect(status("/api/team/join", "POST")).not.toBe(403);
  });

  it("does not touch reads", () => {
    // No route mutates on GET, and refusing them would break ordinary
    // cross-origin reads for nothing.
    expect(status("/api/team", "GET", "https://evil.example")).not.toBe(403);
  });

  // better-auth runs its own origin policy against its own trustedOrigins.
  // Two independent policies on one route is how a sign-in breaks in a way
  // nobody can find — and the OAuth flow involves requests this proxy has no
  // business adjudicating.
  it("leaves better-auth's own endpoints alone", () => {
    expect(status("/api/auth/sign-in/social", "POST", "https://github.com")).not.toBe(403);
    expect(status("/api/auth/callback/github", "POST", "https://github.com")).not.toBe(403);
  });

  it("answers with a body a client can read, not a bare status", () => {
    const res = proxy(request("/api/hints/reveal", "POST", "https://evil.example"));
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});
