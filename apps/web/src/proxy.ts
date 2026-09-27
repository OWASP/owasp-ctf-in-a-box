import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import { MUTATING_METHODS, originAllowed } from "@/lib/origin";

/** better-auth's own endpoints, which run their own origin check against
 *  their own `trustedOrigins` config. Left alone deliberately: the OAuth flow
 *  involves requests this proxy has no business adjudicating, and two
 *  independent origin policies on one route is how a sign-in breaks in a way
 *  nobody can find. */
const AUTH_PREFIX = "/api/auth";

/** The ai module's endpoints, which are cross-origin BY DESIGN: an externally
 *  hosted challenge (a static SPA, or its backend) posts flags and signed
 *  solve events here from its own origin.
 *
 *  Exempt for the same reason `AUTH_PREFIX` is — the blanket assertion below
 *  would refuse every legitimate call — but on a different argument. These
 *  routes read NO cookie: they never call `auth.api.getSession`, so a
 *  cross-site POST from an attacker's page carries no ambient credential to
 *  ride, and there is no CSRF for the origin check to prevent. Authentication
 *  is the box-minted token, plus (on /event) an HMAC signature over the raw
 *  body. See docs/superpowers/specs/2026-08-31-ai-module-design.md §6.
 *
 *  The trailing slash is load-bearing: `/api/ai` without it would also exempt
 *  a future `/api/airline`. */
const AI_PREFIX = "/api/ai/";

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // CSRF assertion for the app's own mutating API routes. Enforced HERE, in
  // one place, rather than as a call at the top of each route handler: there
  // are eighteen of them, and the failure mode of the per-route version is a
  // new route that simply forgets. The matcher below carries `/api/:path*` so
  // this cannot be reached by adding a file.
  if (
    pathname.startsWith("/api/") &&
    !pathname.startsWith(AUTH_PREFIX) &&
    !pathname.startsWith(AI_PREFIX) &&
    MUTATING_METHODS.has(request.method)
  ) {
    if (!originAllowed({ origin: request.headers.get("origin"), configuredUrl: process.env.BETTER_AUTH_URL })) {
      return NextResponse.json({ error: "cross-origin request refused" }, { status: 403 });
    }
  }

  // /profile: optimistic redirect only — the cookie's presence is checked,
  // not its validity. The real check is auth.api.getSession() inside the page.
  if (pathname === "/profile") {
    if (!getSessionCookie(request)) {
      return NextResponse.redirect(new URL("/", request.url));
    }
  }
  return NextResponse.next();
}

// Static literal, and it has to be: "matcher values need to be constants so
// they can be statically analyzed at build-time" (the vendored proxy docs).
// No module page routes: the pre-launch lock (#464) needs a Redis read, which
// this file never makes, so it lives in each page and route (lib/launch.ts).
// `/api/:path*` carries the origin assertion above.
export const config = {
  matcher: ["/profile", "/api/:path*"],
};
