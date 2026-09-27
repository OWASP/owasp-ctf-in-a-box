import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { adminErrorLabel, writeAdminAudit } from "@/lib/admin-store";
import { parseBundle } from "@/lib/classic-io";
import {
  ClassicValidationError,
  deleteChallenge,
  importBundle,
  listCategories,
  listChallengeIds,
  listChallengesForAdmin,
  listStories,
  renameCategory,
  setCategories,
  setStories,
  upsertChallenge,
  type AdminChallenge,
  type Challenge,
} from "@/lib/classic-store";
import type { Story } from "@/lib/story-lock";
import { type Attachment, attachmentMeta } from "@/lib/attachments-keys";
import { listAllAttachments } from "@/lib/attachments-store";

/**
 * Organizer authoring surface for the classic (flag) module: list (GET),
 * create-or-update a challenge or replace the category list (POST), and
 * delete a challenge (DELETE). Gated by `requireAdmin` throughout; every
 * write appends a line to the same `ctf:admin:audit` trail `admin-store`'s
 * settings/reset/seed writers and the quiz admin route use.
 *
 * This is the one surface that may return a challenge's flag. GET calls
 * `listChallengesForAdmin()`, so each row carries `{ challenge, flag }` and
 * the edit form can prefill the flag an organizer is editing — an organizer
 * fixing a typo must not have to retype the whole flag from memory and risk
 * silently redefining what counts as solved. That is sound precisely because
 * `requireAdmin` runs FIRST, before any store read: anyone past it can
 * already rewrite or delete the flag outright. The contestant path is
 * untouched and stays flagless — `/flags` calls `listChallenges()`, which
 * never reads `ctf:classic:flag`/`ctf:classic:flagnorm` at all.
 *
 * The POST payload is runtime-shape-checked field by field, rejecting any key
 * it doesn't explicitly allow, BEFORE it ever reaches `upsertChallenge` or
 * `setCategories`. This matters because TypeScript only rejects excess
 * properties on object LITERALS, not on parsed JSON — without this check, a
 * crafted request body could smuggle an extra key straight through to the
 * store. `parseChallengePayload` / `parseCategoriesPayload` below are the
 * guard: unknown keys, wrong types, or a missing field all fail closed with a
 * 400, never a partially-trusted write.
 *
 * POST carries FIVE distinct payload shapes on the SAME route rather than a
 * separate endpoint per resource: a body with exactly one key, `categories`
 * (an array), replaces the category list; one with exactly `renameCategory`
 * ({from, to}) renames a single category and carries its challenges across
 * (#304 — the array shape cannot express that, since a renamed entry is
 * indistinguishable from one removed plus one added); one with exactly
 * `import` (a string) bulk-imports a challenge bundle; one with exactly
 * `stories` (an array) replaces the story list (#463); anything else is
 * parsed as a challenge-plus-flag upsert. The five key sets never overlap,
 * so the shape alone is enough to dispatch — no extra discriminator field for
 * a caller to get wrong. See the exported `*_KEYS` constants below and the
 * route test's "keeps every payload key set pairwise disjoint" case, which
 * checks every PAIR among them (not just one hand-picked pair) so a future
 * fourth shape is covered by adding one line to that test's `sets` array,
 * rather than a second bespoke assertion.
 *
 * The `import` shape carries the bundle as raw TEXT, never a pre-parsed
 * object: this route re-parses and re-validates it with `parseBundle` (the
 * same validator the admin bulk-import UI runs client-side) before ever
 * calling `importBundle`, so a client that skipped or weakened its own
 * validation cannot write anything the single-challenge path above would
 * have rejected. `importBundle` itself trusts its input completely — see its
 * own doc comment in classic-store.ts — which is exactly why this route must
 * never call it with anything that hasn't been through `parseBundle` first.
 */

type ChallengePayload = Challenge & { flag: string; hint?: string };

/** The two POST shapes' allowed key sets. Exported (not just module-private)
 *  so a test can assert, structurally, that they stay disjoint — see the
 *  route test file's "categories/challenge key sets never overlap" case.
 *  Asserting this in code rather than trusting the two parsers to agree by
 *  construction is what catches a future optional challenge field, or a
 *  challenge field literally named `categories`, before it reintroduces the
 *  ambiguity this route's shape-only dispatch depends on there being none
 *  of. */
