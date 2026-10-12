import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { adminErrorLabel, writeAdminAudit } from "@/lib/admin-store";
import { CategoryConflictError } from "@/lib/category-cas";
import {
  AiValidationError,
  deleteAiChallenge,
  listAiCategories,
  listAiChallengesForAdmin,
  rotateAiSigningKey,
  renameAiCategory,
  setAiCategories,
  upsertAiChallenge,
  type AdminAiChallenge,
  type AiChallenge,
} from "@/lib/ai-store";

/**
 * Organizer authoring surface for the ai (externally hosted AI/LLM) module:
 * list (GET), create-or-update a challenge / replace the category list /
 * rotate a challenge's signing key (POST), and delete a challenge (DELETE).
 * Gated by `requireAdmin` throughout; every write appends a line to the same
 * `ctf:admin:audit` trail the classic and quiz admin routes use.
 *
 * Structural model: `admin/classic/route.ts`. Two ai-specific deltas: the
 * challenge payload carries `mode` and `urlTemplate` (classic has neither),
 * and POST gets a third dispatch arm, `{ rotate: "<id>" }` (classic has no
 * rotate). There is NO import/export arm here — the ai module has no bundle
 * format.
 *
 * This is the one surface that may return a challenge's flag AND its signing
 * key. GET calls `listAiChallengesForAdmin()`, so each row carries
 * `{ challenge, flag, hint, signingKey }` and the edit form can prefill them
 * — an organizer fixing a typo must not have to retype a flag or re-paste a
 * key into every external integration from memory. That is sound precisely
 * because `requireAdmin` runs FIRST, before any store read: anyone past it
 * can already rewrite or delete the flag and key outright. The contestant
 * path is untouched and stays secret-free — `/api/ai/*` calls `listAiChallenges`
 * and `getAiSigningKey`, never this admin lister.
 *
 * The POST payload is runtime-shape-checked field by field, rejecting any key
 * it doesn't explicitly allow, BEFORE it ever reaches `upsertAiChallenge`,
 * `setAiCategories` or `rotateAiSigningKey`. This matters because TypeScript
 * only rejects excess properties on object LITERALS, not on parsed JSON —
 * without this check, a crafted request body could smuggle an extra key
 * straight through to the store.
 *
 * POST carries THREE distinct payload shapes on the SAME route: a body with
 * exactly `categories` and `expected` (two arrays: the new list, and the list
 * it was edited from) replaces the category list; a
 * body with exactly one key, `rotate` (a challenge id string), mints a new
 * signing key for that challenge; anything else is parsed as a
 * challenge-plus-secrets upsert. The three key sets never overlap, so the
 * shape alone is enough to dispatch — no extra discriminator field for a
 * caller to get wrong.
 */

type ChallengePayload = AiChallenge & { flag?: string; hint?: string };

/** The three POST shapes' allowed key sets, kept disjoint by construction —
 *  see the header comment. */
export const CHALLENGE_KEYS = new Set([
  "id",
  "title",
  "category",
  "description",
  "points",
  "order",
  "mode",
  "urlTemplate",
  "flag",
  "caseSensitive",
  "hint",
]);
/** `expected` is required, not optional: it is what lets the store refuse a
 *  replace built from a list another organizer has since changed. A body
 *  without it could only ever be a blind overwrite. */
export const CATEGORIES_KEYS = new Set(["categories", "expected"]);
export const ROTATE_KEYS = new Set(["rotate"]);
/** The rename shape's outer and inner key sets (#304) — see the classic
 *  route's parser comment for why a rename cannot ride the `categories`
 *  array. */
