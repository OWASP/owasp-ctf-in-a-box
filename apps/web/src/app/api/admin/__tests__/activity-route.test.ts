// Route contract for GET /api/admin/activity (issue #212): admin-gated,
// clamped paging, and a Redis failure surfacing as 503 rather than a crash.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireAdmin, listActivity } = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  listActivity: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin-auth", () => ({ requireAdmin }));
vi.mock("@/lib/activity-log", () => ({ listActivity }));

import { GET } from "@/app/api/admin/activity/route";
import { decoratedError, expectLabelOnly } from "@/lib/__tests__/log-redaction";

const req = (query = "") => new Request(`http://x/api/admin/activity${query}`);

beforeEach(() => {
  requireAdmin.mockReset();
  listActivity.mockReset();
  requireAdmin.mockResolvedValue({ ok: true, login: "alice" });
  listActivity.mockResolvedValue({ entries: [], total: 0 });
});

describe("GET /api/admin/activity", () => {
  it("refuses a non-admin with the gate's own status", async () => {
    requireAdmin.mockResolvedValue({ ok: false, status: 403 });
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(listActivity).not.toHaveBeenCalled();
  });

  it("serves a page with the defaults when no params are given", async () => {
    listActivity.mockResolvedValue({
      entries: [{ at: "2026-08-24T18:00:00.000Z", type: "login", login: "octocat" }],
      total: 1,
    });
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(listActivity).toHaveBeenCalledWith(0, 200);
    expect(await res.json()).toEqual({
      entries: [{ at: "2026-08-24T18:00:00.000Z", type: "login", login: "octocat" }],
      total: 1,
    });
  });

  it("honours offset, and clamps limit to the ceiling", async () => {
    await GET(req("?offset=400&limit=9999"));
    expect(listActivity).toHaveBeenCalledWith(400, 500);
  });

  it("falls back to the defaults on junk params", async () => {
    await GET(req("?offset=-3&limit=zero"));
    expect(listActivity).toHaveBeenCalledWith(0, 200);
  });

  it("degrades a Redis failure to 503", async () => {
    listActivity.mockRejectedValue(new Error("down"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await GET(req());
    expect(res.status).toBe(503);
    error.mockRestore();
  });

  // Label only, never the raw caught value (#500 follow-up).
  it("logs the label on a read failure, never the raw err", async () => {
    listActivity.mockRejectedValue(decoratedError());
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await GET(req())).status).toBe(503);
      expectLabelOnly(error);
    } finally {
      error.mockRestore();
    }
  });
});
