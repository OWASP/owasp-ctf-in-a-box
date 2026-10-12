// The server half of upload bytes carried in a file — the event archive's
// `attachmentFiles` and a v3 classic bundle's. attachment-files.ts checks the
// shape client-side; this file reads the bytes for an export, decodes and
// verifies them on import, and fills the uploads an import recorded as
// "missing" (the same fill a re-upload takes, sha256 checked again there).
//
// Every check that can refuse runs before the caller writes anything: a
// tampered file, a size that disagrees with the metadata, or a total past the
// event cap leaves the box as it was.

import "server-only";
import { createHash } from "node:crypto";
import type { AttachmentFile } from "@/lib/attachment-files";
import { ATTACHMENTS_EVENT_MAX_BYTES, formatBytes } from "@/lib/attachments-keys";
import {
  fillMissingUpload,
  listAllAttachments,
  listAttachments,
  readUploadBytes,
  storedAttachmentBytes,
} from "@/lib/attachments-store";
import type { ClassicBundle, ClassicBundleChallenge } from "@/lib/classic-io";
import { importBundle, type ImportSummary } from "@/lib/classic-store";

/** A refused file, before anything was written. `where` is the indexed path
 *  or `attachmentFiles`, for the route's `field`. */
export class AttachmentFilesError extends Error {
  constructor(
    public where: string,
    message: string,
  ) {
    super(message);
    this.name = "AttachmentFilesError";
  }
}

export type DecodedFile = { item: string; sha256: string; bytes: Uint8Array };

/** Every stored classic upload's bytes, base64. A missing upload and a link
 *  carry no bytes. */
export async function exportAttachmentFiles(): Promise<AttachmentFile[]> {
  const out: AttachmentFile[] = [];
  for (const [item, list] of await listAllAttachments("classic")) {
    for (const a of list) {
      if (a.kind !== "upload" || a.missing || !a.sha256) continue;
      out.push({ item, sha256: a.sha256, bytes: Buffer.from(await readUploadBytes(a)).toString("base64") });
    }
  }
  return out;
}

/** Decodes each file and checks its bytes against the upload it names: the
 *  sha256, and the size the metadata records — the two checks the fill
 *  would make later, made before anything is written. THROWS
 *  `AttachmentFilesError` on the first mismatch. */
export function decodeAttachmentFiles(
  challenges: readonly ClassicBundleChallenge[],
  files: readonly AttachmentFile[],
): DecodedFile[] {
  const sizes = new Map<string, number>();
  for (const c of challenges) {
    for (const a of c.attachments ?? []) if ("sha256" in a) sizes.set(`${c.id}\n${a.sha256}`, a.size);
  }
  return files.map((f, i) => {
    const where = `attachmentFiles[${i}]`;
    const bytes = new Uint8Array(Buffer.from(f.bytes, "base64"));
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== f.sha256) throw new AttachmentFilesError(where, `${where}: the bytes do not match the file's sha256`);
    const size = sizes.get(`${f.item}\n${f.sha256}`);
    if (size !== bytes.length) {
      throw new AttachmentFilesError(where, `${where}: the bytes' length does not match the size the classic metadata records`);
    }
    return { item: f.item, sha256: f.sha256, bytes };
  });
}

/** Gives each file's bytes to the missing upload it names, matched by
 *  (challenge, sha256). A file whose upload is already stored is skipped.
 *  Returns how many uploads were filled. */
export async function fillAttachmentFiles(files: readonly DecodedFile[]): Promise<number> {
  let filled = 0;
  for (const f of files) {
    const target = (await listAttachments("classic", f.item)).find((a) => a.kind === "upload" && a.missing && a.sha256 === f.sha256);
    if (!target) continue;
    await fillMissingUpload(target.id, f.bytes);
    filled += 1;
  }
  return filled;
}

/** The bytes an import would add to the event total: each distinct
 *  (challenge, sha256) the box does not already hold as a stored upload.
 *  THROWS `AttachmentFilesError` when the stored total plus those passes the
 *  event cap. The fill re-checks the cap atomically in Lua; this check is
 *  what refuses before the challenges land. */
async function assertFilesFit(files: readonly DecodedFile[]): Promise<void> {
  const counted = new Set<string>();
  let adding = 0;
  for (const f of files) {
    const key = `${f.item}\n${f.sha256}`;
    if (counted.has(key)) continue;
    counted.add(key);
    const held = (await listAttachments("classic", f.item)).some((a) => a.kind === "upload" && !a.missing && a.sha256 === f.sha256);
    if (!held) adding += f.bytes.length;
  }
  if (adding === 0) return;
  const stored = await storedAttachmentBytes();
  if (stored + adding > ATTACHMENTS_EVENT_MAX_BYTES) {
    throw new AttachmentFilesError(
      "attachmentFiles",
      `The event's attachments are capped at ${formatBytes(ATTACHMENTS_EVENT_MAX_BYTES)} — ${formatBytes(stored)} are stored, and this bundle's files add ${formatBytes(adding)}`,
    );
  }
}

/** `files` is present only for a bundle that carried `attachmentFiles`: how
 *  many missing uploads its bytes filled. */
export type ClassicImportSummary = ImportSummary & { files?: number };

/** Imports a PRE-VALIDATED classic bundle (`parseBundle`) and, when it
 *  carries files, fills its uploads. The file checks — sha256, size, the
 *  event cap — run first, and `importBundle` checks the per-challenge cap
 *  before its own write, so a refusal leaves the box as it was. Never
 *  deletes: a bundle import only adds and fills. */
export async function importClassicBundle(bundle: ClassicBundle): Promise<ClassicImportSummary> {
  const decoded = bundle.attachmentFiles ? decodeAttachmentFiles(bundle.challenges, bundle.attachmentFiles) : null;
  if (decoded) await assertFilesFit(decoded);
  const summary = await importBundle(bundle);
  if (!decoded) return summary;
  return { ...summary, files: await fillAttachmentFiles(decoded) };
}