export const CHALLENGE_KEYS = new Set([
  "id",
  "title",
  "category",
  "description",
  "points",
  "order",
  "flag",
  "caseSensitive",
  "hint",
]);
export const CATEGORIES_KEYS = new Set(["categories"]);
/** The rename shape's outer and inner key sets (#304). */
export const RENAME_CATEGORY_KEYS = new Set(["renameCategory"]);
export const RENAME_FIELD_KEYS = new Set(["from", "to"]);
export const IMPORT_KEYS = new Set(["import"]);
/** The story shape (#463): the whole list, and each story's own keys. */
export const STORIES_KEYS = new Set(["stories"]);
export const STORY_KEYS = new Set(["id", "title", "intro", "steps"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hasOnlyKeys(obj: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(obj).every((k) => allowed.has(k));
}

function parseChallengePayload(body: unknown): ChallengePayload | null {
  if (!isPlainObject(body) || !hasOnlyKeys(body, CHALLENGE_KEYS)) return null;
  if (typeof body.id !== "string" || body.id.length === 0) return null;
  // TRIMMED, not merely non-empty, mirroring the quiz admin route's prompt
  // check: a whitespace-only title is empty for every consumer that trims it
  // later, including the delete confirmation's required typed phrase.
  if (typeof body.title !== "string" || body.title.trim().length === 0) return null;
  if (typeof body.category !== "string" || body.category.length === 0) return null;
  if (typeof body.description !== "string") return null;
  if (typeof body.points !== "number" || !Number.isInteger(body.points) || body.points < 0) return null;
  if (typeof body.order !== "number" || !Number.isInteger(body.order)) return null;
  if (typeof body.flag !== "string" || body.flag.trim().length === 0) return null;
  // Optional; a present non-boolean is a malformed body, not a falsy value to
  // shrug at. A string "false" would otherwise make a challenge case-sensitive
  // that the organizer explicitly turned off.
  if (body.caseSensitive !== undefined && typeof body.caseSensitive !== "boolean") return null;
  // Optional paid-hint text (#190); a present non-string is malformed. An
  // empty/whitespace hint is a deliberate CLEAR, passed through so the store
  // deletes the row.
  if (body.hint !== undefined && typeof body.hint !== "string") return null;
  return {
    id: body.id,
    title: body.title.trim(),
    category: body.category,
    description: body.description,
    points: body.points,
    order: body.order,
    flag: body.flag,
    ...(body.hint !== undefined ? { hint: body.hint } : {}),
    // Normalized to "present only when true", the same shape the store writes
    // and the bundle exports, so one challenge has one representation
    // whichever door it came through.
    ...(body.caseSensitive ? { caseSensitive: true as const } : {}),
  };
}

/** Recognizes the OTHER POST shape: a body carrying exactly one key,
 *  `categories`, an array of strings. Deliberately exact (`hasOnlyKeys` PLUS
 *  requiring the key present, not merely "no other keys") rather than merely
 *  "has a categories key" — that is what keeps this shape and the challenge
 *  shape mutually exclusive without a discriminator field. A body carrying
 *  BOTH `categories` and any challenge key fails `hasOnlyKeys` here (an
 *  unrecognized key for this shape) and also fails `parseChallengePayload`'s
 *  own `hasOnlyKeys` (an unrecognized key there), so it falls through to the
 *  400 catch-all rather than being silently treated as either shape. */
function parseCategoriesPayload(body: unknown): string[] | null {
  if (!isPlainObject(body) || !hasOnlyKeys(body, CATEGORIES_KEYS)) return null;
  if (!Array.isArray(body.categories)) return null;
  if (!body.categories.every((c) => typeof c === "string")) return null;
  return body.categories as string[];
}

/** Recognizes the FOURTH POST shape: a body carrying exactly one key,
 *  `renameCategory`, itself an object of exactly `from` and `to` (#304).
 *
 *  A rename needs its own shape because the `categories` array CANNOT express
 *  one: replacing the whole list makes a renamed entry indistinguishable from
 *  "one removed, one added", which is precisely how the challenges lose their
 *  association with it. Same exactness discipline as the shapes above — the
 *  nested object is `hasOnlyKeys`-checked too, so a body smuggling extra
 *  fields falls through to the 400 rather than being partly honoured. */
function parseRenameCategoryPayload(body: unknown): { from: string; to: string } | null {
  if (!isPlainObject(body) || !hasOnlyKeys(body, RENAME_CATEGORY_KEYS)) return null;
  const rename = body.renameCategory;
  if (!isPlainObject(rename) || !hasOnlyKeys(rename, RENAME_FIELD_KEYS)) return null;
  if (typeof rename.from !== "string" || typeof rename.to !== "string") return null;
  return { from: rename.from, to: rename.to };
}

/** Recognizes the THIRD POST shape: a body carrying exactly one key,
 *  `import`, a string — the raw text of an uploaded/pasted bundle file. Only
 *  extracts the string here; parsing and validating it is `parseBundle`'s
 *  job (called from `POST` below), never this function's, so there is
 *  exactly one place that decides whether a bundle is valid. */
function parseImportPayload(body: unknown): string | null {
  if (!isPlainObject(body) || !hasOnlyKeys(body, IMPORT_KEYS)) return null;
  if (typeof body.import !== "string") return null;
  return body.import;
}

/** Recognizes the FIFTH POST shape (#463): exactly `stories`, the whole
 *  story list — each entry exactly `{ id, title, intro?, steps }` with string
 *  fields and a string-array `steps`. Shape only: `setStories` owns the
 *  content rules (id format, caps, one story per challenge), and the handler
 *  checks every step names a challenge that exists. */
function parseStoriesPayload(body: unknown): Story[] | null {
  if (!isPlainObject(body) || !hasOnlyKeys(body, STORIES_KEYS) || !Array.isArray(body.stories)) return null;
  const stories: Story[] = [];
  for (const st of body.stories) {
    if (!isPlainObject(st) || !hasOnlyKeys(st, STORY_KEYS)) return null;
    if (typeof st.id !== "string" || typeof st.title !== "string") return null;
    if (st.intro !== undefined && typeof st.intro !== "string") return null;
    if (!Array.isArray(st.steps) || !st.steps.every((step) => typeof step === "string")) return null;
    stories.push({ id: st.id, title: st.title, intro: st.intro ?? "", steps: st.steps as string[] });
  }
  return stories;
}

/** Maps an error thrown by `upsertChallenge`/`deleteChallenge`/`setCategories`
 *  to a response: a `ClassicValidationError` means the caller's payload was
 *  genuinely bad (bad id, unknown category, non-integer points, empty flag,
 *  too many categories, ...) -> 400 with the message and field. Anything else
 *  is the store's own plain `Error` for a real Upstash/infra failure -> 503,
 *  so an organizer is never told "bad request" for a problem that was never
 *  theirs to fix. */
function errorResponse(err: unknown): Response {
  if (err instanceof ClassicValidationError) {
    return NextResponse.json({ error: err.message, field: err.field }, { status: 400 });
  }
  console.error("[admin/classic] store write failed:", adminErrorLabel(err));
  return NextResponse.json({ error: "classic store write failed" }, { status: 503 });
}

// Audit writes go through admin-store.ts's shared `writeAdminAudit` — see the
// header comment on that function.

export async function GET(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });

  // Admin-gated, so this may carry each challenge's flag — see the header
  // comment. The `requireAdmin` check above must stay the first statement in
  // this handler: with flags in the payload, an early store read on an
  // unauthenticated request is no longer merely wasted work.
  let challenges: AdminChallenge[];
  let categories: string[];
  let stories: Story[];
  let files: Map<string, Attachment[]>;
  try {
    [challenges, categories, stories, files] = await Promise.all([
      listChallengesForAdmin(),
      listCategories(),
      listStories(),
      listAllAttachments("classic"),
    ]);
  } catch (err) {
    return errorResponse(err);
  }
  // #186: each challenge's attachment METADATA, for the panel's own Export —
  // the same shape the server export writes, no ids or chunk counts.
  const attachments = Object.fromEntries([...files].map(([id, list]) => [id, list.map(attachmentMeta)]));
  return NextResponse.json({ challenges, categories, stories, attachments });
}

