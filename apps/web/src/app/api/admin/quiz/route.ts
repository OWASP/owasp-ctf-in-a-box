import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { adminErrorLabel, writeAdminAudit } from "@/lib/admin-store";
import { parseBundle } from "@/lib/quiz-io";
import {
  deleteQuestion,
  importBundle,
  listQuestionsForAdmin,
  QuizValidationError,
  upsertQuestion,
  type AdminQuestion,
  type Choice,
  type Question,
} from "@/lib/quiz-store";
import { auditActor } from "@/lib/admin-audit-keys";

/**
 * Organizer authoring surface for the quiz module: list (GET), create-or-
 * update (POST), and delete (DELETE) questions. Gated by `requireAdmin`
 * throughout; every write appends a line to the same `ctf:admin:audit`
 * trail `admin-store`'s settings/reset/seed writers use.
 *
 * This is the one surface that may return the answer key. GET calls
 * `listQuestionsForAdmin()`, so each row carries `{ question, correct }` and
 * the edit form can prefill which choices are currently right — an organizer
 * fixing a typo must not have to re-pick the answer from memory and risk
 * silently redefining it for every contestant. That is sound precisely
 * because `requireAdmin` runs FIRST, before any store read: anyone past it
 * can already rewrite or delete the answer outright. The contestant path is
 * untouched and stays keyless — `/quiz` calls `listQuestions()`, which never
 * reads `ctf:quiz:key` at all.
 *
 * The POST payload is runtime-shape-checked field by field, rejecting any
 * key it doesn't explicitly allow, BEFORE it ever reaches `upsertQuestion`.
 * This matters because TypeScript only rejects excess properties on object
 * LITERALS, not on parsed JSON — without this check, a crafted request body
 * could smuggle an extra key (e.g. a `points` field on a choice object)
 * straight through to the store, and `upsertQuestion`/GRADE_SCRIPT would
 * have no way to know that value wasn't meant to be there. `parseChoice`
 * and `parseQuestionPayload` below are the guard: unknown keys, wrong
 * types, or missing fields on the question OR any of its choices all fail
 * closed with a 400, never a partially-trusted write.
 *
 * POST carries TWO distinct payload shapes on the SAME route rather than a
 * second endpoint, mirroring the classic admin route: a body whose only key
 * is `import` (a string) bulk-imports a question bundle; anything else is
 * treated as a single question. The two are kept mutually exclusive by
 * `hasOnlyKeys` on both sides — a body carrying `import` AND any question key
 * matches neither shape and falls through to the 400 catch-all, rather than
 * being silently read as either.
 *
 * The `import` shape carries the bundle as raw TEXT, never a pre-parsed
 * object. The route re-parses and re-validates it server-side with
 * `parseBundle` (the same validator the admin bulk-import UI runs
 * client-side) before ever calling `importBundle`, so a client that skipped
 * or weakened its own validation cannot write anything the single-question
 * path above would have rejected. `importBundle` itself trusts its input
 * completely — see its own doc comment in quiz-store.ts — which is exactly
 * why this route must never call it with anything that hasn't been through
 * `parseBundle` first.
 */

type ChoicePayload = Choice;
type QuestionPayload = {
  id: string;
  prompt: string;
  type: "single" | "multi";
  choices: ChoicePayload[];
  points: number;
  order: number;
  correct: string[];
};

/** The two POST shapes' allowed key sets. Exported (not just module-private)
 *  so a test can assert, structurally, that they stay disjoint — mirroring
 *  the classic route's equivalent case. Asserting this in code rather than
 *  trusting the two parsers to agree by construction is what catches a future
 *  optional question field literally named `import` before it reintroduces
 *  the ambiguity this route's shape-only dispatch depends on there being none
 *  of. */
