/**
 * ai-module constants that BOTH the server and the admin UI need — same
 * dependency-free, non-`server-only` split as `classic-defaults.ts` and
 * `hint-defaults.ts`, so a Client Component can import them without dragging
 * in the store.
 */

/** Seconds between flag submissions on the same ai challenge. Mirrors
 *  `CLASSIC_COOLDOWN_SEC`; 0 (an admin override) means no cooldown. Applies to
 *  the GRADED path only — a signed event has no wrong answer to rate-limit. */
export const AI_COOLDOWN_SEC = 5;

/** Graded flag submissions a contestant gets on one ai challenge. 0 means no
 *  cap, which is the shipped default: an event that never sets `aiMaxAttempts`
 *  is throttled by the cooldown alone. Counted per contestant, like the
 *  cooldown, and on the GRADED path only — a signed event is never capped. */
export const AI_MAX_ATTEMPTS = 0;

/** How long a minted launch token stays valid. A fresh token is minted on
 *  every `/ai/[id]` render, so this is also the window in which a pre-event
 *  gate decision (checked at mint time, never on the cross-origin API routes)
 *  stays honoured. */
export const AI_TOKEN_TTL_SEC = 86_400;

/** Cap on the `ctf.progress` array inside a token. The token rides in a URL;
 *  a 300-challenge event would otherwise mint a link a browser refuses. */
export const AI_PROGRESS_MAX = 50;

/** Accepted clock skew, in seconds, on a signed event's `X-CTF-Timestamp`.
 *  Enforced in BOTH directions — a future timestamp is as invalid as a stale
 *  one, or a signer with a fast clock could mint requests replayable later. */
export const AI_EVENT_SKEW_SEC = 300;

/** How long a spent event `jti` is remembered. Must EXCEED 2 * skew, or a
 *  request could become replayable while still inside its own window: an event
 *  stamped a full skew in the future is accepted now AND is still inside its
 *  own acceptance window a further skew later, so a TTL of exactly 2 * skew
 *  forgets the nonce at the very moment the captured request is still valid.
 *
 *  Derived from `AI_EVENT_SKEW_SEC` rather than written as a literal so the
 *  two can never drift apart: widening the skew widens this automatically. */
export const AI_NONCE_TTL_SEC = 2 * AI_EVENT_SKEW_SEC + 1;

/** Hard cap on a signed event body, in bytes, checked before the raw bytes are
 *  hashed. */
export const AI_EVENT_BODY_MAX = 8192;
