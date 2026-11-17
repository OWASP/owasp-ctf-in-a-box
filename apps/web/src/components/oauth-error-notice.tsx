"use client";

// The landing page's OAuth callback error banner (issue #380).
//
// The provider (GitHub, Google or Discord) redirects an authorize failure
// straight back to the app with
// `?error=<code>&error_description=<text>` — a suspended/deleted OAuth app,
// a contestant who cancelled the provider prompt, or a redirect URI the
// provider doesn't recognize; so does a callback the sign-in switches refuse. Before this, the landing page read neither parameter:
// the sign-in button looked like it simply did nothing.
//
// Reuses the mock-data/hint notice's amber `ds-card` look (server-only
// components) but as `role="alert"`, since this is something that JUST
// happened on this exact page load, not page furniture present from every
// first paint — the opposite of teamless-notice's reasoning for skipping it.

import { authClient } from "@/lib/auth-client";
import { oauthErrorCallbackURL, postSigninCallbackURL } from "@/lib/post-signin";

/** Friendly, human sentences for the callback errors worth naming. GitHub's
 *  own `error_description` for these — and for every other code — is NEVER
 *  rendered: it is arbitrary provider-supplied prose with no guarantee about
 *  its contents (CodeRabbit pre-merge finding, "Secrets & Challenge Data In
 *  Logs" — a description is exactly the kind of value that shouldn't reach a
 *  page render, a screen share, or a log capture). Only GitHub's own CODE —
 *  a short, fixed enum of OAuth error identifiers — ever reaches the DOM,
 *  and only once it has been checked against a strict allowlist shape. */
const FRIENDLY_COPY: Record<string, string> = {
  application_suspended:
    "This event's sign-in app has been suspended, so sign-in can't complete right now. Let an organizer know.",
  access_denied:
    "Sign-in was cancelled before the provider confirmed your identity — nothing was created or changed.",
  redirect_uri_mismatch:
    "The sign-in configuration doesn't match this site yet, so the provider refused the request. Let an organizer know.",
};

const GENERIC_MESSAGE = "Sign-in did not complete.";

/** GitHub's own OAuth error codes are short machine identifiers
 *  (`access_denied`, `server_error`, …): letters, digits, underscore, hyphen,
 *  capped well above any real one. A value outside that shape is not a code
 *  this app trusts as GitHub's own, so none of it — not even the sanitized
 *  parts — is shown; the generic sentence renders alone. */
const CODE_SHAPE = /^[A-Za-z0-9_-]{1,40}$/;

export default function OAuthErrorNotice({
  error,
  callbackURL = "/profile",
}: {
  error: string;
  /** Where "Try again" retries toward — the destination the failed sign-in
   *  was originally headed for. Recovered from `?next=` by the caller
   *  (page.tsx) and re-validated there with `sanitizeNext` before being
   *  passed here; this component trusts it no further than that. */
  callbackURL?: string;
}) {
  // `error` is an attacker-controlled query parameter. FRIENDLY_COPY is a
  // plain object literal, so `FRIENDLY_COPY[error]` for `error=constructor`
  // (or `__proto__`, `toString`, `valueOf`, `hasOwnProperty`, …) resolves to
  // an inherited Object.prototype member instead of `undefined` — truthy, so
  // `??` never falls back, and `{message}` below would be a function/object,
  // which React refuses to render as a child (an unauthenticated 500 on `/`
  // from a crafted URL). `Object.hasOwn` only ever answers from the object's
  // OWN keys, never the prototype chain.
  const message = Object.hasOwn(FRIENDLY_COPY, error)
    ? FRIENDLY_COPY[error]
    : CODE_SHAPE.test(error)
      ? `${GENERIC_MESSAGE} (code: ${error})`
      : GENERIC_MESSAGE;
  return (
    <div
      role="alert"
      className="ds-card w-full max-w-xl rounded-lg border border-[#d4a017]/30 bg-[#d4a017]/[0.06] p-5"
    >
      <p className="text-xs font-medium uppercase tracking-wider text-[#d4a017]">Sign-in didn&rsquo;t complete</p>
      <p className="mt-1 text-sm leading-relaxed text-zinc-300">{message}</p>
      <button
        type="button"
        className="ds-link mt-2 text-sm"
        onClick={() => {
          // The same action the header's own sign-in button runs
          // (auth-nav.tsx), carrying the SAME destination through both legs
          // so a retry that also fails lands back here with the destination
          // still intact rather than collapsing to /profile.
          void authClient.signIn.social({
            provider: "github",
            callbackURL: postSigninCallbackURL(callbackURL),
            errorCallbackURL: oauthErrorCallbackURL(callbackURL),
          });
        }}
      >
        Try again
      </button>
    </div>
  );
}
