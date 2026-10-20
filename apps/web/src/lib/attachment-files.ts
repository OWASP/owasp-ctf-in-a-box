// Upload bytes carried inside a file: the event archive's `attachmentFiles`
// and a v3 classic bundle's, one shape and one validator for both. Client-safe
// ON PURPOSE, like classic-io.ts and event-io.ts, which import it: the admin
// panel validates a pasted bundle in the browser before it is sent. It may
// only import the dependency-free attachments-keys.ts.
//
// This is the SHAPE check. The sha256 of the decoded bytes is verified
// server-side (attachment-files-store.ts) before an import writes anything.

import { ATTACHMENT_MAX_BYTES } from "@/lib/attachments-keys";

/** One upload's bytes, base64, keyed by the challenge that holds it and the
 *  sha256 its metadata records. */
export type AttachmentFile = { item: string; sha256: string; bytes: string };

type FileError = { where: string; message: string };

const FILE_KEYS = new Set(["item", "sha256", "bytes"]);
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
/** The same shape `classic-io.ts` requires of an upload's metadata sha256. */
const SHA256_RE = /^[0-9a-f]{64}$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Every `(challenge id, sha256)` an upload in `challenges` names. Read
 *  defensively: the challenges may still carry their own validation errors,
 *  which the caller reports separately. */
function namedUploads(challenges: readonly unknown[]): Set<string> {
  const named = new Set<string>();
  for (const c of challenges) {
    if (!isPlainObject(c) || typeof c.id !== "string" || !Array.isArray(c.attachments)) continue;
    for (const a of c.attachments) {
      if (isPlainObject(a) && typeof a.sha256 === "string") named.add(`${c.id}\n${a.sha256}`);
    }
  }
  return named;
}

/** Validates an `attachmentFiles` array against the uploads `challenges`
 *  name. Each file must name one of them by `(item, sha256)`: bytes for
 *  nothing are refused, not silently dropped. `unmatched` is the message for
 *  a file that names none, worded for the file it sits in.
 *
 *  Every message names the indexed path and the rule, never the file's own
 *  `item`, `sha256` or key names: the list is echoed to the client verbatim,
 *  and a file's values are arbitrary text. */
export function validateAttachmentFiles(
  raw: unknown,
  challenges: readonly unknown[],
  unmatched: string,
  errors: FileError[],
): AttachmentFile[] {
  const where = "attachmentFiles";
  if (!Array.isArray(raw)) {
    errors.push({ where, message: '"attachmentFiles" must be an array' });
    return [];
  }
  const named = namedUploads(challenges);
  const out: AttachmentFile[] = [];
  raw.forEach((f, i) => {
    const at = `${where}[${i}]`;
    if (!isPlainObject(f)) return void errors.push({ where: at, message: "Each file must be an object" });
    const unknown = Object.keys(f).filter((k) => !FILE_KEYS.has(k));
    if (unknown.length > 0) {
      errors.push({ where: at, message: `Unknown key(s) (${unknown.length}) — a file is exactly { item, sha256, bytes }` });
    }
    if (typeof f.item !== "string" || typeof f.sha256 !== "string" || typeof f.bytes !== "string") {
      return void errors.push({ where: at, message: "A file is { item, sha256, bytes } — all strings" });
    }
    if (f.bytes.length % 4 !== 0 || !BASE64_RE.test(f.bytes)) {
      errors.push({ where: `${at}.bytes`, message: "bytes must be base64" });
    } else if (Math.floor((f.bytes.length * 3) / 4) > ATTACHMENT_MAX_BYTES + 2) {
      errors.push({ where: `${at}.bytes`, message: `A file can be at most ${ATTACHMENT_MAX_BYTES} bytes` });
    }
    if (!SHA256_RE.test(f.sha256)) {
      errors.push({ where: `${at}.sha256`, message: "sha256 must be 64 lowercase hex digits" });
    } else if (!named.has(`${f.item}\n${f.sha256}`)) {
      errors.push({ where: at, message: unmatched });
    }
    out.push({ item: f.item, sha256: f.sha256, bytes: f.bytes });
  });
  return out;
}
