// Pure bundle parser, validator and serializer for the ai module's catalogue
// — the shape the whole-event archive carries for `ai` (#250, #155's ai half).
// CLIENT-SAFE ON PURPOSE, mirroring classic-io.ts and quiz-io.ts: the admin
// panel's archive import UI validates a pasted/uploaded bundle in the browser
// before it ever reaches the server, so this file must NEVER import
// ai-store.ts (`server-only`) or anything that pulls in Upstash. It may only
// import from ai-keys.ts and markdown.ts, both dependency-free for the same
// reason.
//
// Validation here MIRRORS `upsertAiChallenge` in ai-store.ts field for field:
// a bundle that parses `ok: true` must contain only challenges the
// single-challenge admin form would also have accepted. If `upsertAiChallenge`'s
// rules ever change, these must change with them.
//
// Bundle-only rules, as in classic-io.ts: no duplicate ids within the file,
// every challenge's `category` must appear in the file's OWN `categories`
// (never the live store's), and the `categories` array is checked with
// `setAiCategories`'s shape rules plus a hard reject on duplicates.
//
// Three fields have no classic equivalent:
//   - `mode` must be one of `AI_MODES`; a record whose mode does not parse is
//     DROPPED by the store's reader, so accepting one here would import an
//     invisible, uneditable challenge.
//   - `flag` is REQUIRED when the challenge is graded (`flag`/`both`) and
//     FORBIDDEN when it is event-only: `upsertAiChallenge` stores no flag for
//     an event-only challenge, so a flag on one in a bundle is a hand-edit
//     mistake worth surfacing rather than silently discarding.
//   - `signingKey` is OPTIONAL. A bundle exported from a box carries every
//     challenge's key so an external integrator's configuration survives a
//     restore; a hand-authored bundle may omit it and the import mints one,
//     exactly as `upsertAiChallenge` does for a new challenge. When present it
//     must be a non-empty string — an empty key is a forgeable one (see
//     ai-token.ts), and `""` is also what a legacy keyless row exports as, so
//     an export is only re-importable once every row has a key.
//
// Like a classic bundle, an ai bundle is an ORGANIZER artifact that already
// carries every flag; the signing keys it carries are secrets of the same
// class (each asserts solves on ONE challenge for players who already hold a
// launch token). The launch keypair is NOT part of a bundle — it is module
// identity, not content, and both directions of the archive leave it alone.

import {
  AI_CATEGORIES_MAX,
  AI_CATEGORY_MAX_LEN,
  AI_HINT_MAX,
  AI_ID_RE,
  AI_MODES,
  AI_POINTS_MAX,
  AI_URL_TEMPLATE_MAX,
  isAiMode,
  validateUrlTemplate,
  type AiMode,
} from "@/lib/ai-keys";
import { MARKDOWN_MAX } from "@/lib/markdown";

export const AI_BUNDLE_VERSION = 1;

/** Upper bound on a carried signing key. Minted keys are `aik_` + 43 chars;
 *  this only exists so a hand-edited bundle cannot smuggle a megabyte into a
 *  hash field. */
export const AI_SIGNING_KEY_MAX = 512;

export type AiBundleChallenge = {
  id: string;
  title: string;
  category: string;
  description: string;
  points: number;
  order: number;
  mode: AiMode;
  urlTemplate: string;
  /** Optional, absent meaning false — see `AiChallenge.caseSensitive`. */
  caseSensitive?: boolean;
  /** The flag AS AUTHORED. Required unless `mode` is `event`, in which case it
   *  must be absent. */
  flag?: string;
  /** Optional paid-hint text. Absent = no hint. */
  hint?: string;
  /** Optional per-challenge event signing key. Absent = mint one on import. */
  signingKey?: string;
};

export type AiBundle = {
  version: number;
  categories: string[];
  challenges: AiBundleChallenge[];
};

/** `where` is the indexed path, `message` the rule it broke — never the
 *  submitted value or a key name. The list goes back to the admin client
 *  verbatim, and a bundle's values are arbitrary text a flag or a pasted
 *  signing key can ride in (#500). */
export type ImportError = { where: string; message: string };

export type ParseResult = { ok: true; bundle: AiBundle } | { ok: false; errors: ImportError[] };