export const RENAME_CATEGORY_KEYS = new Set(["renameCategory"]);
export const RENAME_FIELD_KEYS = new Set(["from", "to"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hasOnlyKeys(obj: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(obj).every((k) => allowed.has(k));
}

function parseChallengePayload(body: unknown): ChallengePayload | null {
  if (!isPlainObject(body) || !hasOnlyKeys(body, CHALLENGE_KEYS)) return null;
  if (typeof body.id !== "string" || body.id.length === 0) return null;
  // TRIMMED, not merely non-empty, mirroring classic's admin route: a
  // whitespace-only title is empty for every consumer that trims it later.
  if (typeof body.title !== "string" || body.title.trim().length === 0) return null;
  if (typeof body.category !== "string" || body.category.length === 0) return null;
  if (typeof body.description !== "string") return null;
  if (typeof body.points !== "number" || !Number.isInteger(body.points) || body.points < 0) return null;
  if (typeof body.order !== "number" || !Number.isInteger(body.order)) return null;
  // Only a basic type check here — whether the value is a KNOWN mode is a
  // domain question the store already owns (`upsertAiChallenge` throws
  // `AiValidationError` via `isAiMode`), so this route does not duplicate it.
  if (typeof body.mode !== "string" || body.mode.length === 0) return null;
  if (typeof body.urlTemplate !== "string") return null;
  // Optional; a present non-boolean is a malformed body, not a falsy value to
  // shrug at, same reasoning as classic's admin route.
  if (body.caseSensitive !== undefined && typeof body.caseSensitive !== "boolean") return null;
  // Optional flag: required only for a graded challenge, which is again the
  // store's call (`upsertAiChallenge` throws when missing and needed).
  if (body.flag !== undefined && typeof body.flag !== "string") return null;
  // Optional paid-hint text. An empty/whitespace hint is a deliberate CLEAR,
  // passed through so the store deletes the row.
  if (body.hint !== undefined && typeof body.hint !== "string") return null;
  return {
    id: body.id,
    title: body.title.trim(),
    category: body.category,
    description: body.description,
    points: body.points,
    order: body.order,
    mode: body.mode as AiChallenge["mode"],
    urlTemplate: body.urlTemplate,
    ...(body.flag !== undefined ? { flag: body.flag } : {}),
    ...(body.hint !== undefined ? { hint: body.hint } : {}),
    // Normalized to "present only when true", same convention as the record
    // the store writes.
    ...(body.caseSensitive ? { caseSensitive: true as const } : {}),
  };
}

/** The rename shape (#304): exactly `renameCategory`, itself exactly
 *  `{from, to}`. The nested object is key-checked too, so a body smuggling an
 *  extra field falls through to the 400 rather than being partly honoured. */
function parseRenameCategoryPayload(body: unknown): { from: string; to: string } | null {
  if (!isPlainObject(body) || !hasOnlyKeys(body, RENAME_CATEGORY_KEYS)) return null;
  const rename = body.renameCategory;
  if (!isPlainObject(rename) || !hasOnlyKeys(rename, RENAME_FIELD_KEYS)) return null;
  if (typeof rename.from !== "string" || typeof rename.to !== "string") return null;
  return { from: rename.from, to: rename.to };
}

/** Recognizes the `categories` shape: a body carrying exactly `categories`
 *  and `expected`, both arrays of strings. Deliberately exact (`hasOnlyKeys`
 *  PLUS requiring both keys to actually be present and well-typed) rather than
 *  merely "has a categories key" — that is what keeps this shape and the
 *  others mutually exclusive without a discriminator field. */
function parseCategoriesPayload(body: unknown): { categories: string[]; expected: string[] } | null {
  if (!isPlainObject(body) || !hasOnlyKeys(body, CATEGORIES_KEYS)) return null;
  if (!isStringArray(body.categories) || !isStringArray(body.expected)) return null;
  return { categories: body.categories, expected: body.expected };
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((c) => typeof c === "string");
}

/** Recognizes the `rotate` shape: a body carrying exactly one key, `rotate`,
 *  the id of the challenge whose signing key should be re-minted. */
function parseRotatePayload(body: unknown): string | null {
  if (!isPlainObject(body) || !hasOnlyKeys(body, ROTATE_KEYS)) return null;
  if (typeof body.rotate !== "string" || body.rotate.length === 0) return null;
  return body.rotate;
}

/** Maps an error thrown by `upsertAiChallenge`/`deleteAiChallenge`/
 *  `setAiCategories`/`rotateAiSigningKey` to a response: an
 *  `AiValidationError` means the caller's payload was genuinely bad (bad id,
 *  unknown category, non-integer points, empty flag, unknown mode, bad url
 *  template, ...) -> 400 with the message. A `CategoryConflictError` means a
 *  category write was refused because the list changed since the organizer
 *  loaded it -> 409 with the reload-and-retry message. Anything else is the store's own
 *  plain `Error` for a real Upstash/infra failure -> 503 `unavailable`, so an
 *  organizer is never told "bad request" for a problem that was never theirs
 *  to fix, and the log never carries the thrown value itself. */
function errorResponse(err: unknown): Response {
  if (err instanceof AiValidationError) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  // The list changed under the organizer and nothing was written: theirs to
  // resolve by reloading, so neither a bad request nor the store being down.
  if (err instanceof CategoryConflictError) {
    return NextResponse.json({ error: err.message }, { status: 409 });
  }
  console.error("[admin/ai] store write failed:", adminErrorLabel(err));
  return NextResponse.json({ error: "unavailable" }, { status: 503 });
}

// Audit writes go through admin-store.ts's shared `writeAdminAudit` — see the
// header comment on that function. Detail below carries only ids, NEVER a
// flag or a signing key.

export async function GET(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });

  // Admin-gated, so this may carry each challenge's flag and signing key —
  // see the header comment. The `requireAdmin` check above must stay the
  // first statement in this handler: with secrets in the payload, an early
  // store read on an unauthenticated request is no longer merely wasted work.
  let challenges: AdminAiChallenge[];
  let categories: string[];
  try {
    [challenges, categories] = await Promise.all([listAiChallengesForAdmin(), listAiCategories()]);
  } catch (err) {
    return errorResponse(err);
  }
  return NextResponse.json({ challenges, categories });
}

