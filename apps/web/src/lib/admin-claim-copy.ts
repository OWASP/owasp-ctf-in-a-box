// User-facing copy for admin claim codes, shared by the API routes and the
// client components that show it. Client-safe: no `server-only`, no Redis.

/** The ONE refusal body for a claim that did not grant: a malformed code, a
 *  spent one, an expired one and one that never existed all read the same, so
 *  the response says nothing about which codes exist. */
export const CLAIM_INVALID =
  "That code is not valid. Each code works once, and codes issued from /admin expire after 15 minutes.";

/** The revoke refusal for the last grant. */
export const LAST_ADMIN =
  "That is the last admin. Issue a code and have someone claim it first, or nobody can open /admin.";
