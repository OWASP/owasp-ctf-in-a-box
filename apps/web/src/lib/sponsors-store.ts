import "server-only";
import { createHash } from "node:crypto";
import { upstashPipeline } from "@/lib/upstash";
import {
  isSponsorTier,
  SPONSOR_BLURB_MAX,
  SPONSOR_ID_RE,
  SPONSOR_LOGO_MAX,
  SPONSOR_LOGO_MAX_DIMENSION,
  SPONSOR_NAME_MAX,
  SPONSOR_URL_MAX,
  SPONSORS_KEY,
  SPONSORS_LOGO_KEY,
  tierRank,
  type SponsorTier,
} from "@/lib/sponsors-keys";
import { decodeStrictBase64, sniffRasterImage, type RasterMime } from "@/lib/image-sniff";
import { SPONSORS_BUNDLE_VERSION, type SponsorsBundle } from "@/lib/sponsors-io";

/**
 * The sponsors platform feature. This file is the only place that touches
 * `ctf:sponsors*` during normal activity (documented exception, as in classic
 * and ai: the master reset in admin-store.ts reuses the key names directly).
 *
 * Key layout:
 *   ctf:sponsors        hash  id -> JSON Sponsor (metadata only, no bytes)
 *   ctf:sponsors:logo   hash  id -> base64 raw logo bytes
 *
 * Split for cost, not secrecy: `listSponsors()` (called on every landing-page
 * and footer render) does one HGETALL against the metadata hash alone and
 * never drags a logo blob along. The logo route does one HGET against the
 * other hash, and only on a real cache miss (see that route's own comment).
 *
 * THERE IS NO SECRECY BOUNDARY HERE. Every field — name, url, blurb, tier,
 * order, the logo itself — is public by design; a sponsor's whole purpose is
 * to be seen. Do not copy ai-store.ts's four-secret-hash ceremony into this
 * file: nothing here is a contestant secret, and pretending otherwise would
 * only add readers this feature does not need.
 *
 * All validation lives here, not in the API route, because this store is the
 * one chokepoint neither the admin route nor a future second route can
 * bypass.
 */

export class SponsorValidationError extends Error {
  field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "SponsorValidationError";
    this.field = field;
  }
}

export type SponsorLogo = {
  type: "image/png" | "image/webp" | "image/jpeg";
  bytes: number;
  w: number;
  h: number;
  etag: string;
};

export type Sponsor = {
  id: string;
  name: string;
  url: string;
  blurb: string;
  tier: SponsorTier;
  order: number;
  logo: SponsorLogo | null;
};

export type SponsorInput = {
  id: string;
  name: string;
  url: string;
  blurb: string;
  tier: SponsorTier;
  order: number;
};

/** A raw logo upload, as the admin route receives it: base64 data plus the
 *  CLIENT's claimed MIME type. The claimed type is used for NOTHING but a
 *  friendlier error message on an obvious SVG upload before the byte sniff
 *  runs — every actual accept/reject decision below reads the decoded bytes,
 *  never `declaredType` or a filename. */
export type SponsorLogoInput = { data: string; declaredType?: string };

// Plain text only — no C0 control characters, no Unicode bidi
// override/isolate characters (U+202A-U+202E, U+2066-U+2069), mirroring
// admin-store.ts's CONTROL_CHARS_RE. Rendered-text integrity, not injection
// protection: there is no HTML here for either field to inject into.
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f‪-‮⁦-⁩]/;


function isValidSponsorUrl(url: string): boolean {
  if (url.length === 0 || url.length > SPONSOR_URL_MAX) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "";
}

function validateFields(input: SponsorInput): void {
  if (!SPONSOR_ID_RE.test(input.id)) {
    throw new SponsorValidationError("id", "sponsor id must match /^[\\w-]{1,64}$/");
  }
  const name = input.name.trim();
  if (name.length === 0 || name.length > SPONSOR_NAME_MAX) {
    throw new SponsorValidationError("name", `sponsor name must be 1-${SPONSOR_NAME_MAX} characters`);
  }
  if (CONTROL_CHARS_RE.test(name)) {
    throw new SponsorValidationError("name", "sponsor name must not contain control characters");
  }
  if (!isValidSponsorUrl(input.url)) {
    throw new SponsorValidationError("url", "sponsor url must be an https: URL with no embedded credentials");
  }
  if (input.blurb.length > SPONSOR_BLURB_MAX) {
    throw new SponsorValidationError("blurb", `sponsor blurb must be at most ${SPONSOR_BLURB_MAX} characters`);
  }
  if (CONTROL_CHARS_RE.test(input.blurb)) {
    throw new SponsorValidationError("blurb", "sponsor blurb must not contain control characters");
  }
  if (!isSponsorTier(input.tier)) {
    throw new SponsorValidationError("tier", 'sponsor tier must be "gold", "silver" or "community"');
  }
  if (!Number.isInteger(input.order)) {
    throw new SponsorValidationError("order", "sponsor order must be an integer");
  }
}

