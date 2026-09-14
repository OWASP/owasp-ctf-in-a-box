import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { adminErrorLabel, writeAdminAudit } from "@/lib/admin-store";
import { isSponsorTier } from "@/lib/sponsors-keys";
import {
  deleteSponsor,
  listSponsorsForAdmin,
  reorderSponsors,
  SponsorValidationError,
  upsertSponsor,
  type Sponsor,
  type SponsorInput,
} from "@/lib/sponsors-store";

/**
 * Organizer authoring surface for sponsors: list (GET), create-or-update or
 * reorder (POST), delete (DELETE). Gated by `requireAdmin` throughout, like
 * every other admin-* route; writes append to the same `ctf:admin:audit`
 * trail via `writeAdminAudit`.
 *
 * POST carries TWO payload shapes on the same route, dispatched by key set —
 * the same discipline api/admin/classic/route.ts uses: a body with exactly
 * one key, `reorder` (an array of ids), rewrites ordering; anything else is
 * parsed as a sponsor upsert. There is nothing here shaped like classic's
 * bulk import — a sponsor bundle rides the whole-EVENT archive
 * (event-io.ts/event-store.ts) instead, since sponsors are a platform
 * feature, not a module with its own bulk-import UI.
 *
 * A raw `request.json()` has no size cap of its own; a logo upload rides this
 * body as base64, so an oversized request is rejected by content-length
 * before it is ever parsed, rather than trusting `SPONSOR_LOGO_MAX` alone to
 * catch it after a large body has already been buffered into memory.
 */

// Base64 inflates by ~4/3; generous headroom over the store's own
// SPONSOR_LOGO_MAX (64KiB) for the rest of the JSON payload around it.
const MAX_BODY_BYTES = 200_000;

const UPSERT_KEYS = new Set(["id", "name", "url", "blurb", "tier", "order", "logoBase64", "logoType", "clearLogo"]);
const REORDER_KEYS = new Set(["reorder"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hasOnlyKeys(obj: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(obj).every((k) => allowed.has(k));
}

type UpsertPayload = SponsorInput & { logoBase64?: string; logoType?: string; clearLogo?: boolean };

function parseUpsertPayload(body: unknown): UpsertPayload | null {
  if (!isPlainObject(body) || !hasOnlyKeys(body, UPSERT_KEYS)) return null;
  if (typeof body.id !== "string" || body.id.length === 0) return null;
  if (typeof body.name !== "string" || body.name.trim().length === 0) return null;
  if (typeof body.url !== "string" || body.url.length === 0) return null;
  if (typeof body.blurb !== "string") return null;
  if (!isSponsorTier(body.tier)) return null;
  if (typeof body.order !== "number" || !Number.isInteger(body.order)) return null;
  if (body.logoBase64 !== undefined && typeof body.logoBase64 !== "string") return null;
  if (body.logoType !== undefined && typeof body.logoType !== "string") return null;
  if (body.clearLogo !== undefined && typeof body.clearLogo !== "boolean") return null;
  return {
    id: body.id,
    name: body.name,
    url: body.url,
    blurb: body.blurb,
    tier: body.tier,
    order: body.order,
    ...(body.logoBase64 !== undefined ? { logoBase64: body.logoBase64 } : {}),
    ...(body.logoType !== undefined ? { logoType: body.logoType } : {}),
    ...(body.clearLogo !== undefined ? { clearLogo: body.clearLogo } : {}),
  };
}

function parseReorderPayload(body: unknown): string[] | null {
  if (!isPlainObject(body) || !hasOnlyKeys(body, REORDER_KEYS)) return null;
  if (!Array.isArray(body.reorder)) return null;
  if (!body.reorder.every((id) => typeof id === "string")) return null;
  return body.reorder as string[];
}

/** Reads the request body up to `maxBytes`, returning `null` the moment that
 *  cap is exceeded — checked against bytes actually read off the stream, not
 *  the client-supplied `Content-Length` header, which a caller can omit or
 *  understate. `requireAdmin` has already run by the time this is called, so
 *  the DoS surface here is an authenticated admin's own oversized request,
 *  not an anonymous one — but "authenticated" is not "trusted with unbounded
 *  memory". Returns `null` on any stream error too, mapped by the caller to
 *  the same "invalid request payload" 400 a malformed JSON body gets. */
async function readBoundedBody(request: Request, maxBytes: number): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) return null;
      chunks.push(value);
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function errorResponse(err: unknown): Response {
  if (err instanceof SponsorValidationError) {
    return NextResponse.json({ error: err.message, field: err.field }, { status: 400 });
  }
  console.error("[admin/sponsors] store write failed:", adminErrorLabel(err));
  return NextResponse.json({ error: "sponsors store write failed" }, { status: 503 });
}

export async function GET(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });

  let sponsors: Sponsor[];
  try {
    sponsors = await listSponsorsForAdmin();
  } catch (err) {
    return errorResponse(err);
  }
  return NextResponse.json({ sponsors });
}

export async function POST(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });

  const raw = await readBoundedBody(request, MAX_BODY_BYTES);
  if (raw === null) {
    return NextResponse.json({ error: "request body too large" }, { status: 413 });
  }
  let body: unknown = null;
  try {
    if (raw !== "") body = JSON.parse(raw);
  } catch {
    body = null;
  }

  const reorderPayload = parseReorderPayload(body);
  if (reorderPayload) {
    let sponsors: Sponsor[];
    try {
      sponsors = await reorderSponsors(reorderPayload);
    } catch (err) {
      return errorResponse(err);
    }
    await writeAdminAudit(gate.login, "sponsors-reorder", { count: sponsors.length });
    return NextResponse.json({ sponsors });
  }

  const parsed = parseUpsertPayload(body);
  if (!parsed) return NextResponse.json({ error: "invalid request payload" }, { status: 400 });

  const { logoBase64, logoType, clearLogo, ...sponsorInput } = parsed;
  const logo = logoBase64 !== undefined ? { data: logoBase64, declaredType: logoType } : clearLogo ? null : undefined;

  let saved: Sponsor;
  try {
    saved = await upsertSponsor(sponsorInput, logo);
  } catch (err) {
    return errorResponse(err);
  }

  await writeAdminAudit(gate.login, "sponsors-upsert", { sponsorId: saved.id });
  return NextResponse.json({ sponsor: saved });
}

export async function DELETE(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });

  const body = await request.json().catch(() => ({}));
  const id = typeof (body as { id?: unknown }).id === "string" ? (body as { id: string }).id : "";
  if (!id) return NextResponse.json({ error: "invalid sponsor id" }, { status: 400 });

  try {
    await deleteSponsor(id);
  } catch (err) {
    return errorResponse(err);
  }

  await writeAdminAudit(gate.login, "sponsors-delete", { sponsorId: id });
  return NextResponse.json({ ok: true });
}
