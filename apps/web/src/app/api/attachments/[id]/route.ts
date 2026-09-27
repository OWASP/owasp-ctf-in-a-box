import { NextResponse } from "next/server";
import { ATTACHMENT_ID_RE, contentDisposition } from "@/lib/attachments-keys";
import { readUploadBytes, resolveAttachment } from "@/lib/attachments-store";
import { auth } from "@/lib/auth";
import { classicVisibility } from "@/lib/classic-visibility";

/**
 * An attachment's bytes (#186), for exactly the viewers who can see its
 * challenge. Visibility is `classicVisibility` — the SAME answer the
 * challenge page gives — so the launch lock (#464), a locked story step
 * (#463), the module switch and a deleted challenge all apply here without a
 * copy that could drift; a guessable URL is not a way around any of them.
 *
 * Hidden, unknown, malformed, a link (links are never proxied) and an upload
 * still missing its bytes all answer the same bodiless 404, so the response
 * says nothing about whether an attachment exists. A failed read is a 503.
 *
 * Always a download: `octet-stream`, `Content-Disposition: attachment` and
 * `nosniff`. The bytes come from our own origin, so an uploaded `.html` or
 * `.svg` rendered inline would be stored XSS against signed-in contestants
 * and admins. `private, no-store`: visibility changes (at launch, when a step
 * unlocks), so no shared cache may keep a copy.
 */
export const dynamic = "force-dynamic";

const notFound = () => new NextResponse(null, { status: 404 });

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // The id shape is checked before any Redis command runs.
  if (!ATTACHMENT_ID_RE.test(id)) return notFound();

  try {
    const found = await resolveAttachment(id);
    if (!found) return notFound();
    const session = await auth.api.getSession({ headers: request.headers });
    const login = (session?.user as { login?: string } | undefined)?.login;
    if ((await classicVisibility(login, found.itemId)).state !== "visible") return notFound();

    const att = found.attachment;
    if (att.kind !== "upload" || att.missing || !att.sha256) return notFound();
    const etag = `"${att.sha256}"`;
    if (request.headers.get("if-none-match") === etag) return new NextResponse(null, { status: 304, headers: { ETag: etag } });

    const bytes = await readUploadBytes(att);
    return new NextResponse(Buffer.from(bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": contentDisposition(att.name),
        "Content-Length": String(bytes.length),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
        ETag: etag,
      },
    });
  } catch (err) {
    // Name and message only — never the error object (#244).
    const e = err instanceof Error ? err : new Error(String(err));
    console.error("[attachments] download failed:", e.name, e.message);
    return new NextResponse(null, { status: 503 });
  }
}
