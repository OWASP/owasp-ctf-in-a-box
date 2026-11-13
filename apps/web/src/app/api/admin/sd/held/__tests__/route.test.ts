import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ requireAdmin: vi.fn(), listHeldScores: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin-auth", () => ({ requireAdmin: h.requireAdmin }));
vi.mock("@/lib/sd-held", () => ({ listHeldScores: h.listHeldScores }));

import * as route from "@/app/api/admin/sd/held/route";

const get = () => route.GET(new Request("http://box.test/api/admin/sd/held"));

beforeEach(() => {
  vi.clearAllMocks();
  h.requireAdmin.mockResolvedValue({ ok: true });
  h.listHeldScores.mockResolvedValue([]);
});

describe("GET /api/admin/sd/held", () => {
  it.each([401, 403])("returns %i without reading", async (status) => {
    h.requireAdmin.mockResolvedValue({ ok: false, status });
    const res = await get();
    expect(res.status).toBe(status);
    expect(h.listHeldScores).not.toHaveBeenCalled();
  });

  it("returns 503 when the store throws", async () => {
    h.listHeldScores.mockRejectedValue(Object.assign(new Error("NOAUTH"), { login: "octo" }));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await get();
    expect(res.status).toBe(503);
    expect(JSON.stringify(err.mock.calls)).not.toContain("octo");
    err.mockRestore();
  });

  it("returns the entries", async () => {
    const entries = [{ login: "octo", target: "dvwa", solved: ["a"], pr: 1, at: "2026-11-19T10:00:00.000Z", status: "held" }];
    h.listHeldScores.mockResolvedValue(entries);
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ entries });
  });

  it("exports only GET and is force-dynamic", () => {
    expect(route.dynamic).toBe("force-dynamic");
    expect(Object.keys(route).sort()).toEqual(["GET", "dynamic"]);
  });
});
