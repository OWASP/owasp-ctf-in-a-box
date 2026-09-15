// Shared `ctf:sponsors*` key names, id/field caps, and the tier vocabulary.
// Dependency-free ON PURPOSE (mirrors classic-keys.ts) so admin-store.ts's
// master reset can name these keys without a require cycle through
// sponsors-store.ts, which imports admin-store.ts's writeAdminAudit.

export const SPONSORS_KEY = "ctf:sponsors";
export const SPONSORS_LOGO_KEY = "ctf:sponsors:logo";

/** Same id shape and cap as classic's, validated in the same places (store
 *  write, API boundary, and the logo route before any Redis command runs). */
export const SPONSOR_ID_RE = /^[\w-]{1,64}$/;

export const SPONSOR_NAME_MAX = 80;
export const SPONSOR_URL_MAX = 512;
export const SPONSOR_BLURB_MAX = 280;
/** Cap on the DECODED logo bytes — never the base64 string's length. */
export const SPONSOR_LOGO_MAX = 65536;
/** Reject an intrinsic width/height of 0 or above this. */
export const SPONSOR_LOGO_MAX_DIMENSION = 4096;

export type SponsorTier = "gold" | "silver" | "community";

export const SPONSOR_TIERS: readonly SponsorTier[] = ["gold", "silver", "community"];

/** Tier is display ordering and a label only — every sponsor still appears on
 *  all three public surfaces. Used to group `/sponsors` and to give a
 *  deterministic tiebreak alongside `order`/`name`. */
export function tierRank(tier: SponsorTier): number {
  const i = SPONSOR_TIERS.indexOf(tier);
  return i === -1 ? SPONSOR_TIERS.length : i;
}

export function isSponsorTier(value: unknown): value is SponsorTier {
  return typeof value === "string" && (SPONSOR_TIERS as readonly string[]).includes(value);
}

/** How big a sponsor's logo renders on the landing-page strip — the one
 *  surface small enough that "too small to read" was a real complaint.
 *  `/sponsors` and the leaderboard display board keep their own fixed
 *  sizes; this setting is scoped to the strip alone (see ADR 57 in
 *  docs/decisions.md for why the strip stays deliberately plain otherwise —
 *  "a credit row, not an ad rail"). */
export type SponsorLogoSize = "sm" | "md" | "lg";

export const SPONSOR_LOGO_SIZES: readonly SponsorLogoSize[] = ["sm", "md", "lg"];

export function isSponsorLogoSize(value: unknown): value is SponsorLogoSize {
  return typeof value === "string" && (SPONSOR_LOGO_SIZES as readonly string[]).includes(value);
}
