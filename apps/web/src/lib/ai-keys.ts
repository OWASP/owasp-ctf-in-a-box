// Shared `ctf:ai:*` key names/builders, the challenge-id and URL-template
// rules, and the mode vocabulary. Dependency-free apart from ONE import of
// `classic-keys.ts` (itself import-free), so `admin-store.ts`'s demo seed and
// master reset can use these names without a require cycle through
// `ai-store.ts`, which imports `admin-store.ts` itself. Same reasoning as
// classic-keys.ts and quiz-keys.ts.
//
// That one import is deliberate and must not become a copy: the flag
// normalization recipe has to be byte-identical across every module, because
// the authoring side and the grading side agreeing on it is the entire design.
export { caseSensitiveFlagForm, flagComparisonForm, generateChallengeId, normalizeFlag } from "./classic-keys";

export const AI_CHALLENGES_KEY = "ctf:ai:challenges";
export const AI_CATEGORIES_KEY = "ctf:ai:categories";
/** SECRET: the flag as authored, for the admin edit form alone. */
export const AI_FLAG_KEY = "ctf:ai:flag";
/** SECRET: the only value grading ever compares against. */
export const AI_FLAGNORM_KEY = "ctf:ai:flagnorm";
/** SECRET: per-challenge EVENT signing key, symmetric. Leaking one lets its
 *  holder assert solves on that challenge for users who already hold a
 *  box-minted launch token — treat it exactly like the flag hashes. It cannot
 *  mint a launch token; that is what `AI_LAUNCHKEY_KEY` is for. */
export const AI_SIGNKEY_KEY = "ctf:ai:signkey";
/** HALF SECRET: one JSON `{ publicKey, privateKey }` holding the MODULE-WIDE
 *  Ed25519 launch keypair, PEM-encoded.
 *
 *  The private half is the most dangerous secret in the module — it mints
 *  identity, so its holder can name ANY user — and so this string key sits
 *  inside the same contestant secrecy boundary as the flag and signkey hashes:
 *  no contestant-path read may name it. The public half is PUBLIC BY DESIGN and
 *  meant to be served, which is why `ai-store.ts` exposes a reader for it
 *  alone.
 *
 *  Module-wide rather than per challenge: a token's `aud` already scopes it to
 *  one challenge, and one publishable public key is far simpler for an
 *  integrator than one per challenge. See ADR 53. */
export const AI_LAUNCHKEY_KEY = "ctf:ai:launchkey";
/** SECRET until purchased, like classic's. */
export const AI_HINTS_KEY = "ctf:ai:hints";
export const AI_POINTS_KEY = "ctf:ai:points";
export const AI_SOLVED_KEY = "ctf:ai:solved";
export const AI_SOLVECOUNT_KEY = "ctf:ai:solvecount";
/** login -> ISO time of that login's latest award (#522). */
export const AI_LAST_AT_KEY = "ctf:ai:lastAt";
export const AI_SOLVES_PREFIX = "ctf:ai:solves:";
export const AI_ATTEMPTS_PREFIX = "ctf:ai:attempts:";
/** Replay guard, one key per spent event `jti`, written with NX EX. */
export const AI_NONCE_PREFIX = "ctf:ai:nonce:";

export const aiSolvesKey = (login: string) => `${AI_SOLVES_PREFIX}${login}`;
export const aiAttemptsKey = (login: string) => `${AI_ATTEMPTS_PREFIX}${login}`;
export const aiNonceKey = (jti: string) => `${AI_NONCE_PREFIX}${jti}`;

/** Same id shape and cap as classic's, validated in the same places (store
 *  write, API boundary). */
export const AI_ID_RE = /^[\w-]{1,64}$/;

/** A token's `jti`, which becomes part of a Redis key name in the replay
 *  guard. Base64url characters only, bounded length — the value arrives
 *  inside a request body, and an unbounded one is an unbounded key. */
export const AI_JTI_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Upper bound on a challenge's point value. NOT cosmetic: `AWARD_SCRIPT`
 *  reads points back out of the challenge JSON with an anchored plain-integer
 *  match, and at >=1e21 JavaScript serialises `1e+21`, which the pattern
 *  cannot read — the script would award 0 for a correct solve. */
export const AI_POINTS_MAX = 100_000;
export const AI_HINT_MAX = 1000;
export const AI_CATEGORY_MAX_LEN = 64;
export const AI_CATEGORIES_MAX = 50;
export const AI_URL_TEMPLATE_MAX = 512;

/** The literal an organizer writes into a challenge's launch template, and
 *  which the page replaces with the minted token. */
export const AI_TOKEN_PLACEHOLDER = "{token}";

/** How a challenge can be solved.
 *  - `flag`  — the box grades a flag; signed events are refused.
 *  - `event` — the external side asserts the solve; no flag is stored.
 *  - `both`  — either path.
 */
export type AiMode = "flag" | "event" | "both";
export const AI_MODES: readonly AiMode[] = ["flag", "event", "both"];

export function isAiMode(value: unknown): value is AiMode {
  return typeof value === "string" && (AI_MODES as readonly string[]).includes(value);
}

export type UrlTemplateCheck = { ok: true; value: string } | { ok: false; reason: string };

/** Validates a launch template.
 *
 *  The placeholder is checked against the RAW string, never a parsed `URL`:
 *  `new URL()` percent-encodes braces in a query (`{token}` becomes
 *  `%7Btoken%7D`), so a check against `url.href` would reject every valid
 *  template. The URL parser is used only for the scheme/host/credential rules,
 *  and only after the placeholder has been swapped for an inert stand-in. */
export function validateUrlTemplate(raw: string): UrlTemplateCheck {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return { ok: false, reason: "Launch URL is required" };
  if (value.length > AI_URL_TEMPLATE_MAX) {
    return { ok: false, reason: `Launch URL must be at most ${AI_URL_TEMPLATE_MAX} characters` };
  }
  if (!value.includes(AI_TOKEN_PLACEHOLDER)) {
    return { ok: false, reason: `Template must contain ${AI_TOKEN_PLACEHOLDER}` };
  }

  let url: URL;
  try {
    url = new URL(value.split(AI_TOKEN_PLACEHOLDER).join("TOKEN"));
  } catch {
    return { ok: false, reason: "Launch URL is not a valid absolute URL" };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "Launch URL must not embed credentials" };
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol === "https:") return { ok: true, value };
  if (url.protocol === "http:" && loopback) return { ok: true, value };
  if (url.protocol === "http:") return { ok: false, reason: "http is only allowed for localhost" };
  return { ok: false, reason: "Launch URL must use https" };
}

/** Substitutes the minted token into a validated template. The token is
 *  base64url with `.` separators — every character is already URL-safe, in a
 *  path or a query alike, so it is inserted verbatim rather than encoded
 *  (encoding would break a template that puts it in a path segment). */
export function renderLaunchUrl(template: string, token: string): string {
  return template.split(AI_TOKEN_PLACEHOLDER).join(token);
}
