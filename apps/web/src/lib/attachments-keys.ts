// Challenge attachments (#186): key names, caps and the pure helpers the
// store, the download route and the admin UI share. Dependency-free ON
// PURPOSE (like classic-keys.ts), so client code can read the caps.
//
// The store is keyed by `(module, itemId)` so quiz or ai can adopt it later
// without new storage work; classic is the only adopter today.
//
// Layout:
//   ctf:attachments:meta   hash  "<module>:<itemId>" → JSON Attachment[]
//   ctf:attachments:index  hash  <attachmentId>      → "<module>:<itemId>"
//   ctf:attachments:blob   hash  "<attachmentId>:<n>" → base64 chunk n
//   ctf:attachments:bytes  int   stored upload bytes, event-wide

export const ATTACHMENTS_META_KEY = "ctf:attachments:meta";
export const ATTACHMENTS_INDEX_KEY = "ctf:attachments:index";
export const ATTACHMENTS_BLOB_KEY = "ctf:attachments:blob";
export const ATTACHMENTS_BYTES_KEY = "ctf:attachments:bytes";

export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
export const ATTACHMENTS_EVENT_MAX_BYTES = 50 * 1024 * 1024;
export const ATTACHMENTS_PER_ITEM_MAX = 10;
export const ATTACHMENT_NAME_MAX = 200;
export const ATTACHMENT_URL_MAX = 2000;
/** Raw bytes per stored chunk. srh refuses a request body over about
 *  8,000,000 bytes (measured, ADR 61); one 5 MiB file as base64 is 6.99 MB,
 *  too close — 1 MiB raw is ~1.4 MB of base64 per request. */
export const ATTACHMENT_CHUNK_BYTES = 1024 * 1024;

export const ATTACHMENT_ID_RE = /^a[0-9a-f]{16}$/;

export type AttachmentModule = "classic";

export type Attachment = {
  /** Server-generated (`newAttachmentId`), never derived from input. */
  id: string;
  kind: "upload" | "link";
  /** Sanitized display and download name. */
  name: string;
  /** Upload only: byte length and hex sha256, both computed by the server. */
  size?: number;
  sha256?: string;
  /** Upload only: how many stored chunks hold the bytes. */
  chunks?: number;
  /** Upload only: named by a bundle but the bytes are not on this box yet. */
  missing?: true;
  /** Link only: an http(s) URL the organizer hosts elsewhere. */
  url?: string;
};

export const itemKey = (module: AttachmentModule, itemId: string) => `${module}:${itemId}`;
export const chunkField = (id: string, n: number) => `${id}:${n}`;

/** 16 random hex digits behind a fixed `a` — nothing in a key, a URL or a
 *  header ever comes from what the organizer typed. */
export function newAttachmentId(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return `a${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** A display/download name: the last path segment, control characters
 *  (CR/LF included) dropped, trimmed, at most `ATTACHMENT_NAME_MAX`
 *  characters, and `file` when nothing is left. */
export function sanitizeFilename(raw: string): string {
  const last = raw.split(/[/\\]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const clean = last.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return clean.slice(0, ATTACHMENT_NAME_MAX) || "file";
}

/** `Content-Disposition` for a download: always `attachment`, an ASCII
 *  `filename` fallback, and the exact name as RFC 5987 `filename*`. */
export function contentDisposition(name: string): string {
  const safe = sanitizeFilename(name);
  const ascii = safe.replace(/[^A-Za-z0-9._-]/g, "_");
  const encoded = encodeURIComponent(safe).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Splits bytes into `ATTACHMENT_CHUNK_BYTES` pieces (none for empty input). */
export function splitChunks(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += ATTACHMENT_CHUNK_BYTES) out.push(bytes.subarray(i, i + ATTACHMENT_CHUNK_BYTES));
  return out;
}

/** Human size for the UI and the cap errors: "812 B", "3.4 KB", "4.9 MB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
