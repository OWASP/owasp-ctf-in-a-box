// The attachments store's TypeScript half (#186): validation, the
// server-computed size and sha256, one chunk per request, and how a commit
// refusal reads. The Lua half (caps, atomicity, cleanup) runs against real
// Redis in attachments-store.upstash.test.ts.

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ upstashEval: vi.fn(), upstashPipeline: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/upstash", () => ({ upstashEval: mocks.upstashEval, upstashPipeline: mocks.upstashPipeline }));

import { ATTACHMENT_CHUNK_BYTES, ATTACHMENT_MAX_BYTES } from "@/lib/attachments-keys";
import {
  AttachmentError,
  addLink,
  addUpload,
  readUploadBytes,
  resolveAttachment,
} from "@/lib/attachments-store";

const calls = () => mocks.upstashPipeline.mock.calls.map((c) => c[0] as (string | number)[][]);

beforeEach(() => {
  mocks.upstashPipeline.mockReset();
  mocks.upstashEval.mockReset();
  mocks.upstashPipeline.mockResolvedValue([{ result: 1 }]);
  mocks.upstashEval.mockResolvedValue(["ok"]);
});

describe("addUpload", () => {
  it("computes size and sha256 from the bytes and writes one chunk per request", async () => {
    const bytes = new Uint8Array(ATTACHMENT_CHUNK_BYTES * 2 + 3).fill(7);
    const att = await addUpload("classic", "web-one", "../cap.pcap", bytes);
    expect(att).toMatchObject({
      kind: "upload",
      name: "cap.pcap",
      size: bytes.length,
      chunks: 3,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(calls()).toHaveLength(3);
    for (const c of calls()) expect(c).toHaveLength(1);
    // Every chunk field is keyed by the generated id, never by the name.
    expect(calls().map((c) => c[0][2])).toEqual([`${att.id}:0`, `${att.id}:1`, `${att.id}:2`]);
    expect(mocks.upstashEval).toHaveBeenCalledTimes(1);
  });

  it("refuses an empty file and one over 5 MiB before writing anything", async () => {
    await expect(addUpload("classic", "x", "a", new Uint8Array(0))).rejects.toThrow(AttachmentError);
    await expect(addUpload("classic", "x", "a", new Uint8Array(ATTACHMENT_MAX_BYTES + 1))).rejects.toThrow(/at most 5\.0 MB/);
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
    expect(mocks.upstashEval).not.toHaveBeenCalled();
  });

  it("names the cap and the usage when the commit refuses", async () => {
    mocks.upstashEval.mockResolvedValueOnce(["items", 10]);
    await expect(addUpload("classic", "x", "a", new Uint8Array(4))).rejects.toThrow(/At most 10 attachments .* has 10/);
    mocks.upstashEval.mockResolvedValueOnce(["bytes", 49 * 1024 * 1024]);
    await expect(addUpload("classic", "x", "a", new Uint8Array(4))).rejects.toThrow(/50\.0 MB .* 49\.0 MB are stored/);
  });

  // Review I2: only a Lua refusal cleaned up; a commit that THROWS (a Redis
  // blip after the chunks landed) orphaned up to 5 MiB outside the cap.
  it("drops the chunks when the commit itself throws", async () => {
    mocks.upstashEval.mockRejectedValueOnce(new Error("Upstash EVAL failed: NOAUTH"));
    await expect(addUpload("classic", "x", "a", new Uint8Array(ATTACHMENT_CHUNK_BYTES + 1))).rejects.toThrow(/NOAUTH/);
    const last = calls().at(-1)!;
    expect(last[0][0]).toBe("HDEL");
    expect(last[0].slice(2)).toHaveLength(2);
  });

  it("drops the chunks it wrote when a chunk write fails, and never commits", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: 1 }]).mockResolvedValueOnce([{ error: "NOAUTH" }]);
    await expect(addUpload("classic", "x", "a", new Uint8Array(ATTACHMENT_CHUNK_BYTES + 1))).rejects.toThrow(/NOAUTH/);
    const last = calls().at(-1)!;
    expect(last[0][0]).toBe("HDEL");
    expect(mocks.upstashEval).not.toHaveBeenCalled();
  });
});

describe("addLink", () => {
  it("accepts http(s) only", async () => {
    await expect(addLink("classic", "x", "doc", "javascript:alert(1)")).rejects.toThrow(AttachmentError);
    await expect(addLink("classic", "x", "doc", "not a url")).rejects.toThrow(AttachmentError);
    const att = await addLink("classic", "x", "big.img", "https://files.example.org/big.img");
    expect(att).toMatchObject({ kind: "link", url: "https://files.example.org/big.img" });
  });
});

describe("resolveAttachment / readUploadBytes", () => {
  it("returns null for an id outside the grammar without a read", async () => {
    expect(await resolveAttachment("../etc")).toBeNull();
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });

  it("throws on a read error rather than answering unknown", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ error: "WRONGTYPE" }]);
    await expect(resolveAttachment("a0123456789abcdef")).rejects.toThrow(/WRONGTYPE/);
  });

  it("refuses to serve a truncated file", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: Buffer.from("abc").toString("base64") }]);
    await expect(
      readUploadBytes({ id: "a0123456789abcdef", kind: "upload", name: "f", size: 4, chunks: 1, sha256: "x" }),
    ).rejects.toThrow(/expected 4/);
  });
});
