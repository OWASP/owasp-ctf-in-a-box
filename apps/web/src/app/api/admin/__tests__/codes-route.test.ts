// POST /api/admin/codes: only an admin may issue a claim code, and the code
// leaves only in the uncached response.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ requireAdmin: vi.fn(), upstashEval: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin-auth", () => ({ requireAdmin: m.requireAdmin }));
vi.mock("@/lib/upstash", () => ({ upstashEval: m.upstashEval, upstashPipeline: vi.fn() }));
vi.mock("@/lib/admin-store", () => ({ adminErrorLabel: (e: unknown) => (e instanceof Error ? e.message : "x") }));

import { POST } from "@/app/api/admin/codes/route";
import { actor } from "@/lib/__tests__/audit-actor";

const req = () => new Request("http://x/api/admin/codes", { method: "POST" });

beforeEach(() => {
  vi.clearAllMocks();
  m.requireAdmin.mockResolvedValue({ ok: true, player: { ...actor("alice"), image: null, githubLogin: null } });
  m.upstashEval.mockResolvedValue(1);
});

describe("POST /api/admin/codes", () => {
  it("refuses a non-admin without issuing anything", async () => {
    m.requireAdmin.mockResolvedValue({ ok: false, status: 403 });
    expect((await POST(req())).status).toBe(403);
    expect(m.upstashEval).not.toHaveBeenCalled();
  });

  it("returns a grouped code and its expiry, uncached", async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as { code: string; expiresAt: string };
    expect(body.code).toMatch(/^([0-9a-f]{4}-){7}[0-9a-f]{4}$/);
    expect(Number.isFinite(Date.parse(body.expiresAt))).toBe(true);
  });

  it("403s when the admin was revoked before the code was stored", async () => {
    m.upstashEval.mockResolvedValue(-1);
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toMatch(/[0-9a-f]{4}-[0-9a-f]{4}/);
  });

  it("503s when the store throws, logging no code", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      m.upstashEval.mockRejectedValue(new Error("redis down"));
      expect((await POST(req())).status).toBe(503);
      expect(JSON.stringify(err.mock.calls)).not.toMatch(/[0-9a-f]{4}-[0-9a-f]{4}/);
    } finally {
      err.mockRestore();
    }
  });
});
