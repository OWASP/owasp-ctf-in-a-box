import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { errorLabel } from "@/lib/error-label";
import {
  OpsValidationError,
  forceDisbandTeam,
  forceRemoveFromTeam,
  forceTransferCaptain,
} from "@/lib/admin-ops-store";

/**
 * Per-team support operations (issue #168).
 *
 *   POST   {slug, action:"remove-member"|"transfer-captain", login}
 *   DELETE {slug}   disband
 *
 * These are the captain-only actions in `team-store.ts`, available to an
 * organizer. They exist because the captain-only path is blocked *exactly*
 * when the captain is unreachable, which is when support is needed: a team
 * whose captain has vanished cannot rename, remove a member, regenerate its
 * code, or disband, and nothing else can rescue it.
 *
 * Unlike the contestant routes, the acting login is NOT the subject — an
 * organizer acts on a team they are not a member of. The store's scripts still
 * verify the team exists and the target is a member in the same atomic step as
 * the write, so an admin override is not the one path that races with a
 * contestant clicking Leave.
 */

/** The two actions this route performs. A UNION, not `string`, so the label
 *  handed to `fail` below can never be arbitrary caller input. */
type TeamAction = "remove-member" | "transfer-captain";

function fail(err: unknown, label: TeamAction | "disband") {
  if (err instanceof OpsValidationError) {
    return NextResponse.json({ error: err.message, field: err.field }, { status: 400 });
  }
  // `label` is passed as a console ARGUMENT, never interpolated into the
  // format string. Anything in the first position is parsed for `%s`/`%d`
  // specifiers, so a value that reached it from a request body would be a
  // format-string sink — CodeQL flagged exactly that here when the label was
  // `String(body.action)`. Narrowing the type fixes the source; keeping the
  // format string a literal fixes the sink, and either alone would do.
  console.error("[admin/ops/team] %s failed", label, errorLabel(err));
  return NextResponse.json({ error: "unavailable" }, { status: 503 });
}

export async function POST(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });

  let body: { slug?: unknown; login?: unknown; action?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof body.slug !== "string" || typeof body.login !== "string") {
    return NextResponse.json({ error: "slug and login must be strings" }, { status: 400 });
  }

  // Narrow BEFORE the try, so `action` is the union from here down rather than
  // `unknown` — the unknown-action 400 stops being a fallthrough at the bottom
  // of a try block, and the catch's label is provably one of two literals.
  const action = body.action;
  if (action !== "remove-member" && action !== "transfer-captain") {
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }

  const { slug, login } = body;
  try {
    const result =
      action === "remove-member"
        ? await forceRemoveFromTeam(slug, login, gate.login)
        : await forceTransferCaptain(slug, login, gate.login);
    return NextResponse.json(result);
  } catch (err) {
    return fail(err, action);
  }
}

export async function DELETE(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });

  let body: { slug?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof body.slug !== "string") {
    return NextResponse.json({ error: "slug must be a string" }, { status: 400 });
  }

  try {
    return NextResponse.json(await forceDisbandTeam(body.slug, gate.login));
  } catch (err) {
    return fail(err, "disband");
  }
}
