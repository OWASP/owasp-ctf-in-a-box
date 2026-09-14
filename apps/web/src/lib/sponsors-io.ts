// Pure bundle parser/serializer for sponsors' archive sub-bundle and the
// admin panel's own list shape. CLIENT-SAFE ON PURPOSE, mirroring
// classic-io.ts: it must never import sponsors-store.ts (`server-only`) or
// anything that pulls in Upstash, because event-io.ts (also client-safe)
// composes this alongside classic-io.ts/quiz-io.ts/ai-io.ts to validate a
// pasted/uploaded archive in the browser before it ever reaches the server.
//
// Validation mirrors the store's field rules (name/url/blurb caps, tier,
// https-only url, logo shape) plus one bundle-only rule the single-sponsor
// admin path has no equivalent for: no duplicate ids within the file.
//
// A sponsor-heavy export is LARGE: each logo's decoded bytes ride the bundle
// as base64, unbounded by anything beyond the per-sponsor SPONSOR_LOGO_MAX
// already enforced when it was stored.

import {
  isSponsorTier,
  SPONSOR_BLURB_MAX,
  SPONSOR_ID_RE,
  SPONSOR_LOGO_MAX,
  SPONSOR_LOGO_MAX_DIMENSION,
  SPONSOR_NAME_MAX,
  SPONSOR_URL_MAX,
  type SponsorTier,
} from "@/lib/sponsors-keys";

export const SPONSORS_BUNDLE_VERSION = 1;

export type SponsorsBundleLogo = {
  type: "image/png" | "image/webp" | "image/jpeg";
  /** Base64-encoded raw bytes. */
  data: string;
  bytes: number;
  w: number;
  h: number;
  etag: string;
};

export type SponsorsBundleSponsor = {
  id: string;
  name: string;
  url: string;
  blurb: string;
  tier: SponsorTier;
  order: number;
  logo: SponsorsBundleLogo | null;
};

export type SponsorsBundle = {
  version: number;
  sponsors: SponsorsBundleSponsor[];
};

export type ImportError = { where: string; message: string };

export type ParseResult = { ok: true; bundle: SponsorsBundle } | { ok: false; errors: ImportError[] };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `https:` only, no embedded credentials (`user:pass@host`), bounded length.
 *  Mirrors the store's own check field-for-field — see sponsors-store.ts. */
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

/** Plain text only: no C0 control characters and no Unicode bidi
 *  override/isolate characters (U+202A-U+202E, U+2066-U+2069), which could
 *  visually scramble the rendered blurb. Mirrors admin-store.ts's
 *  `CONTROL_CHARS_RE`. */
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f‪-‮⁦-⁩]/;

function validateLogo(raw: unknown, where: string, errors: ImportError[]): SponsorsBundleLogo | null | undefined {
  if (raw === null) return null;
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    errors.push({ where, message: "logo must be an object or null" });
    return undefined;
  }
  if (raw.type !== "image/png" && raw.type !== "image/webp" && raw.type !== "image/jpeg") {
    errors.push({ where: `${where}.type`, message: 'logo type must be "image/png", "image/webp" or "image/jpeg"' });
    return undefined;
  }
  if (typeof raw.data !== "string" || raw.data.length === 0) {
    errors.push({ where: `${where}.data`, message: "logo data must be a non-empty base64 string" });
    return undefined;
  }
  if (typeof raw.bytes !== "number" || !Number.isInteger(raw.bytes) || raw.bytes < 1 || raw.bytes > SPONSOR_LOGO_MAX) {
    errors.push({ where: `${where}.bytes`, message: `logo bytes must be an integer between 1 and ${SPONSOR_LOGO_MAX}` });
    return undefined;
  }
  if (typeof raw.w !== "number" || !Number.isInteger(raw.w) || raw.w < 1 || raw.w > SPONSOR_LOGO_MAX_DIMENSION) {
    errors.push({ where: `${where}.w`, message: "logo width must be an integer between 1 and 4096" });
    return undefined;
  }
  if (typeof raw.h !== "number" || !Number.isInteger(raw.h) || raw.h < 1 || raw.h > SPONSOR_LOGO_MAX_DIMENSION) {
    errors.push({ where: `${where}.h`, message: "logo height must be an integer between 1 and 4096" });
    return undefined;
  }
  if (typeof raw.etag !== "string" || !/^[0-9a-f]{16}$/.test(raw.etag)) {
    errors.push({ where: `${where}.etag`, message: "logo etag must be 16 hex characters" });
    return undefined;
  }
  return { type: raw.type, data: raw.data, bytes: raw.bytes, w: raw.w, h: raw.h, etag: raw.etag };
}

