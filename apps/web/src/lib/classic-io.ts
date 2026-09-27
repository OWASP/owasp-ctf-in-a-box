// Pure bundle parser, validator and serializer for classic's bulk
// import/export. This file is CLIENT-SAFE ON PURPOSE: the admin panel's
// bulk-import UI is a Client Component that needs to validate a
// pasted/uploaded bundle in the browser before it ever reaches the server, so
// this file must NEVER import classic-store.ts (`server-only`) or anything
// that pulls in Upstash. It may only import from classic-keys.ts and
// markdown.ts, both dependency-free / client-safe for the same reason (see
// classic-keys.ts's and quiz-keys.ts's header comments).
//
// Validation here MIRRORS `upsertChallenge` in classic-store.ts field for
// field: a bundle that parses `ok: true` must contain only challenges the
// single-challenge admin form would also have accepted, or the two authoring
// paths disagree about what is valid. If `upsertChallenge`'s rules ever
// change, these must change with them.
//
// On top of that per-challenge mirror, a bundle carries rules the
// single-challenge path has no equivalent for, because a bundle must be
// SELF-CONTAINED: no duplicate ids within the file, and every challenge's
// `category` must appear in the file's OWN `categories` array — never the
// live store's — so importing a bundle never silently depends on categories
// that happen to already exist in the target event. The `categories` array
// itself is validated with the same shape rules as `setCategories` (max
// count, per-name trim/empty/length), plus one bundle-only addition:
// duplicates are a hard reject here rather than `setCategories`'s silent
// case-insensitive dedupe, because two spellings of the same category
// arriving in one paste is almost certainly a mistake worth surfacing rather
// than quietly fixing.

import {
  CLASSIC_HINT_MAX,
  CLASSIC_ID_RE,
  CLASSIC_POINTS_MAX,
  CLASSIC_CATEGORY_MAX_LEN,
  CLASSIC_CATEGORIES_MAX,
  CLASSIC_STORIES_MAX,
  CLASSIC_STORY_INTRO_MAX,
  CLASSIC_STORY_STEPS_MAX,
  CLASSIC_STORY_TITLE_MAX,
} from "@/lib/classic-keys";
import {
  ATTACHMENTS_PER_ITEM_MAX,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_NAME_MAX,
  ATTACHMENT_URL_MAX,
  type AttachmentMeta,
} from "@/lib/attachments-keys";
import { MARKDOWN_MAX } from "@/lib/markdown";
import type { Story } from "@/lib/story-lock";

/** 2 since #463: an optional top-level `stories`. 1 stays importable. */
export const CLASSIC_BUNDLE_VERSION = 2;
const SUPPORTED_VERSIONS = new Set([1, 2]);
const STORY_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const STORY_KEYS = new Set(["id", "title", "intro", "steps"]);

export type BundleAttachment = AttachmentMeta;

export type ClassicBundleChallenge = {
  id: string;
  title: string;
  category: string;
  description: string;
  points: number;
  order: number;
  flag: string;
  /** Optional, absent meaning false — see `Challenge.caseSensitive`. Optional
   *  rather than required so every bundle exported before #193 still imports,
   *  which is the whole contract of a versioned bundle. */
  caseSensitive?: boolean;
  /** Optional paid-hint text (#190). Absent = no hint. Secret like `flag`:
   *  a bundle is an ORGANIZER artifact and already carries every answer. */
  hint?: string;
  /** v2 (#186): the challenge's files as METADATA only — an upload's name,
   *  size and sha256, or a link. Bytes travel in the event archive; an
   *  import that names an upload the box lacks creates it as "missing". */
  attachments?: BundleAttachment[];
};

export type ClassicBundle = {
  version: number;
  categories: string[];
  challenges: ClassicBundleChallenge[];
  /** v2 (#463): ordered chains of this bundle's challenges. */
  stories?: Story[];
};

export type ImportError = { where: string; message: string };

export type ParseResult = { ok: true; bundle: ClassicBundle } | { ok: false; errors: ImportError[] };