export const QUESTION_KEYS = new Set(["id", "prompt", "type", "choices", "points", "order", "correct"]);
export const IMPORT_KEYS = new Set(["import"]);
const CHOICE_KEYS = new Set(["id", "label"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hasOnlyKeys(obj: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(obj).every((k) => allowed.has(k));
}

function parseChoice(v: unknown): ChoicePayload | null {
  if (!isPlainObject(v) || !hasOnlyKeys(v, CHOICE_KEYS)) return null;
  if (typeof v.id !== "string" || v.id.length === 0) return null;
  if (typeof v.label !== "string" || v.label.length === 0) return null;
  return { id: v.id, label: v.label };
}

function parseQuestionPayload(body: unknown): QuestionPayload | null {
  if (!isPlainObject(body) || !hasOnlyKeys(body, QUESTION_KEYS)) return null;
  if (typeof body.id !== "string" || body.id.length === 0) return null;
  // TRIMMED, not merely non-empty, and stored trimmed. A whitespace-only
  // prompt is empty for every consumer that trims it later, and one of those
  // consumers is a safety gate: the delete confirmation's required phrase is
  // the trimmed prompt, and `ConfirmModal` reads an empty `requireType` as
  // "no phrase required" — so a question with a blank prompt would delete on
  // a single click with no type-to-confirm at all. `upsertQuestion` validates
  // the id, the choices and the points but never the prompt, so this boundary
  // is the only place that catches it. Fixed here, once, rather than by
  // teaching the modal about a value it should never have been handed.
  if (typeof body.prompt !== "string" || body.prompt.trim().length === 0) return null;
  if (body.type !== "single" && body.type !== "multi") return null;
  if (typeof body.points !== "number" || !Number.isInteger(body.points) || body.points < 0) return null;
  if (typeof body.order !== "number" || !Number.isInteger(body.order)) return null;
  if (!Array.isArray(body.choices) || body.choices.length === 0) return null;
  const choices: ChoicePayload[] = [];
  for (const raw of body.choices) {
    const choice = parseChoice(raw);
    if (!choice) return null;
    choices.push(choice);
  }
  if (!Array.isArray(body.correct) || body.correct.length === 0) return null;
  if (!body.correct.every((c) => typeof c === "string")) return null;
  return {
    id: body.id,
    prompt: body.prompt.trim(),
    type: body.type,
    choices,
    points: body.points,
    order: body.order,
    correct: body.correct as string[],
  };
}

/** Recognizes the OTHER POST shape: a body carrying exactly one key,
 *  `import`, a string — the raw text of an uploaded/pasted bundle file. Only
 *  extracts the string here; parsing and validating it is `parseBundle`'s
 *  job (called from `POST` below), never this function's, so there is
 *  exactly one place that decides whether a bundle is valid. */
function parseImportPayload(body: unknown): string | null {
  if (!isPlainObject(body) || !hasOnlyKeys(body, IMPORT_KEYS)) return null;
  if (typeof body.import !== "string") return null;
  return body.import;
}

/** Maps an error thrown by `upsertQuestion`/`deleteQuestion` to a response:
 *  a `QuizValidationError` means the caller's payload was genuinely bad
 *  (bad id/choice format, non-integer points, a `correct` id not among the
 *  choices, wrong arity) -> 400 with the message. Anything else is the
 *  store's own plain `Error` for a real Upstash/infra failure -> 503, so an
 *  organizer is never told "bad request" for a problem that was never
 *  theirs to fix (the same principle `quiz-store`'s fail-closed gate
 *  lookup already applies on the contestant side). */
function errorResponse(err: unknown): Response {
  if (err instanceof QuizValidationError) {
    return NextResponse.json({ error: err.message, field: err.field }, { status: 400 });
  }
  console.error("[admin/quiz] store write failed:", adminErrorLabel(err));
  return NextResponse.json({ error: "quiz store write failed" }, { status: 503 });
}

// Audit writes go through admin-store.ts's shared `writeAdminAudit` — see the
// header comment on that function.

export async function GET(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });

  // Admin-gated, so this may carry the key — see the header comment. The
  // `requireAdmin` check above must stay the first statement in this
  // handler: with the key in the payload, an early store read on an
  // unauthenticated request is no longer merely wasted work.
  const questions = await listQuestionsForAdmin();
  return NextResponse.json({ questions });
}

export async function POST(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });

  const body = await request.json().catch(() => null);

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

    await writeAdminAudit(auditActor(gate.player), "quiz-import", { created: summary.created, updated: summary.updated });
    return NextResponse.json(summary);
  }

  const parsed = parseQuestionPayload(body);
  if (!parsed) return NextResponse.json({ error: "invalid question payload" }, { status: 400 });

  const { correct, ...question } = parsed;
  const q: Question = question;
  let saved: AdminQuestion;
  try {
    saved = await upsertQuestion(q, correct);
  } catch (err) {
    return errorResponse(err);
  }

  await writeAdminAudit(auditActor(gate.player), "quiz-upsert", { questionId: q.id });
  // Echoes the STORED correct set (deduped and sorted by `upsertQuestion`),
  // not the raw payload, so the authoring client's list matches what a
  // subsequent GET would return rather than drifting from it.
  return NextResponse.json({ question: saved.question, correct: saved.correct });
}

export async function DELETE(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });

  const body = await request.json().catch(() => ({}));
  const id = typeof (body as { id?: unknown }).id === "string" ? (body as { id: string }).id : "";
  if (!id) return NextResponse.json({ error: "invalid question id" }, { status: 400 });

  try {
    await deleteQuestion(id);
  } catch (err) {
    return errorResponse(err);
  }

  await writeAdminAudit(auditActor(gate.player), "quiz-delete", { questionId: id });
  return NextResponse.json({ ok: true });
}
