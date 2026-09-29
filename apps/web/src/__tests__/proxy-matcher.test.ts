// Which paths the proxy actually RUNS on, decided by Next's own matcher code.
//
// `proxy.test.ts` pins the matcher's literal text; that proves nothing about a
// regex. This file compiles `config.matcher` with the same two functions Next
// uses at build and request time (`getMiddlewareMatchers`, then
// `getMiddlewareRouteMatcher`), so a lookahead that exempts too much — or
// nothing at all — fails here.
//
// Audit S2: `/api/admin/event` must be OUT. Every request the proxy runs on has
// its body cloned and silently cut at 10 MB (next/dist/server/body-streams.js),
// which broke every archive import with more than a few MB of attachments.
// Everything else under `/api/` must stay IN, because the proxy is where the
// CSRF origin assertion lives (see proxy-origin.test.ts).
import { describe, expect, it, vi } from "vitest";
import * as staticInfo from "next/dist/build/analysis/get-page-static-info";
import { getMiddlewareRouteMatcher } from "next/dist/shared/lib/router/utils/middleware-route-matcher";
import type { ProxyMatcher } from "next/dist/build/analysis/get-page-static-info";

vi.mock("better-auth/cookies", () => ({ getSessionCookie: vi.fn(() => null) }));

import { config } from "@/proxy";

// Exported at runtime (it is what Next's build calls on a proxy's `config`),
// but left out of the published .d.ts, hence the cast.
const { getMiddlewareMatchers } = staticInfo as unknown as {
  getMiddlewareMatchers: (matcher: string[], nextConfig: object) => ProxyMatcher[];
};
if (typeof getMiddlewareMatchers !== "function") {
  throw new Error("next no longer exports getMiddlewareMatchers; re-point this test at the matcher compiler it uses");
}

const runsOn = getMiddlewareRouteMatcher(getMiddlewareMatchers([...config.matcher], {}));
const matches = (pathname: string) => runsOn(pathname, { headers: {} } as never, {} as never);

describe("the proxy matcher, compiled by Next", () => {
  it.each(["/api/admin/event", "/api/admin/event/"])("does not run on the archive import route %s", (p) => {
    expect(matches(p)).toBe(false);
  });

  it.each([
    "/api/admin/events",
    "/api/admin/eventx",
    "/api/admin/event/extra",
    "/api/admin/settings",
    "/api/admin/attachments",
    "/api/admin/classic",
    "/api/team/join",
    "/api/classic/submit",
    "/api/stats/visit",
    "/api/ai/submit",
    "/api/auth/callback/github",
    "/profile",
  ])("still runs on %s", (p) => {
    expect(matches(p)).toBe(true);
  });

  it("does not run on pages", () => {
    expect(matches("/")).toBe(false);
    expect(matches("/admin")).toBe(false);
  });
});
