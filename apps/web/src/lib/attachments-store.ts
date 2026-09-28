// Challenge attachments (#186): uploads stored in Redis, links stored as
// metadata. See attachments-keys.ts for the key layout and caps, ADR 61 for
// why the bytes live in Redis.
//
// An upload is written in two steps: every 1 MiB chunk in a request of its
// own (srh refuses bodies over ~8 MB), then COMMIT_SCRIPT, which is the ONE
// authority on the caps — the per-item count and the event-wide byte total —
// checked and applied atomically, so two uploads that each fit alone cannot
// both land. A refused commit deletes the chunks it was handed.
//
// Every read checks the per-command `.error` (the app's pipeline does not
// throw on one) and THROWS: the download route answers 404 rather than
// serving a default.

import "server-only";
import { createHash } from "node:crypto";
import {
  ATTACHMENTS_BLOB_KEY,
  ATTACHMENTS_BYTES_KEY,
  ATTACHMENTS_EVENT_MAX_BYTES,
  ATTACHMENTS_INDEX_KEY,
  ATTACHMENTS_META_KEY,
  ATTACHMENTS_PER_ITEM_MAX,
  ATTACHMENT_ID_RE,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_URL_MAX,
  type Attachment,
  type AttachmentModule,
  chunkField,
  formatBytes,
  itemKey,
  newAttachmentId,
  sanitizeFilename,
  splitChunks,
} from "@/lib/attachments-keys";
import { CLASSIC_CHALLENGES_KEY } from "@/lib/classic-keys";
import { upstashEval, upstashPipeline } from "@/lib/upstash";

export class AttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentError";
  }
}

/** `owner` is the hash whose field must exist for an item to take a file —
 *  classic's challenge hash (#472: checked inside the commit, atomically). */
export type AttachmentKeys = { meta: string; index: string; blob: string; bytes: string; owner?: string };
const KEYS: AttachmentKeys = {
  meta: ATTACHMENTS_META_KEY,
  index: ATTACHMENTS_INDEX_KEY,
  blob: ATTACHMENTS_BLOB_KEY,
  bytes: ATTACHMENTS_BYTES_KEY,
  owner: CLASSIC_CHALLENGES_KEY,
};

/** KEYS: meta, index, bytes, blob, owner. ARGV: item key, attachment JSON,
 *  size, per-item max, event max, id, chunk count, item id. Returns {"ok"} or
 *  a refusal {"noitem"} / {"items", count} / {"bytes", total}; a refusal
 *  deletes the chunks. The item must still exist in the owner hash — checked
 *  here, atomically with the write, so a challenge deleted after the route's
 *  own check never gains an orphan still counted against the event cap. */
export const COMMIT_SCRIPT = `
local size = tonumber(ARGV[3])
local function drop()
  for n = 0, tonumber(ARGV[7]) - 1 do redis.call('HDEL', KEYS[4], ARGV[6] .. ':' .. n) end
end
if redis.call('HEXISTS', KEYS[5], ARGV[8]) == 0 then drop() return {'noitem'} end
local raw = redis.call('HGET', KEYS[1], ARGV[1])
local list = raw and cjson.decode(raw) or {}
if #list >= tonumber(ARGV[4]) then drop() return {'items', #list} end
local total = tonumber(redis.call('GET', KEYS[3]) or '0')
if total + size > tonumber(ARGV[5]) then drop() return {'bytes', total} end
table.insert(list, cjson.decode(ARGV[2]))
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(list))
redis.call('HSET', KEYS[2], ARGV[6], ARGV[1])
if size > 0 then redis.call('INCRBY', KEYS[3], size) end
return {'ok'}
`;

/** KEYS: meta, index, bytes, blob. ARGV: id. Removes one attachment, its
 *  chunks, and its bytes from the total. Returns 1, or 0 when unknown. */
