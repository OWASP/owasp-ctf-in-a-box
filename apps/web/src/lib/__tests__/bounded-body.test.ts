import { describe, expect, it } from "vitest";
import { readBoundedBody, readBoundedBytes } from "@/lib/bounded-body";

const req = (body: BodyInit | null) => new Request("http://x", { method: "POST", body, duplex: "half" } as RequestInit);

describe("bounded body reads", () => {
  it("returns the bytes, or the text, up to the cap", async () => {
    expect(await readBoundedBody(req("héllo"), 10)).toEqual({ ok: true, body: "héllo" });
    const r = await readBoundedBytes(req(new Uint8Array([1, 2, 3])), 3);
    expect(r.ok && Array.from(r.bytes)).toEqual([1, 2, 3]);
  });
  it("stops at the first byte past the cap, by bytes actually read", async () => {
    expect(await readBoundedBytes(req(new Uint8Array(4)), 3)).toEqual({ ok: false, reason: "too_large" });
  });
  it("reads an absent body as empty", async () => {
    const r = await readBoundedBytes(req(null), 3);
    expect(r.ok && r.bytes.length).toBe(0);
  });
});
