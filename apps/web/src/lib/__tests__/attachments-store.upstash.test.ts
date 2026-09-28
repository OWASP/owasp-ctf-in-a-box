// The attachments Lua (#186) against real Redis behind srh: a full 5 MiB file
// round-trips through srh (chunked), and COMMIT_SCRIPT enforces the per-item
// and event caps atomically, deleting the chunks of a refused upload.

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { liveConfigured, liveKey } from "./live-redis";
import { ATTACHMENT_MAX_BYTES } from "@/lib/attachments-keys";
import {
  addLink,
  addUpload,
  listAttachments,
  readUploadBytes,
  removeAttachment,
  resolveAttachment,
  type AttachmentKeys,
} from "@/lib/attachments-store";
import { upstashPipeline } from "@/lib/upstash";

const keysFor = (name: string): AttachmentKeys => ({
  meta: liveKey("attachments", `${name}:meta`),
  index: liveKey("attachments", `${name}:index`),
  blob: liveKey("attachments", `${name}:blob`),
  bytes: liveKey("attachments", `${name}:bytes`),
  owner: liveKey("attachments", `${name}:owner`),
});
/** The owning items exist (the commit checks them atomically, #472). */
const own = (k: AttachmentKeys, ...items: string[]) =>
  upstashPipeline([["HSET", k.owner!, ...items.flatMap((i) => [i, "{}"])]]);
const hlen = async (key: string) => Number((await upstashPipeline([["HLEN", key]]))[0].result);

describe.skipIf(!liveConfigured)("attachments store — live (#186)", () => {
  it("round-trips a full-cap 5 MiB upload through srh, then removes it", async () => {
    const k = keysFor("full");
    await own(k, "web-one");
    const bytes = new Uint8Array(ATTACHMENT_MAX_BYTES).map((_, i) => (i * 31) % 256);
    const att = await addUpload("classic", "web-one", "cap.pcap", bytes, k);
    const found = await resolveAttachment(att.id, k);
    expect(found?.itemId).toBe("web-one");
    const back = await readUploadBytes(found!.attachment, k);
    expect(Buffer.from(back).equals(Buffer.from(bytes))).toBe(true);
    expect(Number((await upstashPipeline([["GET", k.bytes]]))[0].result)).toBe(ATTACHMENT_MAX_BYTES);
    expect(await removeAttachment(att.id, k)).toBe(true);
    expect(await hlen(k.blob)).toBe(0);
    expect(Number((await upstashPipeline([["GET", k.bytes]]))[0].result)).toBe(0);
    expect(await resolveAttachment(att.id, k)).toBeNull();
  }, 60_000);

  // Review I1: a name that used to be cut mid-emoji made cjson reject the
  // commit and orphaned the chunks. It now commits and reads back.
  it("commits a name with an emoji at the length cap", async () => {
    const k = keysFor("emoji");
    await own(k, "x");
    const att = await addUpload("classic", "x", "x".repeat(199) + "😀😀", new Uint8Array([1, 2, 3]), k);
    expect(Array.from(att.name)).toHaveLength(200);
    expect((await listAttachments("classic", "x", k))[0].name).toBe(att.name);
  });

  // CodeRabbit #472: the item's existence is checked INSIDE the commit, so a
  // challenge deleted between the route's check and the write never gains an
  // orphan counted against the event cap.
  it("refuses a commit for an item that no longer exists, dropping its chunks", async () => {
    const k = keysFor("gone");
    await expect(addUpload("classic", "deleted", "f", new Uint8Array(8), k)).rejects.toThrow(/No challenge/);
    expect(await hlen(k.blob)).toBe(0);
    expect(await listAttachments("classic", "deleted", k)).toEqual([]);
  });

  it("refuses the 11th attachment on an item", async () => {
    const k = keysFor("items");
    await own(k, "x");
    for (let i = 0; i < 10; i += 1) await addLink("classic", "x", `l${i}`, `https://example.org/${i}`, k);
    await expect(addUpload("classic", "x", "f", new Uint8Array(8), k)).rejects.toThrow(/At most 10/);
    expect(await listAttachments("classic", "x", k)).toHaveLength(10);
    // The refused upload's chunk is gone.
    expect(await hlen(k.blob)).toBe(0);
  });

  it("refuses the upload that crosses the event total, keeping the total exact", async () => {
    const k = keysFor("total");
    await own(k, "a", "b");
    await upstashPipeline([["SET", k.bytes, String(50 * 1024 * 1024 - 10)]]);
    await addUpload("classic", "a", "fits", new Uint8Array(10), k);
    await expect(addUpload("classic", "b", "over", new Uint8Array(1), k)).rejects.toThrow(/capped at 50\.0 MB/);
    expect(Number((await upstashPipeline([["GET", k.bytes]]))[0].result)).toBe(50 * 1024 * 1024);
    expect(await listAttachments("classic", "b", k)).toEqual([]);
  });
});