export const REMOVE_SCRIPT = `
local ik = redis.call('HGET', KEYS[2], ARGV[1])
if not ik then return 0 end
local raw = redis.call('HGET', KEYS[1], ik)
local list = raw and cjson.decode(raw) or {}
local keep = {}
for _, a in ipairs(list) do
  if a.id == ARGV[1] then
    if a.chunks then for n = 0, a.chunks - 1 do redis.call('HDEL', KEYS[4], a.id .. ':' .. n) end end
    if a.kind == 'upload' and not a.missing and a.size then redis.call('DECRBY', KEYS[3], a.size) end
  else
    table.insert(keep, a)
  end
end
if #keep == 0 then redis.call('HDEL', KEYS[1], ik) else redis.call('HSET', KEYS[1], ik, cjson.encode(keep)) end
redis.call('HDEL', KEYS[2], ARGV[1])
return 1
`;

function parseList(raw: unknown): Attachment[] {
  if (raw === null || raw === undefined) return [];
  if (typeof raw !== "string") throw new Error("attachments: stored value is not a string");
  const parsed = JSON.parse(raw) as unknown; // corrupt → throws
  if (!Array.isArray(parsed)) throw new Error("attachments: stored value is not a list");
  return parsed as Attachment[];
}

/** An item's attachments, in the order they were added. THROWS on a read
 *  error or a corrupt value. */
