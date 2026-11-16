// First-login team steering (issue #217): every GitHub sign-in lands on
// /api/post-signin first, which sends a teamless contestant to team setup
// BEFORE their original destination. The module-page redirect
// (require-team.ts) and the API refusals still hold as the backstop; this
// exists so the team step is met at sign-in, not discovered later — and it
// is the only place the secure-development path (whose scores arrive via
// the poller, with no app route to refuse a teamless login) gets covered at
// all.
//
// Pure decision logic only — the route handler (app/api/post-signin) does
// the session/store reads. Kept import-free so require-team.ts can take
// TEAM_SETUP_PATH from here without dragging next/navigation into anything.

/** Where a teamless contestant is sent. The `#team` fragment scrolls the
 *  profile straight to the team card rather than dropping them at the top of
 *  a page of stats with no clue why they are there. */
export const TEAM_SETUP_PATH = "/profile#team";

export const POST_SIGNIN_PATH = "/api/post-signin";

/** Wraps a sign-in destination so the OAuth round-trip lands on the
 *  post-signin decision first, carrying the original intent as `next`. */
export function postSigninCallbackURL(next: string): string {
  return `${POST_SIGNIN_PATH}?next=${encodeURIComponent(next)}`;
}

/** `next` comes back from the OAuth round-trip as a query parameter, i.e.
 *  attacker-influencable. Only a same-origin path survives: anything not
 *  starting with a single `/` (absolute URLs, `//host`, `/\host` — both of
 *  which browsers treat as protocol-relative) falls back to /profile — and
 *  so does anything carrying tab/newline/CR, which the WHATWG URL parser
 *  STRIPS before parsing, so a decoded `/%09/evil.example` would otherwise
 *  re-collapse into protocol-relative `//evil.example` at resolve time. */
export function sanitizeNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/")) return "/profile";
  if (raw.startsWith("//") || raw.startsWith("/\\")) return "/profile";
  if (/[\t\n\r]/.test(raw)) return "/profile";
  return raw;
}

/** Where a FAILED OAuth callback re-lands: the landing page, carrying the
 *  destination the sign-in call was headed for as `?next=` (issue #380
 *  follow-up — `HeroCta` and `JoinTeamInvite` each pass a distinct local
 *  destination through `postSigninCallbackURL`, and a plain `errorCallbackURL:
 *  "/"` lost it on failure). Sanitized with the SAME rule as the return trip
 *  (`sanitizeNext`) before being encoded: this value comes back through an
 *  attacker-influenceable query string exactly like that one does, so the
 *  reader (page.tsx) validates it again on the way back in rather than
 *  trusting that it only ever contains what this function wrote. */
export function oauthErrorCallbackURL(next: string): string {
  return `/?next=${encodeURIComponent(sanitizeNext(next))}`;
}

/** The sign-in page, carrying where the visitor was headed. Sanitized here
 *  and again by the page: `next` round-trips through a query string. */
export function signInHref(next: string): string {
  return `/sign-in?next=${encodeURIComponent(sanitizeNext(next))}`;
}

/**
 * Where a just-signed-in visitor actually goes.
 *
 * The exemptions mirror require-team.ts deliberately:
 *
 * - a `/join/<code>` destination passes through even when teamless — the
 *   invite page IS the team step, and bouncing it to /profile would lose
 *   the invite the sign-in existed to honour;
 * - admins pass through — an organizer signing in to check their content is
 *   not playing;
 * - everyone with a team passes through.
 */
export function resolvePostSigninTarget(opts: {
  /** Already sanitized via sanitizeNext. */
  next: string;
  isAdmin: boolean;
  teamless: boolean;
}): string {
  if (opts.next.startsWith("/join/")) return opts.next;
  if (opts.isAdmin) return opts.next;
  if (opts.teamless) return TEAM_SETUP_PATH;
  return opts.next;
}