export async function POST(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });

  const body = await request.json().catch(() => null);

  const categoriesPayload = parseCategoriesPayload(body);
  if (categoriesPayload) {
    let categories: string[];
    try {
      categories = await setAiCategories(categoriesPayload.categories, categoriesPayload.expected);
    } catch (err) {
      return errorResponse(err);
    }
    await writeAdminAudit(gate.login, "ai-categories", { count: categories.length });
    return NextResponse.json({ categories });
  }

  const renamePayload = parseRenameCategoryPayload(body);
  if (renamePayload) {
    let result;
    try {
      result = await renameAiCategory(renamePayload.from, renamePayload.to);
    } catch (err) {
      return errorResponse(err);
    }
    await writeAdminAudit(gate.login, "ai-category-rename", {
      from: renamePayload.from,
      to: renamePayload.to,
      moved: result.moved,
    });
    return NextResponse.json(result);
  }

  const rotateId = parseRotatePayload(body);
  if (rotateId !== null) {
    let signingKey: string;
    try {
      signingKey = await rotateAiSigningKey(rotateId);
    } catch (err) {
      return errorResponse(err);
    }
    // Detail carries the id only — never the new key. See the header
    // comment and `writeAudit`'s own doc comment.
    await writeAdminAudit(gate.login, "ai-rotate-key", { id: rotateId });
    return NextResponse.json({ signingKey });
  }

  const parsed = parseChallengePayload(body);
  if (!parsed) return NextResponse.json({ error: "invalid request payload" }, { status: 400 });

  const { flag, hint, ...challenge } = parsed;
  const c: AiChallenge = challenge;
  let saved: AdminAiChallenge;
  try {
    saved = await upsertAiChallenge(c, { flag, hint });
  } catch (err) {
    return errorResponse(err);
  }

  await writeAdminAudit(gate.login, "ai-upsert", { id: c.id });
  // Echoes the STORED record (the store may normalize the url template, and
  // guarantees a signing key), not the raw payload, so the authoring
  // client's state matches what a subsequent GET would return.
  return NextResponse.json(saved);
}

export async function DELETE(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });

  const body = await request.json().catch(() => ({}));
  const id = typeof (body as { id?: unknown }).id === "string" ? (body as { id: string }).id : "";
  if (!id) return NextResponse.json({ error: "invalid challenge id" }, { status: 400 });

  try {
    await deleteAiChallenge(id);
  } catch (err) {
    return errorResponse(err);
  }

  await writeAdminAudit(gate.login, "ai-delete", { id });
  return NextResponse.json({ ok: true });
}