/**
 * Decodes and validates an uploaded logo. SECURITY INVARIANT: the declared
 * MIME type and any filename are ignored for the accept/reject decision —
 * only the DECODED bytes decide (image-sniff.ts, shared with the event
 * images #529). This store owns only its caps and its messages.
 */
const SNIFF_MESSAGES = {
  png: "logo is not a structurally valid PNG",
  webp: "logo is not a structurally valid WebP",
  jpeg: "logo is not a structurally valid JPEG",
  svg: "SVG logos are not accepted — an SVG served from this origin can run script. Export the logo as PNG, JPEG or WebP.",
  unknown: "logo must be a PNG, JPEG or WebP image",
} as const;

function decodeAndValidateLogo(input: SponsorLogoInput): { bytes: Buffer; logo: SponsorLogo } {
  const bytes = decodeStrictBase64(input.data);
  if (!bytes) {
    throw new SponsorValidationError("logo", "logo data is not valid base64");
  }
  if (bytes.length === 0) {
    throw new SponsorValidationError("logo", "logo data is empty");
  }
  if (bytes.length > SPONSOR_LOGO_MAX) {
    throw new SponsorValidationError("logo", `logo must be at most ${SPONSOR_LOGO_MAX} bytes, decoded`);
  }
  const sniffed = sniffRasterImage(bytes, input.declaredType);
  if (!sniffed.ok) throw new SponsorValidationError("logo", SNIFF_MESSAGES[sniffed.reason]);
  return { bytes, logo: buildLogoMeta(sniffed.type, bytes, sniffed) };
}

function buildLogoMeta(type: RasterMime, bytes: Buffer, dims: { w: number; h: number }): SponsorLogo {
  if (dims.w < 1 || dims.w > SPONSOR_LOGO_MAX_DIMENSION || dims.h < 1 || dims.h > SPONSOR_LOGO_MAX_DIMENSION) {
    throw new SponsorValidationError("logo", "logo dimensions must be between 1 and 4096 pixels");
  }
  const etag = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  return { type, bytes: bytes.length, w: dims.w, h: dims.h, etag };
}

function parseSponsor(raw: string): Sponsor | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const s = parsed as Record<string, unknown>;
    if (typeof s.id !== "string") return null;
    if (typeof s.name !== "string") return null;
    if (typeof s.url !== "string") return null;
    if (typeof s.blurb !== "string") return null;
    if (!isSponsorTier(s.tier)) return null;
    if (typeof s.order !== "number") return null;
    let logo: SponsorLogo | null = null;
    if (s.logo && typeof s.logo === "object") {
      const l = s.logo as Record<string, unknown>;
      if (
        (l.type === "image/png" || l.type === "image/webp" || l.type === "image/jpeg") &&
        typeof l.bytes === "number" &&
        typeof l.w === "number" &&
        typeof l.h === "number" &&
        typeof l.etag === "string"
      ) {
        logo = { type: l.type, bytes: l.bytes, w: l.w, h: l.h, etag: l.etag };
      }
    }
    return { id: s.id, name: s.name, url: s.url, blurb: s.blurb, tier: s.tier, order: s.order, logo };
  } catch {
    return null;
  }
}