export async function listAttachments(module: AttachmentModule, itemId: string, keys = KEYS): Promise<Attachment[]> {
  const [res] = await upstashPipeline([["HGET", keys.meta, itemKey(module, itemId)]]);
  if (res.error) throw new Error(`Upstash HGET failed: ${res.error}`);
  return parseList(res.result);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function commit(itemId: string, module: AttachmentModule, att: Attachment, keys: AttachmentKeys): Promise<void> {
  const verdict = (await upstashEval(
    COMMIT_SCRIPT,
    [keys.meta, keys.index, keys.bytes, keys.blob, keys.owner ?? CLASSIC_CHALLENGES_KEY],
    [itemKey(module, itemId), JSON.stringify(att), att.size ?? 0, ATTACHMENTS_PER_ITEM_MAX, ATTACHMENTS_EVENT_MAX_BYTES, att.id, att.chunks ?? 0, itemId],
  )) as [string, number?];
  if (verdict[0] === "noitem") throw new AttachmentError(`No challenge with id ${itemId}`);
  if (verdict[0] === "items") {
    throw new AttachmentError(`At most ${ATTACHMENTS_PER_ITEM_MAX} attachments per challenge — this one has ${verdict[1]}`);
  }
  if (verdict[0] === "bytes") {
    throw new AttachmentError(
      `The event's attachments are capped at ${formatBytes(ATTACHMENTS_EVENT_MAX_BYTES)} — ${formatBytes(Number(verdict[1]))} are stored, and this file is ${formatBytes(att.size ?? 0)}`,
    );
  }
  if (verdict[0] !== "ok") throw new Error(`attachments: unexpected commit verdict ${JSON.stringify(verdict)}`);
}

/** Stores an uploaded file. `size` and `sha256` come from the bytes, never
 *  from the client. THROWS `AttachmentError` for a cap, plain `Error` for
 *  Redis. */
export async function addUpload(
  module: AttachmentModule,
  itemId: string,
  rawName: string,
  bytes: Uint8Array,
  keys = KEYS,
): Promise<Attachment> {
  if (bytes.length === 0) throw new AttachmentError("The file is empty");
  if (bytes.length > ATTACHMENT_MAX_BYTES) {
    throw new AttachmentError(`A file can be at most ${formatBytes(ATTACHMENT_MAX_BYTES)} — this one is ${formatBytes(bytes.length)}`);
  }
  const id = newAttachmentId();
  const chunks = splitChunks(bytes);
  const att: Attachment = {
    id,
    kind: "upload",
    name: sanitizeFilename(rawName),
    size: bytes.length,
    sha256: sha256Hex(bytes),
    chunks: chunks.length,
  };
  try {
    for (const [n, chunk] of chunks.entries()) {
      const [res] = await upstashPipeline([["HSET", keys.blob, chunkField(id, n), Buffer.from(chunk).toString("base64")]]);
      if (res.error) throw new Error(`Upstash HSET failed: ${res.error}`);
    }
  } catch (err) {
    await dropChunks(id, chunks.length, keys);
    throw err;
  }
  try {
    await commit(itemId, module, att, keys);
  } catch (err) {
    // A refusal already deleted the chunks in Lua; anything else (a Redis
    // error after the chunks landed) must not leave them behind, uncounted.
    if (!(err instanceof AttachmentError)) await dropChunks(id, chunks.length, keys);
    throw err;
  }
  return att;
}

/** Best effort: a failed cleanup leaves invisible, uncounted chunks. */
async function dropChunks(id: string, count: number, keys: AttachmentKeys): Promise<void> {
  if (count === 0) return;
  await upstashPipeline([["HDEL", keys.blob, ...Array.from({ length: count }, (_, n) => chunkField(id, n))]]).catch(() => {});
}

/** Stores an external link. Only http(s); nothing is fetched or proxied. */
export async function addLink(module: AttachmentModule, itemId: string, rawName: string, rawUrl: string, keys = KEYS): Promise<Attachment> {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new AttachmentError("The link must be a full http(s) URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new AttachmentError("The link must be a full http(s) URL");
  if (url.href.length > ATTACHMENT_URL_MAX) throw new AttachmentError(`The link can be at most ${ATTACHMENT_URL_MAX} characters`);
  const att: Attachment = { id: newAttachmentId(), kind: "link", name: sanitizeFilename(rawName), url: url.href };
  await commit(itemId, module, att, keys);
  return att;
}

/** Removes one attachment (and its bytes). Returns false when unknown. */
export async function removeAttachment(id: string, keys = KEYS): Promise<boolean> {
  if (!ATTACHMENT_ID_RE.test(id)) return false;
  const res = await upstashEval(REMOVE_SCRIPT, [keys.meta, keys.index, keys.bytes, keys.blob], [id]);
  return Number(res) === 1;
}

/** Removes every attachment of an item — a deleted challenge takes its files. */
export async function deleteItemAttachments(module: AttachmentModule, itemId: string, keys = KEYS): Promise<void> {
  for (const att of await listAttachments(module, itemId, keys)) await removeAttachment(att.id, keys);
}

/** Every attachment key, gone — for the classic "clear everything" path
 *  while classic is the only adopter. */
export async function clearAllAttachments(keys = KEYS): Promise<void> {
  const [res] = await upstashPipeline([["DEL", keys.meta, keys.index, keys.blob, keys.bytes]]);
  if (res.error) throw new Error(`Upstash DEL failed: ${res.error}`);
}

/** Where an attachment belongs, or null when the id is unknown. THROWS on a
 *  read error. */
export async function resolveAttachment(
  id: string,
  keys = KEYS,
): Promise<{ module: AttachmentModule; itemId: string; attachment: Attachment } | null> {
  if (!ATTACHMENT_ID_RE.test(id)) return null;
  const [res] = await upstashPipeline([["HGET", keys.index, id]]);
  if (res.error) throw new Error(`Upstash HGET failed: ${res.error}`);
  if (typeof res.result !== "string") return null;
  const sep = res.result.indexOf(":");
  const owner = res.result.slice(0, sep);
  if (owner !== "classic") return null;
  const itemId = res.result.slice(sep + 1);
  const attachment = (await listAttachments(owner, itemId, keys)).find((a) => a.id === id);
  return attachment ? { module: owner, itemId, attachment } : null;
}

/** An upload's bytes, reassembled chunk by chunk (one per request, the same
 *  bound as the write). THROWS when a chunk is gone or the length is off —
 *  never serves a truncated file. */
export async function readUploadBytes(att: Attachment, keys = KEYS): Promise<Uint8Array> {
  if (att.kind !== "upload" || att.missing || !att.chunks || att.size === undefined) {
    throw new Error("attachments: not a stored upload");
  }
  const parts: Buffer[] = [];
  for (let n = 0; n < att.chunks; n += 1) {
    const [res] = await upstashPipeline([["HGET", keys.blob, chunkField(att.id, n)]]);
    if (res.error) throw new Error(`Upstash HGET failed: ${res.error}`);
    if (typeof res.result !== "string") throw new Error(`attachments: chunk ${n} of ${att.id} is missing`);
    parts.push(Buffer.from(res.result, "base64"));
  }
  const bytes = Buffer.concat(parts);
  if (bytes.length !== att.size) throw new Error(`attachments: ${att.id} is ${bytes.length} bytes, expected ${att.size}`);
  return new Uint8Array(bytes);
}
