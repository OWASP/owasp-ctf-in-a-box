import { requireAdmin } from "@/lib/admin-auth";
import { ATTACHMENTS_EVENT_MAX_BYTES } from "@/lib/attachments-keys";
import { readBoundedBody } from "@/lib/bounded-body";
import { ADMIN_AUDIT_KEY, AUDIT_CAP, AdminValidationError } from "@/lib/admin-store";
import { parseEventBundle } from "@/lib/event-io";
import { EventLiveError, exportEventBundle, importEventBundle } from "@/lib/event-store";
import { upstashPipeline } from "@/lib/upstash";

/**
 * Organizer surface for whole-event archive export (GET) and import (POST).
 * Gated by `requireAdmin` throughout, same as the module-scoped admin
 * routes (`admin/classic/route.ts`, `admin/quiz/route.ts`) this mirrors.
 *
 * GET hands back the assembled bundle (see `exportEventBundle` in
 * event-store.ts) as JSON, plus any `warnings` (Secure Development content
 * excluded, event still live, ...) — the client builds the downloadable
 * file from this response; the route itself never writes a file.
 *
 * POST carries the bundle as raw TEXT under the single key `import`, never a
 * pre-parsed object — mirroring the classic/quiz admin routes' bulk-import
 * shape — so this route re-parses and re-validates it with
 * `parseEventBundle` (the same validator `event-io.ts` exposes to the
 * client) before ever calling `importEventBundle`. `importEventBundle`
 * itself refuses on a live event via `EventLiveError`, mapped here to 409.
 *
 * `parseEventBundle` checks the bundle's policy keys against the
 * `EVENT_POLICY_FIELDS` allowlist, but not their VALUE types — a hand-edited
 * bundle can carry an allowlisted key with a wrong-typed value (e.g. a
 * string `hintCost`), which only `updateAdminSettings` catches, throwing
 * `AdminValidationError`. Mapped here to 400, the same status
 * `admin/settings/route.ts` uses for the same error — never a 500, and never
 * silently accepted.
 */

const IMPORT_KEYS = new Set(["import"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hasOnlyKeys(obj: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(obj).every((k) => allowed.has(k));
}

/** Appends one audit line, mirroring admin-store's / the classic admin
 *  route's LPUSH+LTRIM pattern. Best-effort: an audit-write failure is
 *  logged but never fails a request whose actual data write already
 *  succeeded. */
async function writeAudit(actor: string, action: string, detail: Record<string, unknown>): Promise<void> {
  const audit = JSON.stringify({ at: new Date().toISOString(), by: actor, action, ...detail });
  try {
    await upstashPipeline([
      ["LPUSH", ADMIN_AUDIT_KEY, audit],
      ["LTRIM", ADMIN_AUDIT_KEY, 0, AUDIT_CAP - 1],
    ]);
  } catch (err) {
    console.error("[admin/event] audit write failed", err);
  }
}

export async function GET(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return Response.json({ error: "forbidden" }, { status: gate.status });

  const { bundle, warnings } = await exportEventBundle();
  return Response.json({ bundle, warnings });
}

/** The largest archive import body (#186): a full event of attachments
 *  (50 MiB) as base64, plus 8 MiB for everything else in the archive. */
export const EVENT_IMPORT_MAX_BYTES = Math.ceil((ATTACHMENTS_EVENT_MAX_BYTES * 4) / 3) + 8 * 1024 * 1024;

export async function POST(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return Response.json({ error: "forbidden" }, { status: gate.status });

  // Bounded (#186): an archive carries every attachment's bytes as base64,
  // so the body is capped and read by bytes, never `request.json()` whole.
  const tooLarge = () =>
    Response.json({ error: `An archive import can be at most ${Math.round(EVENT_IMPORT_MAX_BYTES / (1024 * 1024))} MB` }, { status: 413 });
  if (Number(request.headers.get("content-length") ?? 0) > EVENT_IMPORT_MAX_BYTES) return tooLarge();
  const read = await readBoundedBody(request, EVENT_IMPORT_MAX_BYTES);
  if (!read.ok) return read.reason === "too_large" ? tooLarge() : Response.json({ error: "invalid request payload" }, { status: 400 });
  let body: unknown = null;
  try {
    body = JSON.parse(read.body);
  } catch {
    body = null;
  }
  if (!isPlainObject(body) || !hasOnlyKeys(body, IMPORT_KEYS) || typeof body.import !== "string") {
    return Response.json({ error: "invalid request payload" }, { status: 400 });
  }

  const parsed = parseEventBundle(body.import);
  if (!parsed.ok) return Response.json({ errors: parsed.errors }, { status: 400 });

  try {
    const { summary, skipped } = await importEventBundle(parsed.bundle, gate.login);
    await writeAudit(gate.login, "event-import", { summary });
    return Response.json({ summary, skipped });
  } catch (e) {
    if (e instanceof EventLiveError) return Response.json({ error: e.message }, { status: 409 });
    if (e instanceof AdminValidationError) return Response.json({ error: e.message, field: e.field }, { status: 400 });
    throw e;
  }
}