function validateSponsor(raw: unknown, where: string, errors: ImportError[]): SponsorsBundleSponsor | null {
  if (!isPlainObject(raw)) {
    errors.push({ where, message: "sponsor must be an object" });
    return null;
  }
  let ok = true;
  if (typeof raw.id !== "string" || !SPONSOR_ID_RE.test(raw.id)) {
    errors.push({ where: `${where}.id`, message: "sponsor id must match /^[\\w-]{1,64}$/" });
    ok = false;
  }
  if (typeof raw.name !== "string" || raw.name.trim().length === 0 || raw.name.length > SPONSOR_NAME_MAX) {
    errors.push({ where: `${where}.name`, message: `sponsor name must be 1-${SPONSOR_NAME_MAX} characters` });
    ok = false;
  } else if (CONTROL_CHARS_RE.test(raw.name)) {
    errors.push({ where: `${where}.name`, message: "sponsor name must not contain control characters" });
    ok = false;
  }
  if (typeof raw.url !== "string" || !isValidSponsorUrl(raw.url)) {
    errors.push({ where: `${where}.url`, message: "sponsor url must be an https: URL with no embedded credentials" });
    ok = false;
  }
  if (typeof raw.blurb !== "string" || raw.blurb.length > SPONSOR_BLURB_MAX) {
    errors.push({ where: `${where}.blurb`, message: `sponsor blurb must be at most ${SPONSOR_BLURB_MAX} characters` });
    ok = false;
  } else if (CONTROL_CHARS_RE.test(raw.blurb)) {
    errors.push({ where: `${where}.blurb`, message: "sponsor blurb must not contain control characters" });
    ok = false;
  }
  if (!isSponsorTier(raw.tier)) {
    errors.push({ where: `${where}.tier`, message: 'sponsor tier must be "gold", "silver" or "community"' });
    ok = false;
  }
  if (typeof raw.order !== "number" || !Number.isInteger(raw.order)) {
    errors.push({ where: `${where}.order`, message: "sponsor order must be an integer" });
    ok = false;
  }
  const logo = validateLogo(raw.logo, `${where}.logo`, errors);
  if (logo === undefined && raw.logo !== undefined) ok = false;

  if (!ok) return null;
  return {
    id: raw.id as string,
    name: (raw.name as string).trim(),
    url: raw.url as string,
    blurb: raw.blurb as string,
    tier: raw.tier as SponsorTier,
    order: raw.order as number,
    logo: logo ?? null,
  };
}

/** Parses and validates a sponsors bundle, accumulating every problem found
 *  rather than stopping at the first — the same contract classic-io.ts and
 *  event-io.ts follow. Returns `{ ok: true, bundle }` only when zero errors
 *  were collected across the whole pass. */
export function parseBundle(raw: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, errors: [{ where: "(document)", message: "Invalid JSON" }] };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, errors: [{ where: "(document)", message: "Bundle must be an object" }] };
  }

  const errors: ImportError[] = [];
  const version = parsed.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version !== SPONSORS_BUNDLE_VERSION) {
    errors.push({
      where: "version",
      message: `Unsupported bundle version: expected ${SPONSORS_BUNDLE_VERSION}, got ${String(version)}`,
    });
  }

  if (!Array.isArray(parsed.sponsors)) {
    errors.push({ where: "sponsors", message: '"sponsors" must be an array' });
    return { ok: false, errors };
  }

  const sponsors: SponsorsBundleSponsor[] = [];
  const seenIds = new Set<string>();
  parsed.sponsors.forEach((raw, i) => {
    const sponsor = validateSponsor(raw, `sponsors[${i}]`, errors);
    if (!sponsor) return;
    if (seenIds.has(sponsor.id)) {
      errors.push({ where: `sponsors[${i}].id`, message: `duplicate sponsor id: ${sponsor.id}` });
      return;
    }
    seenIds.add(sponsor.id);
    sponsors.push(sponsor);
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, bundle: { version: SPONSORS_BUNDLE_VERSION, sponsors } };
}

/** Indented, not minified — an organizer may edit this file by hand, mirroring
 *  every other bundle serializer in the repo. */
export function serializeBundle(bundle: SponsorsBundle): string {
  return JSON.stringify(bundle, null, 2) + "\n";
}
