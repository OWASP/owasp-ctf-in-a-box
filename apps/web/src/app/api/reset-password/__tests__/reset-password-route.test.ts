// POST /api/reset-password: signed-out redemption of an organizer's reset
// code. The rate limiter runs for real over an in-memory stand-in for its one
// Lua script; the redeem itself is mocked (password-reset.test.ts and the live
// suite pin it).
import { beforeEach, describe, expect, it, vi } from "vitest";

const CODE = "0123-4567-89ab-cdef-0123-4567-89ab-cdef";
const PW = "correct horse battery";

const m = vi.hoisted(() => ({
  redeem: vi.fn(),
  counters: new Map<string, number>(),
  evalFails: false,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/password-reset", () => ({ redeemPasswordResetCode: m.redeem }));
vi.mock("@/lib/upstash", () => ({
  // The rate limiter's INCR-then-compare script, in memory.
  upstashEval: async (_script: string, keys: string[], args: (string | number)[]) => {
    if (m.evalFails) throw new Error("redis down");
    const n = (m.counters.get(keys[0]) ?? 0) + 1;
    m.counters.set(keys[0], n);
    return n > Number(args[0]) ? [0, 600] : [1, 0];
  },
  upstashPipeline: vi.fn(),
}));

import { POST } from "@/app/api/reset-password/route";

const req = (body: unknown, ip = "203.0.113.7") =>
  new Request("http://box.test/api/reset-password", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  m.counters.clear();
  m.evalFails = false;
  m.redeem.mockResolvedValue({ ok: true, player: "p" });
});

describe("POST /api/reset-password", () => {
  it("200s a redeemed code and hands the redeem the code and password", async () => {
    const res = await POST(req({ code: CODE, password: PW }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(m.redeem).toHaveBeenCalledWith(CODE, PW);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("answers an invalid code with the one invalid error", async () => {
    m.redeem.mockResolvedValue({ ok: false, reason: "invalid" });
    const res = await POST(req({ code: CODE, password: PW }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "RESET_CODE_INVALID" });
  });

  it("answers a password out of range with its own error", async () => {
    m.redeem.mockResolvedValue({ ok: false, reason: "password" });
    const res = await POST(req({ code: CODE, password: "short" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "PASSWORD_LENGTH" });
  });

  it("429s with Retry-After after 10 attempts from one address, without trying the code", async () => {
    m.redeem.mockResolvedValue({ ok: false, reason: "invalid" });
    for (let i = 0; i < 10; i++) expect((await POST(req({ code: CODE, password: PW }))).status).toBe(400);
    const res = await POST(req({ code: CODE, password: PW }));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("600");
    expect(m.redeem).toHaveBeenCalledTimes(10);
    expect((await POST(req({ code: CODE, password: PW }, "198.51.100.9"))).status).toBe(400);
  });

  it("charges fail closed: an unreadable budget is a 429", async () => {
    m.evalFails = true;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST(req({ code: CODE, password: PW }));
    expect(res.status).toBe(429);
    expect(m.redeem).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it("503s when the redeem throws, and logs neither code nor password", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      m.redeem.mockRejectedValue(Object.assign(new Error("redis down"), { cause: { code: CODE, password: PW } }));
      const res = await POST(req({ code: CODE, password: PW }));
      expect(res.status).toBe(503);
      expect(err).toHaveBeenCalled();
      const logged = JSON.stringify(err.mock.calls);
      expect(logged).not.toContain(CODE);
      expect(logged).not.toContain(PW);
    } finally {
      err.mockRestore();
    }
  });

  it("400s a malformed body as an invalid code before charging", async () => {
    for (const body of ["not json", { code: 12, password: PW }, { code: CODE }, {}, "x".repeat(2000)]) {
      const res = await POST(req(body));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("RESET_CODE_INVALID");
    }
    expect(m.counters.size).toBe(0);
    expect(m.redeem).not.toHaveBeenCalled();
  });
});
