// /api/admin/adjustments (#591): list, add and remove an organizer's team
// score adjustments. Admin-only; the actor is always the session's admin.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => {
  class AdjustmentValidationError extends Error {
    constructor(
      readonly field: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    requireAdmin: vi.fn(),
    listAdjustments: vi.fn(),
    addAdjustment: vi.fn(),
    removeAdjustment: vi.fn(),
    AdjustmentValidationError,
  };
});
vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin-auth", () => ({ requireAdmin: m.requireAdmin }));
vi.mock("@/lib/adjustments-store", () => ({
  listAdjustments: m.listAdjustments,
  addAdjustment: m.addAdjustment,
  removeAdjustment: m.removeAdjustment,
  AdjustmentValidationError: m.AdjustmentValidationError,
}));

import { DELETE, GET, POST } from "@/app/api/admin/adjustments/route";

const req = (method: string, body?: unknown) =>
  new Request("http://x/api/admin/adjustments", { method, body: body === undefined ? undefined : JSON.stringify(body) });

const ROW = { id: "a1", slug: "red", points: -10, reason: "late", by: "alice", at: "t" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  m.requireAdmin.mockResolvedValue({ ok: true, login: "alice" });
  m.listAdjustments.mockResolvedValue([ROW]);
  m.addAdjustment.mockResolvedValue(ROW);
  m.removeAdjustment.mockResolvedValue(ROW);
});

describe("/api/admin/adjustments", () => {
  it("refuses a non-admin on every verb, touching nothing", async () => {
    m.requireAdmin.mockResolvedValue({ ok: false, status: 403 });
    for (const res of [await GET(req("GET")), await POST(req("POST", { slug: "red", points: 5, reason: "x" })), await DELETE(req("DELETE", { id: "a1" }))]) {
      expect(res.status).toBe(403);
    }
    expect(m.listAdjustments).not.toHaveBeenCalled();
    expect(m.addAdjustment).not.toHaveBeenCalled();
    expect(m.removeAdjustment).not.toHaveBeenCalled();
  });

  it("lists the ledger", async () => {
    const res = await GET(req("GET"));
    expect(await res.json()).toEqual({ adjustments: [ROW] });
  });

  it("adds with the admin as actor", async () => {
    const res = await POST(req("POST", { slug: "red", points: -10, reason: "late" }));
    expect(res.status).toBe(200);
    expect(m.addAdjustment).toHaveBeenCalledWith("red", -10, "late", "alice");
  });

  it("400s a body of the wrong shape without touching the store", async () => {
    expect((await POST(req("POST", { slug: "red", points: "5", reason: "x" }))).status).toBe(400);
    expect(m.addAdjustment).not.toHaveBeenCalled();
  });

  it("400s a validation error with its field", async () => {
    m.addAdjustment.mockRejectedValueOnce(new m.AdjustmentValidationError("reason", "a reason is required"));
    const res = await POST(req("POST", { slug: "red", points: 5, reason: "" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "a reason is required", field: "reason" });
  });

  it("removes by id with the admin as actor", async () => {
    expect((await DELETE(req("DELETE", { id: "a1" }))).status).toBe(200);
    expect(m.removeAdjustment).toHaveBeenCalledWith("a1", "alice");
  });

  it("503s a store failure without echoing it", async () => {
    m.listAdjustments.mockRejectedValueOnce(new Error("Upstash pipeline failed: HTTP 503 token=secret"));
    const res = await GET(req("GET"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
  });
});
