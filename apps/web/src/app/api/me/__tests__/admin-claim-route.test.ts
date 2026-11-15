// POST /api/me/admin/claim: who may try, what each try costs, and that every
// refusal looks alike. The claim script itself is pinned by the live suite
// (admin-claim.upstash.test.ts); here it is mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const VECTOR_CODE = "0123-4567-89ab-cdef-0123-4567-89ab-cdef";
const VECTOR_HASH = "3eb1bd439947eb762998e566ccc2e099c791118b2f40579cc4f7da2b5061b7f9";
const player = { id: "0b9e4f3c-1d2a-4c5b-8e6f-7a8b9c0d1e2f", name: "Alice", image: null, githubLogin: "octocat" };

const m = vi.hoisted(() => ({
  getPlayer: vi.fn(),
  claimAdmin: vi.fn(),
  consumeRateLimit: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/player", () => ({ getPlayer: m.getPlayer }));
vi.mock("@/lib/admin-claim", () => ({ claimAdmin: m.claimAdmin }));
vi.mock("@/lib/rate-limit-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit-store")>()),
  consumeRateLimit: m.consumeRateLimit,
}));

import { POST } from "@/app/api/me/admin/claim/route";
import { CLAIM_INVALID } from "@/lib/admin-claim-copy";

const req = (body: unknown) =>
  new Request("http://box.test/api/me/admin/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ADMIN_CLAIM_CODE_HASH", VECTOR_HASH);
  m.getPlayer.mockResolvedValue(player);
  m.consumeRateLimit.mockResolvedValue({ allowed: true });
  m.claimAdmin.mockResolvedValue({ ok: true, via: "bootstrap" });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/me/admin/claim", () => {
  it("401s signed out and charges nothing", async () => {
    m.getPlayer.mockResolvedValue(null);
    const res = await POST(req({ code: VECTOR_CODE }));
    expect(res.status).toBe(401);
    expect(m.consumeRateLimit).not.toHaveBeenCalled();
    expect(m.claimAdmin).not.toHaveBeenCalled();
  });

  it("grants on a valid code and passes the env hash", async () => {
    const res = await POST(req({ code: VECTOR_CODE }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(m.claimAdmin).toHaveBeenCalledWith(VECTOR_CODE, { id: player.id, name: player.name }, VECTOR_HASH);
  });

  it("charges the player's own fail-closed budget", async () => {
    await POST(req({ code: VECTOR_CODE }));
    expect(m.consumeRateLimit).toHaveBeenCalledWith("admin-claim", player.id, 5, 900, { failClosed: true });
  });

  it("passes an empty hash when the env value is not a SHA-256", async () => {
    vi.stubEnv("ADMIN_CLAIM_CODE_HASH", VECTOR_CODE);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await POST(req({ code: VECTOR_CODE }));
    expect(m.claimAdmin.mock.calls[0][2]).toBe("");
    warn.mockRestore();
  });

  it("answers every refusal with the same 400 body", async () => {
    m.claimAdmin.mockResolvedValue({ ok: false, reason: "invalid" });
    const res = await POST(req({ code: VECTOR_CODE }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: CLAIM_INVALID });
  });

  it("409s an existing admin", async () => {
    m.claimAdmin.mockResolvedValue({ ok: false, reason: "already-admin" });
    const res = await POST(req({ code: VECTOR_CODE }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "already-admin" });
  });

  it("429s with Retry-After when the budget is spent, without trying the code", async () => {
    m.consumeRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 321 });
    const res = await POST(req({ code: VECTOR_CODE }));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("321");
    expect(m.claimAdmin).not.toHaveBeenCalled();
  });

  it("503s when the claim script throws, and logs neither code nor hash", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      m.claimAdmin.mockRejectedValue(new Error("redis down"));
      const res = await POST(req({ code: VECTOR_CODE }));
      expect(res.status).toBe(503);
      const logged = JSON.stringify(err.mock.calls);
      expect(logged).not.toContain(VECTOR_CODE);
      expect(logged).not.toContain("0123456789abcdef");
      expect(logged).not.toContain(VECTOR_HASH);
    } finally {
      err.mockRestore();
    }
  });

  it("sets Cache-Control: no-store on every answer", async () => {
    for (const setup of [
      () => m.getPlayer.mockResolvedValueOnce(null),
      () => m.claimAdmin.mockResolvedValueOnce({ ok: false, reason: "invalid" }),
      () => undefined,
    ]) {
      setup();
      const res = await POST(req({ code: VECTOR_CODE }));
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  it("400s a non-JSON body or a non-string code before charging", async () => {
    for (const body of ["not json", { code: 12 }, {}]) {
      const res = await POST(req(body));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: CLAIM_INVALID });
    }
    expect(m.consumeRateLimit).not.toHaveBeenCalled();
    expect(m.claimAdmin).not.toHaveBeenCalled();
  });
});