const CHALLENGE_KEYS = [
  "id",
  "title",
  "category",
  "description",
  "points",
  "order",
  "flag",
  "caseSensitive",
  "hint",
  "attachments",
] as const;
const CHALLENGE_KEY_SET = new Set<string>(CHALLENGE_KEYS);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validates and normalizes the top-level `categories` array. Returns the
 *  canonical (trimmed) list to check challenge membership against — entries
 *  that fail their own checks are left out, so a downstream "unknown
 *  category" error on a challenge is possible even when the real problem is
 *  the category entry itself; that cascading is fine under "collect every
 *  error". */
function validateCategories(raw: unknown, errors: ImportError[]): string[] {
  if (!Array.isArray(raw)) {
    errors.push({ where: "categories", message: '"categories" must be an array' });
    return [];
  }
  if (raw.length > CLASSIC_CATEGORIES_MAX) {
    errors.push({ where: "categories", message: `At most ${CLASSIC_CATEGORIES_MAX} categories are allowed` });
  }
  const seen = new Set<string>();
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
    if (trimmed.length > CLASSIC_CATEGORY_MAX_LEN) {
      errors.push({ where, message: `Category name must be at most ${CLASSIC_CATEGORY_MAX_LEN} characters` });
      return;
    }
    const fold = trimmed.toLowerCase();
    if (seen.has(fold)) {
      errors.push({ where, message: `Duplicate category: ${trimmed}` });
      return;
    }
    seen.add(fold);
    out.push(trimmed);
  });
  return out;
}

/** Validates one challenge object against exactly the rules
 *  `upsertChallenge` enforces, plus the bundle-only category-membership rule
 *  (checked against THIS file's own `categories`, never the live store).
 *  Pushes every problem found onto `errors` rather than stopping at the
 *  first — the whole point of a bulk path is one pass over every row. */
function validateChallenge(raw: unknown, index: number, categories: readonly string[], errors: ImportError[]): void {
  const base = `challenges[${index}]`;
  if (!isPlainObject(raw)) {
    errors.push({ where: base, message: "Each challenge must be an object" });
    return;
  }

  const unknownKeys = Object.keys(raw).filter((k) => !CHALLENGE_KEY_SET.has(k));
  if (unknownKeys.length > 0) {
    errors.push({ where: base, message: `Unknown key(s): ${unknownKeys.join(", ")}` });
  }

  const id = raw.id;
  if (typeof id !== "string" || !CLASSIC_ID_RE.test(id)) {
    errors.push({ where: `${base}.id`, message: `Invalid challenge id: ${String(id)}` });
  }

  // Optional, and only a boolean when present. A string "true" is the shape a
  // hand-edited bundle produces, and it would be truthy everywhere downstream
  // — so it is refused here rather than silently making a challenge
  // case-sensitive that its author did not mean to.
  if (raw.caseSensitive !== undefined && typeof raw.caseSensitive !== "boolean") {
    errors.push({ where: `${base}.caseSensitive`, message: "caseSensitive must be true or false" });
  }

  // Optional paid-hint text (#190): a non-empty string within the cap.
  if (raw.hint !== undefined) {
    if (typeof raw.hint !== "string" || !raw.hint.trim() || raw.hint.length > CLASSIC_HINT_MAX) {
      errors.push({
        where: `${base}.hint`,
        message: `hint must be a non-empty string of at most ${CLASSIC_HINT_MAX} characters`,
      });
    }
  }

  const title = raw.title;
  if (typeof title !== "string" || !title.trim()) {
    errors.push({ where: `${base}.title`, message: "Challenge title is required" });
  }

  // Membership is checked against the bundle's OWN categories (already
  // trimmed/deduped by validateCategories), mirroring upsertChallenge's
  // `categories.includes(c.category)` — but against the file, never the
  // live store's list, so a bundle's validity never depends on what the
  // target event already happens to have.
  const category = raw.category;
  if (typeof category !== "string") {
    errors.push({ where: `${base}.category`, message: "Challenge category must be a string" });
  } else if (!categories.includes(category)) {
    errors.push({ where: `${base}.category`, message: `Unknown category: ${category}` });
  }

  const description = raw.description;
  if (typeof description !== "string" || description.length > MARKDOWN_MAX) {
    errors.push({ where: `${base}.description`, message: `Description must be at most ${MARKDOWN_MAX} characters` });
  }

  // Mirrors upsertChallenge's points check verbatim: points get written
  // verbatim into the challenge hash and read back INSIDE SUBMIT_SCRIPT by
  // pattern-matching a plain integer, so a non-integer or out-of-range value
  // here is not cosmetic — see CLASSIC_POINTS_MAX's doc comment.
  const points = raw.points;
  if (typeof points !== "number" || !Number.isInteger(points) || points < 0 || points > CLASSIC_POINTS_MAX) {
    errors.push({
      where: `${base}.points`,
      message: `Challenge points must be an integer in [0, ${CLASSIC_POINTS_MAX}]`,
    });
  }

  const order = raw.order;
  if (typeof order !== "number" || !Number.isInteger(order)) {
    errors.push({ where: `${base}.order`, message: "Challenge order must be an integer" });
  }

  const flag = raw.flag;
  if (typeof flag !== "string" || !flag.trim()) {
    errors.push({ where: `${base}.flag`, message: "Flag is required" });
  }

  if (raw.attachments !== undefined) validateAttachments(raw.attachments, `${base}.attachments`, errors);
}

