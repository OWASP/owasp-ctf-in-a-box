import "server-only";
import { storyPositions, type Story } from "@/lib/story-lock";
import { teamSolveKeys } from "@/lib/classic-team";
import {
  addLink,
  addMissingUpload,
  clearAllAttachments,
  deleteItemAttachments,
  listAllAttachments,
  listAttachments,
} from "@/lib/attachments-store";
import { ATTACHMENTS_PER_ITEM_MAX, type Attachment, attachmentMeta, sanitizeFilename } from "@/lib/attachments-keys";
import type { BundleAttachment } from "@/lib/classic-io";
// Re-exported, not redeclared — the admin UI cannot import a server-only
// module, so the value lives in the dependency-free defaults file.
export { CLASSIC_COOLDOWN_SEC } from "./classic-defaults";
import { CLASSIC_COOLDOWN_SEC } from "./classic-defaults";
import { effectivePaused, getAdminSettings } from "@/lib/admin-store";
import { errorLabel } from "@/lib/error-label";
import { readLastAt } from "@/lib/last-at";
import { CLASSIC_BUNDLE_VERSION, type ClassicBundle, type ClassicBundleChallenge } from "@/lib/classic-io";
import { foldTeamItems } from "@/lib/leaderboard/team-fold";
import { MARKDOWN_MAX } from "@/lib/markdown";
import { upstashEval, upstashPipeline } from "@/lib/upstash";
import { ATTEMPT_ROW_LUA, parseCounterHash, parseHashEntries, parseJsonValue } from "@/lib/redis-decode";
import {
  CLASSIC_CHALLENGES_KEY as CHALLENGES_KEY,
  CLASSIC_HINTS_KEY as HINTS_KEY,
  CLASSIC_HINT_MAX,
  CLASSIC_FLAG_KEY as FLAG_KEY,
  CLASSIC_FLAGNORM_KEY as FLAGNORM_KEY,
  CLASSIC_CATEGORIES_KEY as CATEGORIES_KEY,
  CLASSIC_STORIES_KEY,
  CLASSIC_STORIES_MAX,
  CLASSIC_STORY_INTRO_MAX,
  CLASSIC_STORY_STEPS_MAX,
  CLASSIC_STORY_TITLE_MAX,
  CLASSIC_POINTS_KEY as POINTS_KEY,
  CLASSIC_SOLVED_KEY as SOLVED_KEY,
  CLASSIC_LAST_AT_KEY as LAST_AT_KEY,
  CLASSIC_SOLVECOUNT_KEY as SOLVECOUNT_KEY,
  classicSolvesKey as solvesKey,
  classicAttemptsKey as attemptsKey,
  normalizeFlag,
  caseSensitiveFlagForm,
  flagComparisonForm,
  CLASSIC_ID_RE,
  CLASSIC_POINTS_MAX,
  CLASSIC_CATEGORY_MAX_LEN,
  CLASSIC_CATEGORIES_MAX,
} from "@/lib/classic-keys";

/**
 * The classic (jeopardy-style flag) module. This file is the only place that
 * touches `ctf:classic:*` Redis keys during normal contestant and authoring
 * activity — submitting, grading, and challenge authoring/deletion all go
 * through it, and nothing else should read or write these keys for those
 * flows. The same deliberate exception quiz-store.ts documents applies here:
 * admin-store.ts's bulk-maintenance paths (demo seed, master reset) reuse the
 * key names from classic-keys.ts directly rather than going through these
 * functions.
 *
 * Key layout:
 *   ctf:classic:challenges       hash, id -> JSON Challenge (public-safe; this
 *                                 is what contestants see)
 *   ctf:classic:flag             hash, id -> the flag AS AUTHORED, trimmed
 *                                 (SECRET from contestants). Written for the
 *                                 admin edit form ALONE and read by exactly
 *                                 one function, `listChallengesForAdmin`. The
 *                                 grading script never reads it — see below.
 *   ctf:classic:flagnorm         hash, id -> `normalizeFlag(flag)` (SECRET).
 *                                 The ONLY value grading ever compares
 *                                 against.
 *   ctf:classic:categories       string, JSON array of category names in the
 *                                 organizer's chosen display order.
 *   ctf:classic:solves:<login>   hash, id -> JSON {points, at} — records ONLY
 *                                 solves. Points are captured at solve time,
 *                                 so a later re-pricing of a challenge never
 *                                 rewrites history.
 *   ctf:classic:attempts:<login> hash, id -> JSON {attempts, firstAt, lastAt, lastAtMs}
 *        firstAt is the FIRST submission's time and is carried forward across
 *        rewrites; absent on rows written before it existed (issue #169).
 *                                 — every submission, right or wrong; the
 *                                 cooldown reads this. `lastAtMs` (a plain
 *                                 epoch-ms mirror of `lastAt`) exists only so
 *                                 SUBMIT_SCRIPT can do cooldown arithmetic in
 *                                 Lua without parsing an ISO-8601 string;
 *                                 readers outside this file should use `lastAt`.
 *   ctf:classic:points           hash, login -> running points total
 *   ctf:classic:solved           hash, login -> running solve count
 *   ctf:classic:lastAt           hash, login -> ISO time of the latest award
 *                                 (#522), the leaderboard's tiebreak
 *   ctf:classic:solvecount       hash, challenge id -> DISTINCT solver count
 *
 * TWO flag hashes, on purpose. `flagnorm` is what grading compares; `flag` is
 * what an organizer sees when editing. They are written together in one
 * pipeline so they cannot observably disagree, and only `flagnorm` is ever
 * handed to Redis's scripting path.
 *
 * Normalization (`normalizeFlag`, in classic-keys.ts) happens in JS on BOTH
 * paths — authoring and submission — and NEVER in Lua. Lua's `string.lower` is
 * ASCII-only, so a Lua-side normalization of any non-ASCII flag would disagree
 * with the authoring side and produce a challenge nobody can solve.
 *
 * Secrecy boundary — a CONTESTANT boundary, not an absolute one, mirroring
 * `ctf:quiz:key`. Two readers, deliberately kept apart:
 *
 *   - `listChallenges` (the CONTESTANT path — `/flags`, the leaderboard
 *     overlay) never issues a command against `ctf:classic:flag` OR
 *     `ctf:classic:flagnorm`, and the `Challenge` type it returns has no field
 *     that could carry a flag. That property is absolute and must stay that
 *     way.
 *   - `listChallengesForAdmin` (the ADMIN path — `GET /api/admin/classic`,
 *     behind `requireAdmin`) DOES read `ctf:classic:flag`, and returns it in a
 *     separate `AdminChallenge` shape that is deliberately not assignable to
 *     `Challenge` (see its doc comment). Withholding the flag from an
 *     organizer editing the challenge buys nothing — anyone through that gate
 *     can already rewrite or delete it — while costing real correctness: an
 *     edit form that starts with an empty flag box turns every typo fix into a
 *     chance to silently redefine what counts as solved.
 *
 * Grading (which reads `ctf:classic:flagnorm`) is likewise server-only and is
 * never exposed by a route that echoes its input back to the caller.
 *
 * Callers (the /api/classic route handlers) are responsible for authenticating
 * the session and deriving `login` server-side — nothing here trusts
 * client-supplied identity.
 */

// Key names/builders live in ./classic-keys (a dependency-free module) rather
// than as local consts here — see classic-keys.ts's header comment for why.
// POINTS_KEY/SOLVED_KEY/SOLVECOUNT_KEY are running totals, updated atomically
// by SUBMIT_SCRIPT alongside the per-login solve row, so a leaderboard overlay
// costs one HGETALL each regardless of board size.

/** Default seconds a login must wait between submissions on the SAME
 *  challenge. Seconds, not minutes: the job is blocking scripted brute force,
 *  not rationing tries. 0 (an admin override) means no cooldown. */


/** Challenge id pattern, re-exported so callers (e.g. the submit route)
 *  validate against this exact pattern instead of keeping their own copy that
 *  could silently desync. It is DEFINED in classic-keys.ts because the admin
 *  panel's id generator runs in the browser and must check its output against
 *  the same object this `server-only` file validates with. `CLASSIC_POINTS_MAX`,
 *  `CLASSIC_CATEGORY_MAX_LEN` and `CLASSIC_CATEGORIES_MAX` are re-exported for
 *  the same reason: classic-io.ts (the bulk import/export parser) is also
 *  client-safe and needs these bounds to validate a pasted bundle without
 *  importing this `server-only` file. */
export { CLASSIC_ID_RE, CLASSIC_POINTS_MAX, CLASSIC_CATEGORY_MAX_LEN, CLASSIC_CATEGORIES_MAX };

/** Thrown by the authoring functions for genuine input-validation failures
 *  (bad id, unknown category, non-integer points, empty flag) — mirroring
 *  `QuizValidationError`. Callers (the admin route) can distinguish this from
 *  a plain `Error`, which these functions still throw for a genuine
 *  Upstash/infra failure, so a caller-facing status code can tell "your
 *  payload was bad" apart from "the store failed". */
