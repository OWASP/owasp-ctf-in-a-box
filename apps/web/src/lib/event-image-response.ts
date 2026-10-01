import "server-only";
import { NextResponse } from "next/server";
import { getEventImageData, getEventImagesMeta } from "@/lib/event-images-store";
import type { EventImageSlot } from "@/lib/event-images-keys";

/**
 * The body of the two PUBLIC event image routes (#529), `/api/event/logo` and
 * `/api/event/icon`. Same contract as the sponsor logo route, for the same
 * reasons (see that route's header):
 *
 * - served from our own origin, with `nosniff` and an inline disposition;
 * - `max-age=300`, not `immutable`: the URL is stable across a replacement,
 *   so the ETag is what changes when an organizer swaps the image. The
 *   favicon link also carries `?v=<etag>` (layout.tsx), because browsers
 *   cache favicons far longer than their headers say;
 * - fails CLOSED (503) on a Redis error: this route's whole job is serving
 *   specific bytes, and a 404 would read as "no image set". The PAGES fall
 *   back to the built-in defaults instead (fail open) — branding must never
 *   take the landing page down.
 *
 * The metadata read comes first and alone, so a 304 never reads the bytes.
 */
export async function serveEventImage(slot: EventImageSlot, request: Request): Promise<Response> {
  let meta;
  try {
    meta = (await getEventImagesMeta())[slot];
  } catch {
    return new NextResponse(null, { status: 503 });
  }
  if (!meta) return new NextResponse(null, { status: 404 });

  if (request.headers.get("if-none-match") === meta.etag) {
    return new NextResponse(null, { status: 304, headers: { ETag: meta.etag } });
  }

  let base64: string | null;
  try {
    base64 = await getEventImageData(slot);
  } catch {
    return new NextResponse(null, { status: 503 });
  }
  if (!base64) return new NextResponse(null, { status: 404 });

  const bytes = Buffer.from(base64, "base64");
  return new NextResponse(bytes, {
    status: 200,
    headers: {
      "Content-Type": meta.type,
      "Content-Length": String(bytes.length),
      ETag: meta.etag,
      "Cache-Control": "public, max-age=300, stale-while-revalidate=86400",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
    },
  });
}
