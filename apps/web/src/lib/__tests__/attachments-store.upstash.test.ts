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
});
const hlen = async (key: string) => Number((await upstashPipeline([["HLEN", key]]))[0].result);

describe.skipIf(!liveConfigured)("attachments store — live (#186)", () => {
  it("round-trips a full-cap 5 MiB upload through srh, then removes it", async () => {
    const k = keysFor("full");
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

  it("refuses the 11th attachment on an item", async () => {
    const k = keysFor("items");
    for (let i = 0; i < 10; i += 1) await addLink("classic", "x", `l${i}`, `https://example.org/${i}`, k);
    await expect(addUpload("classic", "x", "f", new Uint8Array(8), k)).rejects.toThrow(/At most 10/);
    expect(await listAttachments("classic", "x", k)).toHaveLength(10);
    // The refused upload's chunk is gone.
    expect(await hlen(k.blob)).toBe(0);
  });

  it("refuses the upload that crosses the event total, keeping the total exact", async () => {
    const k = keysFor("total");
    await upstashPipeline([["SET", k.bytes, String(50 * 1024 * 1024 - 10)]]);
    await addUpload("classic", "a", "fits", new Uint8Array(10), k);
    await expect(addUpload("classic", "b", "over", new Uint8Array(1), k)).rejects.toThrow(/capped at 50\.0 MB/);
    expect(Number((await upstashPipeline([["GET", k.bytes]]))[0].result)).toBe(50 * 1024 * 1024);
    expect(await listAttachments("classic", "b", k)).toEqual([]);
  });
});