const UPLOAD_META_KEYS = new Set(["name", "size", "sha256"]);
const LINK_META_KEYS = new Set(["name", "url"]);
const SHA256_RE = /^[0-9a-f]{64}$/;

/** A challenge's attachment metadata (#186): each entry EXACTLY an upload
 *  `{ name, size, sha256 }` or a link `{ name, url }` — never bytes — within
 *  the store's own caps, so an import cannot pass here and fail there. */
function validateAttachments(raw: unknown, where: string, errors: ImportError[]): void {
  if (!Array.isArray(raw)) return void errors.push({ where, message: "attachments must be an array" });
  if (raw.length > ATTACHMENTS_PER_ITEM_MAX) {
    errors.push({ where, message: `At most ${ATTACHMENTS_PER_ITEM_MAX} attachments per challenge` });
  }
  raw.forEach((a, i) => {
    const at = `${where}[${i}]`;
    if (!isPlainObject(a)) return void errors.push({ where: at, message: "An attachment must be an object" });
    const isLink = "url" in a;
    const allowed = isLink ? LINK_META_KEYS : UPLOAD_META_KEYS;
    const unknown = Object.keys(a).filter((k) => !allowed.has(k));
    if (unknown.length > 0) {
      errors.push({ where: at, message: `Unknown key(s): ${unknown.join(", ")} — an attachment is { name, size, sha256 } or { name, url }` });
    }
    if (typeof a.name !== "string" || !a.name.trim() || Array.from(a.name).length > ATTACHMENT_NAME_MAX) {
      errors.push({ where: `${at}.name`, message: `name must be a non-empty string of at most ${ATTACHMENT_NAME_MAX} characters` });
    }
    if (isLink) {
      let ok = false;
      try {
        const u = new URL(String(a.url));
        ok = (u.protocol === "https:" || u.protocol === "http:") && u.href.length <= ATTACHMENT_URL_MAX;
      } catch {
        ok = false;
      }
      if (!ok) errors.push({ where: `${at}.url`, message: "url must be a full http(s) URL" });
      return;
    }
    if (typeof a.size !== "number" || !Number.isInteger(a.size) || a.size < 1 || a.size > ATTACHMENT_MAX_BYTES) {
      errors.push({ where: `${at}.size`, message: `size must be an integer from 1 to ${ATTACHMENT_MAX_BYTES}` });
    }
    if (typeof a.sha256 !== "string" || !SHA256_RE.test(a.sha256)) {
      errors.push({ where: `${at}.sha256`, message: "sha256 must be 64 lowercase hex digits" });
    }
  });
}

/** Cross-row rule with no single-challenge equivalent: a repeated id within
 *  one file is always a mistake (it would silently overwrite the earlier
 *  challenge, inheriting its solves), never something to resolve with
 *  "last one wins". */
