import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { adminErrorLabel } from "@/lib/admin-store";
import { exportAttachmentFiles } from "@/lib/attachment-files-store";
import { ATTACHMENTS_EVENT_MAX_BYTES } from "@/lib/attachments-keys";
import { readBoundedBody } from "@/lib/bounded-body";
import { originAllowed } from "@/lib/origin";
import { importBundleResponse } from "@/app/api/admin/classic/import-response";

/**
 * The classic bundle with its files. GET hands the panel's Export the bytes
 * of every stored upload, base64, for an export with "Include files" ticked;
 * the panel builds the rest of the bundle from what it already holds. POST
 * imports a bundle, files or not, as `{ import: <raw text> }` — the same wire
 * shape as `/api/admin/classic`'s import, through the same handler.
 *
 * This route is outside the Next proxy matcher (see `config` in
 * src/proxy.ts): the proxy cuts every body it sees at 10 MB, and a bundle
 * with files runs to tens of MB. So it runs the proxy's CSRF origin check
 * itself, first thing in POST, and reads the body through a bounded reader
 * that answers a 413 naming the cap. GET mutates nothing, so the proxy had
 * nothing to check on it.
 */

/** The largest bundle import body: a full event of attachments (50 MiB) as
 *  base64, plus 8 MiB for the challenges themselves. */
export const CLASSIC_IMPORT_MAX_BYTES = Math.ceil((ATTACHMENTS_EVENT_MAX_BYTES * 4) / 3) + 8 * 1024 * 1024;

const IMPORT_KEYS = new Set(["import"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export async function GET(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });
  try {
    return NextResponse.json({ attachmentFiles: await exportAttachmentFiles() });
  } catch (err) {
    // A chunk that cannot be read fails the whole export: a bundle missing a
    // file would import with that upload "missing" and nobody told why.
    console.error("[admin/classic/bundle] file read failed:", adminErrorLabel(err));
    return NextResponse.json({ error: "attachment files could not be read" }, { status: 503 });
  }
}

export async function POST(request: Request) {
  if (!originAllowed({ origin: request.headers.get("origin"), configuredUrl: process.env.BETTER_AUTH_URL })) {
    return NextResponse.json({ error: "cross-origin request refused" }, { status: 403 });
  }
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });

  const tooLarge = () =>
    NextResponse.json(
      { error: `A bundle import can be at most ${Math.round(CLASSIC_IMPORT_MAX_BYTES / (1024 * 1024))} MB` },
      { status: 413 },
    );
  if (Number(request.headers.get("content-length") ?? 0) > CLASSIC_IMPORT_MAX_BYTES) return tooLarge();
  const read = await readBoundedBody(request, CLASSIC_IMPORT_MAX_BYTES);
  if (!read.ok) {
    return read.reason === "too_large" ? tooLarge() : NextResponse.json({ error: "invalid request payload" }, { status: 400 });
  }
  let body: unknown = null;
  try {
    body = JSON.parse(read.body);
  } catch {
    body = null;
  }
  if (!isPlainObject(body) || !Object.keys(body).every((k) => IMPORT_KEYS.has(k)) || typeof body.import !== "string") {
    return NextResponse.json({ error: "invalid request payload" }, { status: 400 });
  }
  return importBundleResponse(body.import, gate.login);
}
