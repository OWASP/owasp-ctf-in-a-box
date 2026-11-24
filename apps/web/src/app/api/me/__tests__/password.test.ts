// POST /api/me/password: status mapping, the budget, and what is refused
// before any write. better-auth is mocked here; the real hash-and-sign-in
// proof is in auth-store-better-auth.upstash.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decoratedError, expectLabelOnly } from "@/lib/__tests__/log-redaction";

const player = { id: "0b9e4f3c-1d2a-4c5b-8e6f-7a8b9c0d1e2f", name: "Alice", image: null, githubLogin: "octocat", username: "alice" };

const m = vi.hoisted(() => ({
  getPlayer: vi.fn(),
  setPassword: vi.fn(),
  consumeRateLimit: vi.fn(),
  upstashEval: vi.fn(),
  realConsume: null as null | ((...a: never[]) => Promise<unknown>),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: { api: { setPassword: m.setPassword } } }));
vi.mock("@/lib/player", () => ({ getPlayer: m.getPlayer, getPlayerForWrite: m.getPlayer }));
vi.mock("@/lib/upstash", () => ({ upstashEval: m.upstashEval }));
vi.mock("@/lib/rate-limit-store", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/rate-limit-store")>();
  m.realConsume = real.consumeRateLimit as never;
  return { ...real, consumeRateLimit: m.consumeRateLimit };
});

import { POST } from "@/app/api/me/password/route";

const req = (body: unknown) =>
  new Request("http://box.test/api/me/password", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: "better-auth.session_token=abc" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const apiError = (code: string) => Object.assign(new Error(code), { body: { code, message: code }, status: "BAD_REQUEST" });

beforeEach(() => {
  vi.clearAllMocks();
  m.getPlayer.mockResolvedValue(player);
  m.consumeRateLimit.mockResolvedValue({ allowed: true });
  m.setPassword.mockResolvedValue({ status: true });
});

describe("POST /api/me/password", () => {
  it("401s signed out and charges nothing", async () => {
    m.getPlayer.mockResolvedValue(null);
    const res = await POST(req({ newPassword: "p".repeat(12) }));
    expect(res.status).toBe(401);
    expect(m.consumeRateLimit).not.toHaveBeenCalled();
    expect(m.setPassword).not.toHaveBeenCalled();
  });

  it("charges the player's own budget", async () => {
    await POST(req({ newPassword: "p".repeat(12) }));
    expect(m.consumeRateLimit).toHaveBeenCalledWith("set-password", player.id, 10, 600);
  });

  it("429s with Retry-After once the budget is spent, writing nothing", async () => {
    m.consumeRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 42 });
    const res = await POST(req({ newPassword: "p".repeat(12) }));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    expect(m.setPassword).not.toHaveBeenCalled();
  });

  it("200s and hands better-auth the request headers and exactly the password", async () => {
    const res = await POST(req({ newPassword: "p".repeat(12) }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const arg = m.setPassword.mock.calls[0][0] as { headers: Headers; body: unknown };
    expect(arg.body).toEqual({ newPassword: "p".repeat(12) });
    expect(arg.headers.get("cookie")).toContain("session_token");
  });

  it("409s already_set when a credential account exists", async () => {
    m.setPassword.mockRejectedValue(apiError("PASSWORD_ALREADY_SET"));
    const res = await POST(req({ newPassword: "p".repeat(12) }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "already_set" });
  });

  it.each(["PASSWORD_TOO_SHORT", "PASSWORD_TOO_LONG"])("400s length on %s", async (code) => {
    m.setPassword.mockRejectedValue(apiError(code));
    const res = await POST(req({ newPassword: "p".repeat(11) }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "length" });
  });

  it.each([{}, { newPassword: 12 }, { newPassword: null }, "not json", "[]"])("400s invalid on body %j without calling better-auth", async (body) => {
    const res = await POST(req(body));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid");
    expect(m.setPassword).not.toHaveBeenCalled();
  });

  it("500s unavailable on any other failure, logging a label and never the error or the password", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const password = "hunter2hunter2";
    // The rejection carries the submitted password the way a driver decorates
    // an error with its request, so a raw `console.error(err)` would leak it.
    m.setPassword.mockRejectedValue(decoratedError("redis exploded", password));
    const res = await POST(req({ newPassword: password }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "unavailable" });
    expectLabelOnly(err, { label: "redis exploded", secret: password });
    err.mockRestore();
  });

  it("lets the request through when the budget's store fails (fail open)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    m.consumeRateLimit.mockImplementation(m.realConsume as never);
    m.upstashEval.mockRejectedValue(new Error("redis down"));
    const res = await POST(req({ newPassword: "p".repeat(12) }));
    expect(m.upstashEval).toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(m.setPassword).toHaveBeenCalled();
    err.mockRestore();
  });
});