function checkDuplicateIds(challenges: readonly unknown[], errors: ImportError[]): void {
  const seen = new Set<string>();
  challenges.forEach((raw, i) => {
    if (!isPlainObject(raw) || typeof raw.id !== "string") return;
    if (seen.has(raw.id)) {
      errors.push({ where: `challenges[${i}].id`, message: `Duplicate challenge id: ${raw.id}` });
      return;
    }
    seen.add(raw.id);
  });
}

/** Parses and validates a bundle document, accumulating EVERY problem found
 *  rather than stopping at the first — an organizer pasting a 40-row file
 *  needs every issue in one pass, not forty round trips.
 *
 *  Validated in order: JSON parse -> top-level shape -> `version` ->
 *  `categories` -> each challenge (unknown keys, then each field) -> cross-row
 *  rules (duplicate ids, category membership). Returns `{ ok: true, bundle }`
 *  only when zero errors were collected across the whole pass. */
export function parseBundle(raw: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Deliberately generic, with NO part of the underlying SyntaxError or the
    // raw input echoed back: V8's own JSON.parse error message embeds a
    // ~10-20 character excerpt of the offending text verbatim (e.g.
    // `Unexpected token 'c', "{"a": ctfbox{Sec"... is not valid JSON`), and on
    // a malformed bundle that excerpt can contain flag text. This response is
    // admin-only (route + body both behind `requireAdmin`, and the pasted
    // text is the admin's own), so no privilege boundary is crossed, but it
    // can still land on a screen-shared admin panel mid-event — and the
    // excerpt can't be safely truncated out after the fact, either: V8 wraps
    // it in quotes without escaping quotes that occur WITHIN the excerpt, so
    // a regex expecting balanced quoting can stop early and still leave part
    // of the secret text in the "trimmed" message. Not echoing anything at
    // all avoids that failure mode entirely.
    return {
      ok: false,
      errors: [{ where: "(document)", message: "Invalid JSON" }],
    };
  }

  if (!isPlainObject(parsed) || !Array.isArray(parsed.challenges)) {
    return {
      ok: false,
      errors: [{ where: "(document)", message: 'Bundle must be an object with a "challenges" array' }],
    };
  }

  const errors: ImportError[] = [];

  if (typeof parsed.version !== "number" || !SUPPORTED_VERSIONS.has(parsed.version)) {
    errors.push({ where: "version", message: `Unsupported bundle version: expected 1 or ${CLASSIC_BUNDLE_VERSION}` });
  }

  const categories = validateCategories(parsed.categories, errors);

  const rawChallenges = parsed.challenges;
  rawChallenges.forEach((c, i) => validateChallenge(c, i, categories, errors));
  checkDuplicateIds(rawChallenges, errors);

  // v2 (#186): attachments, like stories, need the version that knows them.
  if (parsed.version === 1) {
    rawChallenges.forEach((c, i) => {
      if (isPlainObject(c) && c.attachments !== undefined) {
        errors.push({ where: `challenges[${i}].attachments`, message: `"attachments" needs bundle version ${CLASSIC_BUNDLE_VERSION}` });
      }
    });
  }

  // v2 (#463): stories. On a v1 bundle the key is an error, not ignored — an
  // older box ignoring it would serve every step unlocked, which is exactly
  // why the version bumped.
  let stories: Story[] | undefined;
  if (parsed.stories !== undefined) {
    if (parsed.version === 1) {
      errors.push({ where: "stories", message: `"stories" needs bundle version ${CLASSIC_BUNDLE_VERSION}` });
    } else {
      const ids = new Set(
        rawChallenges.map((c) => (isPlainObject(c) && typeof c.id === "string" ? c.id : null)).filter((v): v is string => v !== null),
      );
      stories = validateStories(parsed.stories, ids, errors);
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  // Every challenge passed validation above (errors.length === 0), so this
  // cast is sound: each entry has exactly the required keys and types.
  const challenges = rawChallenges as ClassicBundleChallenge[];
  return {
    ok: true,
    bundle: { version: parsed.version as number, categories, challenges, ...(stories ? { stories } : {}) },
  };
}

/** Validates a v2 bundle's stories, collecting every problem: each story's
 *  shape, every step naming a challenge IN THIS BUNDLE (a bundle is
 *  self-contained), no challenge in two stories or twice in one, and unique
 *  story ids. */
function validateStories(raw: unknown, challengeIds: ReadonlySet<string>, errors: ImportError[]): Story[] {
  if (!Array.isArray(raw)) {
    errors.push({ where: "stories", message: '"stories" must be an array' });
    return [];
  }
  if (raw.length > CLASSIC_STORIES_MAX) {
    errors.push({ where: "stories", message: `At most ${CLASSIC_STORIES_MAX} stories are allowed` });
  }
  const out: Story[] = [];
  const storyIds = new Set<string>();
  const owner = new Map<string, string>();
  raw.forEach((st, i) => {
    const base = `stories[${i}]`;
    if (!isPlainObject(st)) {
      errors.push({ where: base, message: "A story must be an object" });
      return;
    }
    const unknown = Object.keys(st).filter((k) => !STORY_KEYS.has(k));
    if (unknown.length > 0) errors.push({ where: base, message: `Unknown key(s): ${unknown.join(", ")}` });
    const id = typeof st.id === "string" ? st.id : "";
    if (!STORY_ID_RE.test(id)) errors.push({ where: `${base}.id`, message: `Invalid story id: ${JSON.stringify(st.id)}` });
    else if (storyIds.has(id)) errors.push({ where: `${base}.id`, message: `Story ids must be unique: ${id}` });
    storyIds.add(id);
    // The caps are setStories' own (trimmed, like it measures): refusing here
    // is what keeps an event import from clearing the box and then failing.
    if (typeof st.title !== "string" || !st.title.trim()) errors.push({ where: `${base}.title`, message: "A story needs a title" });
    else if (st.title.trim().length > CLASSIC_STORY_TITLE_MAX) {
      errors.push({ where: `${base}.title`, message: `A story title must be at most ${CLASSIC_STORY_TITLE_MAX} characters` });
    }
    if (st.intro !== undefined && typeof st.intro !== "string") errors.push({ where: `${base}.intro`, message: "intro must be a string" });
    else if (typeof st.intro === "string" && st.intro.trim().length > CLASSIC_STORY_INTRO_MAX) {
      errors.push({ where: `${base}.intro`, message: `A story intro must be at most ${CLASSIC_STORY_INTRO_MAX} characters` });
    }
    if (!Array.isArray(st.steps)) {
      errors.push({ where: `${base}.steps`, message: "steps must be an array of challenge ids" });
      return;
    }
    if (st.steps.length > CLASSIC_STORY_STEPS_MAX) {
      errors.push({ where: `${base}.steps`, message: `A story must have at most ${CLASSIC_STORY_STEPS_MAX} steps` });
    }
    const seen = new Set<string>();
    st.steps.forEach((step, j) => {
      const where = `${base}.steps[${j}]`;
      if (typeof step !== "string") return void errors.push({ where, message: "A step must be a challenge id" });
      if (!challengeIds.has(step)) return void errors.push({ where, message: `Unknown challenge in this bundle: ${step}` });
      if (seen.has(step)) return void errors.push({ where, message: `${step} is listed twice in this story` });
      seen.add(step);
      const prior = owner.get(step);
      if (prior !== undefined && prior !== id) errors.push({ where, message: `${step} is in two stories — a challenge belongs to one story` });
      owner.set(step, id);
    });
    out.push({ id, title: typeof st.title === "string" ? st.title : "", intro: typeof st.intro === "string" ? st.intro : "", steps: st.steps.filter((s): s is string => typeof s === "string") });
  });
  return out;
}

/** Indented, not minified — an organizer edits this file by hand. Ends in a
 *  trailing newline, like every other text file in the repo. */
export function serializeBundle(bundle: ClassicBundle): string {
  return JSON.stringify(bundle, null, 2) + "\n";
}