export class ClassicValidationError extends Error {
  field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "ClassicValidationError";
    this.field = field;
  }
}

/** Public-safe challenge shape. Never carries a flag, in either form. */
export type Challenge = {
  id: string;
  title: string;
  category: string;
  description: string;
  points: number;
  order: number;
  /** Compare this challenge's flag with case intact (issue #193). Absent means
   *  false — the forgiving default every existing challenge already has.
   *
   *  PUBLIC on purpose, unlike the flag itself. The board has to tell a
   *  contestant that case matters, or someone submits the right characters,
   *  gets "Not quite", and has no way to work out why. Knowing that case
   *  matters gives away nothing about the answer.
   *
   *  It is also what SUBMIT_SCRIPT reads to pick which form of the submission
   *  to compare — see that script's comment. */
  caseSensitive?: boolean;
};

/** One challenge as the ADMIN-GATED surface sees it: the public-safe record
 *  and its flag, side by side but in two SEPARATE fields.
 *
 *  The nesting is the point, not an accident of style. The obvious shape —
 *  `Challenge & { flag: string }` — is structurally still a `Challenge`, so
 *  handing an admin record to a contestant-facing component (`<ChallengeBoard
 *  challenges={rows} />`) would type-check and quietly ship every flag to
 *  every visitor. This shape is NOT assignable to `Challenge`, so that mistake
 *  is a compile error; reaching the public half takes an explicit
 *  `.challenge`, which is a thing you write on purpose rather than a thing you
 *  forget. */
export type AdminChallenge = {
  /** Byte-for-byte what `listChallenges` would have returned for this id. */
  challenge: Challenge;
  /** Paid-hint text as authored (trimmed), or null when the challenge has no
   *  hint. ADMIN SURFACES ONLY — contestants buy it through hint-store. */
  hint: string | null;
  /** The flag AS AUTHORED (trimmed), exactly as `ctf:classic:flag` stores it.
   *  Empty only if the flag row is missing — a challenge in that state can
   *  never be solved, which is worth seeing in the edit form rather than
   *  hiding. */
  flag: string;
};

function parseChallenge(raw: string): Challenge | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const c = parsed as Record<string, unknown>;
    if (typeof c.id !== "string") return null;
    if (typeof c.title !== "string") return null;
    if (typeof c.category !== "string") return null;
    if (typeof c.description !== "string") return null;
    if (typeof c.points !== "number") return null;
    if (typeof c.order !== "number") return null;
    return {
      id: c.id,
      title: c.title,
      category: c.category,
      description: c.description,
      points: c.points,
      order: c.order,
      // Carried back only when stored true, mirroring how it is written — an
      // absent field must stay absent, not become `false`, so a record that
      // predates #193 parses to exactly what it did before.
      //
      // This field is easy to leave out here and hard to notice missing:
      // grading reads the stored JSON in Lua and never sees this object, so
      // dropping it grades correctly while the board stops badging the
      // challenge, the edit form unchecks its box, and `exportBundle` writes a
      // backup that restores as case-INsensitive.
      ...(c.caseSensitive === true ? { caseSensitive: true as const } : {}),
    };
  } catch {
    return null;
  }
}

/** The board's reading order: cheapest first (points ascending), then the
 *  organizer's explicit `order`, then id as a stable tiebreak so two equal
 *  challenges never swap places between two renders of the same data. */
function compareChallenges(a: Challenge, b: Challenge): number {
  return a.points - b.points || a.order - b.order || a.id.localeCompare(b.id);
}

function parseChallengeHash(flat: unknown): Challenge[] {
  const arr = Array.isArray(flat) ? (flat as string[]) : [];
  const out: Challenge[] = [];
  for (let i = 0; i < arr.length; i += 2) {
    const parsed = parseChallenge(arr[i + 1]);
    if (parsed) out.push(parsed);
  }
  return out;
}

/** All challenges, in board order. Flags excluded — this issues a single
 *  HGETALL against the public-safe hash only, and the `Challenge` shape it
 *  returns has nowhere to put a flag even if it did. This is the ONLY list
 *  function a contestant-facing route (or the leaderboard) may call. */
export async function listChallenges(): Promise<Challenge[]> {
  const [res] = await upstashPipeline([["HGETALL", CHALLENGES_KEY]]);
  const challenges = parseChallengeHash(res.result);
  challenges.sort(compareChallenges);
  return challenges;
}

/** The same list, WITH each challenge's flag — for the admin-gated authoring
 *  surface ONLY (`GET /api/admin/classic`, behind `requireAdmin`).
 *
 *  Named so a call site reads as a decision rather than a default: any route
 *  reaching for this one is asserting it has already established the caller is
 *  an organizer. Contestant-facing code calls `listChallenges` instead, and
 *  the `AdminChallenge` return shape (not assignable to `Challenge`) is what
 *  stops the two from being mixed up by accident.
 *
 *  Reads the flag AS AUTHORED (`ctf:classic:flag`), never the normalized form:
 *  an edit form must show the organizer what they typed, casing included.
 *  Both hashes are read in ONE pipeline, so the challenges and their flags
 *  come from the same instant. */
export async function listChallengesForAdmin(): Promise<AdminChallenge[]> {
  const [challengesRes, flagRes, hintRes] = await upstashPipeline([
    ["HGETALL", CHALLENGES_KEY],
    ["HGETALL", FLAG_KEY],
    ["HGETALL", HINTS_KEY],
  ]);

  const flagFlat = Array.isArray(flagRes.result) ? (flagRes.result as string[]) : [];
  const flagById = new Map<string, string>();
  for (let i = 0; i < flagFlat.length; i += 2) {
    if (typeof flagFlat[i + 1] === "string") flagById.set(flagFlat[i], flagFlat[i + 1]);
  }
  const hintFlat = Array.isArray(hintRes.result) ? (hintRes.result as string[]) : [];
  const hintById = new Map<string, string>();
  for (let i = 0; i < hintFlat.length; i += 2) {
    if (typeof hintFlat[i + 1] === "string") hintById.set(hintFlat[i], hintFlat[i + 1]);
  }

  const rows = parseChallengeHash(challengesRes.result).map((challenge) => ({
    challenge,
    flag: flagById.get(challenge.id) ?? "",
    hint: hintById.get(challenge.id) ?? null,
  }));
  rows.sort((a, b) => compareChallenges(a.challenge, b.challenge));
  return rows;
}

/** The organizer's category list, in the display order they chose. Stored as
 *  one JSON array in a single string key rather than a Redis set: order is
 *  content here (it is the order the board renders headings in), and a set has
 *  none. An absent or unparseable value reads as an empty list — a board with
 *  no categories yet, not an error. */