function compareSponsors(a: Sponsor, b: Sponsor): number {
  return a.order - b.order || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

function parseSponsorHash(flat: unknown): Sponsor[] {
  const arr = Array.isArray(flat) ? (flat as string[]) : [];
  const out: Sponsor[] = [];
  for (let i = 0; i < arr.length; i += 2) {
    const parsed = parseSponsor(arr[i + 1]!);
    if (parsed) out.push(parsed);
  }
  return out;
}

/** PUBLIC. Metadata only — never issues a command against the logo hash, so
 *  a landing-page/footer render that only needs name+url+order costs one
 *  HGETALL regardless of how many sponsors carry a logo. Every one of the
 *  three public surfaces (sponsor-strip, site-footer, /sponsors) calls this
 *  and renders nothing when it comes back empty. */
export async function listSponsors(): Promise<Sponsor[]> {
  const [res] = await upstashPipeline([["HGETALL", SPONSORS_KEY]]);
  if (res!.error) throw new Error(`Upstash HGETALL failed: ${res!.error}`);
  const sponsors = parseSponsorHash(res!.result);
  sponsors.sort(compareSponsors);
  return sponsors;
}

/** Same public shape as `listSponsors` — there is no admin-only field to add,
 *  since nothing here is secret. Kept as its own named export (rather than a
 *  re-export) so the admin route reads as a deliberate call, mirroring
 *  `listChallengesForAdmin` even though the two happen to return the same
 *  data today. */
export async function listSponsorsForAdmin(): Promise<Sponsor[]> {
  return listSponsors();
}

/** The logo route's ONE read: a single HGET on the logo hash, returning the
 *  raw base64 string or null if this sponsor has no logo row. Never called
 *  outside that route — every other reader uses `listSponsors`. */
export async function getSponsorLogo(id: string): Promise<string | null> {
  const [res] = await upstashPipeline([["HGET", SPONSORS_LOGO_KEY, id]]);
  if (res!.error) throw new Error(`Upstash HGET failed: ${res!.error}`);
  return typeof res!.result === "string" ? res!.result : null;
}

/**
 * Create-or-update. `logo` is three-valued: `undefined` leaves an existing
 * logo untouched (an edit that only changes the blurb, say), `null` clears
 * it (the sponsor's name renders as text from then on), and a
 * `SponsorLogoInput` replaces it after passing `decodeAndValidateLogo`.
 *
 * The metadata write and the logo write (when either changes) land in ONE
 * pipeline, so the two hashes can never observably diverge — the same
 * discipline classic-store's `upsertChallenge` follows for its flag/flagnorm
 * pair.
 */
export async function upsertSponsor(input: SponsorInput, logo?: SponsorLogoInput | null): Promise<Sponsor> {
  validateFields(input);

  const sponsor: Sponsor = {
    id: input.id,
    name: input.name.trim(),
    url: input.url,
    blurb: input.blurb,
    tier: input.tier,
    order: input.order,
    logo: null,
  };

  const commands: (string | number)[][] = [];
  if (logo === undefined) {
    // Keep whatever logo (if any) is already on record.
    const [existingRes] = await upstashPipeline([["HGET", SPONSORS_KEY, input.id]]);
    if (existingRes!.error) throw new Error(`Upstash HGET failed: ${existingRes!.error}`);
    const existing = typeof existingRes!.result === "string" ? parseSponsor(existingRes!.result) : null;
    sponsor.logo = existing?.logo ?? null;
    commands.push(["HSET", SPONSORS_KEY, input.id, JSON.stringify(sponsor)]);
  } else if (logo === null) {
    sponsor.logo = null;
    commands.push(["HSET", SPONSORS_KEY, input.id, JSON.stringify(sponsor)]);
    commands.push(["HDEL", SPONSORS_LOGO_KEY, input.id]);
  } else {
    const { bytes, logo: logoMeta } = decodeAndValidateLogo(logo);
    sponsor.logo = logoMeta;
    commands.push(["HSET", SPONSORS_KEY, input.id, JSON.stringify(sponsor)]);
    commands.push(["HSET", SPONSORS_LOGO_KEY, input.id, bytes.toString("base64")]);
  }

  const results = await upstashPipeline(commands);
  const failed = results.find((r) => r.error);
  if (failed) throw new Error(`Upstash sponsor write failed: ${failed.error}`);
  return sponsor;
}

/** HDEL on both hashes in one pipeline — a sponsor and its logo always leave
 *  together, never one without the other. */
export async function deleteSponsor(id: string): Promise<void> {
  if (!SPONSOR_ID_RE.test(id)) {
    throw new SponsorValidationError("id", "sponsor id must match /^[\\w-]{1,64}$/");
  }
  const results = await upstashPipeline([
    ["HDEL", SPONSORS_KEY, id],
    ["HDEL", SPONSORS_LOGO_KEY, id],
  ]);
  const failed = results.find((r) => r.error);
  if (failed) throw new Error(`Upstash HDEL failed: ${failed.error}`);
}

/** Rewrites `order` on every listed sponsor to match `ids`'s position,
 *  leaving name/url/blurb/tier/logo untouched. Ids not currently on record
 *  are silently skipped (a stale row from a concurrent delete). */
export async function reorderSponsors(ids: string[]): Promise<Sponsor[]> {
  const [res] = await upstashPipeline([["HGETALL", SPONSORS_KEY]]);
  if (res!.error) throw new Error(`Upstash HGETALL failed: ${res!.error}`);
  const byId = new Map(parseSponsorHash(res!.result).map((s) => [s.id, s]));

  const commands: (string | number)[][] = [];
  ids.forEach((id, order) => {
    const existing = byId.get(id);
    if (!existing) return;
    const updated: Sponsor = { ...existing, order };
    byId.set(id, updated);
    commands.push(["HSET", SPONSORS_KEY, id, JSON.stringify(updated)]);
  });

  if (commands.length > 0) {
    const results = await upstashPipeline(commands);
    const failed = results.find((r) => r.error);
    if (failed) throw new Error(`Upstash HSET failed: ${failed.error}`);
  }

  const sponsors = Array.from(byId.values());
  sponsors.sort(compareSponsors);
  return sponsors;
}

/** Sniffs every logo in the bundle without writing anything. `importEventBundle`
 *  calls this BEFORE `resetEvent`, so a bundle carrying a tampered/invalid logo
 *  (real bytes never sniffed anywhere but here and `importBundle` below) throws
 *  while the box's current content is still intact, instead of surfacing the
 *  same error after `resetEvent` and the other modules' clears have already
 *  run. */
export function validateBundleLogos(bundle: SponsorsBundle): void {
  for (const s of bundle.sponsors) {
    if (s.logo) decodeAndValidateLogo({ data: s.logo.data, declaredType: s.logo.type });
  }
}

/** Full replace, for the event-archive import path (event-store.ts) ONLY.
 *  `admin-store.ts`'s master reset (RESET_PREFIXES) already clears both
 *  hashes before an archive import runs, so this only ever writes into an
 *  empty store — see event-store.ts's `importEventBundle`. Re-sniffs each
 *  logo again rather than trusting `validateBundleLogos` already ran: this
 *  function has no way to know the caller called it, and the check is cheap
 *  relative to the HSETs beside it. */
export async function importBundle(bundle: SponsorsBundle): Promise<{ created: number }> {
  if (bundle.sponsors.length === 0) return { created: 0 };
  const commands: (string | number)[][] = [];
  for (const s of bundle.sponsors) {
    // SECURITY INVARIANT, same as upsertSponsor: re-derive the logo's
    // metadata from its OWN bytes rather than trusting the bundle's claimed
    // type/w/h/etag. A hand-edited (or tampered) archive file could otherwise
    // pair `type: "image/png"` with actual SVG bytes and sail straight past
    // every other check in this file, since a bundle's `data` is never
    // sniffed anywhere else on the import path.
    let logo: SponsorLogo | null = null;
    let logoBytes: Buffer | null = null;
    if (s.logo) {
      const decoded = decodeAndValidateLogo({ data: s.logo.data, declaredType: s.logo.type });
      logo = decoded.logo;
      logoBytes = decoded.bytes;
    }
    const sponsor: Sponsor = { id: s.id, name: s.name, url: s.url, blurb: s.blurb, tier: s.tier, order: s.order, logo };
    commands.push(["HSET", SPONSORS_KEY, s.id, JSON.stringify(sponsor)]);
    if (logoBytes) commands.push(["HSET", SPONSORS_LOGO_KEY, s.id, logoBytes.toString("base64")]);
  }
  const results = await upstashPipeline(commands);
  const failed = results.find((r) => r.error);
  if (failed) throw new Error(`Upstash bulk import failed: ${failed.error}`);
  return { created: bundle.sponsors.length };
}

/** For the event-archive export path (event-store.ts) ONLY — the one reader
 *  allowed to carry logo bytes out of this store into an archive file,
 *  because an archive is an organizer artifact meant to reproduce the event
 *  exactly, sponsor logos included. */
export async function exportBundle(): Promise<SponsorsBundle | null> {
  const sponsors = await listSponsors();
  if (sponsors.length === 0) return null;
  const out: SponsorsBundle["sponsors"] = [];
  for (const s of sponsors) {
    let logo: SponsorsBundle["sponsors"][number]["logo"] = null;
    if (s.logo) {
      const data = await getSponsorLogo(s.id);
      if (data) logo = { type: s.logo.type, data, bytes: s.logo.bytes, w: s.logo.w, h: s.logo.h, etag: s.logo.etag };
    }
    out.push({ id: s.id, name: s.name, url: s.url, blurb: s.blurb, tier: s.tier, order: s.order, logo });
  }
  return { version: SPONSORS_BUNDLE_VERSION, sponsors: out };
}

// tierRank is re-exported for the admin panel and /sponsors page, which group
// by tier and need the same ordering this file would use if it ever grouped.
export { tierRank };
