import { NextResponse } from "next/server";
import { SPONSOR_ID_RE } from "@/lib/sponsors-keys";
import { getSponsorLogo, listSponsors } from "@/lib/sponsors-store";

/**
 * PUBLIC logo bytes, served from our own origin — the whole reason this
 * route exists (see the sponsors ADR in docs/decisions.md): a contestant's
 * browser never fetches a sponsor's logo from the sponsor's own CDN, which
 * would leak that contestant's IP to the sponsor on every leaderboard/landing
 * page load. `force-dynamic` because this reads live Redis state on every
 * request that isn't answered by a 304.
 *
 * `max-age=300` rather than `immutable`: the URL is stable across a logo
 * replacement (it's keyed by sponsor id, not by content hash), so a client
 * cache has to recheck periodically. The ETag is what actually changes when
 * an organizer swaps a logo mid-event; five minutes is the worst-case
 * staleness window that trade-off buys, and it avoids threading a
 * cache-busting query string through three separate components instead.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await params;
  let id: string;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    return new NextResponse(null, { status: 404 });
  }

  // SECURITY INVARIANT: validate the id shape before any Redis command runs.
  if (!SPONSOR_ID_RE.test(id)) {
    return new NextResponse(null, { status: 404 });
  }

  // Fails CLOSED (503), unlike the page-level sponsor reads: this route's
  // whole job is serving specific bytes, and a Redis failure means it has no
  // bytes to serve — a 503 is the honest answer, not a 404 that would read
  // as "this sponsor doesn't exist."
  let sponsors;
  let base64: string | null;
  try {
    [sponsors, base64] = await Promise.all([listSponsors(), getSponsorLogo(id)]);
  } catch {
    return new NextResponse(null, { status: 503 });
  }

  const sponsor = sponsors.find((s) => s.id === id);
  if (!sponsor || !sponsor.logo || !base64) {
    return new NextResponse(null, { status: 404 });
  }

  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch === sponsor.logo.etag) {
    return new NextResponse(null, { status: 304 });
  }

  const bytes = Buffer.from(base64, "base64");
  return new NextResponse(bytes, {
    status: 200,
    headers: {
      "Content-Type": sponsor.logo.type,
      "Content-Length": String(bytes.length),
      ETag: sponsor.logo.etag,
      "Cache-Control": "public, max-age=300, stale-while-revalidate=86400",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
    },
  });
}
