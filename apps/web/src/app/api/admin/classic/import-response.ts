import { NextResponse } from "next/server";
import { adminErrorLabel, writeAdminAudit } from "@/lib/admin-store";
import { AttachmentFilesError, importClassicBundle, type ClassicImportSummary } from "@/lib/attachment-files-store";
import { AttachmentError } from "@/lib/attachments-store";
import { parseBundle } from "@/lib/classic-io";
import { ClassicValidationError } from "@/lib/classic-store";

/**
 * The classic bundle import both doors share: the `{ import }` shape on
 * `/api/admin/classic`, and `/api/admin/classic/bundle`, the one that takes a
 * bundle with files past the proxy's 10 MB. The caller has already run the
 * admin gate and read the body; this re-parses the raw text with the SAME
 * `parseBundle` the panel ran client-side — `importClassicBundle` trusts its
 * input completely — then imports, audits and answers.
 *
 * A refusal before anything was written answers 400: the parser's errors, a
 * store validation error, or a file whose bytes, size or total the import
 * refused. A fill that fails after the challenges landed (another upload
 * took the space in between) answers 409 and says the challenges are in.
 * Anything else is infrastructure: 503.
 */
export async function importBundleResponse(text: string, login: string): Promise<Response> {
  const parsed = parseBundle(text);
  if (!parsed.ok) return NextResponse.json({ errors: parsed.errors }, { status: 400 });

  let summary: ClassicImportSummary;
  try {
    summary = await importClassicBundle(parsed.bundle);
  } catch (err) {
    if (err instanceof ClassicValidationError) {
      return NextResponse.json({ error: err.message, field: err.field }, { status: 400 });
    }
    if (err instanceof AttachmentFilesError) {
      return NextResponse.json({ error: err.message, field: err.where }, { status: 400 });
    }
    if (err instanceof AttachmentError) {
      return NextResponse.json(
        { error: `The challenges were imported, but a file was not: ${err.message}. Re-upload it from the challenge's Files.` },
        { status: 409 },
      );
    }
    console.error("[admin/classic] store write failed:", adminErrorLabel(err));
    return NextResponse.json({ error: "classic store write failed" }, { status: 503 });
  }

  await writeAdminAudit(login, "classic-import", {
    created: summary.created,
    updated: summary.updated,
    categories: summary.categories,
    ...(summary.stories !== undefined ? { stories: summary.stories } : {}),
    ...(summary.files !== undefined ? { files: summary.files } : {}),
  });
  return NextResponse.json(summary);
}
