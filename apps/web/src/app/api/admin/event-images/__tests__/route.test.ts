// The organizer route for the event images (#529). requireAdmin runs before
// any store call (the invariant every admin route test pins), the body is
// bounded on the bytes actually read, a store validation error is a 400 that
// names the slot, and every write leaves an audit line.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireAdmin, getEventImagesMeta, setEventImage, clearEventImage, writeAdminAudit, EventImageValidationError } = vi.hoisted(() => {
  class EventImageValidationError extends Error {
    slot: string;
    constructor(slot: string, message: string) {
      super(message);
      this.slot = slot;
    }
  }
  return {
    requireAdmin: vi.fn(),
    getEventImagesMeta: vi.fn(),
    setEventImage: vi.fn(),
    clearEventImage: vi.fn(),
    writeAdminAudit: vi.fn(),
    EventImageValidationError,
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin-auth", () => ({ requireAdmin }));
vi.mock("@/lib/event-images-store", () => ({ getEventImagesMeta, setEventImage, clearEventImage, EventImageValidationError }));
vi.mock("@/lib/admin-store", () => ({
  writeAdminAudit,
  adminErrorLabel: (err: unknown) => (err instanceof Error ? err.message : "non-Error throw"),
}));

const { GET, POST, DELETE } = await import("@/app/api/admin/event-images/route");

const meta = { type: "image/png", bytes: 24, w: 64, h: 64, etag: "0123456789abcdef" };
const req = (method: string, body?: unknown) =>
  new Request("http://x/api/admin/event-images", { method, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(() => {
  for (const m of [requireAdmin, getEventImagesMeta, setEventImage, clearEventImage, writeAdminAudit]) m.mockReset();
  requireAdmin.mockResolvedValue({ ok: true, login: "organizer" });
});

describe("the admin gate", () => {
  it.each([
    ["GET", () => GET(req("GET"))],
    ["POST", () => POST(req("POST", { slot: "logo", data: "AAAA" }))],
    ["DELETE", () => DELETE(req("DELETE", { slot: "logo" }))],
  ])("%s refuses a non-admin before touching the store", async (_m, call) => {
    requireAdmin.mockResolvedValue({ ok: false, status: 403 });
    expect((await call()).status).toBe(403);
    expect(getEventImagesMeta).not.toHaveBeenCalled();
    expect(setEventImage).not.toHaveBeenCalled();
    expect(clearEventImage).not.toHaveBeenCalled();
  });
});

describe("GET", () => {
  it("returns the stored metadata", async () => {
    getEventImagesMeta.mockResolvedValue({ icon: meta });
    const res = await GET(req("GET"));
    expect(await res.json()).toEqual({ images: { icon: meta } });
  });

  it("answers 503 when Redis cannot be read", async () => {
    getEventImagesMeta.mockRejectedValue(new Error("NOAUTH"));
    expect((await GET(req("GET"))).status).toBe(503);
  });
});

describe("POST", () => {
  it("stores the upload, passes the declared type through, and audits it", async () => {
    setEventImage.mockResolvedValue(meta);
    const res = await POST(req("POST", { slot: "icon", data: "AAAA", declaredType: "image/png" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slot: "icon", image: meta });
    expect(setEventImage).toHaveBeenCalledWith("icon", { data: "AAAA", declaredType: "image/png" });
    expect(writeAdminAudit).toHaveBeenCalledWith("organizer", "event-image-set", { slot: "icon", etag: meta.etag });
  });

  it.each([
    ["an unknown slot", { slot: "banner", data: "AAAA" }],
    ["no data", { slot: "logo" }],
    ["a non-string type", { slot: "logo", data: "AAAA", declaredType: 7 }],
    ["an extra key", { slot: "logo", data: "AAAA", url: "https://x" }],
    ["not an object", ["logo"]],
  ])("refuses %s with 400 and never calls the store", async (_n, body) => {
    expect((await POST(req("POST", body))).status).toBe(400);
    expect(setEventImage).not.toHaveBeenCalled();
  });

  it("refuses an oversized body with 413", async () => {
    const res = await POST(req("POST", { slot: "logo", data: "A".repeat(300_000) }));
    expect(res.status).toBe(413);
    expect(setEventImage).not.toHaveBeenCalled();
  });

  it("turns a validation error into a 400 that names the slot, with no audit line", async () => {
    setEventImage.mockRejectedValue(new EventImageValidationError("icon", "The favicon must be square"));
    const res = await POST(req("POST", { slot: "icon", data: "AAAA" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "The favicon must be square", slot: "icon" });
    expect(writeAdminAudit).not.toHaveBeenCalled();
  });

  it("answers 503 when the write fails", async () => {
    setEventImage.mockRejectedValue(new Error("NOAUTH"));
    expect((await POST(req("POST", { slot: "logo", data: "AAAA" }))).status).toBe(503);
    expect(writeAdminAudit).not.toHaveBeenCalled();
  });
});

describe("DELETE", () => {
  it("restores the default and audits it", async () => {
    clearEventImage.mockResolvedValue(undefined);
    const res = await DELETE(req("DELETE", { slot: "logo" }));
    expect(res.status).toBe(200);
    expect(clearEventImage).toHaveBeenCalledWith("logo");
    expect(writeAdminAudit).toHaveBeenCalledWith("organizer", "event-image-clear", { slot: "logo" });
  });

  it("refuses an unknown slot", async () => {
    expect((await DELETE(req("DELETE", { slot: "../logo" }))).status).toBe(400);
    expect(clearEventImage).not.toHaveBeenCalled();
  });

  it("answers 503 when the write fails", async () => {
    clearEventImage.mockRejectedValue(new Error("NOAUTH"));
    expect((await DELETE(req("DELETE", { slot: "icon" }))).status).toBe(503);
  });
});