const CHALLENGE_KEYS = [
  "id",
  "title",
  "category",
  "description",
  "points",
  "order",
  "mode",
  "urlTemplate",
  "caseSensitive",
  "flag",
  "hint",
  "signingKey",
] as const;
const CHALLENGE_KEY_SET = new Set<string>(CHALLENGE_KEYS);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validates and normalizes the top-level `categories` array — same rules
 *  and same cascading as classic-io.ts's `validateCategories`. */
function validateCategories(raw: unknown, errors: ImportError[]): string[] {
  if (!Array.isArray(raw)) {
    errors.push({ where: "categories", message: '"categories" must be an array' });
    return [];
  }
  if (raw.length > AI_CATEGORIES_MAX) {
    errors.push({ where: "categories", message: `At most ${AI_CATEGORIES_MAX} categories are allowed` });
  }
  const seen = new Map<string, number>();
  const out: string[] = [];
  raw.forEach((entry, i) => {
    const where = `categories[${i}]`;
    if (typeof entry !== "string") {
      errors.push({ where, message: "Category must be a string" });
      return;
    }
    const trimmed = entry.trim();
    if (!trimmed) {
      errors.push({ where, message: "Category name cannot be empty" });
      return;
    }
    if (trimmed.length > AI_CATEGORY_MAX_LEN) {
      errors.push({ where, message: `Category name must be at most ${AI_CATEGORY_MAX_LEN} characters` });
      return;
    }
    const fold = trimmed.toLowerCase();
    const first = seen.get(fold);
    if (first !== undefined) {
      errors.push({ where, message: `Duplicate category — the same name as categories[${first}], ignoring case` });
      return;
    }
    seen.set(fold, i);
    out.push(trimmed);
  });
  return out;
}

/** Validates one challenge object against exactly the rules
 *  `upsertAiChallenge` enforces, plus the bundle-only category-membership
 *  rule. Pushes every problem found rather than stopping at the first. */
function validateChallenge(raw: unknown, index: number, categories: readonly string[], errors: ImportError[]): void {
  const base = `challenges[${index}]`;
  if (!isPlainObject(raw)) {
    errors.push({ where: base, message: "Each challenge must be an object" });
    return;
  }

  const unknownKeys = Object.keys(raw).filter((k) => !CHALLENGE_KEY_SET.has(k));
  if (unknownKeys.length > 0) {
    errors.push({ where: base, message: `Unknown key(s) (${unknownKeys.length}) — a challenge has only ${CHALLENGE_KEYS.join(", ")}` });
  }

  const id = raw.id;
  if (typeof id !== "string" || !AI_ID_RE.test(id)) {
    errors.push({ where: `${base}.id`, message: "Challenge id must be 1-64 letters, digits, _ or -" });
  }

  const title = raw.title;
  if (typeof title !== "string" || !title.trim()) {
    errors.push({ where: `${base}.title`, message: "Challenge title is required" });
  }

  const category = raw.category;
  if (typeof category !== "string") {
    errors.push({ where: `${base}.category`, message: "Challenge category must be a string" });
  } else if (!categories.includes(category)) {
    errors.push({ where: `${base}.category`, message: "Challenge category must be one of this bundle's categories" });
  }

  const description = raw.description;
  if (typeof description !== "string" || description.length > MARKDOWN_MAX) {
    errors.push({ where: `${base}.description`, message: `Description must be at most ${MARKDOWN_MAX} characters` });
  }

  // Points and order are read back INSIDE AWARD_SCRIPT / by the store's
  // reader as plain integers — see `upsertAiChallenge` for why a non-integer
  // here is a persisted-but-invisible row, not a cosmetic problem.
  const points = raw.points;
  if (typeof points !== "number" || !Number.isInteger(points) || points < 0 || points > AI_POINTS_MAX) {
    errors.push({ where: `${base}.points`, message: `Challenge points must be an integer in [0, ${AI_POINTS_MAX}]` });
  }

  const order = raw.order;
  if (typeof order !== "number" || !Number.isInteger(order)) {
    errors.push({ where: `${base}.order`, message: "Challenge order must be an integer" });
  }

  const mode = raw.mode;
  const modeOk = isAiMode(mode);
  if (!modeOk) {
    errors.push({ where: `${base}.mode`, message: `Mode must be one of ${AI_MODES.join(", ")}` });
  }

  const urlTemplate = raw.urlTemplate;
  if (typeof urlTemplate !== "string" || urlTemplate.length > AI_URL_TEMPLATE_MAX) {
    errors.push({
      where: `${base}.urlTemplate`,
      message: `Launch URL template must be a string of at most ${AI_URL_TEMPLATE_MAX} characters`,
    });
  } else {
    const check = validateUrlTemplate(urlTemplate);
    if (!check.ok) errors.push({ where: `${base}.urlTemplate`, message: check.reason });
  }

  if (raw.caseSensitive !== undefined && typeof raw.caseSensitive !== "boolean") {
    errors.push({ where: `${base}.caseSensitive`, message: "caseSensitive must be true or false" });
  }

  // Required when graded, forbidden when event-only. Only judged once the mode
  // itself parsed — an unknown mode has already been reported above, and a
  // second error about its flag would be noise.
  const flag = raw.flag;
  if (modeOk) {
    if (mode === "event") {
      if (flag !== undefined) {
        errors.push({ where: `${base}.flag`, message: "An event-only challenge stores no flag — remove it or change mode" });
      }
    } else if (typeof flag !== "string" || !flag.trim()) {
      errors.push({ where: `${base}.flag`, message: "Flag is required unless the challenge is event-only" });
    }
  }

  if (raw.hint !== undefined) {
    if (typeof raw.hint !== "string" || !raw.hint.trim() || raw.hint.length > AI_HINT_MAX) {
      errors.push({ where: `${base}.hint`, message: `hint must be a non-empty string of at most ${AI_HINT_MAX} characters` });
    }
  }

  if (raw.signingKey !== undefined) {
    if (typeof raw.signingKey !== "string" || !raw.signingKey || raw.signingKey.length > AI_SIGNING_KEY_MAX) {
      errors.push({
        where: `${base}.signingKey`,
        message: `signingKey must be a non-empty string of at most ${AI_SIGNING_KEY_MAX} characters, or absent to mint one`,
      });
    }
  }
}

