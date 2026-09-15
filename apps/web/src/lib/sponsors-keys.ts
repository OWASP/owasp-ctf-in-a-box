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

/** How big a sponsor's logo renders on the two surfaces where it is a credit
 *  row rather than the content: the landing-page strip and the leaderboard's
 *  projector display. Each maps these three presets to its own values — a
 *  projector is read from across a room, a landing page from a desk — so the
 *  setting is a relative choice, not a pixel count. `/sponsors` keeps its own
 *  fixed layout: it is the page that exists to show sponsors. See ADR 57 in
 *  docs/decisions.md for why both credit surfaces stay deliberately plain
 *  otherwise — "a credit row, not an ad rail". */
export type SponsorLogoSize = "sm" | "md" | "lg";

export const SPONSOR_LOGO_SIZES: readonly SponsorLogoSize[] = ["sm", "md", "lg"];

export function isSponsorLogoSize(value: unknown): value is SponsorLogoSize {
  return typeof value === "string" && (SPONSOR_LOGO_SIZES as readonly string[]).includes(value);
}

/** The id order that moving one sponsor up or down produces, for the reorder
 *  endpoint (`POST /api/admin/sponsors` with a `reorder` array).
 *
 *  Returns `null` — not a copy of the input — when the move is a no-op: an
 *  unknown id, or an edge row asked to step off the end. A caller that
 *  posted the unchanged array anyway would spend a write and an audit-log
 *  line saying an organizer reordered nothing.
 *
 *  Order alone decides: the list an organizer sees is already sorted, and
 *  tier is a label, so "up" means one position up in THAT list, never
 *  "up within your tier". */
export function movedSponsorOrder(ids: readonly string[], id: string, delta: -1 | 1): string[] | null {
  const from = ids.indexOf(id);
  if (from === -1) return null;
  const to = from + delta;
  if (to < 0 || to >= ids.length) return null;
  const next = [...ids];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}