export async function listCategories(): Promise<string[]> {
  const [res] = await upstashPipeline([["GET", CATEGORIES_KEY]]);
  if (typeof res.result !== "string") return [];
  try {
    const parsed = JSON.parse(res.result) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

/** Replaces the whole category list. Returns what was actually STORED — the
 *  trimmed, deduped list — so the authoring client holds the canonical value a
 *  later `listCategories` would hand it.
 *
 *  Dedupe is case-INSENSITIVE (keeping the first spelling): "Web" and "web"
 *  rendering as two headings side by side is never what an organizer meant,
 *  and `upsertChallenge` matches a challenge's category against this list
 *  exactly, so two casings would also split challenges across them. */
export async function setCategories(names: string[]): Promise<string[]> {
  if (!Array.isArray(names)) throw new ClassicValidationError("categories", "categories must be an array");
  if (names.length > CLASSIC_CATEGORIES_MAX) {
    throw new ClassicValidationError("categories", `At most ${CLASSIC_CATEGORIES_MAX} categories are allowed`);
  }
  const seen = new Set<string>();
  const canonical: string[] = [];
  for (const name of names) {
    if (typeof name !== "string") throw new ClassicValidationError("categories", "Each category must be a string");
    const trimmed = name.trim();
    if (!trimmed) throw new ClassicValidationError("categories", "A category name cannot be empty");
    if (trimmed.length > CLASSIC_CATEGORY_MAX_LEN) {
      throw new ClassicValidationError(
        "categories",
        `A category name must be at most ${CLASSIC_CATEGORY_MAX_LEN} characters`,
      );
    }
    const fold = trimmed.toLowerCase();
    if (seen.has(fold)) continue;
    seen.add(fold);
    canonical.push(trimmed);
  }

  const [res] = await upstashPipeline([["SET", CATEGORIES_KEY, JSON.stringify(canonical)]]);
  if (res.error) throw new Error(`Upstash SET failed: ${res.error}`);
  return canonical;
}

/** What a rename did: the stored list afterwards, and how many challenges
 *  were carried across. */
export type CategoryRename = { categories: string[]; moved: number };

/**
 * Renames one category and carries every challenge in it across (#304).
 *
 * `setCategories` cannot express this. It replaces the whole array, so a
 * renamed entry is indistinguishable from "one removed, one added" — which is
 * exactly how the association with the challenges was lost, and why
 * `removeCategory` has to refuse while any challenge still uses a name. A typo
 * in a category ten challenges already carry meant editing all ten.
 *
 * ORDER OF WRITES, deliberately: the challenges move FIRST, the list is
 * rewritten LAST. Neither half is atomic (an Upstash pipeline is batched, not
 * transactional), so what matters is which partial state a retry can finish
 * from:
 *
 *   - Challenges first — a failure before the list write leaves the list still
 *     naming `from` with some challenges already on `to`. Re-running the SAME
 *     rename finds `from` present, moves whatever is left (re-moving an
 *     already-moved challenge is a no-op) and completes. **Idempotent.**
 *   - List first — a failure would leave the list naming `to` while challenges
 *     still say `from`, and a retry of the same rename would refuse, because
 *     `from` is no longer there to rename. The organizer would have to work
 *     out the inverse rename themselves.
 *
 * Either partial state still RENDERS: `bucketRows` (components/admin) appends
 * a group the category list does not name rather than dropping its rows, so no
 * challenge goes invisible while a rename is half applied.
 *
 * Refuses rather than merges when `to` already exists, case-insensitively —
 * the same fold `setCategories` dedupes on. Merging two categories is a
 * different and lossier operation; it should be asked for explicitly, not
 * arrived at by typing an existing name into a rename box. Changing only the
 * spelling of the SAME entry ("web" -> "Web") is a rename, not a collision.
 */
export async function renameCategory(from: string, to: string): Promise<CategoryRename> {
  const target = to.trim();
  if (!target) throw new ClassicValidationError("categories", "A category name cannot be empty");
  if (target.length > CLASSIC_CATEGORY_MAX_LEN) {
    throw new ClassicValidationError(
      "categories",
      `A category name must be at most ${CLASSIC_CATEGORY_MAX_LEN} characters`,
    );
  }

  const categories = await listCategories();
  const fromFold = from.trim().toLowerCase();
  const targetFold = target.toLowerCase();
  const index = categories.findIndex((name) => name.toLowerCase() === fromFold);
  if (index === -1) throw new ClassicValidationError("categories", `No category named "${from}"`);
  const collides = categories.some((name, i) => i !== index && name.toLowerCase() === targetFold);
  if (collides) {
    throw new ClassicValidationError(
      "categories",
      `"${target}" already exists. Rename it to something else, or move these challenges one at a time.`,
    );
  }

  const stored = categories[index];

  // Read the challenges HERE rather than through `listChallenges`, and check
  // the reply's error. `listChallenges` reads `.result` without checking
  // `.error` (AGENTS.md: `upstashPipeline` reports a per-command failure as a
  // VALUE), so a failed HGETALL comes back as an empty list — indistinguishable
  // from "no challenge uses this category". Renaming on top of that would
  // rewrite the list while moving nothing, orphaning every challenge in the
  // category onto a name that no longer exists AND leaving a retry unable to
  // find the source. Fail closed instead.
  const [challengesRes] = await upstashPipeline([["HGETALL", CHALLENGES_KEY]]);
  if (challengesRes.error) throw new Error(`Upstash HGETALL failed: ${challengesRes.error}`);
  const moving = parseChallengeHash(challengesRes.result).filter((c) => c.category === stored);

  if (moving.length > 0) {
    const writes = await upstashPipeline(
      moving.map((c) => ["HSET", CHALLENGES_KEY, c.id, JSON.stringify({ ...c, category: target })]),
    );
    // `upstashPipeline` reports a per-command failure as a VALUE rather than
    // throwing (AGENTS.md), so an unchecked `.result` would let a partial move
    // report as a complete one — and the list would then be rewritten on top
    // of it, landing in the exact state the write order exists to avoid.
    const failed = writes.find((w) => w.error);
    if (failed) throw new Error(`Upstash HSET failed: ${failed.error}`);
  }

  const next = [...categories];
  next[index] = target;
  const [res] = await upstashPipeline([["SET", CATEGORIES_KEY, JSON.stringify(next)]]);
  if (res.error) throw new Error(`Upstash SET failed: ${res.error}`);

  return { categories: next, moved: moving.length };
}

/** Creates or replaces a challenge and its flag. Writes the challenge (no
 *  flag), the flag as authored, and the normalized flag in ONE pipeline call
 *  so the three hashes never observably disagree — in particular so a
 *  challenge can never be live with a `flagnorm` belonging to a previous
 *  version of its flag.
 *
 *  The flag is stored TRIMMED but otherwise verbatim: trailing whitespace in a
 *  flag is invisible in an edit form and would otherwise round-trip into the
 *  organizer's next save. Casing and everything else are preserved, because
 *  the authored copy exists to be read by a human; `normalizeFlag` owns what
 *  grading actually compares.
 *
 *  Returns what was STORED, as an `AdminChallenge`. Contestant-facing code
 *  never sees this value. */
export async function upsertChallenge(c: Challenge, flag: string, hint?: string | null): Promise<AdminChallenge> {
  if (!CLASSIC_ID_RE.test(c.id)) throw new ClassicValidationError("id", `Invalid challenge id: ${c.id}`);
  if (typeof c.title !== "string" || !c.title.trim()) {
    throw new ClassicValidationError("title", "Challenge title is required");
  }
  // The category must already exist. A challenge filed under a category the
  // board does not render is a challenge no contestant can find.
  const categories = await listCategories();
  if (!categories.includes(c.category)) {
    throw new ClassicValidationError("category", `Unknown category: ${c.category}`);
  }
  if (typeof c.description !== "string" || c.description.length > MARKDOWN_MAX) {
    throw new ClassicValidationError("description", `Description must be at most ${MARKDOWN_MAX} characters`);
  }
  // Points get written verbatim into the challenge hash and read back INSIDE
  // SUBMIT_SCRIPT by pattern-matching a plain integer (see SUBMIT_SCRIPT's
  // comment) — a non-integer here would either fail to match (silently
  // awarding 0) or corrupt HINCRBY mid-script after the attempt bump and solve
  // row had already been written, with no way to roll back.
  if (!Number.isInteger(c.points) || c.points < 0 || c.points > CLASSIC_POINTS_MAX) {
    throw new ClassicValidationError("points", `Challenge points must be an integer in [0, ${CLASSIC_POINTS_MAX}]`);
  }
  if (typeof flag !== "string" || !flag.trim()) {
    throw new ClassicValidationError("flag", "Flag is required");
  }
  if (hint != null && (typeof hint !== "string" || hint.length > CLASSIC_HINT_MAX)) {
    throw new ClassicValidationError("hint", `Hint must be at most ${CLASSIC_HINT_MAX} characters`);
  }

  const authored = flag.trim();
  // The hint is written (or CLEARED — an empty/absent hint deletes the row)
  // in the same pipeline as the challenge, into its own SECRET hash: the
  // public record must never carry it, same storage rule as the flag pair.
  const authoredHint = typeof hint === "string" && hint.trim() ? hint.trim() : null;
  const results = await upstashPipeline([
    ["HSET", CHALLENGES_KEY, c.id, JSON.stringify(c)],
    ["HSET", FLAG_KEY, c.id, authored],
    ["HSET", FLAGNORM_KEY, c.id, flagComparisonForm(flag, c.caseSensitive)],
    authoredHint ? ["HSET", HINTS_KEY, c.id, authoredHint] : ["HDEL", HINTS_KEY, c.id],
  ]);
  const failed = results.find((r) => r.error);
  if (failed) throw new Error(`Upstash HSET failed: ${failed.error}`);

  return { challenge: c, flag: authored, hint: authoredHint };
}

/** Result of a bulk import: how many bundle rows were brand new vs. already
 *  on the board, and how many categories the bundle itself carried (its own
 *  scope, not the post-union total — an organizer reading this back wants to
 *  know what THEY just submitted). */
/** `stories` is present only for a bundle that carried them (v2): the count
 *  of stories the bundle upserted, not the size of the merged list. */
export type ImportSummary = { created: number; updated: number; categories: number; stories?: number };

type AttachmentAddition = { itemId: string; meta: BundleAttachment };

/** What an import adds (#186): a link the challenge lacks (same name and
 *  URL = already there), an upload whose sha256 it lacks (created as
 *  "missing" until its bytes arrive — from the event archive, or a
 *  re-upload). THROWS `ClassicValidationError` when the challenge's stored
 *  files plus the additions pass the per-challenge cap. */
async function planBundleAttachments(bundle: ClassicBundle): Promise<AttachmentAddition[]> {
  const plan: AttachmentAddition[] = [];
  for (const c of bundle.challenges) {
    if (!c.attachments?.length) continue;
    const existing = await listAttachments("classic", c.id);
    // Compared in the form the store keeps (URL href, sanitized name) — a
    // hand-written bundle's raw spelling would otherwise never match what its
    // own last import stored, and every re-import would add the link again.
    const has = (m: BundleAttachment) =>
      existing.some((e: Attachment) =>
        "url" in m
          ? e.kind === "link" && e.url === normalizedUrl(m.url) && e.name === sanitizeFilename(m.name)
          : e.kind === "upload" && e.sha256 === m.sha256,
      );
    const adds = c.attachments.filter((m) => !has(m));
    if (existing.length + adds.length > ATTACHMENTS_PER_ITEM_MAX) {
      throw new ClassicValidationError(
        "attachments",
        `At most ${ATTACHMENTS_PER_ITEM_MAX} attachments per challenge — ${c.id} has ${existing.length} and the bundle adds ${adds.length}`,
      );
    }
    for (const meta of adds) plan.push({ itemId: c.id, meta });
  }
  return plan;
}

function normalizedUrl(raw: string): string {
  try {
    return new URL(raw.trim()).href;
  } catch {
    return raw;
  }
}

async function applyBundleAttachments(plan: readonly AttachmentAddition[]): Promise<void> {
  for (const { itemId, meta } of plan) {
    if ("url" in meta) await addLink("classic", itemId, meta.name, meta.url);
    else await addMissingUpload("classic", itemId, meta.name, meta.size, meta.sha256);
  }
}

/** Applies a PRE-VALIDATED bundle (produced by `classic-io.ts`'s
 *  `parseBundle`) to the store: upserts every challenge it contains and
 *  unions its categories into the existing list.
 *
 *  `importBundle` re-validates NOTHING — its whole contract is that the
 *  caller already ran the bundle through `parseBundle`. Validation lives in
 *  exactly one place so the single-challenge admin form and this bulk path
 *  can never quietly grow different rules; a caller that skips `parseBundle`
 *  before calling this is the one at fault, not something this function
 *  guards against.
 *
 *  UPSERT BY ID, NEVER DELETE. A challenge already in the store but absent
 *  from this bundle is left completely untouched — there is no HDEL
 *  anywhere on this path. That is the whole reason import is safe to run
 *  against a live board: an organizer can import a partial file (this
 *  week's new challenges, say) without erasing anything else already
 *  authored. Existing ids are read FIRST (one HKEYS) so `created`/`updated`
 *  reflect what was already on the board before this call, not what ends up
 *  there after.
 *
 *  Categories are UNIONED, never replaced: the existing order is preserved
 *  and any category new to the store is appended in the bundle's own order
 *  (case-insensitive membership check, mirroring `setCategories`). Replacing
 *  the list outright would silently drop or reorder categories belonging to
 *  challenges this bundle never mentions — part of the board the organizer
 *  wasn't touching.
 *
 *  All challenge/flag/flagnorm writes plus the categories write happen in
 *  ONE `upstashPipeline` call — the same discipline `upsertChallenge` follows
 *  for a single row — so those hashes (and the category list) can never
 *  observably disagree partway through a bulk import. The membership reads
 *  that decide created/updated and the union happen in their OWN earlier
 *  pipeline call, exactly like `upsertChallenge` reads `listCategories()`
 *  before its own write. */
export async function importBundle(bundle: ClassicBundle): Promise<ImportSummary> {
  // A v2 bundle's stories merge into the stored list, so that list is read
  // with the rest; a v1 bundle (no `stories`) never touches it (#463).
  const [idsRes, categoriesRes, storiesRes] = await upstashPipeline([
    ["HKEYS", CHALLENGES_KEY],
    ["GET", CATEGORIES_KEY],
    ...(bundle.stories ? [["GET", CLASSIC_STORIES_KEY]] : []),
  ]);

  // Both reads must have succeeded before anything is written. A failed GET
  // would otherwise read as "no categories yet", and the SET at the end of the
  // write pipeline would replace the box's whole category list with only the
  // bundle's — and re-spell every stored challenge's category to the bundle's
  // casing, hiding them from the board's exact-match filter. A failed HKEYS
  // would report every row `created`. Same guard as ai-store's (#260, #261).
  const failedRead = [idsRes, categoriesRes, storiesRes].find((r) => r?.error);
  if (failedRead) throw new Error(`Upstash read failed before import: ${failedRead.error}`);

  // Upsert by id, like the challenges: a bundle story replaces the stored one
  // with its id in place, a new one is appended, and a stored story the bundle
  // does not mention is kept. The MERGED list is validated here, before any
  // write — a challenge that lands in two stories refuses the whole import,
  // never half of it. A corrupt stored value throws too (parseStoredStories),
  // rather than being overwritten by the bundle's.
  let mergedStories: Story[] | null = null;
  if (bundle.stories) {
    const merged = parseStoredStories(storiesRes?.result);
    for (const st of bundle.stories) {
      const at = merged.findIndex((m) => m.id === st.id);
      if (at >= 0) merged[at] = st;
      else merged.push(st);
    }
    mergedStories = canonicalStories(merged);
  }

  const existingIds = new Set(Array.isArray(idsRes.result) ? (idsRes.result as string[]) : []);

  let existingCategories: string[] = [];
  if (typeof categoriesRes.result === "string") {
    try {
      const parsed = JSON.parse(categoriesRes.result) as unknown;
      if (Array.isArray(parsed)) existingCategories = parsed.filter((v): v is string => typeof v === "string");
    } catch {
      existingCategories = [];
    }
  }

  // Union: keep the existing list's order verbatim, then append anything
  // from the bundle not already present (case-insensitive), in the bundle's
  // own order.
  const unioned = [...existingCategories];
  const seen = new Set(existingCategories.map((name) => name.toLowerCase()));
  for (const name of bundle.categories) {
    const fold = name.toLowerCase();
    if (seen.has(fold)) continue;
    seen.add(fold);
    unioned.push(name);
  }

  // Maps each surviving spelling's fold back to itself, so every stored
  // challenge's category can be canonicalized to whichever spelling the
  // union above kept. Without this, a bundle spelling a category
  // differently from the store ("web" vs. the store's "Web") would write
  // its challenges under a spelling absent from `unioned` — invisible to
  // challenge-board.tsx's exact-equality filter and to upsertChallenge's exact
  // `.includes` check, despite the import reporting success. This is the
  // invariant the rest of the module assumes: every challenge's `category`
  // is present in the stored category list.
  const canon = new Map(unioned.map((name) => [name.toLowerCase(), name]));

  let created = 0;
  let updated = 0;
  const commands: (string | number)[][] = [];
  for (const c of bundle.challenges) {
    if (existingIds.has(c.id)) updated += 1;
    else created += 1;

    // Built field by field, mirroring upsertChallenge's write: the flag
    // never reaches this record. `title` is trimmed and `category` is
    // canonicalized to the surviving spelling, for the same reason
    // `parseChallengePayload` trims `title` on the single-challenge path —
    // a bundle-authored row must end up identical to a form-authored one.
    const record: Challenge = {
      id: c.id,
      title: c.title.trim(),
      category: canon.get(c.category.toLowerCase()) ?? c.category,
      description: c.description,
      points: c.points,
      order: c.order,
      // Only written when true, so a bundle without the field produces a
      // record byte-identical to what it produced before #193 — the export /
      // import round-trip test compares stored JSON, and an always-present
      // `"caseSensitive":false` would break it while changing nothing.
      ...(c.caseSensitive ? { caseSensitive: true as const } : {}),
    };
    commands.push(["HSET", CHALLENGES_KEY, c.id, JSON.stringify(record)]);
    commands.push(["HSET", FLAG_KEY, c.id, c.flag.trim()]);
    // Hint written-or-cleared, same as upsertChallenge: re-importing a bundle
    // without the field removes a hint the earlier import created, so the
    // round-trip stays faithful in both directions (#190).
    const hint = typeof c.hint === "string" && c.hint.trim() ? c.hint.trim() : null;
    commands.push(hint ? ["HSET", HINTS_KEY, c.id, hint] : ["HDEL", HINTS_KEY, c.id]);
    // The comparison form follows the record that was just built, NOT the raw
    // bundle field — they are the same value, and reading it from the record
    // is what keeps them the same value if either ever gains a default.
    commands.push(["HSET", FLAGNORM_KEY, c.id, flagComparisonForm(c.flag, record.caseSensitive)]);
  }
  commands.push(["SET", CATEGORIES_KEY, JSON.stringify(unioned)]);
  if (mergedStories) commands.push(["SET", CLASSIC_STORIES_KEY, JSON.stringify(mergedStories)]);

  // #186: work out each challenge's attachment additions BEFORE any write,
  // so a bundle that would push a challenge past the per-challenge cap
  // refuses whole, never after its challenges already landed.
  const attachmentPlan = await planBundleAttachments(bundle);

  const results = await upstashPipeline(commands);
  const failed = results.find((r) => r.error);
  if (failed) throw new Error(`Upstash bulk import failed: ${failed.error}`);

  await applyBundleAttachments(attachmentPlan);
  return { created, updated, categories: bundle.categories.length, ...(bundle.stories ? { stories: bundle.stories.length } : {}) };
}

/** The current board, in the same shape `importBundle` accepts — so
 *  exporting then re-importing round-trips (every id already exists, so
 *  nothing is reported `created`), which is what makes an export usable as a
 *  backup. Reads the admin-gated challenge list (WITH each flag AS
 *  AUTHORED — never the normalized form) and the category list; every row
 *  comes back with its flag alongside the public fields, matching
 *  `ClassicBundleChallenge`. */
export async function exportBundle(): Promise<ClassicBundle> {
  const [rows, categories, stories, files] = await Promise.all([
    listChallengesForAdmin(),
    listCategories(),
    listStories(),
    listAllAttachments("classic"),
  ]);
  const challenges: ClassicBundleChallenge[] = rows.map(({ challenge, flag, hint }) => ({
    id: challenge.id,
    title: challenge.title,
    category: challenge.category,
    description: challenge.description,
    points: challenge.points,
    order: challenge.order,
    flag,
    // Emitted only when true, so a board with no case-sensitive challenge
    // exports byte-identically to how it did before #193 — an organizer
    // diffing two exports should see the change they made, not a field that
    // appeared on every row.
    ...(challenge.caseSensitive ? { caseSensitive: true as const } : {}),
    // Same only-when-set rule as caseSensitive: a hint-less board exports
    // byte-identically to a pre-#190 one.
    ...(hint ? { hint } : {}),
    // #186: metadata only (the bytes ride the event archive), and only when
    // there is some — the same byte-identical rule as hint.
    ...(files.get(challenge.id)?.length ? { attachments: files.get(challenge.id)!.map(attachmentMeta) } : {}),
  }));
  // A stored step can outlive its challenge (deleteChallenge updates the story
  // in a second call; read paths already drop such a step via storyPositions).
  // parseBundle refuses a step not in the file, so an export that kept one
  // would be a backup that does not restore — prune to the exported ids.
  const exported = new Set(challenges.map((c) => c.id));
  const kept = stories.map((st) => ({ ...st, steps: st.steps.filter((step) => exported.has(step)) }));
  return { version: CLASSIC_BUNDLE_VERSION, categories, challenges, stories: kept };
}

/** Removes a challenge and both of its flag rows together — nothing else.
 *
 *  Scope, stated plainly because it is easy to assume otherwise: this retires
 *  the challenge (contestants stop seeing it, and it can no longer be
 *  submitted against — SUBMIT_SCRIPT's step 1 returns `missing` without the
 *  `flagnorm` row), but it deliberately does NOT touch contestant history.
 *  `ctf:classic:solves:<login>` / `ctf:classic:attempts:<login>` rows for the
 *  deleted id stay put, and the aggregate counters are not decremented — so
 *  points already banked for this challenge REMAIN on the leaderboard.
 *  Clearing banked points is the master reset's job (admin-store's
 *  `resetEvent`).
 *
 *  That's a deliberate contract, mirroring `deleteQuestion`: cascading a
 *  delete across every per-login hash plus aggregate decrements is a fan-out
 *  destructive write with no atomic story and no undo, and retiring a
 *  challenge is a far more common need than un-awarding points for it.
 *  Because the aggregates outlive the challenge, a login can hold more solves
 *  than the challenge list has entries — the leaderboard overlay clamps the
 *  "solved / total" denominator for exactly that reason. */
export async function deleteChallenge(id: string): Promise<void> {
  if (!CLASSIC_ID_RE.test(id)) throw new ClassicValidationError("id", `Invalid challenge id: ${id}`);
  const results = await upstashPipeline([
    ["HDEL", CHALLENGES_KEY, id],
    ["HDEL", FLAG_KEY, id],
    ["HDEL", FLAGNORM_KEY, id],
    ["HDEL", HINTS_KEY, id],
  ]);
  const failed = results.find((r) => r.error);
  if (failed) throw new Error(`Upstash HDEL failed: ${failed.error}`);
  // A deleted step leaves its story (#463): the story shrinks, and the next
  // step's prerequisite becomes the one before it — solves are kept, as above.
  const stories = await listStories();
  if (stories.some((st) => st.steps.includes(id))) {
    await setStories(stories.map((st) => ({ ...st, steps: st.steps.filter((step) => step !== id) })));
  }
  // Its files go with it (#186). The download route already 404s them once
  // the challenge is gone; this frees their bytes from the event cap.
  await deleteItemAttachments("classic", id);
}

/** Deletes ONLY the content keys — challenges, both flag hashes, categories,
 *  and hints — never the run-state keys (points, solved, solvecount,
 *  solves:&lt;login&gt;, attempts:&lt;login&gt;).
 *
 *  For a replace-all import: the caller wipes the board clean before writing
 *  a fresh bundle over it, so a challenge dropped from the new bundle doesn't
 *  linger from the old one. Contestant history and aggregates are
 *  deliberately untouched, mirroring `deleteChallenge`'s contract — that is
 *  the master reset's job (admin-store's `resetEvent`), not this one's. */
export async function clearChallenges(): Promise<void> {
  const results = await upstashPipeline([
    ["DEL", CHALLENGES_KEY],
    ["DEL", FLAG_KEY],
    ["DEL", FLAGNORM_KEY],
    ["DEL", CATEGORIES_KEY],
    ["DEL", CLASSIC_STORIES_KEY],
    ["DEL", HINTS_KEY],
  ]);
  // This runs on the destructive replace-all path (event-store's
  // importEventBundle) — a silently-swallowed per-command error here would
  // leave stale content behind while the caller believes the board is clean.
  // Same discipline as deleteChallenge above: surface it instead.
  const failed = results.find((r) => r.error);
  if (failed) throw new Error(`Upstash DEL failed: ${failed.error}`);
  // Attachments are classic content too (#186) — classic is their only
  // adopter today, so a clean board clears every one.
  await clearAllAttachments();
}

type Solve = { points: number; at: string };
type Attempt = { attempts: number; lastAt: string };

function extractSolve(v: Record<string, unknown>): Solve | null {
  if (typeof v.points !== "number" || typeof v.at !== "string") return null;
  return { points: v.points, at: v.at };
}

function extractAttempt(v: Record<string, unknown>): Attempt | null {
  if (typeof v.attempts !== "number" || typeof v.lastAt !== "string") return null;
  return { attempts: v.attempts, lastAt: v.lastAt };
}

// `parseJsonValue` / `parseHashEntries` / `parseCounterHash` come from
// lib/redis-decode.ts — the one copy quiz, classic and ai share (#504 M13).

export type ViewerClassic = {
  /** Solves only, keyed by challenge id. Points are what the challenge was
   *  worth AT SOLVE TIME, not what it is worth now. */
  solved: Record<string, Solve>;
  /** Every attempt (right or wrong), keyed by challenge id — mirrors
   *  `ViewerQuiz.attempts`. The `/flags` board needs this to derive a
   *  per-challenge cooldown status server-side (same reasoning as quiz's
   *  `deriveStatus`): `classicCooldownSec` can be configured up to an hour,
   *  and without a server-rendered cooldown a contestant would stare at an
   *  enabled submit control that always 403s until they tried it. */
  attempts: Record<string, Attempt>;
};

/** A single caller's classic progress: which challenges they have solved, for
 *  how many points each, and every attempt made (right or wrong) — the latter
 *  is what lets a caller derive a cooldown without an extra round trip.
 *
 *  ONE pipeline call, two HGETALLs against that login's own solve and attempt
 *  hashes — neither flag hash is touched, additive over the original
 *  solve-only shape. */
export async function getViewerClassic(login: string): Promise<ViewerClassic> {
  const [solvesRes, attemptsRes] = await upstashPipeline([
    ["HGETALL", solvesKey(login)],
    ["HGETALL", attemptsKey(login)],
  ]);
  return {
    solved: parseHashEntries(solvesRes.result, extractSolve),
    attempts: parseHashEntries(attemptsRes.result, extractAttempt),
  };
}

/** How many DISTINCT logins have solved each challenge, keyed by challenge id
 *  — the "N solves" figure the board shows. One HGETALL, maintained
 *  atomically by SUBMIT_SCRIPT.
 *
 *  Distinct by construction, not by care: the script's already-solved guard
 *  runs before any write, so a login that resubmits a flag it already holds
 *  returns `already` without ever reaching the increment. */
export async function getSolveCounts(): Promise<Map<string, number>> {
  const [res] = await upstashPipeline([["HGETALL", SOLVECOUNT_KEY]]);
  return parseCounterHash(res.result);
}

/** One login's (or one team's) classic aggregate, as consumed by the
 *  leaderboard overlay. */
/** `itemIds` is present only on the TEAM path, whose fold already dedupes by
 *  item id — the aggregate per-login path has running counters with no memory
 *  of which items produced them. Where it is present a caller can union it
 *  with the live catalogue for a denominator that survives an organizer
 *  deleting a solved item (#348); where it is absent the caller clamps, which
 *  is what every row did before. */
export type ClassicTotal = { points: number; solved: number; lastAt: string | null; itemIds?: string[] };

/** Per-login classic totals for every login that has solved at least one
 *  challenge — three HGETALLs in one pipeline (`ctf:classic:points`,
 *  `ctf:classic:solved`, `ctf:classic:lastAt`), maintained atomically by
 *  SUBMIT_SCRIPT alongside the per-login solve row. The cost does not grow
 *  with the board.
 *
 *  `lastAt` is the login's latest award time (#522), the leaderboard's
 *  "whoever got there first" tiebreak. It is null for a login that last
 *  scored before the time was recorded, and for everyone when that read
 *  fails (`readLastAt` fails open: the points stand). */
export async function getClassicTotals(): Promise<Map<string, ClassicTotal>> {
  const [pointsRes, solvedRes, lastAtRes] = await upstashPipeline([
    ["HGETALL", POINTS_KEY],
    ["HGETALL", SOLVED_KEY],
    ["HGETALL", LAST_AT_KEY],
  ]);
  // An errored counter read is not "nobody has points" (#523): throw, so the
  // leaderboard's own handling applies (it logs and leaves the module off the
  // board) instead of every row silently losing these points.
  const failed = pointsRes.error ?? solvedRes.error;
  if (failed !== undefined) throw new Error(`classic totals read failed: ${failed}`);
  const points = parseCounterHash(pointsRes.result);
  const solved = parseCounterHash(solvedRes.result);
  const lastAt = readLastAt(lastAtRes, "classic");

  const totals = new Map<string, ClassicTotal>();
  for (const login of new Set([...points.keys(), ...solved.keys()])) {
    totals.set(login, { points: points.get(login) ?? 0, solved: solved.get(login) ?? 0, lastAt: lastAt.get(login) ?? null });
  }
  return totals;
}

/** A TEAM's classic total is the UNION of challenges its members solved, never
 *  the sum of member aggregates — summing would double count any challenge two
 *  teammates both solved. The aggregates can't serve a team: they're running
 *  totals with no memory of WHICH challenges contributed, so there is no way
 *  to dedupe from them. Instead this reads each member's
 *  `ctf:classic:solves:<login>` hash directly and dedupes by challenge id,
 *  keeping the EARLIEST solve's stored points for any challenge two or more
 *  members hold (a later solve by a teammate — or a since-changed price
 *  recorded on someone else's row — never changes what the team already
 *  earned).
 *
 *  Exactly ONE `upstashPipeline` round trip for the whole board: one team's
 *  members per entry in `teams`, one `ClassicTotal` per entry out, in the same
 *  order. `/leaderboard` is dynamic and fetched `no-store`, so a per-team form
 *  would cost a 25-team event 25 REST calls on every single page view. A login
 *  on two teams is fetched ONCE and its reply reused for both, so the pipeline
 *  carries one HGETALL per DISTINCT member. */
export async function getTeamClassicTotalsBatch(
  teams: readonly (readonly string[])[],
): Promise<ClassicTotal[]> {
  const indexByLogin = new Map<string, number>();
  for (const members of teams) {
    for (const login of members) {
      if (!indexByLogin.has(login)) indexByLogin.set(login, indexByLogin.size);
    }
  }
  const logins = [...indexByLogin.keys()];
  if (logins.length === 0) return teams.map(() => ({ points: 0, solved: 0, lastAt: null, itemIds: [] }));

  const results = await upstashPipeline(logins.map((login) => ["HGETALL", solvesKey(login)]));
  return teams.map((members) => foldTeamSolves(members.map((login) => results[indexByLogin.get(login) ?? -1])));
}

/** The union-by-challenge fold. Keeps the EARLIEST solve for any challenge
 *  more than one member holds.
 *
 *  The rule itself lives in `leaderboard/team-fold.ts` and is shared verbatim
 *  with quiz-store's team fold — see the note there. All this wrapper does is
 *  rename the shared `completed` to classic's own noun. */
function foldTeamSolves(memberReplies: ({ result?: unknown; error?: string } | undefined)[]): ClassicTotal {
  const { points, completed, lastAt, itemIds } = foldTeamItems(memberReplies);
  return { points, solved: completed, lastAt, itemIds };
}

type ResolvedAdminSettings = Awaited<ReturnType<typeof getAdminSettings>>;

type ClassicGate =
  | { allowed: true }
  | { allowed: false; reason: "paused" | "solved" | "cooldown" | "unavailable"; retryAt?: string };

/** The submission gate, checked in this order (each short-circuits the rest):
 *    1. scoring paused, or outside the scheduled scoring window
 *    2. `login` has already solved this challenge
 *    3. `login` is still inside the cooldown since its last submission
 *
 *  `retryAt` is DERIVED from `lastAt + the CURRENT cooldown setting` on every
 *  call, never stored — so lowering the cooldown mid-event lifts a lock
 *  immediately instead of leaving it stale until some persisted unlock time
 *  catches up.
 *
 *  Two different failure directions, on purpose:
 *
 *  - The pause/schedule check fails OPEN. `settings` is `null` when the
 *    settings read itself failed, and a null reads as "not paused": a Redis
 *    blip must never silently drop a live submission. This mirrors the
 *    manual-freeze fail-open the scorer and sync poller implement.
 *  - The solve/attempt lookup fails CLOSED, with its OWN distinct reason,
 *    "unavailable" — deliberately NOT "cooldown" and never a claim about
 *    spent attempts. Misreporting an unverifiable lookup as a fact about a
 *    contestant's own attempts turns a transient blip into a support argument
 *    about a number nobody can check.
 *
 *  IMPORTANT: this is a cheap, NON-ATOMIC pre-check. It reads solves/attempts
 *  over its own separate round trip, so two concurrent submissions can both
 *  observe "not cooling" before either writes. SUBMIT_SCRIPT re-checks both
 *  the already-solved guard and the cooldown against state read fresh at
 *  script-execution time, and is what actually enforces them. */
async function evaluateGate(
  settings: ResolvedAdminSettings | null,
  login: string,
  challengeId: string,
  cooldownSec: number,
  dryRun = false,
): Promise<ClassicGate> {
  // A dry run (#464 admin preview) happens exactly while scoring is closed —
  // before launch — so the pause is what is being previewed, not a refusal.
  if (!dryRun && settings && effectivePaused(settings)) return { allowed: false, reason: "paused" };

  let solve: Solve | null;
  let attempt: Attempt | null;
  try {
    const [solveRes, attemptRes] = await upstashPipeline([
      ["HGET", solvesKey(login), challengeId],
      ["HGET", attemptsKey(login), challengeId],
    ]);
    if (solveRes.error) throw new Error(solveRes.error);
    if (attemptRes.error) throw new Error(attemptRes.error);
    solve = parseJsonValue(solveRes.result, extractSolve);
    attempt = parseJsonValue(attemptRes.result, extractAttempt);
  } catch (err) {
    console.error("classic gate: solve/attempt lookup failed:", errorLabel(err));
    return { allowed: false, reason: "unavailable" };
  }

  if (solve) return { allowed: false, reason: "solved" };

  // Nothing a dry run does is recorded, so there is nothing for it to cool.
  if (!dryRun && cooldownSec > 0 && attempt) {
    const lastMs = Date.parse(attempt.lastAt);
    if (Number.isFinite(lastMs)) {
      const retryAtMs = lastMs + cooldownSec * 1000;
      if (Date.now() < retryAtMs) {
        return { allowed: false, reason: "cooldown", retryAt: new Date(retryAtMs).toISOString() };
      }
    }
  }

  return { allowed: true };
}

// Grades one flag submission and records everything it changes atomically.
//
// This script — NOT the JS pre-check — is the authority on the cooldown. The
// pre-check reads over its own separate round trip, so two concurrent
// submissions can both observe "not cooling" before either writes. Redis runs
// one script to completion before starting the next, so each submission here
// sees every effect of every submission that finished before it.
//
//   1. HGET the normalized flag. Missing -> {'missing'} (bad/deleted id).
//   2. HEXISTS the solve row BEFORE any write -> {'already'}, nothing touched.
//      This guard is also what makes KEYS[6] (solvecount) distinct-by-
//      construction: a login can never increment it twice.
//   3. Read {attempts,lastAtMs} and re-check the cooldown WITHOUT WRITING.
//      The cooldown comes in as ARGV (the CURRENT admin setting, resolved by
//      the caller on every call — never a stored cutoff) and is combined with
//      the attempts row the script reads at execution time, never a value the
//      caller read earlier and handed in, which is what would let a race
//      bypass it.
//   4. Only past the check: spend an attempt (right or wrong).
//   5. Compare whole values with `==`. A flag routinely contains braces,
//      quotes and backslashes, so it is never pattern-matched out of a JSON
//      blob the way quiz's points are — the value IS the whole hash field.
//      And it is compared against ARGV[2], which the CALLER normalized with
//      the same `normalizeFlag` that produced the stored value. Nothing here
//      lowercases anything: Lua's `string.lower` is ASCII-only and would
//      disagree with the JS recipe on any non-ASCII flag, producing a
//      challenge nobody can solve.
//   6. Equal: read points, write the solve row, bump the three counters.
//
// DRY RUN (ARGV[8] == "1", #464 admin preview): steps 1-2 and 5 run as
// normal; the cooldown refusal (3) is skipped and NOTHING is written — no
// attempts row (4), no solve or counters (6). The verdict comes back with a
// trailing 'dry' so the caller can never mistake it for a banked solve.
//
// The points match is anchored with a trailing [,}] so it can only match a
// complete "points":<int> pair, not a digit run appearing earlier in the blob.
export const SUBMIT_SCRIPT = `
local dry = ARGV[8] == '1'
if redis.call('HEXISTS', KEYS[2], ARGV[1]) == 1 then return {'already'} end
-- STORY LOCK (#463): ARGV[9] names this step's prerequisite ("" when the
-- challenge is not a later story step). It is open only if some TEAMMATE —
-- one of the solves hashes the caller handed in as KEYS[9..] — holds it.
-- (KEYS[8] is the lastAt hash, #522: never part of this loop.)
-- Checked FIRST, before the flag hash is read and before any read or write
-- of attempts: a locked step touches no secret, spends no attempt and cannot
-- be used to test a flag. The store reports it exactly like an unknown
-- challenge (no oracle). A dry-run preview skips it.
if not dry and ARGV[9] and ARGV[9] ~= '' then
  local open = false
  for i = 9, #KEYS do
    if redis.call('HEXISTS', KEYS[i], ARGV[9]) == 1 then open = true break end
  end
  if not open then return {'locked'} end
end
local target = redis.call('HGET', KEYS[3], ARGV[1])
if not target then return {'missing'} end

local cooldownMs = tonumber(ARGV[5])
local nowMs = tonumber(ARGV[6])

-- The shared attempt-row read (#504 M13) — attempts, lastAtMs and firstAt —
-- declared here as ATTEMPT_ROW_LUA, so quiz's and ai's scripts read the same
-- three fields out of the same row shape.
${ATTEMPT_ROW_LUA}

if not dry and cooldownMs > 0 and lastAtMs and nowMs < (lastAtMs + cooldownMs) then
  return {'cooldown', tostring(lastAtMs + cooldownMs)}
end

attempts = attempts + 1
if not firstAt then firstAt = ARGV[3] end
if not dry then
  redis.call('HSET', KEYS[1], ARGV[1], '{"attempts":' .. attempts .. ',"firstAt":"' .. firstAt .. '","lastAt":"' .. ARGV[3] .. '","lastAtMs":' .. ARGV[6] .. '}')
end

-- Fetched BEFORE the comparison, not after, because the record now decides
-- WHICH submitted form to compare (issue #193) as well as what the solve is
-- worth. Lua still performs no case handling of its own: both forms arrive
-- already normalized from JS, and this only chooses between them.
local cRaw = redis.call('HGET', KEYS[4], ARGV[1])
local points = 0
local caseSensitive = false
if cRaw then
  local found = string.match(cRaw, '"points":(%-?%d+)[,}]')
  if found then points = tonumber(found) end
  -- Absent means false: the field is only written when true, so every
  -- challenge authored before this existed keeps the forgiving comparison.
  if string.match(cRaw, '"caseSensitive":true[,}]') then caseSensitive = true end
end

local submitted = ARGV[2]
if caseSensitive then submitted = ARGV[7] end

if target ~= submitted then
  if dry then return {'incorrect', '0', 'dry'} end
  return {'incorrect', tostring(attempts)}
end
if dry then return {'correct', tostring(points), 'dry'} end
redis.call('HSET', KEYS[2], ARGV[1], '{"points":' .. points .. ',"at":"' .. ARGV[3] .. '"}')
redis.call('HINCRBY', KEYS[5], ARGV[4], points)
redis.call('HINCRBY', KEYS[7], ARGV[4], 1)
redis.call('HINCRBY', KEYS[6], ARGV[1], 1)
-- Keep the LATEST award time (#522). The time is taken before this script
-- runs, so two awards can arrive out of order; toISOString values compare
-- correctly as strings. A stored value that is not an ISO time is replaced.
local prevAt = redis.call('HGET', KEYS[8], ARGV[4])
if not prevAt or not string.match(prevAt, '^%d%d%d%d%-%d%d%-%d%dT') or prevAt < ARGV[3] then
  redis.call('HSET', KEYS[8], ARGV[4], ARGV[3])
end
return {'correct', tostring(points)}`;

export type SubmitResult =
  // `already` marks the idempotent re-submission of a flag this login had
  // ALREADY banked (SUBMIT_SCRIPT's step-2 guard). It is still a correct flag,
  // but `points` is 0 because this call awarded nothing further — NOT because
  // the challenge is worth nothing. Callers must render the two apart.
  // `dryRun` marks an admin-preview grade (#464): the script compared and
  // wrote NOTHING, so `points` is what the flag is worth, not what was banked.
  | { ok: true; correct: true; points: number; already?: boolean; dryRun?: true }
  | { ok: true; correct: false; dryRun?: true }
  | { ok: false; reason: "paused" | "solved" | "cooldown" | "locked"; retryAt?: string }
  // The gate's lookup itself failed (fail-closed), the submission was
  // malformed / named an unknown challenge, or the script blew up. Kept
  // distinct from the gate reasons above so a caller-facing message can say
  // the check couldn't be completed instead of stating a fact about the
  // contestant that was never established.
  | { ok: false; reason: "unavailable" | "invalid" | "error" };

/** Grades `flag` against `challengeId` for `login`, and on success records the
 *  solve, the running totals and the challenge's solve count — all in one
 *  atomic script.
 *
 *  The gate is checked BEFORE the script runs — a refused submission must
 *  never reach Redis's scoring path — but it is only a cheap pre-check;
 *  SUBMIT_SCRIPT re-checks the already-solved guard and the cooldown
 *  authoritatively (see its comment) using the CURRENT admin settings resolved
 *  by THIS call, so a race that slips past the pre-check is still caught,
 *  atomically, by the script.
 *
 *  Both sides of the comparison are normalized by `normalizeFlag` in JS: the
 *  authoring side when `upsertChallenge` writes `ctf:classic:flagnorm`, and
 *  this side before the value is ever handed to the script. That agreement is
 *  the whole design — see SUBMIT_SCRIPT step 5.
 *
 *  This function never returns the flag itself, only whether the submission
 *  was right. */
export async function submitFlag(
  login: string,
  challengeId: string,
  flag: string,
  opts: { dryRun?: boolean } = {},
): Promise<SubmitResult> {
  const dryRun = opts.dryRun === true;
  if (!CLASSIC_ID_RE.test(challengeId)) return { ok: false, reason: "invalid" };
  if (typeof flag !== "string" || !flag.trim()) return { ok: false, reason: "invalid" };

  // Fails OPEN: if the settings read blows up we treat scoring as live rather
  // than dropping a submission a contestant is entitled to make. The cooldown
  // then falls back to the module default, which the script still enforces.
  let settings: ResolvedAdminSettings | null = null;
  try {
    settings = await getAdminSettings();
  } catch (err) {
    console.error("classic: admin settings read failed, treating scoring as live:", errorLabel(err));
  }
  const cooldownSec = settings?.classicCooldownSec ?? CLASSIC_COOLDOWN_SEC;

  const gate = await evaluateGate(settings, login, challengeId, cooldownSec, dryRun);

  // STORY LOCK (#463): a later story step names its prerequisite, and the
  // script checks it against every teammate's solves hash. Resolved here and
  // enforced THERE (the script is the authority). A stories or team read that
  // fails is `unavailable` — closed, never "no lock".
  let prereq = "";
  let lockKeys: string[] = [];
  if (gate.allowed || gate.reason === "cooldown") {
    try {
      const [stories, existing] = await Promise.all([listStories(), listChallengeIds()]);
      const pos = storyPositions(stories, existing).get(challengeId);
      if (pos?.prereq) {
        prereq = pos.prereq;
        lockKeys = await teamSolveKeys(login);
      }
    } catch (err) {
      console.error("classic: story lock lookup failed (failing closed):", errorLabel(err));
      return { ok: false, reason: "unavailable" };
    }
  }

  // A later story step's cooldown is left to the script (CodeRabbit #470): it
  // checks the lock BEFORE the cooldown, so a locked step is answered like an
  // unknown challenge — never with a cooldown an unknown id cannot have. The
  // script still enforces the cooldown on an open step.
  const cooldownDeferred = !gate.allowed && gate.reason === "cooldown" && prereq !== "";
  if (!gate.allowed && !cooldownDeferred) {
    // Kept as its own branch (not folded into the passthrough below) so its
    // caller-facing shape can never accidentally pick up a retryAt the lookup
    // never actually established.
    if (gate.reason === "unavailable") return { ok: false, reason: "unavailable" };
    return gate.retryAt
      ? { ok: false, reason: gate.reason, retryAt: gate.retryAt }
      : { ok: false, reason: gate.reason };
  }

  const now = new Date();
  const nowIso = now.toISOString();
  // A duration in ms, recomputed from the SAME settings the pre-check used —
  // never a stored cutoff. The script combines it with the attempts row IT
  // reads at execution time.
  const cooldownMs = cooldownSec * 1000;

  let verdict: unknown;
  try {
    verdict = await upstashEval(
      SUBMIT_SCRIPT,
      [
        attemptsKey(login), // KEYS[1]
        solvesKey(login), // KEYS[2]
        FLAGNORM_KEY, // KEYS[3] — the normalized flag; ctf:classic:flag is
        //                          never handed to the script at all
        CHALLENGES_KEY, // KEYS[4]
        POINTS_KEY, // KEYS[5]
        SOLVECOUNT_KEY, // KEYS[6]
        SOLVED_KEY, // KEYS[7]
        LAST_AT_KEY, // KEYS[8] — login -> latest award time (#522)
        ...lockKeys, // KEYS[9..] — teammates' solves hashes, for the story lock (#463)
      ],
      // BOTH comparison forms go in, and the script picks. Normalizing on this
      // side is non-negotiable (Lua's string.lower is ASCII-only — see the
      // module header), but which form applies is a per-challenge fact the
      // script is already holding when it decides. Sending both costs one
      // short string and saves a round trip to read the mode first.
      [
        challengeId,
        normalizeFlag(flag), // ARGV[2] — case-insensitive form (the default)
        nowIso,
        login,
        cooldownMs,
        now.getTime(),
        caseSensitiveFlagForm(flag), // ARGV[7] — case preserved (issue #193)
        dryRun ? "1" : "0", // ARGV[8] — dry run: grade, write nothing (#464)
        prereq, // ARGV[9] — story prerequisite, "" when none (#463)
      ],
    );
  } catch (err) {
    console.error("Classic grading failed:", errorLabel(err));
    return { ok: false, reason: "error" };
  }

  const [status, value, marker] = Array.isArray(verdict) ? (verdict as unknown[]) : [];
  if (status === "missing") return { ok: false, reason: "invalid" };
  // A locked story step (#463): answered EXACTLY like an unknown challenge —
  // a distinct refusal would confirm that a guessed id is a hidden step
  // (CodeRabbit #470, secrecy boundary). Never a wrong answer either.
  if (status === "locked") return { ok: false, reason: "invalid" };
  // A dry verdict carries a trailing 'dry' from the script itself, so a
  // preview result can never be read as a banked solve.
  if (marker === "dry") {
    if (status === "correct") return { ok: true, correct: true, points: Number(value) || 0, dryRun: true };
    if (status === "incorrect") return { ok: true, correct: false, dryRun: true };
    return { ok: false, reason: "error" };
  }
  if (status === "cooldown") {
    const retryAtMs = Number(value);
    return { ok: false, reason: "cooldown", retryAt: new Date(retryAtMs).toISOString() };
  }
  if (status === "incorrect") return { ok: true, correct: false };
  // Raced a prior correct submission past the gate's own read — already
  // banked, so this call awards nothing further, but it IS a correct flag.
  if (status === "already") return { ok: true, correct: true, points: 0, already: true };
  if (status === "correct") return { ok: true, correct: true, points: Number(value) || 0 };
  return { ok: false, reason: "error" };
}

// ---------------------------------------------------------------------------
// Stories (#463) — ordered chains of challenges a team unlocks step by step.
// Stored like the category list: one JSON value. The lock itself is derived
// (lib/story-lock.ts), never stored.

export { CLASSIC_STORIES_MAX, CLASSIC_STORY_STEPS_MAX, CLASSIC_STORY_TITLE_MAX, CLASSIC_STORY_INTRO_MAX };
const STORY_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function parseStoredStories(raw: unknown): Story[] {
  if (raw === null || raw === undefined) return [];
  if (typeof raw !== "string") throw new Error("stories: stored value is not a string");
  const parsed = JSON.parse(raw) as unknown; // a corrupt value THROWS
  if (!Array.isArray(parsed)) throw new Error("stories: stored value is not a list");
  return parsed.map((v) => {
    const o = v as Partial<Story>;
    if (typeof o?.id !== "string" || typeof o.title !== "string" || !Array.isArray(o.steps)) {
      throw new Error("stories: a stored story is malformed");
    }
    return {
      id: o.id,
      title: o.title,
      intro: typeof o.intro === "string" ? o.intro : "",
      steps: o.steps.filter((s): s is string => typeof s === "string"),
    };
  });
}

/** Every story, in organizer order. THROWS on a read error or a corrupt
 *  value — unlike `listCategories`, which reads either as "none": "no stories"
 *  would open every story step, so the caller's fail-CLOSED direction must
 *  apply instead (a page errors, a grade answers `unavailable`). */
export async function listStories(): Promise<Story[]> {
  const [res] = await upstashPipeline([["GET", CLASSIC_STORIES_KEY]]);
  if (res.error) throw new Error(`Upstash GET failed: ${res.error}`);
  return parseStoredStories(res.result);
}

/** Replaces the whole story list, after validating it: unique story ids, a
 *  non-empty title, a challenge in at most one story and at most once. Step
 *  ids are checked for shape here and for existence by the authoring route.
 *  Returns what was stored. */
export async function setStories(stories: Story[]): Promise<Story[]> {
  const canonical = canonicalStories(stories);
  const [res] = await upstashPipeline([["SET", CLASSIC_STORIES_KEY, JSON.stringify(canonical)]]);
  if (res.error) throw new Error(`Upstash SET failed: ${res.error}`);
  return canonical;
}

/** `setStories`'s validation, pure, so `importBundle` can run it on the
 *  merged list before its write pipeline. THROWS `ClassicValidationError`. */
function canonicalStories(stories: Story[]): Story[] {
  if (!Array.isArray(stories)) throw new ClassicValidationError("stories", "stories must be an array");
  if (stories.length > CLASSIC_STORIES_MAX) {
    throw new ClassicValidationError("stories", `At most ${CLASSIC_STORIES_MAX} stories are allowed`);
  }
  const storyIds = new Set<string>();
  const stepOwner = new Map<string, string>();
  const canonical: Story[] = [];
  for (const st of stories) {
    const id = typeof st?.id === "string" ? st.id.trim() : "";
    if (!STORY_ID_RE.test(id)) throw new ClassicValidationError("stories", `Invalid story id: ${JSON.stringify(st?.id)}`);
    if (storyIds.has(id)) throw new ClassicValidationError("stories", `Story ids must be unique: ${id}`);
    storyIds.add(id);
    const title = typeof st.title === "string" ? st.title.trim() : "";
    if (!title || title.length > CLASSIC_STORY_TITLE_MAX) {
      throw new ClassicValidationError("stories", `Story ${id} needs a title of at most ${CLASSIC_STORY_TITLE_MAX} characters`);
    }
    const intro = typeof st.intro === "string" ? st.intro.trim() : "";
    if (intro.length > CLASSIC_STORY_INTRO_MAX) {
      throw new ClassicValidationError("stories", `Story ${id}'s intro must be at most ${CLASSIC_STORY_INTRO_MAX} characters`);
    }
    if (!Array.isArray(st.steps) || st.steps.length > CLASSIC_STORY_STEPS_MAX) {
      throw new ClassicValidationError("stories", `Story ${id} must have at most ${CLASSIC_STORY_STEPS_MAX} steps`);
    }
    const seen = new Set<string>();
    for (const step of st.steps) {
      if (typeof step !== "string" || !CLASSIC_ID_RE.test(step)) {
        throw new ClassicValidationError("stories", `Story ${id} has an invalid step id: ${JSON.stringify(step)}`);
      }
      if (seen.has(step)) throw new ClassicValidationError("stories", `Story ${id} lists ${step} twice`);
      seen.add(step);
      const owner = stepOwner.get(step);
      if (owner) throw new ClassicValidationError("stories", `${step} is in two stories (${owner}, ${id}) — a challenge belongs to one story`);
      stepOwner.set(step, id);
    }
    canonical.push({ id, title, intro, steps: [...st.steps] });
  }
  return canonical;
}

/** The ids of every challenge that exists — what `storyPositions` needs to
 *  drop a stale story step (#463). One HKEYS; THROWS on a read error. */
export async function listChallengeIds(): Promise<Set<string>> {
  const [res] = await upstashPipeline([["HKEYS", CHALLENGES_KEY]]);
  if (res.error) throw new Error(`Upstash HKEYS failed: ${res.error}`);
  return new Set(Array.isArray(res.result) ? (res.result as unknown[]).filter((v): v is string => typeof v === "string") : []);
}