/** Cross-row rule: a repeated id within one file is always a mistake. */
function checkDuplicateIds(challenges: readonly unknown[], errors: ImportError[]): void {
  const seen = new Map<string, number>();
  challenges.forEach((raw, i) => {
    if (!isPlainObject(raw) || typeof raw.id !== "string") return;
    const first = seen.get(raw.id);
    if (first !== undefined) {
      errors.push({ where: `challenges[${i}].id`, message: `Duplicate challenge id — the same as challenges[${first}].id` });
      return;
    }
    seen.set(raw.id, i);
  });
}

/** Parses and validates a bundle document, accumulating EVERY problem found
 *  rather than stopping at the first. Same order and same generic-JSON-error
 *  rule as classic-io.ts (V8's parse error echoes an excerpt of the input,
 *  which on a bundle can be flag or key text). */
export function parseBundle(raw: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, errors: [{ where: "(document)", message: "Invalid JSON" }] };
  }

  if (!isPlainObject(parsed) || !Array.isArray(parsed.challenges)) {
    return {
      ok: false,
      errors: [{ where: "(document)", message: 'Bundle must be an object with a "challenges" array' }],
    };
  }

  const errors: ImportError[] = [];

  if (parsed.version !== AI_BUNDLE_VERSION) {
    errors.push({ where: "version", message: `Unsupported bundle version: expected ${AI_BUNDLE_VERSION}` });
  }

  const categories = validateCategories(parsed.categories, errors);
  parsed.challenges.forEach((c, i) => validateChallenge(c, i, categories, errors));
  checkDuplicateIds(parsed.challenges, errors);

  if (errors.length > 0) return { ok: false, errors };

  const challenges = (parsed.challenges as Record<string, unknown>[]).map((c) => {
    const out: AiBundleChallenge = {
      id: c.id as string,
      title: c.title as string,
      category: c.category as string,
      description: c.description as string,
      points: c.points as number,
      order: c.order as number,
      mode: c.mode as AiMode,
      urlTemplate: c.urlTemplate as string,
    };
    if (c.caseSensitive !== undefined) out.caseSensitive = c.caseSensitive as boolean;
    if (c.flag !== undefined) out.flag = c.flag as string;
    if (c.hint !== undefined) out.hint = c.hint as string;
    if (c.signingKey !== undefined) out.signingKey = c.signingKey as string;
    return out;
  });

  return { ok: true, bundle: { version: AI_BUNDLE_VERSION, categories, challenges } };
}

/** Indented, not minified — an organizer edits this file by hand. Ends in a
 *  trailing newline, like every other text file in the repo. */
export function serializeBundle(bundle: AiBundle): string {
  return JSON.stringify(bundle, null, 2) + "\n";
}
