// /api/admin/attachments (#186): organizer upload, link, list and remove.
// requireAdmin first; the body is bounded; caps come back as 400s with the
// store's message; the item must exist.

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  admin: true,
  ids: new Set(["web-one"]),
  addUpload: vi.fn(),
  addLink: vi.fn(),
  removeAttachment: vi.fn(),
  listAttachments: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin-auth", () => ({
  requireAdmin: async () => (m.admin ? { ok: true, login: "boss" } : { ok: false, status: 403 }),
}));
vi.mock("@/lib/admin-store", () => ({
  writeAdminAudit: m.audit,
  adminErrorLabel: (e: unknown) => String(e),
}));
vi.mock("@/lib/classic-store", () => ({ listChallengeIds: async () => m.ids }));
vi.mock("@/lib/attachments-store", async () => {
  class AttachmentError extends Error {}
  return {
    AttachmentError,
    addUpload: m.addUpload,
    addLink: m.addLink,
    removeAttachment: m.removeAttachment,
    listAttachments: m.listAttachments,
  };
});

import { AttachmentError } from "@/lib/attachments-store";
import { ATTACHMENT_MAX_BYTES } from "@/lib/attachments-keys";
import { DELETE, GET, POST } from "@/app/api/admin/attachments/route";

const url = (q: string) => `http://x/api/admin/attachments?${q}`;
const upload = (bytes: Uint8Array, q = "module=classic&item=web-one&name=cap.pcap", headers: Record<string, string> = {}) =>
  POST(new Request(url(q), { method: "POST", body: Buffer.from(bytes), headers: { "content-type": "application/octet-stream", ...headers } }));
const json = (body: unknown) =>
  POST(new Request(url(""), { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));

beforeEach(() => {
  m.admin = true;
  for (const f of [m.addUpload, m.addLink, m.removeAttachment, m.listAttachments, m.audit]) f.mockReset();
  m.addUpload.mockImplementation(async (_m, _i, name: string, bytes: Uint8Array) => ({
    id: "a0123456789abcdef", kind: "upload", name, size: bytes.length, sha256: "f".repeat(64), chunks: 1,
  }));
  m.addLink.mockResolvedValue({ id: "a0123456789abcdee", kind: "link", name: "big", url: "https://e.org/big" });
  m.removeAttachment.mockResolvedValue(true);
  m.listAttachments.mockResolvedValue([{ id: "a0123456789abcdef", kind: "upload", name: "x", size: 1, sha256: "f", chunks: 1 }]);
});

describe("/api/admin/attachments", () => {
  it("refuses a non-admin before reading anything", async () => {
    m.admin = false;
    expect((await upload(new Uint8Array(3))).status).toBe(403);
    expect((await GET(new Request(url("module=classic&item=web-one")))).status).toBe(403);
    expect((await DELETE(new Request(url("id=a0123456789abcdef"), { method: "DELETE" }))).status).toBe(403);
    expect(m.addUpload).not.toHaveBeenCalled();
    expect(m.listAttachments).not.toHaveBeenCalled();
    expect(m.removeAttachment).not.toHaveBeenCalled();
  });

  it("uploads the bytes it read, and audits the name and size only", async () => {
    const res = await upload(new Uint8Array([1, 2, 3]));
    expect(res.status).toBe(200);
    expect(m.addUpload).toHaveBeenCalledWith("classic", "web-one", "cap.pcap", new Uint8Array([1, 2, 3]));
    expect((await res.json()).attachment).not.toHaveProperty("chunks");
    expect(m.audit).toHaveBeenCalledWith("boss", "attachment-add", { item: "web-one", kind: "upload", name: "cap.pcap", size: 3 });
  });

  it("413s a declared or actual body over 5 MiB without storing it", async () => {
    expect((await upload(new Uint8Array(4), undefined, { "content-length": String(ATTACHMENT_MAX_BYTES + 1) })).status).toBe(413);
    expect((await upload(new Uint8Array(ATTACHMENT_MAX_BYTES + 1))).status).toBe(413);
    expect(m.addUpload).not.toHaveBeenCalled();
  });

  it("400s an unknown item, an unknown module, and a missing name", async () => {
    expect((await upload(new Uint8Array(1), "module=classic&item=ghost&name=x")).status).toBe(400);
    expect((await upload(new Uint8Array(1), "module=quiz&item=web-one&name=x")).status).toBe(400);
    expect((await upload(new Uint8Array(1), "module=classic&item=web-one")).status).toBe(400);
    expect(m.addUpload).not.toHaveBeenCalled();
  });

  it("maps a cap refusal to 400 with the store's message, a Redis failure to 503", async () => {
    m.addUpload.mockRejectedValueOnce(new AttachmentError("At most 10 attachments per challenge — this one has 10"));
    const refused = await upload(new Uint8Array(1));
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toMatch(/At most 10/);
    m.addUpload.mockRejectedValueOnce(new Error("NOAUTH"));
    expect((await upload(new Uint8Array(1))).status).toBe(503);
  });

  // Review M2: a multipart body would be stored with its boundaries inside.
  it("415s an upload that is not application/octet-stream", async () => {
    const res = await POST(
      new Request(url("module=classic&item=web-one&name=x"), { method: "POST", body: "--b\r\n", headers: { "content-type": "multipart/form-data; boundary=b" } }),
    );
    expect(res.status).toBe(415);
    expect(m.addUpload).not.toHaveBeenCalled();
  });

  // Review M1: the JSON branch is bounded too.
  it("413s an oversized link body", async () => {
    const res = await json({ module: "classic", item: "web-one", link: { name: "x", url: "https://e.org/" + "a".repeat(20_000) } });
    expect(res.status).toBe(413);
    expect(m.addLink).not.toHaveBeenCalled();
  });

  it("adds a link from an exact JSON shape", async () => {
    const res = await json({ module: "classic", item: "web-one", link: { name: "big", url: "https://e.org/big" } });
    expect(res.status).toBe(200);
    expect(m.addLink).toHaveBeenCalledWith("classic", "web-one", "big", "https://e.org/big");
    expect((await json({ module: "classic", item: "web-one", link: { name: "big" } })).status).toBe(400);
    expect((await json({ module: "classic", item: "web-one", link: { name: "b", url: "https://e.org" }, extra: 1 })).status).toBe(400);
  });

  it("lists an item's attachments without chunk counts, and removes one", async () => {
    const list = await GET(new Request(url("module=classic&item=web-one")));
    expect((await list.json()).attachments[0]).not.toHaveProperty("chunks");
    const del = await DELETE(new Request(url("id=a0123456789abcdef"), { method: "DELETE" }));
    expect(del.status).toBe(200);
    expect(m.audit).toHaveBeenCalledWith("boss", "attachment-remove", { id: "a0123456789abcdef" });
    m.removeAttachment.mockResolvedValueOnce(false);
    expect((await DELETE(new Request(url("id=a0123456789abcdef"), { method: "DELETE" }))).status).toBe(404);
  });
});
