import { NextResponse } from "next/server";
import { readBoundedBody } from "@/lib/bounded-body";
import { requireAdmin } from "@/lib/admin-auth";
import { adminErrorLabel, writeAdminAudit } from "@/lib/admin-store";
import { isEventImageSlot, type EventImageSlot } from "@/lib/event-images-keys";
import { clearEventImage, EventImageValidationError, getEventImagesMeta, setEventImage } from "@/lib/event-images-store";

/**
 * Organizer route for the event's own images (#529): the hero logo and the
 * favicon. GET lists the stored metadata, POST replaces one slot's image,
 * DELETE restores one slot's built-in default. Admin-gated before anything
 * else; the CSRF origin check runs in proxy.ts for every mutating /api/*
 * route, this one included (pinned in proxy-matcher.test.ts).
 *
 * Validation is the store's (event-images-store.ts) — this route only checks
 * the payload's SHAPE, so nothing it lets through reaches Redis unchecked.
 */

/** The largest upload is the 128 KB logo, which is ~175 KB as base64; the
 *  rest of the JSON is a few dozen bytes. Checked on the bytes read, not on
 *  Content-Length (bounded-body.ts). */
const MAX_BODY_BYTES = 200_000;

const POST_KEYS = new Set(["slot", "data", "declaredType"]);
const DELETE_KEYS = new Set(["slot"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hasOnlyKeys(obj: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(obj).every((k) => allowed.has(k));
}

const invalid = () => NextResponse.json({ error: "invalid request payload" }, { status: 400 });

function storeFailure(err: unknown): Response {
  if (err instanceof EventImageValidationError) {
    return NextResponse.json({ error: err.message, slot: err.slot }, { status: 400 });
  }
  console.error("[admin/event-images] store call failed:", adminErrorLabel(err));
  return NextResponse.json({ error: "event images store unavailable" }, { status: 503 });
}

async function readJson(request: Request): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  const bounded = await readBoundedBody(request, MAX_BODY_BYTES);
  if (!bounded.ok) {
    return {
      ok: false,
      response:
        bounded.reason === "too_large"
          ? NextResponse.json({ error: "request body too large" }, { status: 413 })
          : invalid(),
    };
  }
  try {
    return { ok: true, body: bounded.body === "" ? null : JSON.parse(bounded.body) };
  } catch {
    return { ok: true, body: null };
  }
}

export async function GET(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });
  try {
    return NextResponse.json({ images: await getEventImagesMeta() });
  } catch (err) {
    return storeFailure(err);
  }
}

export async function POST(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });

  const read = await readJson(request);
  if (!read.ok) return read.response;
  const body = read.body;
  if (!isPlainObject(body) || !hasOnlyKeys(body, POST_KEYS)) return invalid();
  if (!isEventImageSlot(body.slot) || typeof body.data !== "string") return invalid();
  if (body.declaredType !== undefined && typeof body.declaredType !== "string") return invalid();
  const slot: EventImageSlot = body.slot;

  let image;
  try {
    image = await setEventImage(slot, {
      data: body.data,
      ...(body.declaredType !== undefined ? { declaredType: body.declaredType } : {}),
    });
  } catch (err) {
    return storeFailure(err);
  }
  await writeAdminAudit(gate.login, "event-image-set", { slot, etag: image.etag });
  return NextResponse.json({ slot, image });
}

export async function DELETE(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });

  const read = await readJson(request);
  if (!read.ok) return read.response;
  const body = read.body;
  if (!isPlainObject(body) || !hasOnlyKeys(body, DELETE_KEYS) || !isEventImageSlot(body.slot)) return invalid();
  const slot: EventImageSlot = body.slot;

  try {
    await clearEventImage(slot);
  } catch (err) {
    return storeFailure(err);
  }
  await writeAdminAudit(gate.login, "event-image-clear", { slot });
  return NextResponse.json({ ok: true });
}