export async function POST(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });

  const body = await request.json().catch(() => null);

  const categoriesPayload = parseCategoriesPayload(body);
  if (categoriesPayload) {
    let categories: string[];
    try {
      categories = await setCategories(categoriesPayload);
    } catch (err) {
      return errorResponse(err);
    }
    await writeAdminAudit(gate.login, "classic-categories", { count: categories.length });
    return NextResponse.json({ categories });
  }

  const storiesPayload = parseStoriesPayload(body);
  if (storiesPayload) {
    let stories: Story[];
    try {
      // A step must name a challenge that exists: the store checks a step id's
      // shape, not its existence (#463). A ghost step would otherwise sit in
      // the list, dropped at read time by storyPositions, invisible here.
      const existing = await listChallengeIds();
      const ghost = storiesPayload.flatMap((st) => st.steps).find((step) => !existing.has(step));
      if (ghost) throw new ClassicValidationError("stories", `No challenge with id ${ghost}`);
      stories = await setStories(storiesPayload);
    } catch (err) {
      return errorResponse(err);
    }
    await writeAdminAudit(gate.login, "classic-stories", { count: stories.length });
    return NextResponse.json({ stories });
  }

  const renamePayload = parseRenameCategoryPayload(body);
  if (renamePayload) {
    let result;
    try {
      result = await renameCategory(renamePayload.from, renamePayload.to);
    } catch (err) {
      return errorResponse(err);
    }
    await writeAdminAudit(gate.login, "classic-category-rename", {
      from: renamePayload.from,
      to: renamePayload.to,
      moved: result.moved,
    });
    return NextResponse.json(result);
  }

  const importPayload = parseImportPayload(body);
  if (importPayload !== null) {
    // Re-parse and re-validate the raw text server-side with the SAME
    // validator the client ran (or should have run) — this is what makes it
    // safe to accept raw text from a client that skipped or weakened its own
    // validation. `importBundle` itself does not re-check any of this; see
    // its doc comment.
    const parsedBundle = parseBundle(importPayload);
    if (!parsedBundle.ok) return NextResponse.json({ errors: parsedBundle.errors }, { status: 400 });

    let summary;
    try {
      summary = await importBundle(parsedBundle.bundle);
    } catch (err) {
      return errorResponse(err);
    }

    await writeAdminAudit(gate.login, "classic-import", {
      created: summary.created,
      updated: summary.updated,
      categories: summary.categories,
      ...(summary.stories !== undefined ? { stories: summary.stories } : {}),
    });
    return NextResponse.json(summary);
  }

  const parsed = parseChallengePayload(body);
  if (!parsed) return NextResponse.json({ error: "invalid request payload" }, { status: 400 });

  const { flag, hint, ...challenge } = parsed;
  const c: Challenge = challenge;
  let saved: AdminChallenge;
  try {
    saved = await upsertChallenge(c, flag, hint);
  } catch (err) {
    return errorResponse(err);
  }

  await writeAdminAudit(gate.login, "classic-upsert", { challengeId: c.id });
  // Echoes the STORED record (flag trimmed by `upsertChallenge`), not the raw
  // payload, so the authoring client's state matches what a subsequent GET
  // would return rather than drifting from it.
  return NextResponse.json({ challenge: saved.challenge, flag: saved.flag, hint: saved.hint });
}

export async function DELETE(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });

  const body = await request.json().catch(() => ({}));
  const id = typeof (body as { id?: unknown }).id === "string" ? (body as { id: string }).id : "";
  if (!id) return NextResponse.json({ error: "invalid challenge id" }, { status: 400 });

  try {
    await deleteChallenge(id);
  } catch (err) {
    return errorResponse(err);
  }

  await writeAdminAudit(gate.login, "classic-delete", { challengeId: id });
  return NextResponse.json({ ok: true });
}
